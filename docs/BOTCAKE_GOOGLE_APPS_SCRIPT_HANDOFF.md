# Botcake Google Sheets / Apps Script 自动化交接文档

最后整理：2026-09-05

## 1. 目标

在一个新的 Google 表格绑定 Apps Script 中，实现插件现有的主要 Botcake 自动化能力。目标端不依赖浏览器页面、Redux、Cookie 或页面跳转，只依赖：

- Botcake Token；
- 专页 ID；
- 需要应用的设置模板或 Flow 模板；
- 必要时的素材文件。

计划覆盖：

1. 用 Token 扫描有权限的专页；
2. 批量读取最多约 100 个专页的错误日志；
3. 读取和更新专页设置；
4. 读取、创建和替换评论私信、默认回复、欢迎信息、关键词 Flow；
5. 创建或恢复机器人变量；
6. 创建和映射标签；
7. 上传并替换图片、音频、视频和文件素材；
8. 批量任务进度、失败隔离、Token 故障切换、回读校验和审计记录。

本文件描述技术原理、接口形态和推荐实现，不代表 Botcake 的正式公开 API 文档。Botcake 可能调整私有接口，开发时必须先在少量测试专页验证。

---

## 2. 已验证事实与验证边界

### 2.1 已经在真实 Botcake 环境验证

2026-09-02 已确认下列请求在完全不带 Botcake Cookie、仅在 URL 中携带 `access_token` 时可工作：

- `GET /api/v1/pages/{pageId}/settings`
- `GET /api/v1/pages/{pageId}/settings/comment`
- `POST /api/v1/pages/{pageId}/settings`
- `POST /api/v1/pages/{pageId}/save_contents`
- `GET /api/v1/pages/{pageId}/bot_field`
- `GET /api/v1/pages/{pageId}/tags`

当前插件还在使用以下接口，它们是 Apps Script 实现的重要参考，但新脚本仍应逐项做小范围闭环测试：

- `/api/v1/pages/{pageId}/logs`
- `/api/v1/pages/{pageId}/customers`
- `/api/v1/pages/{pageId}/change_timezone`
- `/api/v1/pages/{pageId}/settings/comment`
- `/api/v1/pages/{pageId}/create_private_reply`
- `/api/v1/pages/{pageId}/create_contents`
- `/api/v1/pages/{pageId}/get_contents`
- `/api/v1/pages/{pageId}/replace`
- `/api/v1/pages/{pageId}/flow`
- `/api/v1/pages/{pageId}/flow/create`
- `/api/v1/pages/{pageId}/keywords`
- `/api/v1/pages/{pageId}/keywords/add_flow`
- `/api/v1/pages/{pageId}/bot_field/archive`
- `/api/v1/pages/{pageId}/contents`

### 2.2 Apps Script 与插件的差异

插件通过扩展 Background 发请求；Apps Script 通过 `UrlFetchApp` 从 Google 服务器发请求。两者共同点是都不需要 Botcake 页面上下文。

差异：

- Apps Script 没有浏览器 Cookie，也没有 Botcake Redux；
- Apps Script 不受浏览器 CORS 限制；
- 请求来源 IP、User-Agent 和执行环境与 Chrome 不同；
- Apps Script 有执行时间、URL Fetch 和属性存储配额；
- 定时触发器可能重复执行，必须使用锁和幂等设计；
- Apps Script 不应依赖插件的 `chrome.storage`、ContentScript 或 MAIN world 页面桥接。

因此，所有核心能力应直接实现为 `Token + pageId + payload -> Botcake API`。

---

## 3. 推荐系统结构

```text
Google 表格
├─ 专页配置
├─ 任务队列
├─ 错误日志
├─ 执行记录
├─ 设置模板
└─ Flow 模板目录
        │
        ▼
Apps Script 调度层
├─ TokenRepository
├─ BotcakeClient
├─ PageDirectoryService
├─ LogSyncService
├─ PageSettingsService
├─ FlowService
├─ DependencyService（变量/标签/素材）
└─ JobRunner（锁、分批、游标、重试、审计）
        │
        ▼
https://botcake.io/api/v1/...
```

不要把所有逻辑写进一个 `sync()` 函数。HTTP、Token、表格读写和业务步骤必须分层，否则批量任务中途失败后很难恢复。

---

## 4. 表格设计

### 4.1 `专页配置`

推荐列：

