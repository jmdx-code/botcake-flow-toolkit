// node scripts/test-botcake-risk-monitor.cjs — fully local, no network/messages.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const code = fs.readFileSync(path.join(__dirname, '../botcake-risk-monitor.gs'), 'utf8');

function harness(count = 3, environment = {}) {
  const bookId = environment.bookId || 'book-id';
  let now = Date.parse('2026-09-20T09:00:00Z');
  let batchMs = 100;
  let postMode = 'success';
  let failAppend = false, failStatus = false, failDelete = false;
  let failLedger = null;
  const props = environment.props || new Map(), sent = [], fetched = [];
  const operations = {recordReads: 0, sourceNoteWrites: 0, statusWrites: 0, a1Lookups: 0, recordAppends: 0, summaryWrites: 0, noteWrites: 0, deletions: [], ledgerDeletes: 0, ledgerWriteCalls: 0, ledgerMaxBytes: 0};
  const statuses = new Map(), logs = new Map(), sheets = new Map();
  const response = (status, body) => ({getResponseCode: () => status, getContentText: () => JSON.stringify(body)});
  function sheet(name, initial) {
    const data = initial || [], notes = new Map();
    const api = {
      data, notes,
      getLastRow: () => data.length,
      getLastColumn: () => Math.max(0, ...data.map(row => row.length)),
      getMaxRows: () => 2000, insertRowsAfter() {},
      deleteRows(start, count) {
        assert.ok(start > 1);
        assert.equal(state(), null, 'Finish checkpoint before shifting row numbers');
        operations.deletions.push([start, count]);
        data.splice(start - 1, count);
        if (failDelete) { failDelete = false; throw new Error('Simulated cleanup interruption'); }
      },
      getDataRange: () => api.getRange(1, 1, Math.max(1, data.length), Math.max(1, api.getLastColumn())),
      getRange(row, col, height = 1, width = 1) {
        const range = {
          getDisplayValues: () => {
            if (name === 'botcake限制记录') operations.recordReads++;
            return Array.from({length: height}, (_, i) => Array.from({length: width}, (_, j) => String(data[row - 1 + i]?.[col - 1 + j] ?? '')));
          },
          getA1Notation: () => { operations.a1Lookups++; return `${row}:${col}`; },
          setNumberFormat() { return range; }, setWrap() { return range; },
          setValues(values) {
            if (name === 'botcake限制记录' && row > 1 && width > 1) operations.recordAppends++;
            if (name === 'botcake限制记录' && row === 1 && col === 8) operations.summaryWrites++;
            for (let i = 0; i < height; i++) {
              if (!data[row - 1 + i]) data[row - 1 + i] = [];
              for (let j = 0; j < width; j++) {
                const val = values[i][j];
                data[row - 1 + i][col - 1 + j] = typeof val === 'string' && val.startsWith("'=") ? val.slice(1) : val;
              }
            }
            if (failAppend && name === 'botcake限制记录' && row > 1 && width > 1) {
              failAppend = false;
              throw new Error('Simulated crash after append');
            }
            return range;
          },
          setValue(value) { return range.setValues(Array.from({length: height}, () => Array(width).fill(value))); },
          setNote(value) {
            operations.noteWrites++;
            if (name === 'botcake专页清单') operations.sourceNoteWrites++;
            notes.set(`${row}:${col}`, value); return range;
          },
          setNotes(values) {
            operations.noteWrites++;
            if (name === 'botcake专页清单') operations.sourceNoteWrites++;
            for (let i = 0; i < height; i++) notes.set(`${row + i}:${col}`, values[i][0]);
            return range;
          }
        };
        return range;
      },
      getRangeList(addresses) {
        const parse = address => {
          const match = /^([A-Z]+)(\d+)$/.exec(address);
          assert.ok(match, 'Use valid A1 notation');
          const col = [...match[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
          return [Number(match[2]), col];
        };
        const list = {
          setValue(value) { if (failStatus) { failStatus = false; throw new Error('Simulated status write failure'); } operations.statusWrites++; addresses.forEach(a => { const [r, c] = parse(a); api.getRange(r, c).setValue(value); }); return list; },
          setNote(value) { operations.noteWrites++; addresses.forEach(a => { const [r, c] = parse(a); notes.set(`${r}:${c}`, value); }); return list; }
        };
        return list;
      }
    };
    sheets.set(name, api);
    return api;
  }
  const input = sheet('botcake专页清单', [['名字', '通知组ID', '专页ID', 'token']]);
  for (let i = 1; i <= count; i++) {
    input.data.push([`Page <${i}>`, i === 3 ? 'group-b' : 'group-a', String(i), 'fake-secret']);
    logs.set(String(i), [{code: 10, subcode: 20, description: 'BLOCKED <danger>', updated_at: '2026-09-20T08:00:00'}]);
  }
  input.data.push(['skip', '', 'missing', '']);
  const rules = sheet('日志类型控制', [['', '关键词'], ['', 'blocked'], ['', '10/20'], ['', 'BLOCKED'], ['', '']]);
  // Extra first column and reordered record headers must work.
  const records = sheet('botcake限制记录', [['其他', '是否通知', '名字', '更新时间', '高危日志', '专页ID', '全部报错日志', '', '通知组ID']]);
  const book = {getId: () => bookId, getSheetByName: name => sheets.get(name), insertSheet: name => sheet(name), toast() {}};
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const ctx = vm.createContext({
    Date: Clock,
    LockService: {getScriptLock: () => { throw new Error('Library script lock must not be used'); }, getDocumentLock: () => ({tryLock: () => !environment.locked, releaseLock() {}})},
    SpreadsheetApp: {getActiveSpreadsheet: () => environment.noActive ? null : book, openById: id => { assert.equal(id, bookId, 'Never open another caller workbook'); return book; }, flush() {}},
    PropertiesService: {getScriptProperties: () => { throw new Error('Library Script Properties must not be accessed'); }, getDocumentProperties: () => ({
      getProperty: key => props.get(key) || null,
      setProperty: (k, v) => props.set(k, v),
      getProperties: () => Object.fromEntries(props),
      setProperties: (obj, deleteAllOthers) => {
        assert.notEqual(deleteAllOthers, true);
        operations.ledgerWriteCalls++;
        let writes = 0;
        for (const [k, v] of Object.entries(obj)) {
          const bytes = Buffer.byteLength(v, 'utf8');
          assert.ok(bytes < 9 * 1024, 'Property must fit Apps Script per-value limit');
          operations.ledgerMaxBytes = Math.max(operations.ledgerMaxBytes, bytes);
          props.set(k, v); writes++;
          if (failLedger && JSON.parse(v).result === failLedger.result && writes === failLedger.after) {
            failLedger = null; throw new Error('Simulated partial property save');
          }
        }
      },
      deleteProperty: k => { if (k.startsWith('BCRM_SEND_')) operations.ledgerDeletes++; return props.delete(k); }
    })},
    Utilities: {
      DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'},
      computeDigest: (_, text) => crypto.createHash('sha256').update(text).digest(),
      base64EncodeWebSafe: b => Buffer.from(b).toString('base64url'),
      formatDate: (d, zone) => new Date(d.getTime() + Number(zone.slice(3, 6)) * 3600000).toISOString().slice(0, 19).replace('T', ' ')
    },
    UrlFetchApp: {
      fetchAll(requests) {
        now += batchMs;
        return requests.map(request => {
          const id = request.url.match(/pages\/([^/]+)\/logs/)[1];
          fetched.push(id);
          return response(statuses.get(id) || 200, {success: true, page_logs: logs.get(id) || []});
        });
      },
      fetch(url, options) {
        assert.ok(['https://example.test/send', 'http://example.test/send'].includes(url));
        assert.equal(options.headers['x-api-key'], 'test-key');
        assert.ok(options.headers['Idempotency-Key']);
        assert.equal(state().phase, 'NOTIFY');
        assert.ok([...props.entries()].some(([k,v]) => k.startsWith('BCRM_SEND_') && JSON.parse(v).result === 'attempted'));
        const payload = JSON.parse(options.payload);
        sent.push({payload, fetchedAtSend: fetched.length});
        assert.doesNotMatch(payload.content, /fake-secret/);
        if (postMode === 'timeout') throw new Error('network unavailable');
        if (postMode === '500') return response(500, {});
        if (postMode === 'business') return response(200, {success: false});
        return response(200, {success: true});
      }
    }
  });
  vm.runInContext(code.replace('return bcrmRun_();', 'globalThis.__test = {bcrmTimestamp_}; return bcrmRun_();'), ctx);
  vm.runInContext("BOTCAKE_RISK_CONFIG.SERVER_API_URL = 'https://example.test/send'; BOTCAKE_RISK_CONFIG.SERVER_API_KEY = 'test-key';", ctx);
  function state() {
    const key = 'BCRM_STATE_' + crypto.createHash('sha256').update(JSON.stringify([bookId, 'botcake专页清单', '日志类型控制', 'botcake限制记录'])).digest('base64url');
    return JSON.parse(props.get(key) || 'null');
  }
  return {ctx, input, rules, records, sent, fetched, props, logs, statuses, state, operations,
    run: overrides => ctx.checkBotcakeRisks(overrides), resume: overrides => ctx.checkBotcakeRisks(overrides),
    config: text => vm.runInContext(text, ctx),
    advance: ms => { now += ms; }, batchTime: ms => { batchMs = ms; },
    post: mode => { postMode = mode; }, breakAppend: () => { failAppend = true; }, breakStatus: () => { failStatus = true; }, breakDelete: () => { failDelete = true; },
    breakLedger: (result, after) => { failLedger = {result, after}; },
    globals: () => Object.keys(ctx).filter(k => typeof ctx[k] === 'function' && k !== 'Date')};
}

const h = harness();
h.run();
assert.equal(h.records.data.length, 4);
assert.equal(h.sent.length, 2); // one per group, not one per keyword
assert.equal(h.sent[0].fetchedAtSend, 3);
assert.match(h.sent[0].payload.content, /Page &lt;1&gt;/);
assert.match(h.sent[0].payload.content, /Page &lt;2&gt;/);
assert.match(h.records.data[1][6], /2026-09-20 16:00:00\+08:00/);
assert.equal(h.records.data[1][1], '已通知');
assert.match(h.records.data[0][7], /检查专页：3；成功：3；失败：0/);
assert.match(h.records.data[0][7], /新增高危记录：3/);
assert.match(h.records.data[0][7], /已通知 3 条/);
assert.deepEqual(h.globals(), ['checkBotcakeRisks']);
const firstTime = h.records.data[1][3];
h.advance(3600000); h.run();
assert.equal(h.records.data.length, 4);
assert.equal(h.records.data[1][3], firstTime); // no sliding suppression window
assert.equal(h.sent.length, 2);
h.records.data[0][7].includes('新增高危记录：0') || assert.fail('Repeated round summary should show zero new records');
h.logs.get('1').push({code: 99, description: 'new severe', updated_at: '2026-09-20T09:30:00'});
h.rules.data.push(['', 'new severe']);
h.run();
assert.equal(h.records.data.length, 5); // changed risk set is new
assert.equal(h.sent.length, 3);
h.advance(25 * 3600000);
h.logs.set('1', [{code: 10, subcode: 20, description: 'BLOCKED', updated_at: '2026-09-21T10:00:00'}]);
h.run();
assert.equal(h.records.data.length, 6); // repeat after 24h can notify again
assert.equal(h.sent.length, 4);

const partial = harness(1000);
partial.batchTime(65000);
partial.records.data[0][7] = '上一轮结果';
partial.run();
assert.equal(partial.state().cursor, 40);
assert.equal(partial.sent.length, 0);
assert.equal(partial.records.data[0][7], '上一轮结果');
let rounds = 0;
while (partial.state()) { partial.resume(); assert.ok(++rounds < 40); }
assert.equal(partial.fetched.length, 1000);
assert.equal(partial.records.data.length, 1001);
assert.equal(partial.sent.length, 2);
assert.equal(partial.sent[0].fetchedAtSend, 1000);
assert.match(partial.records.data[0][7], /新增高危记录：1000/);
assert.match(partial.records.data[0][7], /已通知 1000 条/);

partial.resume();
assert.equal(partial.sent.length, 2);

const crash = harness();
crash.breakAppend();
assert.throws(() => crash.run(), /Simulated crash/);
assert.equal(crash.state().cursor, 0);
assert.equal(crash.sent.length, 0);
crash.run();
assert.equal(crash.records.data.length, 4); // append succeeded but cursor didn't: dedup still works
assert.match(crash.records.data[0][7], /新增高危记录：3/);
assert.equal(crash.sent.length, 2);

for (const mode of ['timeout', '500', 'business']) {
  const failure = harness(2);
  failure.post(mode); failure.run();
  assert.equal(failure.records.data[1][1], '');
  assert.equal(failure.operations.statusWrites, 0);
  assert.equal(failure.operations.noteWrites, 0);
  assert.ok([...failure.props.entries()].some(([k,v]) => k.startsWith('BCRM_SEND_') && JSON.parse(v).result === (mode === 'business' ? 'failed' : 'unknown')));
  failure.run(); assert.equal(failure.sent.length, 1); // no blind retry on subsequent scans
}

const missing = harness(2);
missing.input.data[1][1] = '';
missing.statuses.set('2', 403);
missing.run();
assert.equal(missing.records.data.length, 2);
assert.equal(missing.records.data[1][1], '');
assert.equal(missing.input.notes.size, 0);
assert.equal(missing.sent.length, 0);
assert.match(missing.records.data[0][7], /成功：1；失败：1/);
assert.match(missing.records.data[0][7], /未通知 1 条/);
missing.records.data[1][8] = 'group-c';
missing.run();
assert.equal(missing.sent.length, 1);

const noConfig = harness(1);
noConfig.config("BOTCAKE_RISK_CONFIG.SERVER_API_URL = ''");
noConfig.run(); assert.equal(noConfig.sent.length, 0);
assert.equal(noConfig.records.data[1][1], '');
noConfig.config("BOTCAKE_RISK_CONFIG.SERVER_API_URL = 'https://example.test/send'");
noConfig.run(); assert.equal(noConfig.sent.length, 1);
assert.equal(noConfig.records.data.length, 2);

const boundaries = harness(1);
boundaries.batchTime(0);
boundaries.logs.set('1', [{code: 10, description: 'BLOCKED', updated_at: '2026-09-19T08:59:59'}]);
boundaries.run(); assert.equal(boundaries.records.data.length, 1);
boundaries.logs.set('1', [{code: 10, description: 'BLOCKED', updated_at: '2026-09-19T09:00:00'}]);
boundaries.run(); assert.equal(boundaries.records.data.length, 2);
assert.ok(Number.isNaN(boundaries.ctx.__test.bcrmTimestamp_('2026-02-30T12:00:00', '+0')));
assert.equal(boundaries.ctx.__test.bcrmTimestamp_('2026-09-20T09:00:00', '+0'), Date.parse('2026-09-20T09:00:00Z'));
const changed = harness(50); changed.batchTime(65000); changed.run();
changed.input.data[1][2] = 'replacement';
changed.resume();
assert.ok(changed.fetched.includes('replacement'));
const http = harness(1);
http.config("BOTCAKE_RISK_CONFIG.SERVER_API_URL = 'http://example.test/send'");
http.run();
assert.equal(http.sent.length, 1);
assert.equal(http.records.data[1][1], '已通知');
const invalidUrl = harness(1);
invalidUrl.config("BOTCAKE_RISK_CONFIG.SERVER_API_URL = 'ftp://example.test/send'");
assert.throws(() => invalidUrl.run(), /http/);
const ordered = harness(4);
ordered.input.data[1][0] = '专页10';
ordered.input.data[2][0] = '专页2';
ordered.input.data[3][0] = '专页1';
ordered.input.data[3][1] = 'group-a';
ordered.input.data[4][0] = '';
ordered.run();
assert.equal(ordered.sent.length, 1);
const html = ordered.sent[0].payload.content;
assert.ok(html.indexOf('<td>专页1</td>') < html.indexOf('<td>专页2</td>'));
assert.ok(html.indexOf('<td>专页2</td>') < html.indexOf('<td>专页10</td>'));
assert.ok(html.indexOf('<b>专页1（') < html.indexOf('<b>专页2（'));
assert.ok(html.indexOf('<b>专页2（') < html.indexOf('<b>专页10（'));
assert.equal(ordered.records.data[1][2], '专页10'); // Only message order changes.
const overrides = harness(1);
overrides.run({SEND_TEAMS: false, TIMEZONE: '+7', BATCH_SIZE: undefined});
assert.equal(overrides.sent.length, 0);
assert.match(overrides.records.data[1][6], /2026-09-20 15:00:00\+07:00/);
assert.equal(vm.runInContext('BOTCAKE_RISK_CONFIG.SEND_TEAMS', overrides.ctx), true);
assert.equal(vm.runInContext('BOTCAKE_RISK_CONFIG.TIMEZONE', overrides.ctx), '+8');
overrides.props.set('BOTCAKE_TEAMS_API_KEY', 'property-key-should-be-overridden');
overrides.run({SERVER_API_KEY: 'test-key', SERVER_API_URL: 'http://example.test/send'});
assert.equal(overrides.sent.length, 1);
const timerEvent = harness(1);
timerEvent.run({triggerUid: 'test-trigger', authMode: 'FULL'});
assert.equal(timerEvent.sent.length, 1);
const emptyKey = harness(1);
emptyKey.props.set('BOTCAKE_TEAMS_API_KEY', 'test-key');
emptyKey.run({SERVER_API_KEY: ''});
assert.equal(emptyKey.sent.length, 0);
assert.throws(() => emptyKey.run('invalid'), /配置必须为对象/);
const resumeConfig = harness(50);
resumeConfig.batchTime(65000);
resumeConfig.run({SEND_TEAMS: false, TIMEZONE: '+7'});
assert.equal(resumeConfig.state().cursor, 40);
resumeConfig.resume({SEND_TEAMS: false, TIMEZONE: '+7'});
assert.equal(resumeConfig.fetched.length, 50);
assert.equal(resumeConfig.sent.length, 0);
assert.equal(resumeConfig.state(), null);
const efficient = harness(1000);
efficient.run();
assert.equal(efficient.operations.recordReads, 1);
assert.equal(efficient.operations.sourceNoteWrites, 0);
assert.equal(efficient.operations.noteWrites, 0);
assert.equal(efficient.operations.recordAppends, 20);
assert.equal(efficient.operations.summaryWrites, 1);
assert.equal(efficient.operations.a1Lookups, 0);
assert.equal(efficient.operations.statusWrites, 2); // two groups, one successful status write each
assert.equal(efficient.records.data.length, 1001);
assert.equal(efficient.sent.length, 2);
const gaps = harness(3);
gaps.input.data[2][3] = '';
gaps.input.notes.set('3:1', 'keep this note');
gaps.run();
assert.equal(gaps.input.notes.get('3:1'), 'keep this note');
assert.equal(gaps.operations.sourceNoteWrites, 0);
const bulkMissing = harness(100);
bulkMissing.input.data.slice(1).forEach(row => { row[1] = ''; });
bulkMissing.run();
assert.equal(bulkMissing.operations.statusWrites, 0);
assert.equal(bulkMissing.sent.length, 0);
const wide = harness(1);
wide.records.data[0] = Array(27).fill('').concat(['是否通知', '名字', '更新时间', '高危日志', '专页ID', '全部报错日志', '通知组ID']);
wide.run();
assert.equal(wide.records.data[1][27], '已通知');
const conflict = harness(1);
conflict.records.data[0][7] = '通知组ID';
conflict.records.data[0][8] = '';
assert.throws(() => conflict.run(), /H1 已预留/);
assert.equal(conflict.records.data[0][7], '通知组ID');
const statusCrash = harness(1);
statusCrash.breakStatus();
assert.throws(() => statusCrash.run(), /status write failure/);
assert.equal(statusCrash.sent.length, 1);
assert.equal(statusCrash.records.data[1][1], '');
statusCrash.resume();
assert.equal(statusCrash.sent.length, 1); // accepted response recovers by writing status only
assert.equal(statusCrash.records.data[1][1], '已通知');
assert.equal([...statusCrash.props.keys()].filter(k => k.startsWith('BCRM_SEND_')).length, 0);
const bufferedCrash = harness(60);
bufferedCrash.breakAppend();
assert.throws(() => bufferedCrash.run(), /Simulated crash/);
assert.equal(bufferedCrash.fetched.length, 50);
assert.equal(bufferedCrash.state().cursor, 0);
bufferedCrash.resume();
assert.equal(bufferedCrash.records.data.length, 61);
assert.equal(bufferedCrash.fetched.length, 110);
assert.equal(bufferedCrash.sent.length, 2);
const quiet = harness(1000);
quiet.logs.clear();
quiet.run();
assert.equal(quiet.operations.recordAppends, 0);
assert.equal(quiet.operations.statusWrites, 0);
assert.equal(quiet.operations.noteWrites, 0);
assert.equal(quiet.operations.summaryWrites, 1);
const biggerBuffer = harness(1000);
biggerBuffer.run({WRITE_EVERY_BATCHES: 10});
assert.equal(biggerBuffer.operations.recordAppends, 10);
assert.equal(biggerBuffer.operations.statusWrites, 2);
const pendingUnknown = harness(1);
pendingUnknown.post('timeout'); pendingUnknown.run();
pendingUnknown.post('success');
pendingUnknown.input.data.splice(2, 0, ['New page', 'group-a', '2', 'fake-secret']);
pendingUnknown.logs.set('2', [{code: 10, subcode: 20, description: 'BLOCKED', updated_at: '2026-09-20T08:00:00'}]);
pendingUnknown.run();
assert.equal(pendingUnknown.sent.length, 2);
assert.match(pendingUnknown.sent[1].payload.content, /New page/);
assert.doesNotMatch(pendingUnknown.sent[1].payload.content, /Page &lt;1&gt;/);
assert.equal(pendingUnknown.records.data[1][1], '');
assert.equal(pendingUnknown.records.data[2][1], '已通知');
const invalidBuffer = harness(1);
assert.throws(() => invalidBuffer.run({WRITE_EVERY_BATCHES: 0}), /累计写入批数/);
const retention = harness(1);
retention.batchTime(0);
function historyRow(id, date) { return ['=keep-formula', '已通知', id, date, 'blocked', id, 'old logs', '', 'group-a']; }
retention.records.data.push(
  historyRow('old-a', '2026-09-10 17:00:00+08:00'),
  historyRow('old-b', '2026-09-12 17:00:00+08:00'),
  historyRow('keep', '2026-09-19 17:00:00+08:00'),
  historyRow('old-c', '2026-09-13 16:59:59+08:00'),
  historyRow('boundary', '2026-09-13 17:00:00+08:00')
);
retention.run();
assert.deepEqual(retention.operations.deletions, [[5, 1], [2, 2]]);
assert.deepEqual(retention.records.data.slice(1).map(row => row[5]), ['keep', 'boundary', '1']);
assert.equal(retention.records.data[1][0], '=keep-formula');
assert.equal(retention.records.data[0][5], '专页ID');
assert.match(retention.records.data[0][7], /新增高危记录：1/);
retention.run();
assert.equal(retention.sent.length, 1);
assert.equal(retention.operations.deletions.length, 2);
const cleanupCrash = harness(1);
cleanupCrash.records.data.push(historyRow('old', '2026-09-01 00:00:00+08:00'));
cleanupCrash.breakDelete();
assert.throws(() => cleanupCrash.run(), /cleanup interruption/);
assert.equal(cleanupCrash.state(), null);
cleanupCrash.run();
assert.equal(cleanupCrash.sent.length, 1);
assert.equal(cleanupCrash.records.data.length, 2);
const pausedCleanup = harness(50);
pausedCleanup.batchTime(65000);
pausedCleanup.records.data.push(historyRow('old', '2026-09-01 00:00:00+08:00'));
pausedCleanup.run();
assert.equal(pausedCleanup.operations.deletions.length, 0);
pausedCleanup.resume();
assert.equal(pausedCleanup.operations.deletions.length, 1);
assert.equal(pausedCleanup.records.data.length, 51);
assert.throws(() => harness(1).run({RETENTION_DAYS: 0}), /记录保留天数/);
const grouped = harness(1000);
grouped.input.data[3][1] = 'group-a';
grouped.props.set('unrelated-secret', 'preserve-other-feature');
grouped.run();
assert.equal(grouped.sent.length, 1);
assert.equal(grouped.operations.ledgerDeletes, 8);
assert.equal(grouped.operations.ledgerWriteCalls, 2);
assert.ok(grouped.operations.ledgerMaxBytes < 6500);
assert.equal(grouped.props.get('unrelated-secret'), 'preserve-other-feature');
assert.equal(grouped.operations.statusWrites, 1);
assert.equal(grouped.operations.recordAppends, 20);
const chunkRecovery = harness(129);
chunkRecovery.input.data[3][1] = 'group-a';
chunkRecovery.breakStatus();
assert.throws(() => chunkRecovery.run(), /status write failure/);
assert.equal([...chunkRecovery.props.keys()].filter(k => k.startsWith('BCRM_SEND_')).length, 2);
// Reorder record rows: persisted identities cannot depend on old row numbers.
const swap = chunkRecovery.records.data[1];
chunkRecovery.records.data[1] = chunkRecovery.records.data[129];
chunkRecovery.records.data[129] = swap;
chunkRecovery.resume();
assert.equal(chunkRecovery.sent.length, 1);
assert.equal(chunkRecovery.operations.ledgerDeletes, 2);
assert.ok(chunkRecovery.records.data.slice(1).every(row => row[1] === '已通知'));
const halfResult = harness(129);
halfResult.input.data[3][1] = 'group-a';
halfResult.breakLedger('accepted', 1);
assert.throws(() => halfResult.run(), /partial property save/);
assert.equal(halfResult.sent.length, 1);
halfResult.resume();
assert.equal(halfResult.sent.length, 1);
assert.equal(halfResult.records.data.slice(1).filter(row => row[1] === '已通知').length, 128);
assert.equal(halfResult.records.data[129][1], ''); // remaining chunk uncertain; do not send again
const chunkExpiry = harness(1000);
chunkExpiry.input.data[3][1] = 'group-a';
chunkExpiry.post('timeout'); chunkExpiry.run();
assert.equal([...chunkExpiry.props.keys()].filter(k => k.startsWith('BCRM_SEND_')).length, 8);
chunkExpiry.advance(25 * 3600000);
chunkExpiry.run();
assert.equal(chunkExpiry.operations.ledgerDeletes, 8);
assert.equal(chunkExpiry.sent.length, 1);
const unsupported = harness(1);
unsupported.post('timeout'); unsupported.run();
const guardKey = [...unsupported.props.keys()].find(k => k.startsWith('BCRM_SEND_'));
const guard = JSON.parse(unsupported.props.get(guardKey));
unsupported.props.set(guardKey, JSON.stringify({until: guard.until, result: guard.result}));
assert.throws(() => unsupported.run(), /发送保护记录格式不支持/);
assert.equal(unsupported.sent.length, 1);
assert.ok(unsupported.props.has(guardKey));
// No-argument library path: never open another workbook or use Script Properties.
assert.doesNotMatch(code, /getScriptProperties|getScriptLock|openById|STATE_STORE|RUN_LOCK|SPREADSHEET_ID/);
const automaticBook = harness(1, {bookId: 'automatic-caller-book'});
automaticBook.ctx.SpreadsheetApp.openById = () => { throw new Error('Use caller active spreadsheet'); };
automaticBook.run();
assert.equal(automaticBook.sent.length, 1);
assert.equal(automaticBook.records.data[1][1], '已通知');
assert.throws(() => harness(1, {noActive: true}).run(), /绑定脚本/);
const sharedStore = new Map();
sharedStore.set('BOTCAKE_RISK_MONITOR_BOOK', 'someone-elses-private-book');
sharedStore.set('BOTCAKE_RISK_MONITOR_STATE_V1', '{old-unusable-state');
const callerA = harness(50, {bookId: 'caller-a', props: sharedStore});
const callerB = harness(1, {bookId: 'caller-b', props: sharedStore});
callerA.batchTime(65000);
callerA.run();
assert.ok(callerA.state());
const checkpointA = JSON.stringify(callerA.state());
callerB.post('timeout'); callerB.run();
assert.equal(JSON.stringify(callerA.state()), checkpointA);
assert.equal(callerB.state(), null);
callerA.batchTime(0); callerA.resume();
assert.equal(callerA.state(), null);
assert.equal(callerA.sent.length, 2); // B's uncertain send must not suppress A
assert.equal(callerA.records.data.length, 51);
callerB.resume();
assert.equal(callerB.sent.length, 1); // B's own protection survives A's cleanup
assert.equal(callerB.records.data.length, 2);
assert.equal(sharedStore.get('BOTCAKE_RISK_MONITOR_BOOK'), 'someone-elses-private-book');
assert.equal(sharedStore.get('BOTCAKE_RISK_MONITOR_STATE_V1'), '{old-unusable-state');
const corruptScope = harness(50);
corruptScope.batchTime(65000); corruptScope.run();
const scopedKey = [...corruptScope.props.keys()].find(k => k.startsWith('BCRM_STATE_'));
const wrongState = corruptScope.state(); wrongState.bookId = 'other-book';
corruptScope.props.set(scopedKey, JSON.stringify(wrongState));
assert.throws(() => corruptScope.resume(), /断点与当前表格不一致/);
const missingServices = harness(1);
missingServices.ctx.PropertiesService.getDocumentProperties = () => null;
assert.throws(() => missingServices.run(), /绑定脚本/);
const busyCaller = harness(1, {locked: true});
busyCaller.run();
assert.equal(busyCaller.fetched.length, 0);
assert.equal(busyCaller.props.size, 0);
console.log('PASS: no-argument document services, interleaved workbook checkpoints, isolated send guards, ignored legacy shared pointers, wrong-book rejection and document locking; Script Properties/Script Lock forbidden throughout.');
console.log('PASS: 1000 pages, reordered headers, 24h cutoff/dedup, changed risk sets, group aggregation after scan, HTML escaping, append-crash recovery, ambiguous send suppression, missing configuration/group, read failures, resume and cleanup.');
console.log('PASS: name sorting, partial configuration overrides, false/empty/undefined handling, unchanged defaults, API key precedence, trigger event compatibility and configured resume.');
console.log('PASS: 1000 pages: 20 record writes, 2 successful group status writes, 1 H1 write, zero notes; no sheet writes on send failure.');
console.log('PASS: 7-day retention boundary, grouped deletion, header/H1/formula preservation, no cleanup while paused and no duplicate notification after cleanup interruption.');
console.log('PASS: 1000 records in one group: 2 ledger saves, 8 ledger deletions, each property below 6.5KB; chunk recovery, partial metadata save, expiry and unsupported-format protection.');

for (const bad of [{PAGE_SHEET: ''}, {SEND_TEAMS: 'false'}, {SERVER_API_KEY: 123}]) {
  assert.throws(() => harness(1).run(bad));
}
const invalidCursor = harness(50);
invalidCursor.batchTime(65000); invalidCursor.run();
const invalidCursorKey = [...invalidCursor.props.keys()].find(k => k.startsWith('BCRM_STATE_'));
const invalidCursorState = invalidCursor.state(); invalidCursorState.cursor = -1;
invalidCursor.props.set(invalidCursorKey, JSON.stringify(invalidCursorState));
const fetchesBefore = invalidCursor.fetched.length;
assert.throws(() => invalidCursor.resume(), /断点格式无效/);
assert.equal(invalidCursor.fetched.length, fetchesBefore);
console.log('PASS: final configuration validation, corrupt checkpoint rejection before requests, no-argument caller isolation.');
