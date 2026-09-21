/** Botcake 高危日志监控库 · 完整重构版
 * 唯一入口：checkBotcakeRisks(configOverrides)，配置可省略。
 * 从调用者绑定表格获取文档属性和文档锁；不使用 Script Properties。
 * 初始化 → 扫描 → 批量提交 → 按群通知 → 汇总与清理。
 * 定时器由使用者自行建立，不自动安装或修改触发器。
 */
const BOTCAKE_RISK_CONFIG = {
  PAGE_SHEET: 'botcake专页清单',
  RULE_SHEET: '日志类型控制', // B2:B，一行一个包含匹配关键词。
  RECORD_SHEET: 'botcake限制记录',
  TIMEZONE: '+8',
  API_TIMEZONE: '+0', // Botcake 不带时区的日志时间按 UTC 解析。
  SERVER_API_URL: '', // 填写自建 Teams 发信 API 的 HTTP 或 HTTPS 地址。
  SERVER_API_KEY: '', // 优先级：本次传入配置 > 调用者文档属性 BOTCAKE_TEAMS_API_KEY > 此默认值。
  SEND_TEAMS: true, // false：仅检查和记录，不发消息。
  BATCH_SIZE: 10, // 每批请求的专页数。
  WRITE_EVERY_BATCHES: 5, // 默认累计 5 批（50 页）再写表；暂停/结束前也会提交。
  RETENTION_DAYS: 7, // 完成整轮后，删除更新时间早于最近 7 天的记录。
  MAX_RUN_SECONDS: 240
};
// 唯一全局函数：手动运行或在 Apps Script 中自行绑定时间触发器。
// 内部辅助函数不占用全局函数名；脚本不创建、删除或修改任何触发器。
function checkBotcakeRisks(configOverrides) {
  // 仅合并已知配置项；undefined 沿用默认值，false 和空字符串保留。
  // 时间触发器传入的事件对象没有这些字段，因此仍使用默认配置。
  if (configOverrides != null && (typeof configOverrides !== 'object' || Array.isArray(configOverrides))) {
    throw new Error('传入配置必须为对象。');
  }
  const riskConfig = Object.assign({}, BOTCAKE_RISK_CONFIG);
  Object.keys(BOTCAKE_RISK_CONFIG).forEach(function(key) {
    if (configOverrides && Object.prototype.hasOwnProperty.call(configOverrides, key)
      && configOverrides[key] !== undefined) riskConfig[key] = configOverrides[key];
  });
  const hasExplicitApiKey = Boolean(configOverrides
    && Object.prototype.hasOwnProperty.call(configOverrides, 'SERVER_API_KEY')
    && configOverrides.SERVER_API_KEY !== undefined);
  const BCRM_HEADERS = ['专页ID', '名字', '通知组ID', '高危日志', '全部报错日志', '更新时间', '是否通知'];

  return bcrmRun_();

  function bcrmRun_() {
    const enteredAt = Date.now();
    bcrmValidate_();
    // 仅面向表格绑定项目：自动使用本次调用的容器，不打开缓存里的表格。
    const book = SpreadsheetApp.getActiveSpreadsheet();
    const props = PropertiesService.getDocumentProperties();
    const lock = LockService.getDocumentLock();
    if (!book || !props || !lock) {
      throw new Error('请从 Google 表格的绑定脚本调用本库，无法获取当前表格、文档属性或文档锁。');
    }
    const stateKey = 'BCRM_STATE_' + bcrmHash_(JSON.stringify([
      book.getId(), riskConfig.PAGE_SHEET, riskConfig.RULE_SHEET, riskConfig.RECORD_SHEET
    ]));
    if (!lock.tryLock(1000)) return '当前表格已有检测正在执行，本次跳过。';
    try {
      const ctx = bcrmLoad_(book, props, stateKey);
      if (!bcrmScan_(ctx, enteredAt)) return '进度已保存，下次运行本函数时接续。';
      if (!bcrmNotify_(ctx, enteredAt)) return '扫描已完成，通知阶段等待接续。';
      return bcrmFinish_(ctx);
    } finally { lock.releaseLock(); }
  }

  // 初始化：本次执行只读一次清单、规则及历史记录。
  function bcrmLoad_(book, props, stateKey) {
    let state = JSON.parse(props.getProperty(stateKey) || 'null');
    if (state && state.bookId !== book.getId()) {
      throw new Error('断点与当前表格不一致，已停止执行。请检查调用者存储配置。');
    }
    const config = riskConfig;
    const source = book.getSheetByName(config.PAGE_SHEET);
    const control = book.getSheetByName(config.RULE_SHEET);
    if (!source || !control) throw new Error('找不到专页清单或日志类型控制工作表。');
    const input = source.getDataRange().getDisplayValues();
    const cols = bcrmColumns_(input[0], ['token', '专页ID', '名字', '通知组ID']);
    const ruleLastRow = control.getLastRow();
    const rules = ruleLastRow < 2 ? [] : bcrmRules_(
      control.getRange(2, 2, ruleLastRow - 1, 1).getDisplayValues().map(function(r) { return r[0]; }));
    if (!rules.length) throw new Error('高危关键词清单为空，请填写日志类型控制的 B2:B。');
    const pages = [];
    const seen = new Map();
    input.slice(1).forEach(function(row, index) {
      const page = { row: index + 2, token: row[cols.token].trim(), id: row[cols['专页ID']].trim(),
        name: row[cols['名字']].trim(), group: row[cols['通知组ID']].trim() };
      if (!page.token || !page.id) return;
      if (seen.has(page.id)) throw new Error('专页清单包含重复专页 ID：' + page.id + '，请合并为一行。');
      seen.set(page.id, true);
      pages.push(page);
    });
    // 输入变动后停止沿用旧行号；摘要不保存明文 Token。
    const signature = bcrmHash_(JSON.stringify([pages, rules, config.PAGE_SHEET, config.RULE_SHEET,
      config.RECORD_SHEET, config.TIMEZONE, config.API_TIMEZONE]));
    if (state && state.signature !== signature) {
      // 输入改变后从头重新检查，已有记录继续用于去重。
      props.deleteProperty(stateKey);
      state = null;
    }
    let records = book.getSheetByName(config.RECORD_SHEET);
    if (!records) records = book.insertSheet(config.RECORD_SHEET);
    if (!records.getLastRow()) records.getRange(1, 1, 1, BCRM_HEADERS.length).setValues([BCRM_HEADERS]);
    // 每次执行只读一遍限制记录，后续追加同时更新内存中的记录。
    const recordValues = records.getDataRange().getDisplayValues();
    const recordCols = bcrmColumns_(recordValues[0], BCRM_HEADERS);
    if (BCRM_HEADERS.some(function(header) { return recordCols[header] === 7; })) {
      throw new Error('H1 已预留最终汇总，请将 H 列的业务表头及对应数据移到其他列后重试。');
    }
    const recordPosition = {nextRow: recordValues.length + 1, width: recordValues[0].length,
      maxRows: records.getMaxRows()};
    if (!state) {
      state = {bookId: book.getId(), signature: signature, end: Date.now(), cursor: 0, phase: 'SCAN', failed: 0,
        firstRecordRow: recordPosition.nextRow};
      props.setProperty(stateKey, JSON.stringify(state));
    }
    if (!Number.isInteger(state.firstRecordRow) || state.firstRecordRow < 2
      || !Number.isFinite(state.end) || !Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor > pages.length
      || !Number.isInteger(state.failed) || state.failed < 0 || state.failed > state.cursor
      || !['SCAN', 'NOTIFY'].includes(state.phase) || (state.phase === 'NOTIFY' && state.cursor !== pages.length)) {
      throw new Error('断点格式无效，请在调用者文档属性中删除断点 ' + stateKey + ' 后重新运行。');
    }
    const history = bcrmReadRecords_(recordValues, recordCols);
    const dedup = new Map();
    history.forEach(function(record) {
      if (!Number.isFinite(record.time)) throw new Error('限制记录第 ' + record.row + ' 行更新时间无法解析。');
      const key = bcrmKey_(record.id, record.risk.split('\n'));
      dedup.set(key, Math.max(dedup.get(key) || 0, record.time));
    });
    return {props, book, stateKey, state, pages, rules, ruleKeys: rules.map(function(rule) { return rule.toLowerCase(); }),
      input, records, recordCols, recordPosition, history, dedup};
  }

  // 扫描阶段：只处理日志和内存缓冲，由提交阶段推进持久化断点。
  function bcrmScan_(ctx, enteredAt) {
    const {state, stateKey, pages, rules, ruleKeys, dedup, props} = ctx;
    if (state.phase === 'NOTIFY') return true;
    const config = riskConfig;
    const buffer = {records: [], batches: 0};
    while (state.cursor < pages.length) {
      if (bcrmOutOfTime_(enteredAt)) {
        bcrmCommit_(ctx, buffer);
        return false;
      }
      const batch = pages.slice(state.cursor, state.cursor + config.BATCH_SIZE);
      let responses;
      try {
        responses = UrlFetchApp.fetchAll(batch.map(function(page) {
          return {url: 'https://botcake.io/api/v1/pages/' + encodeURIComponent(page.id)
            + '/logs?access_token=' + encodeURIComponent(page.token), method: 'get',
            muteHttpExceptions: true, followRedirects: false};
        }));
      } catch (_) { responses = batch.map(function() { return null; }); }

      batch.forEach(function(page, index) {
        let logs;
        try { logs = bcrmLogs_(responses[index], state.end); }
        catch (error) {
          state.failed++;
          return;
        }
        // 不保存 Token，也清理服务端可能在错误文字中回显的 Token。
        logs.forEach(function(log) {
          log.text = log.text.split(page.token).join('[TOKEN已隐藏]')
            .split(encodeURIComponent(page.token)).join('[TOKEN已隐藏]');
        });
        const searchable = logs.map(function(log) { return log.search.toLowerCase(); });
        const matched = rules.filter(function(rule, ruleIndex) {
          return searchable.some(function(text) { return text.includes(ruleKeys[ruleIndex]); });
        });
        if (!matched.length) return;
        const key = bcrmKey_(page.id, matched);
        const now = Date.now();
        if (dedup.has(key) && now - dedup.get(key) < 86400000) return;
        const fullText = logs.map(function(log) { return log.text; }).join('\n');
        // 超长文本仍保留告警，不因单元格限制丢掉整个专页。
        const clipped = fullText.length > 45000 ? fullText.slice(0, 44000) + '\n[日志过长，后续已截断]' : fullText;
        buffer.records.push({id: page.id, name: page.name, group: page.group, risk: matched.join('\n'),
          logs: clipped, updated: bcrmTime_(now), status: ''});
        dedup.set(key, now);
      });
      state.cursor += batch.length;
      buffer.batches++;
      if (buffer.batches >= config.WRITE_EVERY_BATCHES) bcrmCommit_(ctx, buffer);
    }
    bcrmCommit_(ctx, buffer);
    state.phase = 'NOTIFY';
    props.setProperty(stateKey, JSON.stringify(state));
    return true;
  }

  // 提交阶段：先落表，成功后保存扫描游标；失败不会丢失未提交的专页。
  function bcrmCommit_(ctx, buffer) {
    if (!buffer.batches) return;
    if (buffer.records.length) {
      bcrmAppend_(ctx.records, ctx.recordCols, buffer.records, ctx.recordPosition, ctx.history);
      SpreadsheetApp.flush();
    }
    ctx.props.setProperty(ctx.stateKey, JSON.stringify(ctx.state));
    buffer.records = []; buffer.batches = 0;
  }

  // 通知阶段：按群合并；防重复保护以一次群消息为单位分块保存。
  function bcrmNotify_(ctx, enteredAt) {
    const {props, records: sheet, recordCols: cols, history: rows, book} = ctx;
    const config = riskConfig;
    const prefix = 'BCRM_SEND_' + bcrmHash_(JSON.stringify([book.getId(), config.RECORD_SHEET])) + '_';
    const ledger = bcrmReadLedger_(props, prefix);
    const byMember = new Map(), groups = new Map(), recovery = new Map();
    rows.forEach(function(row) {
      row.member = bcrmHash_(JSON.stringify([row.id, row.risk, row.updated, row.group]));
      byMember.set(row.member, row);
      if (row.status || Date.now() - row.time >= 86400000 || !row.group || row.group === '您的群ID') return;
      const entry = ledger.members.get(row.member);
      if (entry) { row.sendResult = entry.result; return; }
      if (!groups.has(row.group)) groups.set(row.group, []);
      groups.get(row.group).push(row);
    });
    ledger.blocks.forEach(function(block) {
      if (block.entry.result !== 'accepted') return;
      if (!recovery.has(block.entry.group)) recovery.set(block.entry.group, []);
      recovery.get(block.entry.group).push(block);
    });
    // API 已成功但写表中断：按群补写状态，再按属性块清理，绝不重发。
    for (const blocks of recovery.values()) {
      if (bcrmOutOfTime_(enteredAt)) return false;
      const pending = new Map();
      blocks.forEach(function(block) {
        block.entry.members.forEach(function(member) {
          const row = byMember.get(member);
          if (row && !row.status) pending.set(member, row);
        });
      });
      if (pending.size) {
        bcrmMarkNotified_(sheet, cols, Array.from(pending.values()));
        SpreadsheetApp.flush();
      }
      blocks.forEach(function(block) {
        if (block.entry.members.every(function(member) {
          const row = byMember.get(member);
          return row && row.status === '已通知';
        })) props.deleteProperty(block.key);
      });
    }
    const apiKey = hasExplicitApiKey ? config.SERVER_API_KEY
      : props.getProperty('BOTCAKE_TEAMS_API_KEY') || config.SERVER_API_KEY;
    if (!config.SEND_TEAMS || !config.SERVER_API_URL || !apiKey) return true;
    for (const [group, list] of groups) {
      if (bcrmOutOfTime_(enteredAt)) return false;
      const requestId = bcrmHash_(JSON.stringify([group, list.map(function(row) { return row.member; }).sort()]));
      // 128 个 SHA-256 摘要一块，单属性约 6 KB，低于 9 KB 限制。
      const blocks = [];
      for (let i = 0; i < list.length; i += 128) {
        const part = list.slice(i, i + 128);
        blocks.push({key: prefix + requestId + '_' + blocks.length, entry: {
          until: Math.max.apply(null, part.map(function(row) { return row.time + 86400000; })),
          group: bcrmHash_(group), result: 'attempted', members: part.map(function(row) { return row.member; })
        }});
      }
      bcrmSaveLedger_(props, blocks, 'attempted');
      const result = bcrmSend_(group, bcrmHtml_(list), requestId, apiKey);
      bcrmSaveLedger_(props, blocks, result);
      list.forEach(function(row) { row.sendResult = result; });
      if (result === 'accepted') {
        bcrmMarkNotified_(sheet, cols, list);
        SpreadsheetApp.flush();
        blocks.forEach(function(block) { props.deleteProperty(block.key); });
      }
    }
    return true;
  }

  // 收尾：汇总落表后结束断点，再清理旧行。
  function bcrmFinish_(ctx) {
    const {state, stateKey, history, pages, input, records, props, book} = ctx;
    const newRecords = history.filter(function(record) { return record.row >= state.firstRecordRow; });
    const summaryLines = ['本轮检查完成：' + bcrmTime_(Date.now()),
      '检查专页：' + pages.length + '；成功：' + (pages.length - state.failed) + '；失败：' + state.failed,
      '缺少 Token/专页ID 跳过：' + (input.length - 1 - pages.length) + ' 行'];
    summaryLines.push('新增高危记录：' + newRecords.length);
    const counts = new Map();
    newRecords.forEach(function(record) {
      const status = record.status === '已通知' ? '已通知' : '未通知';
      counts.set(status, (counts.get(status) || 0) + 1);
    });
    summaryLines.push('新增记录通知状态：' + (Array.from(counts).map(function(entry) {
      return entry[0] + ' ' + entry[1] + ' 条';
    }).join('；') || '无新增记录'));
    const uncertainCount = history.filter(function(record) { return record.sendResult === 'attempted' || record.sendResult === 'unknown'; }).length;
    const failedSendCount = history.filter(function(record) { return record.sendResult === 'failed'; }).length;
    if (uncertainCount || failedSendCount) summaryLines.push('通知未成功确认：结果待确认 ' + uncertainCount + ' 条；接口失败 ' + failedSendCount + ' 条（防重复，不自动重发）。');
    const summary = summaryLines.join('\n');
    // 整轮完成才覆盖 H1；暂停时保留上一轮总结果。先保存汇总，再清除断点。
    records.getRange(1, 8).setValue(summary).setWrap(true);
    SpreadsheetApp.flush();
    props.deleteProperty(stateKey);
    // 先完成通知、汇总并结束断点，再删除旧行，避免行号变化影响断点或重发。
    bcrmCleanHistory_(records, history);
    book.toast(summary, 'Botcake 高危日志检测', 10);
    return summary;
  }

  function bcrmReadLedger_(props, prefix) {
    const saved = props.getProperties(), blocks = [], members = new Map();
    Object.keys(saved).forEach(function(key) {
      if (!key.startsWith(prefix)) return;
      const entry = JSON.parse(saved[key]);
      if (Number.isFinite(entry.until) && entry.until <= Date.now()) { props.deleteProperty(key); return; }
      // 只支持当前结构。未知/旧格式不得默认为“未发送”，避免升级时重复通知。
      if (!Number.isFinite(entry.until) || !Array.isArray(entry.members) || !entry.members.length || entry.members.length > 128
        || !entry.members.every(function(member) { return typeof member === 'string' && /^[\w-]{43}=?$/.test(member); })
        || typeof entry.group !== 'string' || !['attempted', 'accepted', 'unknown', 'failed'].includes(entry.result)) {
        throw new Error('发送保护记录格式不支持。请先核对旧通知或等待旧记录的 24 小时有效期结束，勿直接删除未确认的保护记录。');
      }
      blocks.push({key: key, entry: entry});
      entry.members.forEach(function(member) { members.set(member, entry); });
    });
    return {blocks: blocks, members: members};
  }

  function bcrmSaveLedger_(props, blocks, result) {
    const values = {};
    blocks.forEach(function(block) { block.entry.result = result; values[block.key] = JSON.stringify(block.entry); });
    props.setProperties(values); // 不使用 deleteAllOthers，保留其他功能的文档属性。
  }

  function bcrmSend_(group, content, requestId, apiKey) {
    try {
      const response = UrlFetchApp.fetch(riskConfig.SERVER_API_URL, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true, followRedirects: false,
        headers: {'x-api-key': apiKey, 'Idempotency-Key': requestId},
        payload: JSON.stringify({chat_id: group, content: content})
      });
      const code = response.getResponseCode();
      let body = null;
      try { body = JSON.parse(response.getContentText()); } catch (_) { /* API 可返回非 JSON 成功响应。 */ }
      if (code >= 200 && code < 300 && !(body && (body.success === false || body.ok === false || body.error))) return 'accepted';
      return code >= 500 || code === 408 ? 'unknown' : 'failed';
    } catch (_) { return 'unknown'; } // 不记录可能含密钥的原始异常。
  }

  function bcrmHtml_(rows) {
    // 名字自然升序（如专页2排在专页10之前），空名字最后，同名按 ID 排序。
    rows = rows.slice().sort(function(a, b) {
      const left = String(a.name || '').trim();
      const right = String(b.name || '').trim();
      if (!left && right) return 1;
      if (left && !right) return -1;
      return left.localeCompare(right, 'zh-CN', {numeric: true, sensitivity: 'base'})
        || String(a.id).localeCompare(String(b.id), 'zh-CN', {numeric: true});
    });
    const escape = bcrmEscape_;
    const lines = ['<p>🔔 <b>Botcake小蛋糕 高危报错提醒</b><br>检测范围：最近 24 小时</p>',
      '<table border="1" cellpadding="5" cellspacing="0"><tr><th>序号</th><th>名字</th><th>专页ID</th><th>高危日志</th></tr>'];
    rows.forEach(function(row, i) {
      lines.push('<tr><td>' + (i + 1) + '</td><td>' + escape(row.name) + '</td><td>' + escape(row.id)
        + '</td><td>' + escape(row.risk).replace(/\n/g, '<br>') + '</td></tr>');
    });
    lines.push('</table>');
    rows.forEach(function(row) {
      lines.push('<p><b>' + escape(row.name || row.id) + '（' + escape(row.id) + '）</b><br>'
        + escape(row.logs).replace(/\n/g, '<br>') + '</p>');
    });
    return lines.join('');
  }

  function bcrmReadRecords_(values, cols) {
    return values.slice(1).map(function(row, i) {
      return {row: i + 2, id: row[cols['专页ID']].trim(), name: row[cols['名字']], group: row[cols['通知组ID']].trim(),
        risk: row[cols['高危日志']], logs: row[cols['全部报错日志']], updated: row[cols['更新时间']],
        time: bcrmTimestamp_(row[cols['更新时间']], riskConfig.TIMEZONE), status: row[cols['是否通知']].trim()};
    }).filter(function(row) { return row.id && row.risk; });
  }

  function bcrmCleanHistory_(sheet, history) {
    const cutoff = Date.now() - riskConfig.RETENTION_DAYS * 86400000;
    const expired = history.filter(function(record) {
      return record.row > 1 && Number.isFinite(record.time) && record.time < cutoff;
    }).map(function(record) { return record.row; }).sort(function(a, b) { return a - b; });
    // 连续过期行一次删除，从底部向上处理，保留其他行、表头及 H1。
    for (let end = expired.length - 1; end >= 0;) {
      let start = end;
      while (start > 0 && expired[start - 1] === expired[start] - 1) start--;
      sheet.deleteRows(expired[start], end - start + 1);
      end = start - 1;
    }
  }

  function bcrmAppend_(sheet, cols, records, position, history) {
    if (!records.length) return;
    const width = position.width;
    const rows = records.map(function(record) {
      const row = Array(width).fill('');
      const fields = [record.id, record.name, record.group, record.risk, record.logs, record.updated, record.status];
      BCRM_HEADERS.forEach(function(header, i) { row[cols[header]] = bcrmCell_(fields[i]); });
      return row;
    });
    const start = position.nextRow;
    const extra = start + rows.length - 1 - position.maxRows;
    if (extra > 0) {
      sheet.insertRowsAfter(position.maxRows, extra);
      position.maxRows += extra;
    }
    sheet.getRange(start, 1, rows.length, width).setNumberFormat('@').setValues(rows).setWrap(true);
    records.forEach(function(record, i) {
      history.push(Object.assign({}, record, {row: start + i, time: bcrmTimestamp_(record.updated, riskConfig.TIMEZONE)}));
    });
    position.nextRow += rows.length;
  }

  function bcrmMarkNotified_(sheet, cols, rows) {
    if (!rows.length) return;
    let column = cols['是否通知'] + 1, letters = '';
    while (column > 0) {
      column--; letters = String.fromCharCode(65 + column % 26) + letters;
      column = Math.floor(column / 26);
    }
    sheet.getRangeList(rows.map(function(row) { return letters + row.row; })).setValue('已通知');
    rows.forEach(function(row) { row.status = '已通知'; });
  }

  function bcrmLogs_(response, end) {
    if (!response) throw new Error('网络请求失败，下轮重新检查');
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) throw new Error('Botcake HTTP ' + code);
    let body;
    try { body = JSON.parse(response.getContentText()); } catch (_) { throw new Error('响应不是 JSON'); }
    if (body && (body.success === false || body.error)) throw new Error('Botcake 返回业务错误');
    const rows = bcrmArray_(body);
    if (!rows) throw new Error('无法识别日志列表');
    return rows.map(function(row) {
      if (!row || typeof row !== 'object') throw new Error('日志记录结构错误');
      const time = bcrmTimestamp_(row.updated_at ?? row.updatedAt, riskConfig.API_TIMEZONE);
      if (!Number.isFinite(time)) throw new Error('日志时间缺失或格式无法解析');
      const search = String(row.code ?? '-') + '/' + String(row.subcode ?? '-') + '-'
        + String(row.description ?? row.message ?? '').replace(/[\r\n]+/g, ' ').trim();
      return {time: time, search: search, text: search + '-' + bcrmTime_(time)};
    }).filter(function(row) { return row.time >= end - 86400000 && row.time <= end; })
      .sort(function(a, b) { return b.time - a.time; });
  }

  function bcrmArray_(body) {
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== 'object') return null;
    for (const key of ['page_logs', 'logs', 'data', 'result']) {
      const found = bcrmArray_(body[key]);
      if (found !== null) return found;
    }
    return null;
  }

  function bcrmTimestamp_(value, zone) {
    const text = String(value ?? '').trim();
    if (!text) return NaN;
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text) < 1e12 ? Number(text) * 1000 : Number(text);
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
    if (!match) return NaN;
    const local = match[1] + 'T' + match[2] + '.' + (match[3] || '').padEnd(3, '0').slice(0, 3);
    const calendar = Date.parse(local + 'Z');
    if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 19) !== local.slice(0, 19)) return NaN;
    return Date.parse(local + (match[4] || bcrmZone_(zone).slice(3)));
  }

  function bcrmTime_(time) {
    const zone = bcrmZone_(riskConfig.TIMEZONE);
    // 保存明确的时差，后续修改显示时区也不会改变历史记录的去重时间。
    return Utilities.formatDate(new Date(time), zone, 'yyyy-MM-dd HH:mm:ss') + zone.slice(3);
  }
  function bcrmZone_(value) {
    if (!/^[+-]\d{1,2}$/.test(String(value)) || Number(value) < -12 || Number(value) > 14) throw new Error('时区请使用 +8、+7、+0 等格式。');
    return 'GMT' + (Number(value) < 0 ? '-' : '+') + String(Math.abs(Number(value))).padStart(2, '0') + ':00';
  }
  function bcrmRules_(values) {
    const unique = new Map();
    values.forEach(function(value) {
      const text = String(value).trim();
      if (/[\r\n]/.test(text)) throw new Error('高危关键词请一行一个，不要在一个单元格中换行。');
      if (text) unique.set(text.toLowerCase(), text);
    });
    return Array.from(unique.values()).sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
  }
  function bcrmKey_(id, rules) { return JSON.stringify([id, Array.from(new Set(rules.map(function(r) { return r.trim().toLowerCase(); }))).sort()]); }
  function bcrmCell_(value) { return String(value).startsWith('=') ? "'" + value : String(value); }
  function bcrmEscape_(value) { return String(value).replace(/[&<>"']/g, function(c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function bcrmHash_(text) { return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)); }
  function bcrmOutOfTime_(start) { return Date.now() - start >= riskConfig.MAX_RUN_SECONDS * 1000; }
  function bcrmColumns_(headers, required) {
    const normalized = headers.map(function(value) { return String(value).replace(/\s+/g, '').toLowerCase(); });
    const result = {};
    required.forEach(function(name) {
      const key = name.toLowerCase();
      const index = normalized.indexOf(key);
      if (index < 0 || normalized.lastIndexOf(key) !== index) throw new Error('表头缺失或重复：' + name);
      result[name] = index;
    });
    return result;
  }
  function bcrmValidate_() {
    const c = riskConfig;
    bcrmZone_(c.TIMEZONE); bcrmZone_(c.API_TIMEZONE);
    if (![c.PAGE_SHEET, c.RULE_SHEET, c.RECORD_SHEET].every(function(name) {
      return typeof name === 'string' && name.trim().length > 0;
    })) throw new Error('工作表名称必须为非空字符串。');
    if (typeof c.SEND_TEAMS !== 'boolean') throw new Error('SEND_TEAMS 必须为 true 或 false。');
    if (typeof c.SERVER_API_URL !== 'string' || typeof c.SERVER_API_KEY !== 'string') throw new Error('通知地址和密钥必须为字符串。');
    if (new Set([c.PAGE_SHEET, c.RULE_SHEET, c.RECORD_SHEET]).size !== 3) throw new Error('三个工作表名称必须不同。');
    if (!Number.isInteger(c.BATCH_SIZE) || c.BATCH_SIZE < 1 || c.BATCH_SIZE > 20
      || !Number.isFinite(c.MAX_RUN_SECONDS) || c.MAX_RUN_SECONDS < 1 || c.MAX_RUN_SECONDS > 240) throw new Error('批量大小必须为 1–20，运行预算为 1–240 秒。');
    if (!Number.isInteger(c.WRITE_EVERY_BATCHES) || c.WRITE_EVERY_BATCHES < 1 || c.WRITE_EVERY_BATCHES > 50) throw new Error('累计写入批数必须为 1–50。');
    if (!Number.isInteger(c.RETENTION_DAYS) || c.RETENTION_DAYS < 1) throw new Error('记录保留天数必须为大于等于 1 的整数。');
    if (c.SERVER_API_URL && !/^https?:\/\//i.test(c.SERVER_API_URL)) throw new Error('Teams API 地址必须以 http:// 或 https:// 开头。');
  }
}