| 列 | 含义 |
|---|---|
| enabled | 是否参与任务 |
| pageId | 专页 ID，按文本保存 |
| pageName | 专页名称 |
| platform | Facebook / Instagram 等 |
| tokenAliases | 可访问该专页的 Token 别名，多个用逗号分隔 |
| lastPermissionCheck | 最近权限验证时间 |
| permissionStatus | OK / DENIED / ERROR |
| lastError | 最近错误，不包含完整 Token |

专页 ID 必须按文本保存，避免长数字被 Google Sheets 转为科学计数法或丢失精度。

### 4.2 `错误日志`

推荐列：

```text
recordKey, pageId, pageName, avatarUrl, code, subcode,
description, count, updatedAt, fetchedAt, tokenAlias
```

`recordKey` 推荐规则：

```text
如果接口返回日志 id：pageId + ":" + id
否则：pageId + ":" + code + ":" + subcode + ":" + descriptionHash
```

同一错误再次出现时更新 `count`、`updatedAt` 和 `fetchedAt`，不要无限追加重复行。

### 4.3 `任务队列`

推荐列：

```text
jobId, action, pageId, templateId, status, attempt,
createdAt, startedAt, finishedAt, nextRetryAt, error, resultSummary
```

状态建议：

```text
PENDING -> RUNNING -> SUCCESS
                   -> RETRY
                   -> FAILED
```

发现上一次遗留的 `RUNNING` 超过合理时间后，转为 `RETRY`，不要永久卡住。

### 4.4 `执行记录`

只记录脱敏信息：

- jobId；
- pageId；
- action；
- Token 别名及 Token 末四位；
- HTTP 状态码；
- 每阶段耗时；
- 修改前摘要、修改后摘要；
- 成功或错误说明。

严禁记录完整 Token、完整请求 URL（URL 中含 Token）或完整敏感响应。

---

## 5. Token 管理与多 Token 故障切换

### 5.1 存储

不要把完整 Token 放在普通工作表单元格。

最低可接受方案：

```javascript
PropertiesService.getScriptProperties().setProperty(
  "BOTCAKE_TOKEN_team_a",
  token
);
```

注意：Script Properties 不是硬件密钥库，也不是对项目编辑者加密。能编辑脚本项目的人原则上可以读取 Token，因此必须严格控制脚本和表格编辑权限。

配置表只保存 Token 别名，如 `team_a`、`team_b`。实际 Token 从属性读取。

### 5.2 专页到 Token 的映射

一个 Token 可以拥有多个专页，一个专页也可能同时属于多个 Token。内存结构建议：

```javascript
{
  "1189673984225873": ["team_a", "team_b"],
  "1247700201749799": ["team_a"]
}
```

删除 Token 时必须重新计算所有 Token 的专页权限并做并集：

- 如果被删除 Token 是某专页唯一权限来源，删除或禁用该专页；
- 如果其他 Token 仍有该专页权限，必须保留专页；
- 不能简单按照“删除 Token 关联的 pageId”批量删专页。

### 5.3 故障切换

只在确定是权限问题时尝试下一个 Token：

- HTTP 401；
- HTTP 403；
- 响应明确包含 Token 过期、无权限、Forbidden、Unauthorized。

不要因为 400、业务校验错误或 Flow 数据错误而切换 Token，否则会把真实模板问题伪装成权限问题。

伪代码：

```javascript
function withPageToken(pageId, task) {
  var aliases = getPageTokenAliases(pageId);
  if (!aliases.length) throw new Error("专页没有可用 Token：" + pageId);

  var lastError;
  for (var i = 0; i < aliases.length; i++) {
    var token = readToken(aliases[i]);
    try {
      return task(token, aliases[i]);
    } catch (error) {
      lastError = error;
      if (!isTokenAccessError(error) || i === aliases.length - 1) throw error;
    }
  }
  throw lastError;
}
```

对于多步骤写操作，Token 一旦通过第一步权限验证，整个事务尽量固定使用同一个 Token。不要每一步重新选择 Token，否则中途切换可能造成重复创建。

---

## 6. 通用 Botcake HTTP 客户端

基础 URL：

```text
https://botcake.io
```

认证方式：

```text
?access_token={URL 编码后的 Token}
```

Apps Script 示例：

