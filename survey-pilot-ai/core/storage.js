/* SurveyPilot AI - IndexedDB persistence with versioned migrations and typed storage errors.
   The Gemini API key is NOT stored in IndexedDB: it lives in chrome.storage.local so it is never
   included in backups, exports or log dumps. */
(function (root, factory) {
  var dep = (typeof require === 'function' && typeof module === 'object') ? require('./util.js') : root.SP;
  var api = factory(dep.Util, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  var SP = (root.SP = root.SP || {});
  Object.keys(api).forEach(function (k) { SP[k] = api[k]; });
})(typeof globalThis !== 'undefined' ? globalThis : self, function (Util, root) {
  'use strict';

  var DB_NAME = 'surveypilot';
  var DB_VERSION = 2;

  var DEFAULT_SETTINGS = {
    mode: 'local',                 // 'local' | 'ai'
    model: 'gemini-2.5-flash',
    autoFallback: true,            // fall back to local generation when AI fails
    aiRetries: 3,
    aiTimeoutMs: 30000,
    defaultRespondentCount: 10,
    defaultBatchSize: 10,
    retryLimit: 2,
    delayBetweenRunsMs: 3000,
    delayBetweenActionsMs: 150,
    navigationTimeoutMs: 8000,
    theme: 'system',               // 'system' | 'light' | 'dark'
    language: 'en',                // language of generated text answers
    retentionDays: 30,             // 0 = keep forever (logs and diagnostics)
    csvDelimiter: ',',
    exportIncludeProfile: true,
    exportFilenamePrefix: 'surveypilot',
    diagnosticLogging: false,      // verbose logging of every question
    captureScreenshots: true,
    generatorConfig: null          // last used respondent generator configuration
  };

  /* Each migration upgrades the schema from version n-1 to n. They must be idempotent. */
  var MIGRATIONS = {
    1: function (db) {
      db.createObjectStore('settings', { keyPath: 'key' });
      db.createObjectStore('surveys', { keyPath: 'id' });
      var r = db.createObjectStore('respondents', { keyPath: 'id' });
      r.createIndex('surveyId', 'surveyId', { unique: false });
      db.createObjectStore('runs', { keyPath: 'id' });
      var rr = db.createObjectStore('runRecords', { keyPath: 'id' });
      rr.createIndex('runId', 'runId', { unique: false });
      var logs = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
      logs.createIndex('ts', 'ts', { unique: false });
    },
    2: function (db, tx) {
      if (!db.objectStoreNames.contains('diagnostics')) {
        var d = db.createObjectStore('diagnostics', { keyPath: 'id' });
        d.createIndex('ts', 'ts', { unique: false });
      }
      var resp = tx.objectStore('respondents');
      if (!resp.indexNames.contains('source')) resp.createIndex('source', 'source', { unique: false });
      var logs = tx.objectStore('logs');
      if (!logs.indexNames.contains('runId')) logs.createIndex('runId', 'runId', { unique: false });
      // Data migration: records written by v1 had no `source`; mark them as local.
      var req = resp.openCursor();
      req.onsuccess = function () {
        var c = req.result; if (!c) return;
        var v = c.value; if (!v.source) { v.source = 'local'; c.update(v); }
        c.continue();
      };
    }
  };

  function StorageError(code, message, cause) {
    var e = new Error(message);
    e.name = 'StorageError'; e.code = code; e.cause = cause;
    return e;
  }

  function wrapError(err, action) {
    if (err && err.name === 'StorageError') return err;
    var name = err && err.name || '';
    if (name === 'QuotaExceededError') return StorageError('QUOTA', 'Browser storage is full while ' + action + '. Export a backup and clear old data.', err);
    if (name === 'VersionError') return StorageError('VERSION', 'Stored data is from a newer version of SurveyPilot AI.', err);
    if (name === 'InvalidStateError' || name === 'SecurityError') return StorageError('UNAVAILABLE', 'Browser storage is unavailable while ' + action + ' (' + name + ').', err);
    return StorageError('FAILED', 'Storage error while ' + action + ': ' + (err && err.message || err), err);
  }

  var Storage = {
    DB_NAME: DB_NAME, DB_VERSION: DB_VERSION, DEFAULT_SETTINGS: DEFAULT_SETTINGS, MIGRATIONS: MIGRATIONS,
    StorageError: StorageError,
    _db: null, _idb: null, _dbName: DB_NAME,
    /** Hook for UI/service worker: called with every StorageError. */
    onError: null,

    /** opts: { indexedDB, name } - injectable for tests. */
    open: function (opts) {
      opts = opts || {};
      var idb = opts.indexedDB || root.indexedDB;
      if (!idb) return Promise.reject(StorageError('UNAVAILABLE', 'IndexedDB is not available in this context.'));
      Storage._idb = idb; Storage._dbName = opts.name || DB_NAME;
      if (Storage._db) return Promise.resolve(Storage._db);
      if (Storage._opening) return Storage._opening;
      Storage._opening = new Promise(function (resolve, reject) {
        var req;
        try { req = idb.open(Storage._dbName, DB_VERSION); } catch (e) { return reject(wrapError(e, 'opening the database')); }
        req.onupgradeneeded = function (ev) {
          var db = req.result, tx = req.transaction;
          for (var v = ev.oldVersion + 1; v <= (ev.newVersion || DB_VERSION); v++) {
            if (MIGRATIONS[v]) MIGRATIONS[v](db, tx);
          }
        };
        req.onblocked = function () { reject(StorageError('BLOCKED', 'The database upgrade is blocked by another open SurveyPilot tab. Close other extension pages and retry.')); };
        req.onerror = function () { reject(wrapError(req.error, 'opening the database')); };
        req.onsuccess = function () {
          var db = req.result;
          db.onversionchange = function () { db.close(); Storage._db = null; };
          Storage._db = db; resolve(db);
        };
      }).then(function (db) { Storage._opening = null; return db; }, function (e) { Storage._opening = null; Storage._report(e); throw e; });
      return Storage._opening;
    },

    close: function () { if (Storage._db) { Storage._db.close(); Storage._db = null; } },

    _report: function (e) { try { if (Storage.onError) Storage.onError(e); } catch (ignored) { /* a failing error hook must not hide the storage error */ } },

    _tx: function (stores, mode, fn, action) {
      return Storage.open({ indexedDB: Storage._idb, name: Storage._dbName }).then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx;
          try { tx = db.transaction(stores, mode); } catch (e) { return reject(wrapError(e, action)); }
          var result;
          tx.oncomplete = function () { resolve(result); };
          tx.onerror = function () { reject(wrapError(tx.error, action)); };
          tx.onabort = function () { reject(wrapError(tx.error, action)); };
          try { result = fn(tx); } catch (e) { try { tx.abort(); } catch (e2) { /* already finished */ } reject(wrapError(e, action)); }
        });
      }).catch(function (e) { var w = wrapError(e, action); Storage._report(w); throw w; });
    },

    _reqP: function (req) {
      return new Promise(function (resolve, reject) {
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    },

    get: function (store, key) {
      var out;
      return Storage._tx(store, 'readonly', function (tx) { var r = tx.objectStore(store).get(key); r.onsuccess = function () { out = r.result; }; }, 'reading ' + store).then(function () { return out; });
    },
    getAll: function (store) {
      var out;
      return Storage._tx(store, 'readonly', function (tx) { var r = tx.objectStore(store).getAll(); r.onsuccess = function () { out = r.result; }; }, 'reading ' + store).then(function () { return out || []; });
    },
    getAllByIndex: function (store, index, value) {
      var out;
      return Storage._tx(store, 'readonly', function (tx) { var r = tx.objectStore(store).index(index).getAll(value); r.onsuccess = function () { out = r.result; }; }, 'reading ' + store).then(function () { return out || []; });
    },
    put: function (store, value) {
      var key;
      return Storage._tx(store, 'readwrite', function (tx) { var r = tx.objectStore(store).put(value); r.onsuccess = function () { key = r.result; }; }, 'saving to ' + store).then(function () { return key; });
    },
    putMany: function (store, values) {
      if (!values.length) return Promise.resolve();
      return Storage._tx(store, 'readwrite', function (tx) { var s = tx.objectStore(store); values.forEach(function (v) { s.put(v); }); }, 'saving to ' + store);
    },
    delete: function (store, key) {
      return Storage._tx(store, 'readwrite', function (tx) { tx.objectStore(store).delete(key); }, 'deleting from ' + store);
    },
    deleteMany: function (store, keys) {
      if (!keys.length) return Promise.resolve();
      return Storage._tx(store, 'readwrite', function (tx) { var s = tx.objectStore(store); keys.forEach(function (k) { s.delete(k); }); }, 'deleting from ' + store);
    },
    clear: function (store) {
      return Storage._tx(store, 'readwrite', function (tx) { tx.objectStore(store).clear(); }, 'clearing ' + store);
    },
    count: function (store) {
      var n = 0;
      return Storage._tx(store, 'readonly', function (tx) { var r = tx.objectStore(store).count(); r.onsuccess = function () { n = r.result; }; }, 'counting ' + store).then(function () { return n; });
    },

    /* ---------- settings ---------- */
    getSettings: function () {
      return Storage.getAll('settings').then(function (rows) {
        var s = Object.assign({}, DEFAULT_SETTINGS);
        rows.forEach(function (r) { if (r.key in DEFAULT_SETTINGS) s[r.key] = r.value; });
        return s;
      });
    },
    setSettings: function (partial) {
      var rows = Object.keys(partial).filter(function (k) { return k in DEFAULT_SETTINGS; }).map(function (k) { return { key: k, value: partial[k] }; });
      return Storage.putMany('settings', rows);
    },

    /* ---------- API key (kept outside IndexedDB and outside every export) ---------- */
    _memKey: '',
    getApiKey: function () {
      var c = root.chrome;
      if (c && c.storage && c.storage.local) {
        return new Promise(function (resolve, reject) {
          c.storage.local.get('spApiKey', function (r) {
            if (c.runtime && c.runtime.lastError) return reject(StorageError('FAILED', 'Could not read the API key: ' + c.runtime.lastError.message));
            resolve((r && r.spApiKey) || '');
          });
        });
      }
      return Promise.resolve(Storage._memKey);
    },
    setApiKey: function (key) {
      var c = root.chrome;
      key = String(key || '').trim();
      if (c && c.storage && c.storage.local) {
        return new Promise(function (resolve, reject) {
          var done = function () { if (c.runtime && c.runtime.lastError) reject(StorageError('FAILED', 'Could not save the API key: ' + c.runtime.lastError.message)); else resolve(); };
          if (key) c.storage.local.set({ spApiKey: key }, done); else c.storage.local.remove('spApiKey', done);
        });
      }
      Storage._memKey = key; return Promise.resolve();
    },
    maskKey: function (key) {
      if (!key) return '';
      return key.length <= 8 ? '********' : key.slice(0, 4) + '…' + key.slice(-2);
    },

    /* ---------- domain helpers ---------- */
    listRespondents: function (surveyId) {
      var p = surveyId ? Storage.getAllByIndex('respondents', 'surveyId', surveyId) : Storage.getAll('respondents');
      return p.then(function (rows) { return rows.sort(function (a, b) { return (a.index || 0) - (b.index || 0); }); });
    },
    listRunRecords: function (runId) {
      return Storage.getAllByIndex('runRecords', 'runId', runId).then(function (rows) { return rows.sort(function (a, b) { return a.startedAt - b.startedAt; }); });
    },
    appendLog: function (entry) {
      var e = Object.assign({ ts: Util.now(), level: 'info' }, entry);
      return Storage.put('logs', e);
    },
    listLogs: function (filter) {
      filter = filter || {};
      return Storage.getAll('logs').then(function (rows) {
        return rows.filter(function (l) {
          if (filter.runId && l.runId !== filter.runId) return false;
          if (filter.respondentId && l.respondentId !== filter.respondentId) return false;
          if (filter.level && l.level !== filter.level) return false;
          if (filter.text) {
            var t = filter.text.toLowerCase();
            if ((l.action + ' ' + (l.question || '') + ' ' + (l.result || '') + ' ' + (l.error || '')).toLowerCase().indexOf(t) < 0) return false;
          }
          return true;
        }).sort(function (a, b) { return a.ts - b.ts || (a.id - b.id); });
      });
    },

    /** Deletes logs and diagnostics older than `days` (0 = keep forever). Returns removed counts. */
    purgeOld: function (days, now) {
      if (!days || days <= 0) return Promise.resolve({ logs: 0, diagnostics: 0 });
      var cutoff = (now == null ? Util.now() : now) - days * 86400000;
      return Promise.all([Storage.getAll('logs'), Storage.getAll('diagnostics')]).then(function (res) {
        var oldLogs = res[0].filter(function (l) { return l.ts < cutoff; }).map(function (l) { return l.id; });
        var oldDiag = res[1].filter(function (d) { return d.ts < cutoff; }).map(function (d) { return d.id; });
        return Promise.all([Storage.deleteMany('logs', oldLogs), Storage.deleteMany('diagnostics', oldDiag)])
          .then(function () { return { logs: oldLogs.length, diagnostics: oldDiag.length }; });
      });
    },

    /** Reads every store (API key excluded by construction). */
    dumpAll: function () {
      var names = ['surveys', 'respondents', 'runs', 'runRecords', 'logs', 'diagnostics', 'settings'];
      return Promise.all(names.map(function (n) { return Storage.getAll(n); })).then(function (res) {
        var out = {}; names.forEach(function (n, i) { out[n] = res[i]; }); return out;
      });
    },

    /** mode: 'replace' wipes every store first; 'merge' upserts by key. */
    restoreAll: function (backup, mode) {
      var data = backup.data, names = ['surveys', 'respondents', 'runs', 'runRecords', 'diagnostics', 'settings', 'logs'];
      var chain = Promise.resolve();
      if (mode === 'replace') names.forEach(function (n) { chain = chain.then(function () { return Storage.clear(n); }); });
      names.forEach(function (n) {
        chain = chain.then(function () {
          var rows = (data[n] || []).map(function (r) { return Util.clone(r); });
          if (n === 'respondents') rows.forEach(function (r) { if (!r.source) r.source = 'local'; });
          if (n === 'settings') rows = rows.filter(function (r) { return r.key !== 'apiKey'; });
          if (n === 'logs' && mode === 'merge') rows.forEach(function (r) { delete r.id; });
          return Storage.putMany(n, rows);
        });
      });
      return chain;
    },

    clearAllData: function () {
      var names = ['surveys', 'respondents', 'runs', 'runRecords', 'logs', 'diagnostics', 'settings'];
      return names.reduce(function (p, n) { return p.then(function () { return Storage.clear(n); }); }, Promise.resolve());
    }
  };

  return { Storage: Storage };
});
