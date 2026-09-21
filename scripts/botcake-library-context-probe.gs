/** 临时放入库项目，发布测试版本后从表格绑定项目调用。
 * 调用：console.log(JSON.stringify(BotcakeRiskLib.probeBotcakeLibraryContext()));
 * 不读取业务数据或密钥，不请求 API，不写表格，不使用 Script Properties。
 * available 仅表示服务可用，不证明跨表格隔离或并发互斥。
 */
function probeBotcakeLibraryContext() {
  const result = {};
  try {
    const book = SpreadsheetApp.getActiveSpreadsheet();
    result.spreadsheetId = book ? book.getId() : null;
  } catch (e) { result.spreadsheetError = String(e); }
  try {
    const props = PropertiesService.getDocumentProperties();
    result.documentPropertiesAvailable = Boolean(props);
    if (props) {
      // 随机临时键：验证读写能力，finally 清理，不碰已有状态。
      const key = 'BCRM_PROBE_' + Utilities.getUuid();
      try {
        props.setProperty(key, key);
        result.documentPropertiesReadWrite = props.getProperty(key) === key;
      } finally { props.deleteProperty(key); }
    }
  } catch (e) { result.documentPropertiesError = String(e); }
  try {
    const lock = LockService.getDocumentLock();
    result.documentLockAvailable = Boolean(lock);
    if (lock) {
      const acquired = lock.tryLock(100);
      result.documentLockAcquired = acquired;
      if (acquired) lock.releaseLock();
    }
  } catch (e) { result.documentLockError = String(e); }
  return result;
}