```javascript
function botcakeRequest(path, token, options) {
  options = options || {};
  var separator = path.indexOf("?") >= 0 ? "&" : "?";
  var url = "https://botcake.io" + path
    + separator + "access_token=" + encodeURIComponent(token);

  var request = {
    method: options.method || "get",
    muteHttpExceptions: true,
    followRedirects: false,
    headers: options.headers || {}
  };
  if (options.payload !== undefined) request.payload = options.payload;

  var response = UrlFetchApp.fetch(url, request);
  var status = response.getResponseCode();
  var text = response.getContentText();
  var body;
  try { body = text ? JSON.parse(text) : {}; }
  catch (_) { body = text; }

  if (status < 200 || status >= 300) {
    throw makeBotcakeError(status, sanitizeResponse(body));
  }
  return body;
}
```

### 6.1 重试规则

读取请求：

- 网络错误、429、500、502、503、504 可以最多重试一次；
- 优先尊重 `Retry-After`；
- 没有该响应头时使用带随机抖动的短退避；
- 超过一次后记录失败，让下一轮定时任务再处理。

写入请求：

- 默认不自动重试；
- 因为响应丢失时，服务器可能已经成功创建变量、标签、关键词或 Flow；
- 重试前必须先通过 GET 回读，确认目标不存在或写入没有生效；
- 所有创建操作采用“按名称确保存在”或客户端幂等键思路。

### 6.2 成功判定

不能只判断 HTTP 200。还要检查：

```javascript
if (body && body.success === false) {
  throw new Error("Botcake 返回 success=false");
}
```

关键写操作完成后继续 GET 回读验证。Botcake 个别接口可能返回 `success: true`，但实际绑定没有持久化。

---

## 7. 用 Token 扫描有权限专页

当前按顺序尝试：

```text
GET /api/v1/users/pages_by_platform_on_pancake
GET /api/v1/pages
```

两个接口的返回外壳可能不同，解析器不能只认一个固定顶层字段。可递归扫描对象，识别包含下列字段的记录：

- ID：`page_id`、`pageId`、`id`；
- 名称：`page_name`、`pageName`、`name`、`title`；
- 专页标记：`platform`、`role_in_page`、`page_ids` 等；
- 头像：`avatar_url`、`avatarUrl`、`picture.url`、`image_url` 等。

Instagram 接口有时使用 `igo_{id}`，保存展示 ID 时去掉 `igo_`，调用部分 Instagram 专页接口时再按平台补回。

每次扫描 Token 后保存该 Token 的完整专页快照，不要只增量追加。这样 Token 权限被撤销后才能正确移除旧专页。

---

## 8. 批量读取 100 个专页错误日志

### 8.1 接口

```text
GET /api/v1/pages/{pageId}/logs?access_token={token}
```

目前没有确认到一次提交多个 `pageId` 的 Botcake 批量日志接口。因此 100 个专页底层仍需要最多 100 次 HTTP 请求。

可能的响应数组字段：

```text
page_logs
logs
data
```

插件当前标准化字段：

```javascript
{
  id: row.id,
  code: String(row.code || "-"),
  subcode: String(row.subcode || "-"),
  description: String(row.description || row.message || "未知错误"),
  count: Math.max(0, Number(row.count || 0)),
  updatedAt: String(row.updated_at || row.updatedAt || "")
}
```

接口没有已确认的日期过滤参数。当前产品只显示最近三天，所以必须在脚本端按 `updatedAt` 过滤。

### 8.2 不要沿用插件的 12 专页限制

插件引流看板为了控制流量，把统计选择限制为 12 个专页。Google Sheet 的全量错误日志任务应独立设计，不要复用这个限制。

### 8.3 推荐批处理方式

不要一次 `fetchAll()` 100 个请求。建议每批 10–20 个专页：

1. 从 `专页配置` 读取 enabled 专页；
2. 从 Script Properties 读取本轮游标；
3. 取下一批 10–20 个专页；
4. 按首选 Token 构造 `UrlFetchApp.fetchAll()`；
5. 逐响应解析；
6. 对 401/403 的专页单独使用第二候选 Token；
7. 对 429/5xx 的读取请求最多再试一次；
8. 批量 upsert 到 `错误日志`；
9. 写入游标和本批执行记录；
10. 到达末尾后将游标归零并记录完整轮次完成。

`fetchAll()` 的响应顺序与请求顺序对应，必须在请求对象旁保存 `pageId`、`pageName`、`tokenAlias`，不能仅凭返回内容猜专页。

### 8.4 失败隔离

一页失败不能让整批抛出并停止。结果结构建议：

