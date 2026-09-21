# Botcake 专页自动化接口笔记

本文记录 2026-08-18 至 2026-09-02 通过真实操作验证的接口，供插件实现和回归测试使用。专页助手的设置和流程应用已迁移到扩展后台，只依赖加密 Token、专页 ID 和目标资源，不再要求进入目标 Flow 页面。

2026-09-02 已验证以下请求在 `credentials: omit`、完全不带 Botcake Cookie 时仍可工作：

- `GET /api/v1/pages/{pageId}/settings`：读取完整专页设置。
- `GET /api/v1/pages/{pageId}/settings/comment`：读取评论私信 Flow ID、`blocks` 和 `drafts`。
- `POST /api/v1/pages/{pageId}/save_contents`：直接替换指定 Flow。
- `POST /api/v1/pages/{pageId}/settings`：写入专页设置。
- `GET /api/v1/pages/{pageId}/bot_field` 和 `/tags`：读取变量与标签。

Token 由后台按专页选择，优先使用 Token 管理中明确授权该专页的 Token，再尝试当前账号 Token；401/403 权限错误会切换同一专页的下一个候选 Token。日志和界面不得显示完整 Token。

## 当前支持范围

- 默认评论回复开关与批量回复内容
- 默认评论私信开关
- 默认评论私信 Flow 的识别、缺失时创建及命名
- 欢迎信息绑定到默认评论私信 Flow 并开启
- 评论相关的常用开关
- 时区
- 目标地区
- 机器人变量按名称批量确保存在

暂不处理手机号、提及、直播对应的专用 Flow。

## 设置模板与使用流程

专页设置模板使用独立的 `botcake-page-settings-template` JSON 格式，包含：

- 一级评论回复及常用评论开关
- 时区和目标地区
- 需要确保存在的机器人变量

模板明确不包含默认评论私信 Flow、欢迎信息 Flow，也不包含 `Auto-inbox`。悬浮专页助手提供三个互相独立的主动作：

1. `一键设置专页`：应用设置 JSON，并按名称创建缺失的机器人变量。
2. `应用评论私信流程`：通过专页 ID 自动识别 Flow；缺失时创建名为“评论”的 Flow 并开启 Auto-inbox，然后在后台直接替换。
3. `同步欢迎信息流程`：把欢迎信息直接绑定到同一个评论私信 Flow 并开启，全程不跳转 Flow 页面。

低频操作（导出当前设置、重新读取）放在更多菜单。设置模板可以直接保存为公开 Google Drive JSON 文件，Google 表格只作为模板目录，记录预设名称和公开文件链接。

当前悬浮助手只处理当前专页。后续多专页批量管理将使用独立扩展页面，复用同一个后台 Token 操作服务，不把复杂的专页选择、权限状态和执行报告塞进悬浮窗。

## 评论设置

常用开关通过 `POST /api/v1/pages/{pageId}/settings` 保存，表单字段为 `changes[{key}]`。

当前映射：

- `auto_reply_comment`：评论自动回复
- `inbox_from_comment`：评论自动私信
- `prioritize_auto_reply_with_setup_of_each_post`：优先使用单帖设置
- `only_reply_post_config`：仅按指定帖子设置回复
- `only_reply_first_comment`：每位客户只在专页首次评论时回复
- `inbox_first_comment_post`：每位客户在每篇帖子首次评论时回复
- `only_track_first_level_comment`：只处理一级评论
- `auto_comment_in_group`：群组帖子评论也进入处理
- `auto_like_comment`：自动点赞评论
- `no_auto_inb_fr_cmt_seeding`：忽略养号账号评论私信

`only_reply_first_comment` 与 `inbox_first_comment_post` 是互斥项。模板会同时备份这两个值；恢复时先关闭原来的选项，再开启目标选项，避免产生两个开关同时开启的中间状态。

批量评论回复通过 `POST /api/v1/pages/{pageId}/settings/comment` 保存，表单字段 `changes` 是 JSON。回复项结构为：

```json
{
  "text": "{{user_full_name}} 感谢留言",
  "images": [],
  "commentLevel2": "可选的二级回复",
  "imagesLv2": []
}
```

普通批量输入采用“每个非空行是一条回复”的方式，转换时直接构造对象再 `JSON.stringify`，不手工拼 JSON 字符串。这样引号、反斜杠、缅甸语和 Emoji 都能正确转义。高级模式仍可直接编辑完整回复 JSON，以支持二级回复和图片。

保存时必须同时带回 Botcake 要求的其他评论配置字段；插件只替换 `data_comments`，手机号、提及和直播数据原样保留。

## 默认评论私信 Flow

创建顺序已经通过“创建 → 改名 → 读取验证 → 删除”闭环验证：

1. `POST /api/v1/pages/{pageId}/create_private_reply?for_case=1`
2. 使用返回的 `reply_id` 调用 `POST /api/v1/pages/{pageId}/save_contents`
3. 将 Flow 名称保存为 `评论`
4. 如需要，再把 `inbox_from_comment` 设置为 `true`

创建前必须先读取 `/settings/comment`。已经存在默认 `private_replies` 时只复用，不重复创建。创建或保存失败时，对本次新建记录执行回滚删除。

## 欢迎信息 Flow

- 读取：`GET /api/v1/pages/{pageId}/get_contents?type=welcome`
- 绑定现有 Flow：`POST /api/v1/pages/{pageId}/replace`，字段为 `type=welcomes` 和 `flow_id`
- 开启欢迎信息：`POST /api/v1/pages/{pageId}/settings`，字段为 `changes[is_started]=true`

插件不复制评论流程，而是让欢迎信息与评论私信引用同一个 Flow ID。这样修改流程后两处会同步，不会形成两份容易漂移的副本。欢迎信息读取接口偶发 500 时进行三次短重试。

## 时区与目标地区

- 时区：`POST /api/v1/pages/{pageId}/change_timezone`，字段 `timezone` 必须使用 Botcake 选项字符串，例如北京时间是 `"8.0"`，不能提交 `"8"`，否则下拉框无法匹配显示名称。模板中仍保存数字，恢复时由插件转换成 Botcake 的选项格式。
- 目标地区不是独立字段。它存储在 `currentSettings.webform_setting.country` 中，值是国家电话区号数组，例如 Myanmar 为 `95`。保存使用页面 `settings` 接口的 `general_webform` 表单结构，并保留整个原 `webform_setting`。

因此修改目标地区时不能新建一个简化对象，否则会覆盖 WebForm 的其他设置。

## 机器人变量

- 读取：`GET /api/v1/pages/{pageId}/bot_field`
- 创建：`POST /api/v1/pages/{pageId}/bot_field`

批量处理采用“按名称（忽略大小写）确保存在”的语义：已有变量不改类型、不改默认值，只有缺失变量才创建，防止覆盖用户已有数据。

## 关键词流程评估

Botcake 提供 `POST /api/v1/pages/{pageId}/keywords/bulk_create`，批量创建关键词本身不复杂；但给每个关键词创建或绑定消息 Flow 还需要逐项调用 `/keywords/{id}/message`，并处理激活状态、关键词类型及现有重名项。

结论：关键词适合作为第二阶段功能。第一阶段先稳定专页设置、评论回复和默认评论私信 Flow；关键词功能采用“批量确保关键词 + 绑定共享模板”的受控模式，不直接照搬所有页面状态。
