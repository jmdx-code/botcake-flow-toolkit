/** 放在使用者表格的绑定项目中；botcakeMsg 替换为实际库标识符。
 * 库默认配置需先填写通知 API 地址和密钥。
 * 定时触发器绑定本地 checkBotcakeRisks，无需部署调用方。
 */
function checkBotcakeRisks() {
  return botcakeMsg.checkBotcakeRisks();
}

// 需要覆盖默认配置时，将上面的调用替换为：
// return botcakeMsg.checkBotcakeRisks({
//   PAGE_SHEET: 'botcake专页清单',
//   RULE_SHEET: '日志类型控制',
//   RECORD_SHEET: 'botcake限制记录',
//   TIMEZONE: '+8',
//   SERVER_API_URL: 'http://your-server/send',
//   SERVER_API_KEY: '你的密钥'
// });
