# Botcake 流程助手安全审核报告

审核日期：2026 年 10 月 6 日（Asia/Taipei）。基线提交：`edf7f547fd922f65470d849e073004f94ad304c9`，版本 1.0.9。修改留在工作区，未提交、发布或调用真实 Botcake 写接口。

已修复 9 类代码边界问题，升级 source-map-js，并提高 fflate 的安全版本下限。开发者随后授权修复测试工具链漏洞，已升级 Vitest 至 4.1.11、移除 Tinypool，同时修复 mocker 公告。HTTP 通知仍按开发者选择保留，存在明文传输风险。本报告中的“已修复”指代码改动及本地验证完成，真实浏览器和 Google Apps Script 部署回归仍待确认。

## 项目概况与审核范围

| 项目 | 结果 |
| --- | --- |
| 语言 | TypeScript、TSX、JavaScript、Google Apps Script；辅助 Python 和 PowerShell |
| 架构 | Chrome Manifest V3，React 19，Vite 7，CRXJS；Botcake MAIN 注入脚本、隔离内容脚本、扩展后台、popup/options |
| 包管理器 | npm，`package.json`、`package-lock.json`，lockfileVersion 3 |
| 直接依赖 | 18 项：9 项运行依赖、9 项开发依赖 |
| 锁文件 | 231 个非根安装位置，包含平台可选依赖；实际 Windows 安装数量与锁文件数量不同 |
| 项目文件 | 基线 91 个 Git 跟踪文件，其中 `src` 62 个；另检查新增文件和 `dist` 构建产物 |
| 历史凭据范围 | 本地全部可达的 15 个提交，去重后 172 个 blob；不包含远端未抓取、不可达对象或其他仓库 |
| 依赖交叉核对 | 逐项 WebSearch、GitHub 官方公告、npm registry 元数据、`npm audit --json`、OSV 全锁文件版本查询 |

静态扫描覆盖源码、测试、配置、CI、脚本、示例、注释、文档和构建输出；人工重点核对消息入口、数据来源、模板路径、解压、网络、令牌存储、自动应用、表格写入和发布流程。没有后端数据库服务、Electron、移动端或外部上传服务器代码，不能据此确认 Botcake 服务端鉴权、TLS 部署或服务端上传处理。

## 问题汇总

位置为修改后的工作区行号，便于复核。依赖严重级别沿用公告；代码问题结合本项目利用条件定级。“建议关注”也包括开发者已明确决定暂缓修复的项目。

| 编号 | 类别 | 严重级别 | 位置 | 状态 |
| --- | --- | --- | --- | --- |
| D01 | 依赖 | Critical | `package.json:33`；`package-lock.json:3023`，Vitest | 已修复：3.2.7 → 4.1.11，移除 Tinypool |
| D02 | 依赖 | Medium | `package-lock.json:1551`，@vitest/mocker | 已修复：3.2.7 → 4.1.11 |
| D03 | 依赖 | High | `package-lock.json:2773`，source-map-js | 已修复：1.2.1 → 1.2.2 |
| D04 | 依赖 | Medium | `package.json:17`，fflate 版本下限 | 已修复：声明下限提高；原锁定版本已安全 |
| C01 | 代码 | High | `src/scopes/content/pending-flow-apply.ts:7`；`src/scopes/content/App.tsx:141` | 已修复：任务迁移至扩展私有存储 |
| C02 | 代码 | Medium | `src/shared/utils.ts:55`、`:76` | 已修复：原型访问和路径解析边界 |
| C03 | 代码 | Medium | `src/scopes/background/index.ts:82`、`:553` | 已修复：实际下载字节限流及超时 |
| C04 | 代码 | Low | `src/scopes/background/index.ts:55`；`src/scopes/content/index.tsx:14`；`src/scopes/content/bridge.ts:23` | 已修复：消息来源加固 |
| C05 | 代码 | High | `botcake-google-apps-script.gs:186` | 已修复：Google Sheets 公式注入 |
| C06 | 代码 | Medium | `src/scopes/background/botcake-operations.ts:485`；`src/scopes/background/analytics.ts:484`；`src/scopes/injects/botcake-main.entry.ts:1367`；`botcake-google-apps-script.gs:348` | 已修复：凭据请求禁止重定向 |
| C07 | 代码 | Medium | `src/core/security-errors.ts:2`；`botcake-google-apps-script.gs:134`、`:385` | 已修复：令牌错误回显和客户原文日志 |
| C08 | 代码 | Medium | `.github/workflows/release.yml:40` | 已修复：Git 标签 shell 插入 |
| C09 | 代码 | Medium | `.github/workflows/release.yml:18`、`:21`、`:47`、`:52` | 已修复：第三方 Actions 固定提交 |
| K01 | 密钥 | Medium | `botcake-risk-monitor.gs:325`、`:507` | 建议关注：开发者决定保留 HTTP |
| K02 | 密钥 | Low | `src/scopes/background/analytics-token-vault.ts:147` | 建议关注：密文与解密密钥共存 |
| C10 | 代码 | Low | `src/scopes/injects/botcake-main.entry.ts:68`；`src/scopes/content/bridge.ts:31` | 建议关注：MAIN 同源脚本信任边界 |
| C11 | 代码 | Low | `src/scopes/options/TemplateGraphCanvas.tsx:144`；`src/scopes/options/TemplateEditorApp.tsx:550`；`src/scopes/background/index.ts:553` | 建议关注：远程资源请求策略，内网影响待确认 |
| C12 | 代码 | Low | `vite.config.ts:9`；生成的 `dist/manifest.json` | 建议关注：source map 随包发布 |
| D05 | 依赖 | Low | `package.json:14`、`:15` | 建议关注：未使用且低更新频率的 WebExtKits 依赖 |

