# 库无参数调用实测

2026-09-20，在 Google Apps Script 编辑器实际执行 `bcrmVerifyLibraryEntry`，日志时间 22:17:36–22:17:38。调用者绑定表格 ID：`1rgSTOOSiil61nNS-v_jHAeUfoowEJJ4yP8ERVM5a7Qk`。

调用者本地检测与库调用 `botcakeMsg.probeBotcakeLibraryContext()` 均返回：

```json
{
  "spreadsheetId": "1rgSTOOSiil61nNS-v_jHAeUfoowEJJ4yP8ERVM5a7Qk",
  "documentPropertiesAvailable": true,
  "documentPropertiesReadWrite": true,
  "documentLockAvailable": true,
  "documentLockAcquired": true
}
```

库检测入口存在，执行正常结束。此结果来自真实 Google 环境，不是本地模拟。未运行日志扫描或发送 Teams 消息；检测仅写入、读取并清理随机临时文档属性，短暂获取并释放文档锁。

结论：本测试环境下库可无参数取得正确调用者表格、可读写的文档属性和可获取的文档锁，显式传入服务对象不是可用性的必要条件。此前要求传入两个对象属于谨慎设计，不能据此断言无参数必然失败。

上述首次检测的边界：未证明库与调用者取得同一属性存储，未测试两张表的隔离、不同账号、并发执行、定时器或整个业务流程。后续验证如下。

## 同表并发实测

实际测试库为 `1y56KbMAp7l05kxGVE9qJH3tWQY8TbGi8uAI1bH1p_IokAq92G_aqSlGr`，调用者引用 HEAD；不是最早的只读旧业务库。新增独立测试文件，未修改业务函数。

2026-09-20 22:23:34（UTC+8），A 表第一次执行调用库内部 `getDocumentLock()`，获取成功并持有 45 秒。在另一个编辑器窗口于 22:23:44 启动同一个绑定项目的第二次执行；22:23:45 库检测返回 `documentLockAcquired:false`。两次调用均未传服务对象，证明本测试环境中同表并发会竞争同一个库文档锁。

隔离测试副本：`1QkwBBwrAufeh49TPwtWxV5y4i_flYlIi4O_p8fEaWwg`，名称 `Botcake隔离验证B-临时`，未共享。其绑定项目为 `1-SD3KlGv4moYlNT4o8kIxfWxHM-tK2wAMnVSzD_pSe0O39B_YygOeFcP`。A 表已写入临时键 `BCRM_ISOLATION_PROBE_20260920`，值为 A 表 ID。B 表首次执行需要用户授权，尚未据此报告跨表隔离通过；完成对比后应清理临时键。

## 跨表隔离后续实测：通过

用户完成 B 表授权后：

- 22:26:43，B 表读取与 A 完全相同的属性键，返回 null。
- 22:30:30，B 表把同名属性写为 B 表 ID，回读为 B 表 ID。
- 22:30:50，A 表再次读取同名属性，仍为 A 表 ID，未被 B 覆盖。
- 22:30:50.820，A 表从库中成功获取文档锁并持有 45 秒；22:31:11，B 表从同一库获取文档锁成功；A 到 22:31:35.910 才释放。因此跨表执行不被同一文档锁串行化。

结论：同账号、两个独立表格绑定项目、同一个测试库 HEAD、编辑器手动执行的环境中，无参数表格识别、文档属性跨表隔离、同表锁互斥及跨表锁独立均有真实执行证据。未测试不同账号、定时器和完整业务通知流程。生产旧库并未因此自动更新。

22:32:04–22:32:05，两表分别执行清理并回读，均返回 `stored:null`。临时属性已清理，锁正常释放；未发送 Teams 消息。测试副本及独立测试函数保留供复查，不属于生产入口。
