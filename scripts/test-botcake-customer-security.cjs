// Local VM regression: no Google access and no HTTP requests.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const written = [], logs = [];
const sheet = {
  getDataRange: () => ({ getValues: () => [[]] }),
  insertRowsBefore() {},
  getRange: () => ({ setNumberFormat() { return this; }, setValues(rows) { written.push(rows); return this; } }),
};
const context = vm.createContext({
  Logger: { log: value => logs.push(String(value)) },
  LockService: { getDocumentLock: () => ({ waitLock() {}, releaseLock() {} }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, getSpreadsheetTimeZone: () => 'GMT+8' }) },
  Utilities: { sleep() {} },
  UrlFetchApp: { fetch(url, options) { assert.equal(options.followRedirects, false); throw new Error('Request failed: ' + url); } },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../botcake-google-apps-script.gs'), 'utf8'), context);
context.assertValidTimeZone = () => {};
context.normalizeDateInput = value => value;
context.convertTimestampToDate = () => '2026-10-06 09:00:00';
context.fetchBotCakeData = () => [
  { id: 'customer-1', full_name: '=IMPORTXML("https://example.test", "//x")', source: '=1+1', last_subscribed_at: 'sample' },
  { full_name: 'private-customer-data', last_subscribed_at: 'sample' },
];
const token = 'fake/test+' + 'x'.repeat(110);
context.botCakes('123456789', 'sheet', 'GMT+8', '2026-10-06', token, 'Page', '2026-10-06');
assert.equal(written[1][0][0][0], "'");
assert.equal(written[1][0][2], "'=1+1");
assert.ok(!logs.some(value => value.includes('private-customer-data')));
assert.throws(() => context.fetchBotCakeCustomerPage('123456789', token, 'Page', 1, { unit: 'day', startSeconds: 1, endSeconds: 2 }), error => {
  assert.ok(!error.message.includes(token));
  assert.ok(!error.message.includes(encodeURIComponent(token)));
  assert.ok(error.message.includes('[REDACTED]'));
  return true;
});
console.log('PASS: customer formula escaping, sensitive record logging removed, redirects disabled, transport Token redacted.');