```javascript
{
  pageId: "1189673984225873",
  status: "SUCCESS", // SUCCESS / DENIED / RETRY / FAILED
  rows: [],
  error: "",
  elapsedMs: 842
}
```

如果本轮 100 页中 3 页失败，其余 97 页仍应写入。失败页保留旧日志，并在 `执行记录` 标记为 stale，下一次优先重试。

### 8.5 缓存

错误日志按专页缓存 10 分钟。Apps Script 可以把 `lastFetchedAt` 写入配置或状态表：

- 未过期：跳过网络请求；
- 过期：后台刷新；
- 刷新失败：保留旧数据并标记 stale；
- 手动强制刷新：忽略 TTL。

---

## 9. 读取专页完整自动化状态

建议并行或分步读取：

```text
GET /api/v1/pages/{pageId}/settings
GET /api/v1/pages/{pageId}/settings/comment
GET /api/v1/pages/{pageId}/get_contents?type=default
GET /api/v1/pages/{pageId}/get_contents?type=welcome
GET /api/v1/pages/{pageId}/bot_field
```

输出统一状态：

```javascript
{
  pageId: "...",
  timezone: 8,
  targetCountryCodes: ["95"],
  comment: { /* 评论开关和回复 */ },
  defaultPrivateReply: { id: "...", name: "..." },
  defaultReply: { id: "...", name: "..." },
  welcome: { enabled: true, flow: { id: "...", name: "..." } },
  botFields: []
}
```

用于写入前快照、差异判断和写入后验证。

---

## 10. 更新专页设置

### 10.1 简单布尔设置

接口：

```text
POST /api/v1/pages/{pageId}/settings
Content-Type: application/x-www-form-urlencoded 或 multipart/form-data
```

表单字段：

```text
changes[{key}] = true 或 false
```

当前映射：

| 功能 | Botcake key |
|---|---|
| 评论自动回复 | `auto_reply_comment` |
| 评论自动私信 | `inbox_from_comment` |
| 优先单帖设置 | `prioritize_auto_reply_with_setup_of_each_post` |
| 仅按指定帖子设置 | `only_reply_post_config` |
| 专页首次评论 | `only_reply_first_comment` |
| 每篇帖子首次评论 | `inbox_first_comment_post` |
| 仅一级评论 | `only_track_first_level_comment` |
| 群组帖子评论 | `auto_comment_in_group` |
| 自动点赞评论 | `auto_like_comment` |
| 忽略养号账号 | `no_auto_inb_fr_cmt_seeding` |
| 欢迎信息启用 | `is_started` |
| 默认回复使用 AI | `is_using_ai_for_default_reply` |
| 默认回复发布 | `is_published` |

`only_reply_first_comment` 和 `inbox_first_comment_post` 互斥。如果要从 A 切换到 B，先关闭 A，确认成功后再开启 B。

### 10.2 时区

```text
POST /api/v1/pages/{pageId}/change_timezone
timezone = "8.0"
```

Botcake 需要下拉框选项格式，例如 UTC+8 使用字符串 `"8.0"`，不要提交 `"8"`。

### 10.3 目标地区

目标地区位于 `settings.webform_setting.country`，不是安全的独立字段。更新步骤：

1. GET `/settings`；
2. 解析完整 `webform_setting`；
3. 只替换其中的 `country`；
4. 将其他字段原样带回。

表单：

```text
changes = general_webform
is_country_code = true
is_admin = false
is_add_actions = false
is_webform = false
webform_setting = {完整 JSON 字符串}
```

禁止构造只有 `country` 的新对象，否则可能覆盖用户的其他 WebForm 设置。

### 10.4 评论回复

接口：

```text
POST /api/v1/pages/{pageId}/settings/comment
changes = {JSON 字符串}
```

回复结构：

```json
{
  "text": "{{user_full_name}} 感谢留言",
  "images": [],
  "commentLevel2": "可选的二级回复",
  "imagesLv2": []
}
```

只想更新 `data_comments` 时，也必须从当前设置中保留并回传这些关联字段：

```text
keywords
hide_comment_keyword
time_ranges
action_mention
data_has_phone
data_has_mentions
data_phone_customer
data_live_comment
cmt_add_actions
use_ai_for_default_cmt
selected_agent_default_cmt
```

否则可能清空手机号、提及、直播、AI 或 Bot action 等其他评论配置。

---

## 11. Flow 替换的核心原则