## 依赖版本与漏洞核对

下面列出全部直接依赖的实际版本；“未命中”仅表示本次 npm/OSV 版本查询未报漏洞，不代表不存在未知漏洞。18 项均已进行包名安全公告 WebSearch；没有可靠命中时不根据第三方评分推断安全或恶意。

| 直接依赖 | 声明版本 | 锁定版本 | 用途 | 本次结果 |
| --- | --- | --- | --- | --- |
| @webextkits/messages-center | ^1.0.1 | 1.0.1 | 运行 | 未命中；源码未使用 |
| @webextkits/storage-local | ^1.0.0 | 1.0.0 | 运行 | 未命中；源码未使用 |
| @xyflow/react | ^12.11.3 | 12.11.3 | 运行 | 未命中 |
| fflate | **^0.8.3** | 0.8.3 | 运行 | 已在 ZIP64 公告修复版本；提高下限 |
| papaparse | ^5.5.3 | 5.6.0 | 运行 | 未命中 |
| react | ^19.1.1 | 19.2.8 | 运行 | 未命中；本项目无 React Server Components |
| react-dom | ^19.1.1 | 19.2.8 | 运行 | 未命中 |
| recharts | ^3.10.1 | 3.10.1 | 运行 | 未命中 |
| zod | ^4.0.17 | 4.4.3 | 运行 | 未命中；CUID 未审阅公告不据此认定本项目受影响 |
| @crxjs/vite-plugin | ^2.7.1 | 2.7.1 | 开发 | 未命中 |
| @types/chrome | ^0.1.4 | 0.1.43 | 开发 | 未命中；类型包 |
| @types/papaparse | ^5.3.16 | 5.5.2 | 开发 | 未命中；类型包 |
| @types/react | ^19.1.10 | 19.2.18 | 开发 | 未命中；类型包 |
| @types/react-dom | ^19.1.7 | 19.2.4 | 开发 | 未命中；类型包 |
| @vitejs/plugin-react | ^5.2.0 | 5.2.0 | 开发 | 未命中；不等同于 plugin-rsc |
| typescript | ^5.9.2 | 5.9.3 | 开发 | 未命中；当前分支维护状态待确认 |
| vite | ^7.3.6 | 7.3.6 | 开发 | 未命中；未配置公网 host / 宽 CORS |
| vitest | **^4.1.11** | **4.1.11** | 开发 | D01、D02 已修复 |

关键间接依赖实际版本：

