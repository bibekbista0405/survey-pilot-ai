'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { Storage } = require('../core/storage.js');
const { Export: Exp } = require('../core/export.js');

async function fresh() {
  Storage.close(); Storage._opening = null;
  const idb = new IDBFactory();
  await Storage.open({ indexedDB: idb, name: 'sp-test-' + Math.random().toString(36).slice(2) });
  return idb;
}
/** Simulates closing Chrome and starting it again: same database, new connection. */
async function restart(idb) { const name = Storage._dbName; Storage.close(); Storage._opening = null; await Storage.open({ indexedDB: idb, name }); }

const resp = (id, extra) => Object.assign({ id, index: 0, surveyId: 's1', profile: { age: 30 }, answers: { q: 'A' }, source: 'local' }, extra);

test('data survives a browser restart (close + reopen)', async () => {
  const idb = await fresh();
  await Storage.put('surveys', { id: 's1', title: 'T', questions: [{ key: 'q' }] });
  await Storage.putMany('respondents', [resp('SYN-0001'), resp('SYN-0002', { index: 1 })]);
  await Storage.appendLog({ action: 'hello', respondentId: 'SYN-0001' });
  await Storage.setSettings({ mode: 'ai', retryLimit: 5 });
  await restart(idb);
  assert.equal((await Storage.get('surveys', 's1')).title, 'T');
  assert.deepEqual((await Storage.listRespondents('s1')).map((r) => r.id), ['SYN-0001', 'SYN-0002']);
  assert.equal((await Storage.listLogs()).length, 1);
  const s = await Storage.getSettings();
  assert.equal(s.mode, 'ai'); assert.equal(s.retryLimit, 5); assert.equal(s.theme, 'system');   // stored + default
});

test('settings ignore unknown keys and always fall back to defaults', async () => {
  await fresh();
  await Storage.setSettings({ bogus: 1, theme: 'dark' });
  const s = await Storage.getSettings();
  assert.equal(s.theme, 'dark'); assert.equal('bogus' in s, false); assert.equal(s.mode, 'local');
});