### 11.1 不要把源 Flow 整体覆盖到目标专页

源模板包含源专页的 Flow ID、变量 ID、标签 ID 和素材引用。直接提交会产生 500、找不到标签、变量错位或修改错误 Flow。

正确步骤：

1. 读取目标 Flow 完整对象；
2. 保存目标 Flow 快照；
3. 读取源模板；
4. 用目标专页变量 ID、标签 ID 和素材替换依赖；
5. 保留目标 Flow 的身份外壳；
6. 将模板节点写入目标 Flow；
7. 保存；
8. 回读验证。

必须从目标 Flow 保留的字段至少包括：

```text
id
name
path
is_published
is_locked
published_at
drafted_at
status
```

目标 `post.id` 必须使用目标 Flow ID，不能使用模板来源 Flow ID。

### 11.2 保存 Flow

```text
POST /api/v1/pages/{pageId}/save_contents
```

表单字段：

```text
post = {完整 Flow JSON 字符串}
is_preview = false
name = 目标 Flow 名称
is_preview_published = false
selected_tab = content
```

写接口不要盲目自动重试。失败或超时后先 GET 回读目标 Flow，比较入口节点、节点数量或模板版本标记，再决定是否需要重试。

### 11.3 备份

写入前至少保存：

- pageId；
- flowId；
- kind；
- name；
- 完整 post；
- selectedTab；
- isPreview；
- isPreviewPublished；
- capturedAt。

备份可写入 Drive 的专用文件夹，文件名使用 `pageId-flowId-timestamp.json`。不要把完整 Flow JSON 塞进单个表格单元格。

---

## 12. 评论私信 Flow

### 12.1 读取已有 Flow

```text
GET /api/v1/pages/{pageId}/settings/comment
```

返回中按顺序兼容：

```text
private_replies
privateReplies
result.private_replies
settings.private_replies
```

第一条默认私信记录目前包含 `id`、`name`、`blocks`、`drafts`，可以作为目标 Flow 外壳和备份。

### 12.2 缺失时创建

```text
POST /api/v1/pages/{pageId}/create_private_reply?for_case=1
post = {最小私信 Flow JSON}
```

读取返回的 `reply_id` 或 `id`，把它写入最小 Flow 的 `post.id`，然后调用 `/save_contents` 完成命名和保存。

如需要开启评论自动私信：

```text
POST /settings
changes[inbox_from_comment] = true
```

警告：现有插件的失败回滚使用：

```text
DELETE /api/v1/pages/{pageId}/private_replies?for_case=1
```

该删除接口没有在 URL 中显式携带 Flow ID。GAS 版本上线前必须确认它只删除本次新建的默认记录，不能未经验证就在生产批量任务中调用。

---

## 13. 默认回复 Flow

读取：

```text
GET /api/v1/pages/{pageId}/get_contents?type=default
```

缺失时创建：

```text
POST /api/v1/pages/{pageId}/create_contents
post = {"blocks": [...], "drafts": {"blocks": [...]}, "config": {}, "name": "默认回复"}
type = default
```

创建后必须重新 GET `type=default` 取得服务器生成的 Flow ID，再通过 `/save_contents` 写入编译后的 Flow。

完成后：

```text
changes[is_using_ai_for_default_reply] = false
changes[is_published] = true
```

顺序应先关闭 AI，再发布普通默认回复，避免中间状态启用错误模式。

---

## 14. 欢迎信息 Flow

读取：

```text
GET /api/v1/pages/{pageId}/get_contents?type=welcome
```

把欢迎信息绑定到已有评论私信 Flow：

```text
POST /api/v1/pages/{pageId}/replace
type = welcomes
flow_id = {评论私信 Flow ID}
```

然后开启：

```text
POST /settings
changes[is_started] = true
```

当前产品设计让欢迎信息和评论私信引用同一个 Flow ID，不复制出第二份 Flow。

---

## 15. 关键词 Flow

关键词 Flow 是最需要回读校验的链路。

### 15.1 读取 Customer 关键词

```text
GET /api/v1/pages/{pageId}/keywords
    ?for_page=false
    &for_comment=false
    &page_size=100
    &page={n}
```

按页读取，直到短页。按名称查找时：

- 无同名：创建；
- 只有一个：复用；
- 多个同名：停止并要求人工整理，不能随便选。

### 15.2 创建关键词规则

```text
POST /api/v1/pages/{pageId}/keywords
changes = {...}
```