| 间接依赖 | 实际版本 | 核对结果 |
| --- | --- | --- |
| tinypool | 已移除（原 1.1.1） | 两项 Critical 公告的受影响依赖已不在锁文件或实际安装中 |
| @vitest/mocker | **4.1.11** | 由 3.2.7 升级，路径穿越 / 文件读取公告已修复 |
| source-map-js | **1.2.2** | 本次由 1.2.1 升级 |
| rollup | 4.62.4 | 本次版本查询未命中 |
| esbuild | 0.28.2 | 本次版本查询未命中 |
| postcss | 8.5.26 | 本次版本查询未命中 |
| @babel/core | 7.29.7 | 本次版本查询未命中；高于官方文件读取修复版本 7.29.6 |
| picomatch | 4.0.5 | 本次版本查询未命中 |
| nanoid | 3.3.18 | 本次版本查询未命中 |

全部锁文件条目、integrity 和开发/可选标记见 `docs/security-audit/dependency-inventory.json`；OSV 实际查询结果见 `osv-results.json`，npm 原始结果见 `npm-audit-after.json`。

### D01 测试工作池的原型污染利用链

tinypool 1.1.1 受两项公告影响：构造 worker 时继承 `execArgv` / `env`，修复于 2.1.1；`run()` options 继承 `filename`，修复于 2.1.2。因此同时覆盖两项公告需要 **tinypool ≥2.1.2**。[构造 worker 公告](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)、[run options 公告](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)。

原项目 `npm test` 使用 Vitest 3 的工作池，确实加载该间接依赖。利用仍需测试进程内先出现原型污染，并存在攻击者可加载的模块或相应选项控制；未确认本项目有从线上用户输入直接触发测试进程 RCE 的路径。浏览器扩展运行时不打包 Vitest/Tinypool，也不能把浏览器内路径问题直接等同于 Node 测试进程中的污染。

开发者随后授权修复，已将 `package.json` 的 Vitest 下限从 `^3.2.4` 提高至 `^4.1.11`，重新生成锁文件并安装。Vitest 4.1.11 不依赖 Tinypool；最终锁文件检索、`npm ls --all`、npm audit 和 OSV 查询共同确认受影响包已移除。没有使用跨主版本 Tinypool override。

