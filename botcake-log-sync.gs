/**
 * Google 表格绑定脚本。第一行必须有：token、专页ID、日志、同步时间、同步状态。
 * syncBotcakeLogs：开始新一轮；若有未完成任务则继续断点。
 * restartBotcakeLogSync：放弃旧断点，从头重新同步。
 * stopBotcakeLogSync：停止自动接续，保留断点供手动继续。
 * 自动接续由脚本创建并在完成后删除，无需手动配置触发器。
 * 同一轮请勿排序、增删行或改动 Token/专页 ID；需要改动时修改后运行 restartBotcakeLogSync。
 */
const BOTCAKE_LOG_CONFIG = {
  SHEET_NAME: '日志同步',
  TIMEZONE: '+8', // 香港 +8；需要时改成 '+7'、'+9' 等。
  API_TIMEZONE: '+0', // 接口时间未标注时区时，暂按 UTC 解释；这是源时区假设，不是显示时区。
  DAYS: 2, // 整轮共用开始时刻往前 48 小时的查询窗口。
  BATCH_SIZE: 10,
  MAX_RUN_SECONDS: 240 // 每次最多主动运行约 4 分钟，预留保存进度时间。
};
const BCL_STATE_KEY = 'BOTCAKE_LOG_SYNC_STATE_V2';

function syncBotcakeLogs() { return bclRun_('manual'); }
function restartBotcakeLogSync() { return bclRun_('restart'); }
// 专用触发器入口：没有断点时只清理触发器，不会自动开始下一轮。
function continueBotcakeLogSync() { return bclRun_('continue'); }

function stopBotcakeLogSync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('当前正在同步，请等本次执行结束后再停止。');
  try { bclRemoveTriggers_(); }
  finally { lock.releaseLock(); }
}