推荐 `changes`：

```json
{
  "keyword_type": 2,
  "content": {
    "is_content": ["关键词1", "关键词2"],
    "not_content": [],
    "contents": [],
    "are_content": [],
    "rates": []
  },
  "name": "",
  "coordinate": { "coordinateX": 100, "coordinateY": 100 },
  "config": {
    "add_actions": [],
    "after_type": "immediately",
    "after": 1
  },
  "is_activated": false,
  "for_page": false
}
```

`keyword_type=2` 表示“包含任一关键词”。不要额外发送未经验证的 `for_comment=false` 创建字段；Botcake 曾出现返回成功但规则没有进入可编辑列表的情况。

### 15.3 查找或创建普通 Flow

列表：

```text
POST /api/v1/pages/{pageId}/flow?page_size=100&page={n}
change = {"path":null,"isRemoved":false}
```

创建：

```text
POST /api/v1/pages/{pageId}/flow/create
changes = {"name":"流程名","contents":[],"path":[],"blocks":[]}
```

先通过 `/save_contents` 保存完整 Flow，再做关键词绑定。

### 15.4 更新、绑定、启用

更新关键词内容：

```text
POST /api/v1/pages/{pageId}/keywords/{keywordId}/update
keyword_id = {keywordId}
keyword_type = 2
content = {关键词内容 JSON}
```

绑定 Flow：

```text
POST /api/v1/pages/{pageId}/keywords/add_flow
keyword_id = {keywordId}
flow_id = {flowId}
```

启用：

```text
POST /api/v1/pages/{pageId}/keywords/{keywordId}
keyword_id = {keywordId}
is_activated = false
```

这里的 `is_activated=false` 是 Botcake 当前接口的“提交当前状态并由服务器切换”行为，不是直观的目标值。上线前必须重新验证，不能擅自改成 `true`。

### 15.5 强制回读校验

绑定和启用后重新读取关键词列表，最多做一次短延迟回读，确认：

- 关键词记录仍存在；
- `flow_id` 等于目标 Flow ID；
- `keyword_type` 等于 2；
- `is_activated` 为真；
- `content.is_content` 与预期词集合一致。

任何一项不符都应把任务标记为失败。不能仅相信写接口的 `success: true`。

---

## 16. 机器人变量

读取：

```text
GET /api/v1/pages/{pageId}/bot_field
```

处理语义应为“按名称忽略大小写确保存在”：

1. 活跃变量中有同名：复用，不修改类型和默认值；
2. 归档变量中有同名：恢复；
3. 完全不存在：创建。

恢复：

```text
POST /api/v1/pages/{pageId}/bot_field/archive
changes = {"is_archive":false,"field_ids":[变量ID]}
```

创建：

```text
POST /api/v1/pages/{pageId}/bot_field
field = {
  "name":"变量名",
  "type":"string",
  "value":"",
  "description":"",
  "folder_id":null
}
path = /{pageId}/home
```

Flow 中变量引用形态：

```text
{{源变量ID/|变量名称}}
```

迁移时按变量名称找到目标 ID，替换为：

```text
{{目标变量ID/|变量名称}}
```

不能保留源专页变量 ID。

---

## 17. 标签

读取：

```text
GET /api/v1/pages/{pageId}/tags
```

按名称忽略大小写匹配。不存在时创建：

```text
POST /api/v1/pages/{pageId}/tags
```

创建表单的具体兼容字段应直接复用插件 [src/core/botcake-tags.ts](../src/core/botcake-tags.ts) 中的 `buildCreateBotcakeTagForm()` 逻辑转换为 Apps Script 对象。

当前限制：标签名不能超过 20 个字符。

Flow 中至少有两类标签引用需要替换：

- Action 节点中的 `add_tag`、`remove_tag` 的 `action_id`；
- 条件对象 `type=tags` 中的 `tags[].tag_id` 和 `label`。

源标签 ID 必须映射为目标专页标签 ID。

---

## 18. 素材上传与替换

接口：

```text
POST /api/v1/pages/{pageId}/contents
    ?is_reusable=true
    &upload_type={image|audio|video|file}
```

multipart 字段：

```text
name
file
upload_type
length
```

Apps Script 中 `file` 使用 `Blob`：

```javascript
var blob = DriveApp.getFileById(fileId).getBlob().setName(fileName);
var payload = {
  name: fileName,
  file: blob,
  upload_type: mediaKind,
  length: String(blob.getBytes().length)
};
```

