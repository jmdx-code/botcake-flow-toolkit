// Run: node scripts/test-botcake-log-sync.cjs
// Local Apps Script mocks; never connects to Botcake or Google.
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../botcake-log-sync.gs'), 'utf8');

function setup(count, options = {}) {
  let now = Date.parse('2026-09-05T09:00:00Z');
  let triggers = [];
  let failWrite = false;
  const properties = new Map();
  const calls = [];
  const notes = new Map();
  // Deliberately reorder headers and add an unrelated column.
  const grid = [['同步状态', '其他', '日志', 'token', '同步时间', '专页ID']];
  for (let i = 1; i <= count; i++) grid.push(['旧状态', '=1+1', '旧日志', 'fake-token', '旧时间', String(i)]);
  grid.push(['保留', '=2+2', '不动', '', '不动', 'missing-token']);
  const sheet = {
    getSheetId: () => 123,
    getDataRange: () => ({ getDisplayValues: () => grid.map(row => row.slice()) }),
    getRange(row, col, size = 1) {
      const range = {
        setNumberFormat() { return range; }, setWrap() { return range; },
        setValues(values) {
          if (failWrite && col === 3) { failWrite = false; throw new Error('Simulated write failure'); }
          for (let i = 0; i < size; i++) grid[row - 1 + i][col - 1] = values[i][0];
          return range;
        },
        setNotes(values) {
          for (let i = 0; i < size; i++) notes.set(`${row + i}:${col}`, values[i][0]);
          return range;
        }
      };
      return range;
    }
  };
  const book = {getId: () => 'book', getSheetByName: () => sheet, toast() {}};
  const props = {
    getProperty: key => properties.get(key) || null,
    setProperty: (key, value) => properties.set(key, value),
    deleteProperty: key => properties.delete(key)
  };
  class MockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: MockDate,
    SpreadsheetApp: {getActiveSpreadsheet: () => book, openById: id => { assert.equal(id, 'book'); return book; }, flush() {}},
    PropertiesService: {getScriptProperties: () => props},
    LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock() {}})},
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: target => { triggers = triggers.filter(item => item !== target); },
      newTrigger(handler) {
        const builder = {timeBased: () => builder, everyMinutes: () => builder, create() {
          const trigger = {getHandlerFunction: () => handler}; triggers.push(trigger); return trigger;
        }};
        return builder;
      }
    },
    Utilities: {
      DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'},
      computeDigest: (_, text) => crypto.createHash('sha256').update(text).digest(),
      base64Encode: value => Buffer.from(value).toString('base64'),
      formatDate: (date, zone) => new Date(date.getTime() + Number(zone.slice(3, 6)) * 3600000)
        .toISOString().slice(0, 19).replace('T', ' ')
    },
    UrlFetchApp: {fetchAll(requests) {
      now += options.batchMs ?? 65000;
      return requests.map(request => {
        const id = Number(request.url.match(/pages\/(\d+)\/logs/)[1]);
        calls.push(id);
        return {
          getResponseCode: () => id === options.failedId ? 403 : 200,
          getContentText: () => JSON.stringify({logs: id % 2 ? [] : [
            {code: 100, subcode: 0, description: '错误说明', updated_at: '2026-09-05T08:00:00Z'},
            {code: 1, description: '旧错误', updated_at: '2026-09-01T08:00:00Z'}
          ]})
        };
      });
    }}
  });
  vm.runInContext(source, context);
  return {
    run: name => context[name](), context, grid, notes, calls,
    state: () => { const raw = properties.get('BOTCAKE_LOG_SYNC_STATE_V2'); return raw ? JSON.parse(raw) : null; },
    triggers: () => triggers,
    breakNextWrite: () => { failWrite = true; }
  };
}

