/*
 * SurveyPilot AI - Storage Module
 * IndexedDB-backed persistent storage for surveys, respondents, runs, logs,
 * diagnostics, and settings. Survives Chrome restarts and extension reloads.
 *
 * Works in: content scripts (window), service worker (self), side panel/options (window).
 */
(function (global) {
  'use strict';

  const DB_NAME = 'surveypilot_ai';
  const DB_VERSION = 2;

  const STORES = {
    surveys: { keyPath: 'id', indexes: ['url', 'detectedAt'] },
    respondents: { keyPath: 'id', indexes: ['generatedAt', 'surveyId', 'profile.region'] },
    runs: { keyPath: 'id', indexes: ['startedAt', 'status', 'destinationUrl'] },
    logs: { keyPath: 'id', indexes: ['timestamp', 'runId', 'respondentId'] },
    diagnostics: { keyPath: 'id', indexes: ['timestamp', 'runId', 'respondentId'] },
    settings: { keyPath: 'key' }
  };

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const oldVersion = event.oldVersion;
        // Migration: create stores that don't exist
        for (const [name, spec] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: spec.keyPath });
            (spec.indexes || []).forEach((idx) => {
              const idxName = String(idx).replace(/\./g, '_');
              store.createIndex(idxName, idx, { unique: false });
            });
          }
        }
        // Version bumps for future migrations
        if (oldVersion < 1) {
          // initial schema
        }
        if (oldVersion < 2) {
          // added diagnostics store (idempotent above)
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    });
    return _dbPromise;
  }

  function _tx(storeName, mode) {
    return openDB().then((db) => {
      const tx = db.transaction(storeName, mode);
      return tx.objectStore(storeName);
    });
  }

  function _reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function put(storeName, value) {
    const store = await _tx(storeName, 'readwrite');
    await _reqToPromise(store.put(value));
    return value;
  }

  async function get(storeName, key) {
    const store = await _tx(storeName, 'readonly');
    return _reqToPromise(store.get(key));
  }

  async function getAll(storeName) {
    const store = await _tx(storeName, 'readonly');
    return _reqToPromise(store.getAll());
  }

  async function del(storeName, key) {
    const store = await _tx(storeName, 'readwrite');
    return _reqToPromise(store.delete(key));
  }

  async function clearStore(storeName) {
    const store = await _tx(storeName, 'readwrite');
    return _reqToPromise(store.clear());
  }

  async function count(storeName) {
    const store = await _tx(storeName, 'readonly');
    return _reqToPromise(store.count());
  }

  async function queryByIndex(storeName, indexName, value) {
    const store = await _tx(storeName, 'readonly');
    const idx = store.index(String(indexName).replace(/\./g, '_'));
    return _reqToPromise(idx.getAll(value));
  }

  // Settings helpers (key/value store)
  async function getSetting(key, defaultValue) {
    try {
      const rec = await get('settings', key);
      return rec ? rec.value : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  }

  async function setSetting(key, value) {
    return put('settings', { key, value, updatedAt: Date.now() });
  }

  async function getAllSettings() {
    const rows = await getAll('settings');
    const out = {};
    rows.forEach((r) => { out[r.key] = r.value; });
    return out;
  }

  // Backup / restore (JSON dump)
  async function backup() {
    const out = { db: DB_NAME, version: DB_VERSION, exportedAt: new Date().toISOString(), data: {} };
    for (const name of Object.keys(STORES)) {
      out.data[name] = await getAll(name);
    }
    return out;
  }

  async function restore(payload, { replace } = { replace: false }) {
    if (!payload || !payload.data) throw new Error('Invalid backup payload');
    for (const name of Object.keys(STORES)) {
      if (!payload.data[name]) continue;
      if (replace) {
        await clearStore(name);
      }
      const store = await _tx(name, 'readwrite');
      for (const row of payload.data[name]) {
        store.put(row);
      }
      await _reqToPromise(store.transaction ? store.transaction.done : { onsuccess: null });
    }
    return true;
  }

  async function clearAll() {
    for (const name of Object.keys(STORES)) {
      await clearStore(name);
    }
    return true;
  }

  async function usage() {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return { usageBytes: est.usage, quotaBytes: est.quota };
    }
    return { usageBytes: null, quotaBytes: null };
  }

  const Storage = {
    DB_NAME,
    DB_VERSION,
    STORES,
    openDB,
    put,
    get,
    getAll,
    del,
    clearStore,
    count,
    queryByIndex,
    getSetting,
    setSetting,
    getAllSettings,
    backup,
    restore,
    clearAll,
    usage
  };

  global.SurveyPilot = global.SurveyPilot || {};
  global.SurveyPilot.Storage = Storage;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