上传成功后兼容解析：

```text
result
data
{kind}_data
content_url / url
content_preview_url / preview_url
content_id / fb_id
```

如果响应没有 URL、content ID 或 fb_id，应视为失败，不能把空对象写进 Flow。

素材可能显著消耗 Apps Script 时间和流量。批量 100 页替换时建议：

- 先完成变量和标签准备；
- 每次任务只处理少量专页；
- 同一专页、同一模板、同一素材在一次执行内复用上传结果；
- 不要假设跨专页可以共用 Botcake 素材 ID；
- 大视频优先由插件处理，GAS 版本先支持小图片和小文件。

---

## 19. 客户引流数据（可选迁移）

现有 [botcake-google-apps-script.gs](../botcake-google-apps-script.gs) 已实现客户数据同步，可直接复用。

接口：

```text
POST /api/v1/pages/{pageId}/customers?page_size=100&page={n}
```

过滤字段：

```text
filter[0][type] = last_subscribed
filter[0][filter_type] = ranger
filter[0][unit] = hour 或 day
filter[0][start_date] = Unix 秒
filter[0][end_date] = Unix 秒
```

服务端区间按闭区间处理，结束时间建议使用“结束日期下一天零点减 1 秒”。优先使用响应中的 `total_entries` 计算页数；不存在时读取到短页，并防止接口忽略 page 参数导致相同页无限循环。

---

## 20. Flow 模板处理

插件模板格式为 ZIP，至少包含 Flow JSON、输入定义和依赖描述。GAS 可以采用两条路线：

### 路线 A：复用插件 ZIP 格式

优点是与插件资源控制台兼容。Apps Script 使用 `Utilities.unzip()` 读取。

安全限制：

- 解压前检查 ZIP Blob 大小；
- 限制条目数量；
- 解压后累计所有条目大小，超过上限立即拒绝；
- 拒绝绝对路径、`..`、反斜杠路径穿越和异常文件名；
- 限制单文件大小；
- JSON 解析后验证 `format`、`version`、`flow.post`、入口节点和依赖结构；
- 不把 ZIP 内文件名直接作为 Drive 写入路径。

### 路线 B：为 GAS 建立展开后的 Drive 模板目录

每个模板一个 Drive 文件夹：

```text
manifest.json
flow.json
assets/...
```

实现更简单，也更适合 Apps Script，但要维护与插件 ZIP 格式之间的转换工具。

无论哪条路线，最终都必须执行：文本输入替换、目标 Flow 外壳保留、变量 ID 映射、标签 ID 映射、素材上传和入口节点恢复。

---

## 21. 批量更新设置或 Flow

建议一条专页一个 Job，不要把“100 个专页全部更新”视为一个不可拆事务。

单专页 Flow Job 阶段：

```text
VALIDATE_TOKEN
READ_TARGET
BACKUP_TARGET
PREPARE_BOT_FIELDS
PREPARE_TAGS
UPLOAD_MEDIA
COMPILE_FLOW
SAVE_FLOW
COMPLETE_BINDING
VERIFY
SUCCESS
```

把 `stage` 写入任务队列。脚本因执行时间退出后，下次可以从安全阶段继续。

写入阶段的恢复规则：

- 变量/标签：重新按名称读取，存在即复用；
- Flow 创建：重新按目标类型或名称读取，避免重复创建；
- 素材：可接受少量孤立上传，但不要重复写 Flow；
- `/save_contents`：超时后先回读比较，再决定是否重试；
- 关键词绑定：始终回读验证；
- 备份：同一 jobId 只创建一次。

---

## 22. 定时器、锁和游标

入口示例：

```javascript
function scheduledRunner() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    runPendingJobsWithinBudget();
  } finally {
    lock.releaseLock();
  }
}
```

`runPendingJobsWithinBudget()` 应记录开始时间，在接近安全执行预算时停止领取新任务，保存游标后正常退出。不要依赖运行到平台强制终止。

推荐把以下信息放入 Script Properties：

```text
LOG_SYNC_CURSOR
LAST_FULL_LOG_SYNC_AT
ACTIVE_JOB_CURSOR
BOTCAKE_TOKEN_{alias}
```

大量日志、Flow 备份和执行历史不要放 Properties，应写入表格或 Drive。

---

## 23. 日志、隐私和安全

必须遵守：