// A thousand pages across many resumptions, preserving a single query window.
const large = setup(1000, {failedId: 20});
large.run('syncBotcakeLogs');
assert.equal(large.state().nextIndex, 40);
const windowEnd = large.state().end;
assert.equal(large.triggers().length, 1);
assert.equal(large.grid[41][0], ''); // Pending rows cannot retain old success status.
let passes = 1;
while (large.state()) {
  assert.equal(large.state().end, windowEnd);
  large.run('continueBotcakeLogSync');
  assert.ok(++passes < 40);
}
assert.equal(large.calls.length, 1000);
assert.equal(new Set(large.calls).size, 1000);
assert.equal(large.triggers().length, 0);
assert.equal(large.grid[1][0], '成功');
assert.equal(large.grid[1][2], '');
assert.equal(large.grid[2][2], '100/0-错误说明-2026-09-05 16:00:00');
assert.equal(large.grid[20][0], '失败');
assert.equal(large.grid[20][2], '旧日志');
assert.equal(large.grid[20][4], '旧时间');
assert.match(large.notes.get('21:1'), /403/);
assert.equal(large.grid[1001][0], '保留');
assert.ok(large.grid.slice(1).every(row => row[1].startsWith('=')));
large.run('continueBotcakeLogSync'); // A stale trigger must not start a fresh full sync.
assert.equal(large.calls.length, 1000);

// A write failure must leave the checkpoint before the uncommitted batch.
const interrupted = setup(30, {batchMs: 1000});
interrupted.breakNextWrite();
assert.throws(() => interrupted.run('syncBotcakeLogs'), /Simulated write failure/);
assert.equal(interrupted.state().nextIndex, 0);
assert.equal(interrupted.triggers().length, 0);
interrupted.run('syncBotcakeLogs');
assert.equal(interrupted.state(), null);
assert.equal(interrupted.calls.length, 40); // Only the interrupted 10 rows repeat.

// Changed row identities must not be silently skipped by a saved row cursor.
const changed = setup(100);
changed.run('syncBotcakeLogs');
changed.grid[1][5] = '9999';
assert.throws(() => changed.run('continueBotcakeLogSync'), /restartBotcakeLogSync/);
assert.equal(changed.triggers().length, 0);
changed.run('restartBotcakeLogSync');
assert.ok(changed.calls.includes(9999));
changed.run('stopBotcakeLogSync');
assert.ok(changed.state());
assert.equal(changed.triggers().length, 0);

// Unparseable log dates are failures, not false empty successes.
assert.throws(() => large.context.bclLogText_({
  getResponseCode: () => 200,
  getContentText: () => JSON.stringify({logs: [{updated_at: 'ambiguous-date'}]})
}, 0, Date.now(), 'GMT+08:00'), /无法解析/);
assert.throws(() => large.context.bclColumns_(['token', '专页ID', '日志', '同步时间']), /同步状态/);
// Real response format from both authorized test pages: ISO time without a zone.
assert.equal(large.context.bclTimestamp_('2026-09-04T17:44:04'), Date.parse('2026-09-04T17:44:04Z'));
assert.equal(large.context.bclTimestamp_('2026-08-30T06:11:54'), Date.parse('2026-08-30T06:11:54Z'));
assert.equal(large.context.bclTimestamp_('2026-09-04 17:44:04.123456'), Date.parse('2026-09-04T17:44:04.123Z'));
assert.ok(Number.isNaN(large.context.bclTimestamp_('2026-02-30T12:00:00')));
assert.equal(large.context.bclLogText_({
  getResponseCode: () => 200,
  getContentText: () => JSON.stringify({page_logs: [{code: 10903, subcode: 1893049, description: '测试说明', updated_at: '2026-09-04T17:44:04'}]})
}, Date.parse('2026-09-03T09:00:00Z'), Date.parse('2026-09-05T09:00:00Z'), 'GMT+08:00'),
'10903/1893049-测试说明-2026-09-05 01:44:04');
vm.runInContext("BOTCAKE_LOG_CONFIG.API_TIMEZONE = '+7'", large.context);
assert.equal(large.context.bclTimestamp_('2026-09-04T17:44:04'), Date.parse('2026-09-04T10:44:04Z'));
assert.equal(large.context.bclTimestamp_('2026-09-04T17:44:04Z'), Date.parse('2026-09-04T17:44:04Z'));
console.log('PASS: 1000 pages, resume, statuses, empty logs, fixed window, skipped rows, batched writes, interrupted write recovery, changed input detection, stop/restart, trigger cleanup and invalid dates.');