选择 4.1.11 是为了同时修复 D01/D02，并兼容现有 Vite 7.3.6 和 CI Node 20；registry engines 为 `^20.0.0 || ^22.0.0 || >=24.0.0`。Vitest 5.0.3 要求 Node 22.12+，本次不连带改变 CI Node 版本。[Vitest 4.1.11 元数据](https://registry.npmjs.org/vitest/4.1.11)、[Vitest 5 迁移要求](https://vitest.dev/guide/migration/)。96 个现有测试无需改写即通过，业务源码没有因该依赖升级修改；本地验证使用 Node 24.13.0，GitHub 的 Node 20 job 尚未实际运行。

### D02 mocker 路径穿越

@vitest/mocker 与 Vitest 3.2.7 命中 GHSA-82fw-gwwq-j7x9；修复版本为 4.1.11，稳定 5.x 亦包含修复。公告确认 3.x 不计划回移此修复。[官方公告](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)。

远程利用的主要入口是第三方开发服务器公开注册的 mockerPlugin/interceptorPlugin WebSocket。当前只使用 `vitest run` / `vitest`，未发现公开加载上述插件或配置 browser mode 的代码；受影响功能的远程可达性未确认。已随 D01 升级至 Vitest / @vitest/mocker 4.1.11，达到官方修复版本，npm/OSV 均不再命中。

### D03 source-map-js 拒绝服务

source-map-js 1.2.1 对 indexed source map 的 section offset 校验不足；巨大偏移可能长时间阻塞事件循环，官方修复版本 **1.2.2**。[公告](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)。

本项目通过构建工具链安装它，存在处理 source map 的功能；攻击者还需能影响构建输入中的 source map。模板 ZIP 不会作为 Vite/PostCSS source map 编译，未确认有线上模板直达此 sink 的路径。已在原兼容范围内升级，只有该间接包的实际版本发生变化。

### D04 fflate 安全版本下限

原锁文件已为 0.8.3，未命中漏洞；但 `^0.8.2` 声明仍允许有问题的 0.8.2。项目确实使用 `unzipSync` 加载外部 ZIP。已将声明改为 `^0.8.3`，防止使用低于 ZIP64 无限循环修复版本的安装结果。[fflate 官方来源公告](https://github.com/advisories/GHSA-px8p-9vwx-vf98)。这属于版本下限加固，不将已安全的原锁定版本描述为新发现漏洞。

### D05 维护状态与包名

registry 未给这 18 项直接依赖返回 deprecated 标记，未发现可证实的仿冒包。WebExtKits messages-center 最后发布于 2026-02-20；storage-local 最后发布于 2025-11-07，且其安装版本的 registry 元数据没有 repository 字段。两个包均未在 `src` 导入，建议后续移除未使用依赖或补充来源核验；低更新频率和缺少 repository 不等于恶意或停止维护。[messages-center registry](https://registry.npmjs.org/%40webextkits%2Fmessages-center)、[storage-local registry](https://registry.npmjs.org/%40webextkits%2Fstorage-local)。

Vitest 3.x 的上述安全修复不会回移，本次已升级至包含修复的 4.1.11。后续仍需关注 4.x 的维护周期。其他旧主版本的支持周期有待逐个按维护者政策确认，不能用“有新版本”替代“已停止维护”。完整发布时间和来源元数据见 `maintenance.json`。

React 公告需按具体包区分：本项目不包含 react-server-dom-*、Next.js 或 plugin-rsc，不能因使用 React 19 就判断存在 React Server Components RCE。[React 官方说明](https://react.dev/blog/2025/12/11/denial-of-service-and-source-code-exposure-in-react-server-components)。Zod CUID 公告处于未审阅状态，描述涉及 SQL 注入，但项目没有 SQL/CUID 使用，4.4.3 的 OSV/npm 查询也未命中；不扩大为已确认问题。[该公告](https://github.com/advisories/GHSA-hprg-jrj6-qhrw)。

## 已修复的代码问题与利用条件

### C01 网站存储任务导致自动流程篡改

旧实现使用内容脚本的 `indexedDB`，数据属于 Botcake 网站 origin，并通过网站 `sessionStorage` 查找任务。任何能执行在 Botcake 同源页面中的脚本都可伪造数据库记录和指针；`App` 匹配专页/Flow 后使用 `skipConfirm`，可能未经新确认替换流程。目标 ID 相同不构成真实性校验。

按开发者批准，改为扩展后台自己的 `chrome-extension://` IndexedDB：内容脚本通过校验发送者的后台请求保存、读取、删除；记录绑定创建标签页 ID，随机任务 ID、24 小时有效期、结构及体积校验；二进制通过 Base64 避免 Chrome JSON 消息丢失 Uint8Array。写操作等待事务提交。网站仅保留不透明指针，未知 ID 不执行，跨标签页不能读或删。

**升级行为：旧网站数据库任务不迁移，新指针键使旧任务失效，未完成任务需要重新发起。**旧网站数据库中可能仍有历史模板或输入数据；有隐私清理需求时可在 Botcake 网站存储管理中确认并清理该旧数据库。本次没有删除网站存储。当前 `savePendingFlowApply` 未在现有专页助手调用，但旧的自动读取入口仍可被伪造任务触发，因此读取入口也必须修复。

### C02 模板路径访问原型属性

旧 `getByPath` / `setByPath` 接受继承属性和只部分匹配的路径。恶意模板的媒体 configPath 可指向 `__proto__` 等对象，导致读取或替换非模板自身属性；通用 setter 若被传入更深路径还可写原型链。本次未证明正常导入链可直接污染全局 Object.prototype，按 Medium 定级。

修改 `src/shared/utils.ts`：拒绝 `__proto__`、`prototype`、`constructor`（包括引号键），要求完整解析路径，并仅允许沿对象自身属性遍历。保留合法数组索引和带点的引号键。回归测试包含污染路径、部分解析路径和合法读写。

### C03 下载限流不覆盖实际响应

旧限制主要依赖 Content-Length；服务器不提供、伪造头部或返回高膨胀压缩响应时，文本下载及二进制读取可在限制检查前消耗大量内存。利用要求用户加载攻击者控制的资源或资源服务器被控制。

新增 `src/core/remote-download.ts`，流式累计解码后的实际字节，超过现有 30MB 限额即取消读取。fetchText、fetchCatalog、fetchBinary 均采用同一边界，另为下载增加 60 秒请求/响应体超时。未扩大网络权限或改变资源目录类型。

### C04 消息来源加固

旧后台忽略 sender，内容脚本代理忽略 sender，页面桥未核对 origin / 响应 action。已新增同扩展 ID、扩展页面 URL 或 Botcake 顶层内容脚本来源校验；拒绝其他站点、子 frame 和不明后台消息；内容脚本控制消息要求来自本扩展非内容脚本发送者；MAIN 桥和路由消息检查 event.origin，响应同时匹配 requestId 与 action。

Manifest 没有 externally_connectable，也没有 onMessageExternal；普通外部网页不能直接调用该 runtime 消息入口。因此此项主要是防御加固，不能描述成已证实的任意网站令牌窃取。来源校验不意味着同源 MAIN 脚本被隔离，残余风险见 C10。

### C05 客户记录触发 Google Sheets 公式

订阅同步直接把 API 返回的 full_name、source 等写入 setValues。攻击者能影响客户字段时，以 `=` 开头的内容可被解释为公式，包含 IMPORT* 外连函数时可能读取/泄露表格数据。已逐单元格为此类字符串添加文本转义前缀，保留正常字符串和非字符串值。其他日志同步/高危监控脚本原已有对应转义，本次没有重复改动。

新增 `scripts/test-botcake-customer-security.cjs`，在完全本地的 Apps Script VM 中验证姓名和来源公式被转义、客户原文不出现在日志、凭据重定向及错误脱敏。

### C06 凭据请求的自动重定向

三个扩展 Botcake 请求封装和订阅同步脚本旧有自动跟随重定向行为。若 API / 代理被错误配置或控制，可能把请求导向非预期目标；查询令牌不必然被 Fetch 自动复制到 Location，因此跨域令牌实际泄露还取决于重定向内容和目标处理，不能无条件声称已泄露。

已对固定 Botcake API 请求使用 `redirect: "error"`，Apps Script 使用 `followRedirects: false`。资源下载仍跟随 Google Drive 正常下载重定向；它使用 credentials: omit，未附加 Botcake Token。真实部署若存在合法 API 重定向需要回归确认，不应直接恢复跨域凭据跟随。

### C07 错误回显与客户原文日志

旧 API 错误把原始返回内容传给 UI，订阅同步传输异常可能包含带 Token 的完整 URL；缺少客户 ID 的记录还会被完整 JSON 写进 Logger。API / 代理反射令牌或异常包含 URL 时，会扩大令牌、客户信息的可见范围。

新增 `src/core/security-errors.ts`，对错误中的当前 Token、URL 编码形式和常见敏感字段脱敏，限制错误文本至 500 字符；三个扩展请求封装使用它。Apps Script 最终错误移除当前 Token 及编码形式，并将完整客户 JSON 日志改为固定跳过提示。正常 API 返回仍供业务处理，不统一删除业务数据。未验证所有真实服务异常格式，额外自定义凭据字段仍需关注。

### C08 发布标签插入 shell

旧 workflow 在 run 脚本文本中直接嵌入 github.ref_name。创建包含 shell 元字符的 `v*` 标签时，表达式展开可改变命令；利用需要有能力触发标签发布，不是普通 PR 作者可直接利用。

现改为 RELEASE_TAG 环境变量、变量加引号，并在打包前验证发布版本标签格式。标签数据不再作为 shell 源码直接展开。打包产物名称和普通 `v1.0.9` 发布行为保持一致。

### C09 第三方 Action 可变引用

旧 actions/checkout、actions/setup-node、actions/attest-build-provenance、softprops/action-gh-release 使用可移动的 v4/v2 标签。上游标签被移动或供应链被控制时，带发布权限的 job 会执行变化后的代码。

通过各官方仓库 git ls-remote 核对标签对应提交，固定为 40 位 SHA 并保留版本注释。没有擅自跨主版本升级 Action；workflow 未使用 pull_request_target，权限为发布和 attestation 所需，未发现来自 PR 标题/分支正文的 shell 插入路径。

## 密钥与凭据检查

当前文件及本地可达 Git 历史的凭据特征扫描未发现经复核确认的真实硬编码密钥、私钥、数据库密码或私有 Webhook。唯一规则候选 `botcake-risk-monitor.gs:146` 是动态拼接 encodeURIComponent(page.token)，不是密钥字面量；测试中的 fake/test Token、test-key 与文档占位符不当成泄露。

`.gitignore` 已忽略 `.env`、`.env.*`、pem/key/p12/pfx 等，保留 `.env.example` 例外；`git check-ignore --no-index` 验证 `.env`、`.env.production`、sample.pem 被忽略。`git ls-files` 没有跟踪这些凭据文件。忽略规则不会清除历史，但本次可达历史扫描也已覆盖。

扩展现有凭据由运行时 UI、Botcake 登录状态或 Apps Script 参数/文档属性提供，没有确认需要改成 Node 环境变量的硬编码值，因此未添加无消费端的 `.env.example`。Apps Script 不使用 Node process.env；建议把实际 Teams API Key 放在调用者文档属性 BOTCAKE_TEAMS_API_KEY，避免填入共享库源码。

**如实际部署密钥曾被提交、公开分享或通过 HTTP 泄露，必须到对应平台作废并重新生成；只删除代码或 Git 文件不够。**本次没有调用平台接口轮换任何密钥，也没有把真实凭据上传给 WebSearch / OSV；依赖查询只发送公开包名和版本。

### K01 HTTP 明文通知

风险监控可把 x-api-key、专页名称/ID 和日志发送到 HTTP 通知服务；路径上的观察者可读取或篡改请求。严重级别 Medium，利用条件是实际配置使用 HTTP。开发者明确选择保留 HTTP 支持，代码和既有 HTTP 回归用例均保留。

可选方案是给现有服务加 HTTPS 反向代理后改 URL，或继续使用 HTTP 并承担网络路径暴露风险。建议优先部署 HTTPS，再考虑收紧代码；即便内网 HTTP 也不提供传输加密。

### K02 本地令牌库的保护边界

AES-GCM 使用随机 12 字节 IV 和随机 256 位密钥，未发现固定 IV、弱哈希或关闭 TLS 验证。密钥和密文都保存在 chrome.storage.local，能完整读取浏览器扩展存储的本地攻击者可以解密；加密不能作为抵御浏览器配置目录窃取的独立保护。内容脚本也默认可访问 local storage，但普通网站 JavaScript 没有这个 Chrome API 权限。

可考虑仅会话保存、用户口令或把敏感存储限制为 TRUSTED_CONTEXTS 并代理内容脚本的正常设置读取。上述方案涉及持久化、交互或架构取舍，本次不更改，也不把共存问题误报成已经硬编码泄露的密钥。

## 剩余风险与后续建议

### 开发者决定及可选方案

| 项目 | 可选方案与建议 | 本次决定 |
| --- | --- | --- |
| D01 / D02 测试工具链 | 升级至修复版并验证测试、构建和最终依赖树 | 开发者随后授权修复，已升级至 4.1.11，移除 Tinypool；本地验证通过 |
| K01 HTTP 通知 | 保留 HTTP；或加 HTTPS 反向代理后更换通知地址（建议），再收紧代码 | 开发者选择保留 HTTP；风险保留 |
| C01 自动应用任务 | 扩展私有存储（建议）；或保留网站存储但逐次人工确认；或暂缓 | 开发者批准私有存储迁移，已实施；旧未完成任务重发 |
| K02 持久令牌保护 | 保留本地加密；改会话存储；用户口令；或限制敏感存储并代理普通设置读取 | 后续取舍，本次不改变持久化体验 |
| C10 / C11 页面与外连边界 | 后台执行 API、域名白名单或逐资源确认；均需结合真实模板和页面行为验证 | 后续取舍，本次仅加固已有边界 |

### C10 MAIN 同源脚本

window.postMessage 的 origin/source/UUID 能过滤错来源和错响应，不能认证同一个 Botcake 页面内的其他脚本。页面同源 XSS 或被攻陷的脚本能观察请求、调用 MAIN 操作或伪造对应响应；它们通常也已有 Botcake 页面令牌权限。要进一步缩小边界，可把可行操作迁到校验发送者的后台/API 或通过 scripting.executeScript 返回结果；这属于需要单独验证的架构改动。不能把 postMessage 随机 requestId 当成对同源脚本保密的凭证。

### C11 远程资源与外连

host_permissions 列出 7 个 HTTPS 业务域，没有 `<all_urls>`、通配域或 HTTP。scripting、storage、downloads、alarms、clipboardWrite 均有对应用途；内容脚本只注入 Botcake。未发现 CDN / 远程 JavaScript、eval、new Function 或不受控 HTML 注入；analytics-bootstrap 的 innerHTML 是固定字面量。

下载仅校验初始 HTTPS，仍允许用户/模板指定 URL，自动预览也会请求外部图片或媒体。攻击者控制模板可观察资源请求时间/IP，或诱导访问用户可达的地址；是否能读取内网响应受 Chrome host permissions、CORS 和 Private Network Access 实际行为限制，**SSRF/内网读取可利用性待确认**。可选域名白名单、禁止自动预览或逐资源确认会影响既有模板，需要开发者决定后实现。

### C12 source map 与复杂输入

Vite 保留 sourcemap: true，CRXJS 将部分 map 暴露给 Botcake。当前没有确认的内嵌凭据，故不当成 High 泄露；如果后续加入私有逻辑或配置，应考虑发布包移除 map。

ZIP 已有 200 文件、80MB 声明总解压大小和解压后再次校验，以及绝对路径/`..` 拒绝；解压在内存中，没有文件系统落盘，未确认 zip slip。同步解压、递归 walkJson 和本地文件 arrayBuffer 仍可能被巨大/极深输入阻塞 UI，建议后续以 Worker、深度/复杂度和本地压缩包大小限制进一步加固；没有将这些可用性边界推断成已证实 RCE。

模板可包含业务动作（例如拉黑、清理历史）和链接，外部模板内容可信度仍由使用者确认；未经授权不删除业务动作或限制全部链接协议。API 专页 ID 在操作服务入口有数字格式验证；真实账号专页授权最终由 Botcake 服务端执行，服务端越权是否存在待确认。

## 验证结果与证据

| 检查 | 结果 |
| --- | --- |
| `npm test` | 16 个测试文件，96 个测试通过 |
| `npm run build` | TypeScript 检查及 Windows 官方构建脚本通过，867 个模块，生成 MV3 manifest |
| `node scripts/test-botcake-risk-monitor.cjs` | 通过，包括保留 HTTP、通知重试、HTML 转义和千页批处理场景 |
| `node scripts/test-botcake-log-sync.cjs` | 通过 |
| `node scripts/test-botcake-customer-security.cjs` | 新增公式、日志、重定向、Token 错误脱敏测试通过 |
| workflow 与 manifest 静态核对 | 4 项 Action 均固定 40 位 SHA，无 zip 命令直接表达式插入，MV3 与内容脚本域符合预期 |
| `git diff --check` | 通过 |
| npm audit 修复前 | 4 个包条目：2 Critical、1 High、1 Moderate；条目包含传播聚合，不代表 4 个独立漏洞 |
| npm audit 修复后 | 0 个漏洞；Critical、High、Moderate、Low 均为 0 |
| OSV 全锁查询 | 231 个名称/版本；0 项命中，与 npm 交叉一致 |

新增 Vitest 回归验证了模板路径防护、消息发送者规则、无 Content-Length 流取消、错误脱敏，以及私有任务的二进制往返、伪造 ID、跨标签页访问和过期拒绝。IndexedDB 使用本地事件驱动适配器测试；真实 Chrome 服务工作线程事务、扩展升级/重载和 Apps Script 真实 API 行为仍待部署回归确认。没有运行真实发送通知、写专页或发布 GitHub Release。

证据收集脚本为 `scripts/security-audit-evidence.mjs`。生成文件只保存包元数据、公开公告引用及凭据规则命中位置，不保存命中的凭据值。扫描未命中不保证没有未知格式密钥；本地证据不等同于线上服务渗透测试。

建议下次维护优先处理 K01 的 HTTPS 部署，关注 Vitest 4.x 维护周期，并回归验证 Chrome 扩展升级、标签页刷新后的任务隔离及各 Botcake 保存/素材上传路径。