- 不输出完整 Token；
- URL 日志必须移除 `access_token`；
- 最多记录 Token 别名、长度和末四位；
- Web App 如果提供管理入口，必须验证调用者身份；
- 不把 Token 作为 Web App query 参数；
- 不允许普通表格公式直接触发写 Botcake 的自定义函数；
- 写操作只允许菜单、受控按钮或任务队列触发；
- 批量写 Flow 前必须有 dry-run；
- 默认只处理明确勾选的专页；
- 保存写前备份和写后验证结果。

如果表格需要共享给只读用户，应把 Apps Script 项目和 Token 管理权限与普通查看权限分开。

---

## 24. 推荐开发顺序

### 第一阶段：只读闭环

1. Token 属性管理；
2. Token 扫描专页；
3. 5 个测试专页错误日志；
4. 扩展到 100 个专页的分批、游标、缓存和失败隔离；
5. 读取完整专页状态；
6. 脱敏审计日志。

### 第二阶段：低风险设置写入

1. 用同值写入一个布尔开关；
2. 回读验证；
3. 时区同值写入；
4. 评论回复完整字段回写；
5. 测试互斥开关切换与恢复；
6. 批量任务 dry-run。

### 第三阶段：依赖管理

1. 读取变量、标签；
2. 创建测试变量和标签；
3. 验证重复运行不重复创建；
4. 测试归档变量恢复；
5. 小图片素材上传。

### 第四阶段：Flow

1. 同一个 Flow 原样保存并回读；
2. 评论私信 Flow 替换；
3. 欢迎信息绑定；
4. 默认回复 Flow；
5. 关键词 Flow；
6. 失败恢复和批量队列。

不要一开始就在 100 个生产专页上测试写操作。

---

## 25. 最低验收清单

### Token 与目录

- 一个 Token 扫描全部权限专页；
- 两个 Token 权限取并集；
- 两个 Token 同时拥有一个专页时不重复；
- 删除一个 Token 后，重叠专页仍保留；
- 401/403 自动尝试下一个候选 Token；
- Token 不出现在日志和表格。

### 错误日志

- 5、20、100 个专页分批完成；
- 单页失败不阻塞整批；
- 最近三天过滤正确；
- 相同日志 upsert 而非重复追加；
- 10 分钟缓存和强制刷新正确；
- 429/5xx 只做有限读取重试。

### 设置

- 同值运行不产生多余写请求；
- 互斥开关没有非法中间状态；
- 评论二级回复和图片不丢失；
- 目标地区更新不覆盖其他 `webform_setting`；
- 写入后回读一致。

### Flow

- 目标 Flow ID 不被源 Flow ID 覆盖；
- 变量和标签映射到目标专页 ID；
- 素材上传结果有效；
- 写前备份可恢复；
- 评论、默认回复、欢迎信息、关键词分别完成；
- 关键词绑定和启用回读一致；
- 超时不会盲目重复创建。

---

## 26. 插件代码参考位置

| 能力 | 参考文件 |
|---|---|
| Token-only 专页设置与 Flow 操作 | [src/scopes/background/botcake-operations.ts](../src/scopes/background/botcake-operations.ts) |
| 专页目录、日志、客户统计、并发队列 | [src/scopes/background/analytics.ts](../src/scopes/background/analytics.ts) |
| 多 Token 合并和故障切换 | [src/core/analytics-token-management.ts](../src/core/analytics-token-management.ts) |
| Token 持久化模型 | [src/scopes/background/analytics-token-vault.ts](../src/scopes/background/analytics-token-vault.ts) |
| Flow 编译、目标外壳、变量/标签/素材映射 | [src/core/compiler.ts](../src/core/compiler.ts) |
| ZIP 解析和安全限制 | [src/core/archive.ts](../src/core/archive.ts) |
| 标签创建表单 | [src/core/botcake-tags.ts](../src/core/botcake-tags.ts) |
| 时区转换 | [src/core/botcake-timezone.ts](../src/core/botcake-timezone.ts) |
| 设置模板结构 | [src/core/page-settings-template.ts](../src/core/page-settings-template.ts) |
| 现有 Google Apps Script 客户同步 | [botcake-google-apps-script.gs](../botcake-google-apps-script.gs) |
| 既有接口笔记 | [docs/BOTCAKE_AUTOMATION.md](BOTCAKE_AUTOMATION.md) |

新窗口开发时应优先移植这些文件中的业务规则，而不是从 UI 组件反推接口。
