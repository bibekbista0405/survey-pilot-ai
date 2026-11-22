/* SurveyPilot AI - MV3 service worker: wires the run engine to the real Chrome APIs and answers panel commands. */
importScripts('../core/util.js', '../core/survey-parser.js', '../core/respondent-generator.js', '../core/ai-client.js',
  '../core/answer-generator.js', '../core/storage.js', '../core/statistics.js', 'run-engine.js');

(function () {
  'use strict';
  var SP = self.SP, Util = SP.Util, Storage = SP.Storage;
  var CONTENT_FILES = ['core/util.js', 'core/survey-parser.js', 'content/form-detector.js', 'content/form-reader.js',
    'content/validation.js', 'content/form-filler.js', 'content/form-navigation.js', 'content/content-main.js'];

  var keepAliveTimer = null;
  function keepAlive(on) {
    if (on && !keepAliveTimer) keepAliveTimer = setInterval(function () { chrome.runtime.getPlatformInfo(function () { /* touching an extension API resets the idle timer */ }); }, 20000);
    if (!on && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  }

  function tabGet(tabId) {
    return new Promise(function (resolve) {
      chrome.tabs.get(tabId, function (tab) {
        // A closed tab is an expected condition, reported as null so the engine can raise TAB_CLOSED.
        if (chrome.runtime.lastError) return resolve(null);
        resolve(tab);
      });
    });
  }

  function rawSend(tabId, msg) {
    return new Promise(function (resolve, reject) {
      chrome.tabs.sendMessage(tabId, msg, function (res) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(res);
      });
    });
  }

  /** Sends to the content script; injects it once when the tab was opened before the extension was loaded. */
  function sendToTab(tabId, msg) {
    return rawSend(tabId, msg).catch(function (err) {
      if (!/Receiving end does not exist|Could not establish connection/i.test(err.message)) throw err;
      return new Promise(function (resolve, reject) {
        chrome.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_FILES }, function () {
          if (chrome.runtime.lastError) return reject(new Error('Cannot attach to this page: ' + chrome.runtime.lastError.message + ' (for file:// pages enable "Allow access to file URLs" in chrome://extensions).'));
          resolve();
        });
      }).then(function () { return rawSend(tabId, msg); });
    });
  }

  function waitComplete(tabId, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function finish(err) { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); err ? reject(err) : resolve(); }
      function listener(id, info) { if (id === tabId && info.status === 'complete') finish(); }
      var timer = setTimeout(function () { finish(new Error('Page load timed out after ' + Math.round(timeoutMs / 1000) + ' s.')); }, timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
      tabGet(tabId).then(function (t) { if (t && t.status === 'complete' && !t.pendingUrl) { /* may be the old page; wait for the update event instead */ } });
    });
  }

  var env = {
    getTab: tabGet,
    sendToTab: sendToTab,
    navigate: function (tabId, url) {
      return tabGet(tabId).then(function (tab) {
        var p = waitComplete(tabId, 20000);
        if (tab && tab.url === url) chrome.tabs.reload(tabId, { bypassCache: true }); else chrome.tabs.update(tabId, { url: url });
        return p;
      });
    },
    waitForContent: function (tabId, timeoutMs) {
      var deadline = Util.mono() + timeoutMs;
      return (function poll() {
        return sendToTab(tabId, { target: 'sp-content', type: 'ping' }).then(function (r) {
          if (r && r.ok && r.ready) return true;
          throw new Error('not ready');
        }).catch(function () {
          if (Util.mono() > deadline) return false;
          return Util.sleep(250).then(poll);
        });
      })();
    },
    screenshot: function (tabId) {
      return tabGet(tabId).then(function (tab) {
        if (!tab) return null;
        return new Promise(function (resolve, reject) {
          chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 50 }, function (data) {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve(data);
          });
        });
      });
    },
    broadcast: function (event) {
      if (event.type === 'run') keepAlive(event.run && event.run.status === 'running');
      var p = chrome.runtime.sendMessage({ sp: 'event', event: event });
      // "No receiving end" simply means the side panel is closed; state is in storage, so nothing is lost.
      if (p && p.catch) p.catch(function () { /* side panel closed */ });
    },
    getApiKey: function () { return Storage.getApiKey(); }
  };

  var engine = new SP.RunEngine(env);
  Storage.onError = function (e) { env.broadcast({ type: 'storageError', message: e.message }); };

  var ready = Storage.open().then(function () { return engine.restore(); }).then(function () {
    return Storage.getSettings().then(function (s) { return Storage.purgeOld(s.retentionDays); });
  }).then(function () { if (engine.run && engine.run.status === 'running') keepAlive(true); })
    .catch(function (err) { console.error('SurveyPilot startup failed:', err); env.broadcast({ type: 'storageError', message: err.message }); });

  function commands(msg, sender) {
    switch (msg.cmd) {
      case 'run.start': return engine.start(msg.options).then(function (run) { return { run: run }; });
      case 'run.pause': return engine.pause().then(function () { return { run: engine.run }; });
      case 'run.resume': return engine.resume().then(function () { return { run: engine.run }; });
      case 'run.stop': return engine.stop().then(function () { return { run: engine.run }; });
      case 'run.skip': return engine.skip().then(function () { return {}; });
      case 'run.retry': return engine.retry(msg.respondentId).then(function () { return { run: engine.run }; });
      case 'run.reset': return engine.reset().then(function () { return {}; });
      case 'run.state': return Promise.resolve({ run: engine.run, active: engine.loopActive });
      case 'fill.start': return engine.fillActive(msg.options).then(function (s) { return { summary: s }; });
      case 'tab.send': return sendToTab(msg.tabId, Object.assign({ target: 'sp-content' }, msg.message)).then(function (r) { return { response: r }; });
      case 'tab.info': return tabGet(msg.tabId).then(function (t) { return { tab: t ? { id: t.id, url: t.url, title: t.title, status: t.status } : null }; });
      case 'panel.open':
        return new Promise(function (resolve, reject) {
          chrome.sidePanel.open({ tabId: msg.tabId }, function () { if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve({}); });
        });
      default: return Promise.reject(Object.assign(new Error('Unknown command: ' + msg.cmd), { code: 'UNKNOWN_COMMAND' }));
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.sp !== 'cmd') return false;
    ready.then(function () { return commands(msg, sender); }).then(function (r) { sendResponse(Object.assign({ ok: true }, r)); },
      function (err) { sendResponse({ ok: false, code: err.code || 'ERROR', error: Util.redact(err.message, []) }); });
    return true;
  });

  chrome.runtime.onInstalled.addListener(function () {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }, function () { /* popup opens the panel */ });
  });
})();
