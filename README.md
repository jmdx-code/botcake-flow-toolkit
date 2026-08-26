# Botcake 流程助手

Botcake 流程助手是一款 Manifest V3 Chrome 扩展，用于制作、编辑、备份和批量应用 Botcake Flow 模板，也可备份与恢复常用专页设置。

> 本项目是独立开发的辅助工具，并非 Botcake 官方产品。Botcake 页面或接口发生变化时，部分自动化能力可能需要更新。

## 主要功能

- 从当前 Flow 导出 ZIP 模板，并保存可读取的图片、音频和视频素材。
- 从本地 ZIP 或公开 Google Sheet + Google Drive 目录读取模板。
- 使用 `[[变量]]` 定义文字、数字、随机选项和素材输入。
- 按机器人变量名称映射目标专页字段，缺失时自动创建。
- 将素材重新上传到目标专页，并改写素材 ID、URL 和 page ID。
- 导入前识别不支持的专页绑定对象，防止误覆盖。
- 按专页 ID 和 Flow ID 保存最近 5 份本地备份并支持恢复。
- 应用评论私信流程、默认回复流程、欢迎信息流程与专页设置模板。
- 按控制台名称创建或更新 Customer 关键词流程，多个关键词使用“包含任意一个”逻辑。
- 提供只读流程图和模板可视化编辑器。

## 安装发行版

最新稳定版：[v1.0.1 Release](https://github.com/secure-artifacts/botcake-flow-toolkit/releases/)

1. 在 GitHub Releases 下载 `botcake-flow-toolkit-vX.Y.Z.zip`。
2. 将 ZIP 解压到一个不会移动或删除的目录。
3. 打开 `chrome://extensions`。
4. 开启右上角“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择刚才解压的目录。

Chrome 会按文件夹路径加载本地扩展，因此安装后不要移动该目录。

如已安装 GitHub CLI，可验证下载文件确实由本仓库的 GitHub Actions 构建：

```bash
gh attestation verify botcake-flow-toolkit-v1.0.1.zip --owner secure-artifacts
```

## 新手使用手册

完整操作说明见 [Botcake流程助手-新手使用手册.md](./Botcake流程助手-新手使用手册.md)。

## Google 表格目录

普通资源使用前两列，关键词流程再使用第三列：

| 名称 | 资源网盘链接 | 关键词 |
| --- | --- | --- |
| 设置-默认设置 | 公开设置 JSON 链接 | |
| 流程-评论流程 1 号 | 公开 Flow ZIP 链接 | |
| 默认回复-通用 | 公开 Flow ZIP 链接 | |
| 关键词-客服咨询 | 公开 Flow ZIP 链接 | 价格,费用,怎么买 |

名称以“设置”“流程”“默认回复”或“关键词”开头，插件会自动分类。关键词资源第三列支持中文或英文逗号，任意一个词被包含时即可触发。Google Sheet 和 Drive 文件必须允许任何拥有链接的人读取；插件通过公开导出地址访问，不请求 Google OAuth。

## 本地开发

```bash
npm install
npm test
npm run build
```

构建完成后，在 `chrome://extensions` 中选择本项目的 `dist` 目录。

## 数据与权限说明

- `storage`：保存控制台地址、窗口位置和本地备份。
- `downloads`：下载用户主动导出的模板与设置文件。
- `scripting`：扩展重载后按需重新连接已打开的 Botcake 页面。
- 站点权限：仅用于 Botcake、公开 Google Sheet/Drive 和 Botcake 素材域名。

扩展不会内置 GitHub、Google 或 Botcake 登录令牌。请勿将含隐私数据、未脱敏专页信息或私有素材的模板上传到公共仓库。

## ZIP 模板结构

```text
template.zip
├─ template.json
└─ assets/
   ├─ media_1.jpg
   └─ media_2.mp3
```

`template.json` 是唯一必需文件。模板文字可写入 `[[变量名]]`，更复杂的选项和素材绑定可在模板编辑器中设置。

## 安全发布

版本标签采用 `vX.Y.Z`。标签推送后，GitHub Actions 会运行测试、构建扩展、生成 ZIP、创建构建来源证明并发布 Release；请勿手工上传或替换 Release 文件。