test('migration v1 -> v2 keeps data, adds diagnostics store and backfills respondent source', async () => {
  const idb = new IDBFactory(), name = 'sp-migrate';
  await new Promise((resolve, reject) => {          // build a genuine version-1 database by hand
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => Storage.MIGRATIONS[1](req.result, req.transaction);
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction('respondents', 'readwrite');
      tx.objectStore('respondents').put({ id: 'old1', index: 0, surveyId: 's', profile: {}, answers: {} });   // no `source` in v1
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  Storage.close(); Storage._opening = null;
  const db = await Storage.open({ indexedDB: idb, name });
  assert.equal(db.version, 2);
  assert.ok(db.objectStoreNames.contains('diagnostics'));
  const r = await Storage.get('respondents', 'old1');
  assert.equal(r.source, 'local');
  await Storage.put('diagnostics', { id: 'd1', ts: 1 });
  assert.equal((await Storage.getAll('diagnostics')).length, 1);
});

test('backup -> clear -> restore round trip (replace) and merge keep every record', async () => {
  await fresh();
  await Storage.put('surveys', { id: 's1', questions: [] });
  await Storage.putMany('respondents', [resp('A'), resp('B', { index: 1 })]);
  await Storage.putMany('runs', [{ id: 'run1', status: 'completed', startedAt: 1 }]);
  await Storage.putMany('runRecords', [{ id: 'rec1', runId: 'run1', respondentId: 'A', status: 'Completed', startedAt: 2 }]);
  await Storage.appendLog({ action: 'one' }); await Storage.appendLog({ action: 'two' });
  await Storage.setApiKey('AIzaSyD-FAKE_KEY_1234567890abcdefghij');
  const backup = Exp.buildBackup(await Storage.dumpAll());
  const json = JSON.stringify(backup);
  assert.ok(!json.includes('FAKE_KEY'), 'backup must not contain the API key');
  await Storage.clearAllData();
  assert.equal(await Storage.count('respondents'), 0);
  Exp.validateBackup(JSON.parse(json));
  await Storage.restoreAll(JSON.parse(json), 'replace');
  assert.deepEqual((await Storage.listRespondents()).map((r) => r.id), ['A', 'B']);
  assert.equal((await Storage.listRunRecords('run1')).length, 1);
  assert.equal((await Storage.listLogs()).length, 2);
  await Storage.restoreAll(JSON.parse(json), 'merge');            // merge twice must not duplicate keyed data
  assert.equal(await Storage.count('respondents'), 2);
  assert.equal(await Storage.getApiKey(), 'AIzaSyD-FAKE_KEY_1234567890abcdefghij', 'restore must not touch the stored key');
});

test('restore (replace) removes data that is not in the backup', async () => {
  await fresh();
  await Storage.putMany('respondents', [resp('keep'), resp('extra', { index: 1 })]);
  const b = Exp.buildBackup({ respondents: [resp('keep')] });
  await Storage.restoreAll(b, 'replace');
  assert.deepEqual((await Storage.listRespondents()).map((r) => r.id), ['keep']);
});

test('purgeOld removes old logs/diagnostics only; 0 keeps everything', async () => {
  await fresh();
  const now = 1_000_000_000_000, day = 86400000;
  await Storage.put('logs', { ts: now - 40 * day, action: 'old' }); await Storage.put('logs', { ts: now - 1 * day, action: 'new' });
  await Storage.put('diagnostics', { id: 'old', ts: now - 40 * day }); await Storage.put('diagnostics', { id: 'new', ts: now });
  assert.deepEqual(await Storage.purgeOld(0, now), { logs: 0, diagnostics: 0 });
  assert.equal(await Storage.count('logs'), 2);
  assert.deepEqual(await Storage.purgeOld(30, now), { logs: 1, diagnostics: 1 });
  assert.deepEqual((await Storage.listLogs()).map((l) => l.action), ['new']);
});

test('log filters: level, text, respondent', async () => {
  await fresh();
  await Storage.appendLog({ action: 'Question filled', respondentId: 'A', level: 'info' });
  await Storage.appendLog({ action: 'Question failed', respondentId: 'B', level: 'error', error: 'timeout' });
  assert.equal((await Storage.listLogs({ level: 'error' })).length, 1);
  assert.equal((await Storage.listLogs({ respondentId: 'A' })).length, 1);
  assert.equal((await Storage.listLogs({ text: 'TIMEOUT' })).length, 1);
  assert.equal((await Storage.listLogs({ text: 'nothing' })).length, 0);
});

test('storage errors are typed StorageError, reported through onError, and not swallowed', async () => {
  await fresh();
  const seen = [];
  Storage.onError = (e) => seen.push(e);
  await assert.rejects(Storage.put('respondents', { id: 'bad', fn() {} }), (e) => e.name === 'StorageError' && e.code === 'FAILED');
  await assert.rejects(Storage.put('no-such-store', { id: 1 }), (e) => e.name === 'StorageError');
  assert.equal(seen.length, 2);
  Storage.onError = null;
  assert.equal(await Storage.count('respondents'), 0, 'failed writes must not leave partial data');
});

test('opening without IndexedDB gives an actionable error', async () => {
  Storage.close(); Storage._opening = null;
  const saved = globalThis.indexedDB; delete globalThis.indexedDB;
  try {
    await assert.rejects(Storage.open({ indexedDB: undefined, name: 'x' }), (e) => e.code === 'UNAVAILABLE' && /not available/.test(e.message));
  } finally { if (saved) globalThis.indexedDB = saved; }
});

test('API key helpers: maskKey never reveals the middle of the key', () => {
  const m = Storage.maskKey('AIzaSyD-FAKE_KEY_1234567890abcdefghij');
  assert.ok(m.length < 10 && !m.includes('FAKE'));
  assert.equal(Storage.maskKey(''), ''); assert.equal(Storage.maskKey('short'), '********');
});

test('clearAllData empties every store', async () => {
  await fresh();
  await Storage.put('surveys', { id: 's' }); await Storage.put('respondents', resp('x')); await Storage.appendLog({ action: 'a' }); await Storage.setSettings({ theme: 'dark' });
  await Storage.clearAllData();
  for (const n of ['surveys', 'respondents', 'runs', 'runRecords', 'logs', 'diagnostics', 'settings']) assert.equal(await Storage.count(n), 0, n);
});