function bclRun_(mode) {
  const enteredAt = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    if (mode === 'restart') {
      bclRemoveTriggers_();
      props.deleteProperty(BCL_STATE_KEY);
    }
    const saved = props.getProperty(BCL_STATE_KEY);
    let state = saved ? JSON.parse(saved) : null;
    if (!state && mode === 'continue') { bclRemoveTriggers_(); return; }
    const config = BOTCAKE_LOG_CONFIG;
    const zone = bclTimezone_(config.TIMEZONE);
    const apiZone = bclTimezone_(config.API_TIMEZONE);
    if (!Number.isInteger(config.BATCH_SIZE) || config.BATCH_SIZE < 1 || config.BATCH_SIZE > 20
      || !Number.isFinite(config.MAX_RUN_SECONDS) || config.MAX_RUN_SECONDS < 1
      || config.MAX_RUN_SECONDS > 240 || !Number.isFinite(config.DAYS) || config.DAYS <= 0) {
      throw new Error('配置无效：批量大小为 1–20，执行预算为 1–240 秒，DAYS 必须大于 0。');
    }
    const book = state ? SpreadsheetApp.openById(state.bookId) : SpreadsheetApp.getActiveSpreadsheet();
    if (!book) throw new Error('请从目标 Google 表格的绑定 Apps Script 运行。');
    const sheet = book.getSheetByName(config.SHEET_NAME);
    if (!sheet) throw new Error('找不到工作表：' + config.SHEET_NAME);
    const values = sheet.getDataRange().getDisplayValues();
    const cols = bclColumns_(values[0]);
    const inputs = values.slice(1).map(function(row) {
      return [row[cols.token].trim(), row[cols.pageId].trim()];
    });
    // 只保存输入摘要，不把 Token 放入断点属性。
    const signature = Utilities.base64Encode(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      JSON.stringify([sheet.getSheetId(), config.SHEET_NAME, zone, apiZone, config.DAYS, inputs]),
      Utilities.Charset.UTF_8
    ));
    if (state && state.signature !== signature) {
      throw new Error('专页行、Token、工作表或查询配置已改变，请运行 restartBotcakeLogSync 从头重新同步。');
    }
    if (!state) {
      // 清除本轮尚未处理行的旧状态，防止把上一轮成功误认为本轮成功。
      const pendingRows = inputs.map(function(input, index) {
        return { row: index + 2, values: [''], notes: [''], valid: Boolean(input[0] && input[1]) };
      }).filter(function(item) { return item.valid; });
      bclWriteGroups_(sheet, cols.status + 1, pendingRows, false);
      SpreadsheetApp.flush();
      const end = Date.now();
      state = {
        bookId: book.getId(), signature: signature, nextIndex: 0,
        start: end - config.DAYS * 86400000, end: end,
        success: 0, failed: 0, skipped: 0
      };
      props.setProperty(BCL_STATE_KEY, JSON.stringify(state));
    }
    // 在请求前创建周期接续器：即使本次被强制终止，也能从最近已提交批次恢复。
    bclEnsureTrigger_();
    while (state.nextIndex < inputs.length) {
      if (Date.now() - enteredAt >= config.MAX_RUN_SECONDS * 1000) {
        const summary = '已处理 ' + state.nextIndex + '/' + inputs.length + ' 行，进度已保存，将自动接续。';
        book.toast(summary, 'Botcake 日志同步', 10);
        return summary;
      }
      const nextIndex = Math.min(state.nextIndex + config.BATCH_SIZE, inputs.length);
      const batch = [];
      for (let index = state.nextIndex; index < nextIndex; index++) {
        const input = inputs[index];
        if (input[0] && input[1]) batch.push({row: index + 2, token: input[0], pageId: input[1]});
      }
      const requests = batch.map(function(job) {
        return {
          url: 'https://botcake.io/api/v1/pages/' + encodeURIComponent(job.pageId)
            + '/logs?access_token=' + encodeURIComponent(job.token),
          method: 'get', muteHttpExceptions: true, followRedirects: false
        };
      });
      let responses = [];
      if (requests.length) {
        try { responses = UrlFetchApp.fetchAll(requests); }
        catch (_) {
          // 不记录可能含 Token 的原始异常。整批网络失败时记录失败，避免串行补读耗尽预算。
          responses = requests.map(function() { return null; });
        }
      }
      const results = batch.map(function(job, index) {
        const attemptedAt = bclFormat_(new Date(), zone);
        try {
          let content = bclLogText_(responses[index], state.start, state.end, zone);
          content = content.split(job.token).join('[TOKEN已隐藏]');
          content = content.split(encodeURIComponent(job.token)).join('[TOKEN已隐藏]');
          return {row: job.row, ok: true, content: content, time: attemptedAt, note: ''};
        } catch (error) {
          return {row: job.row, ok: false, note: '同步失败：' + error.message
            + '\n尝试时间：' + attemptedAt + '\n日志及同步时间保留上次成功结果。'};
        }
      });
      const successful = results.filter(function(item) { return item.ok; });
      // 只批量写实际处理的行，不改缺少信息的行，也不覆盖其他列。
      bclWriteGroups_(sheet, cols.log + 1, successful.map(function(item) {
        return {row: item.row, values: [bclCellText_(item.content)], notes: ['']};
      }), true);
      bclWriteGroups_(sheet, cols.time + 1, successful.map(function(item) {
        return {row: item.row, values: [item.time]};
      }), false);
      bclWriteGroups_(sheet, cols.status + 1, results.map(function(item) {
        return {row: item.row, values: [item.ok ? '成功' : '失败'], notes: [item.note]};
      }), false);
      // 必须先写表并 flush，再推进断点；中断最多重复读取当前一批。
      SpreadsheetApp.flush();
      state.success += successful.length;
      state.failed += results.length - successful.length;
      state.skipped += nextIndex - state.nextIndex - batch.length;
      state.nextIndex = nextIndex;
      props.setProperty(BCL_STATE_KEY, JSON.stringify(state));
    }
    props.deleteProperty(BCL_STATE_KEY);
    bclRemoveTriggers_();
    const summary = '同步完成：成功 ' + state.success + ' 行，失败 ' + state.failed
      + ' 行，缺少信息跳过 ' + state.skipped + ' 行。';
    book.toast(summary, 'Botcake 日志同步', 10);
    return summary;
  } catch (error) {
    // 配置、权限或表格写入错误停止自动运行，保留断点；修正后手动运行入口继续。
    bclRemoveTriggers_();
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function bclCellText_(text) {
  return text.startsWith('=') ? "'" + text : text;
}

// 将相邻行合并为 setValues，减少 1000 行时的表格 API 调用次数。
function bclWriteGroups_(sheet, column, entries, wrap) {
  for (let i = 0; i < entries.length;) {
    let end = i + 1;
    while (end < entries.length && entries[end].row === entries[end - 1].row + 1) end++;
    const group = entries.slice(i, end);
    const range = sheet.getRange(group[0].row, column, group.length, 1);
    range.setNumberFormat('@').setValues(group.map(function(item) { return item.values; }));
    if (wrap) range.setWrap(true);
    if (group[0].notes) range.setNotes(group.map(function(item) { return item.notes; }));
    i = end;
  }
}

function bclEnsureTrigger_() {
  const props = PropertiesService.getScriptProperties();
  // 首次运行新版时替换旧的 5 分钟触发器，保留同步断点。
  if (props.getProperty('BCL_TRIGGER_INTERVAL') !== '1') bclRemoveTriggers_();
  const triggers = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === 'continueBotcakeLogSync';
  });
  if (!triggers.length) ScriptApp.newTrigger('continueBotcakeLogSync').timeBased().everyMinutes(1).create();
  props.setProperty('BCL_TRIGGER_INTERVAL', '1');
  triggers.slice(1).forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
}

function bclRemoveTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'continueBotcakeLogSync') ScriptApp.deleteTrigger(trigger);
  });
  PropertiesService.getScriptProperties().deleteProperty('BCL_TRIGGER_INTERVAL');
}

function bclColumns_(headers) {
  const normalized = headers.map(function(value) {
    return String(value).replace(/\s+/g, '').toLowerCase();
  });
  const result = {};
  const required = { token: 'token', pageId: '专页id', log: '日志', time: '同步时间', status: '同步状态' };
  Object.keys(required).forEach(function(key) {
    const name = required[key];
    const index = normalized.indexOf(name);
    if (index < 0) throw new Error('第一行缺少表头：' + name);
    if (normalized.lastIndexOf(name) !== index) throw new Error('第一行表头重复：' + name);
    result[key] = index;
  });
  return result;
}

function bclTimezone_(value) {
  const text = String(value).trim();
  if (!/^[+-]\d{1,2}$/.test(text) || Number(text) < -12 || Number(text) > 14) {
    throw new Error("TIMEZONE 请填写 '+8' 或 '+7' 这样的 UTC 时差（-12 至 +14）。");
  }
  return 'GMT' + (Number(text) < 0 ? '-' : '+')
    + String(Math.abs(Number(text))).padStart(2, '0') + ':00';
}

function bclFormat_(date, zone) {
  return Utilities.formatDate(date, zone, 'yyyy-MM-dd HH:mm:ss');
}

function bclLogArray_(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  const keys = ['page_logs', 'logs', 'data', 'result'];
  for (let i = 0; i < keys.length; i++) {
    const found = bclLogArray_(body[keys[i]]);
    if (found !== null) return found;
  }
  return null;
}

function bclTimestamp_(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    return number < 1e12 ? number * 1000 : number;
  }
  // Botcake 实测会返回不带时区的 ISO 时间，例如 2026-09-04T17:44:04。
  // 显式补上 API_TIMEZONE，避免 Apps Script 项目的默认时区影响过滤结果。
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (!match) return NaN;
  const offset = match[4] || bclTimezone_(BOTCAKE_LOG_CONFIG.API_TIMEZONE).slice(3);
  const local = match[1] + 'T' + match[2] + '.' + (match[3] || '').padEnd(3, '0').slice(0, 3);
  // 排除会被 Date.parse 自动滚动到下个月的无效日期。
  const calendar = Date.parse(local + 'Z');
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 19) !== local.slice(0, 19)) return NaN;
  return Date.parse(local + offset);
}

function bclLogText_(response, start, end, zone) {
  if (!response) throw new Error('网络请求失败，请稍后重试');
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    if (status === 401 || status === 403) throw new Error('Token 无效、过期或没有该专页权限（HTTP ' + status + '）');
    throw new Error('接口请求失败（HTTP ' + status + '），请稍后重试');
  }
  let body;
  try { body = JSON.parse(response.getContentText()); }
  catch (_) { throw new Error('接口返回的内容不是 JSON'); }
  if (body && (body.success === false || body.error || body.errors)) {
    throw new Error('Botcake 返回业务错误，请检查 Token 与专页权限');
  }
  const rows = bclLogArray_(body);
  if (rows === null) throw new Error('接口未返回可识别的日志列表');
  const recent = [];
  rows.forEach(function(row) {
    if (!row || typeof row !== 'object') throw new Error('日志记录结构无法识别');
    const timestamp = bclTimestamp_(row.updated_at ?? row.updatedAt);
    if (!Number.isFinite(timestamp)) throw new Error('日志时间缺失或无法解析，不能确认最近两天范围');
    if (timestamp >= start && timestamp <= end) recent.push({ row: row, timestamp: timestamp });
  });
  recent.sort(function(a, b) { return b.timestamp - a.timestamp; });
  const text = recent.map(function(item) {
    const row = item.row;
    return String(row.code ?? '-') + '/' + String(row.subcode ?? '-')
      + '-' + String(row.description ?? row.message ?? '').replace(/[\r\n]+/g, ' ').trim()
      + '-' + bclFormat_(new Date(item.timestamp), zone);
  }).join('\n');
  if (text.length > 45000) throw new Error('日志过长，无法完整写入单个单元格');
  return text;
}
