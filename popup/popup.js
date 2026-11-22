/* SurveyPilot AI - toolbar popup: shows detection status of the active tab and opens the side panel. */
(function () {
  'use strict';
  var Storage = window.SP.Storage;

  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function send(msg) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(msg, function (res) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.ok) return reject(new Error((res && res.error) || 'No answer from the extension.'));
        resolve(res);
      });
    });
  }
  function activeTab() { return new Promise(function (r) { chrome.tabs.query({ active: true, currentWindow: true }, function (t) { r(t && t[0]); }); }); }

  async function init() {
    try { var s = await (Storage.open().then(Storage.getSettings)); document.documentElement.setAttribute('data-theme', s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'); }
    catch (e) { console.error('popup theme failed', e); }
    var box = document.getElementById('status'); box.textContent = '';
    var tab = await activeTab();
    if (!tab) { box.appendChild(h('div', 'muted', 'No active tab.')); return; }
    // sidePanel.open() must run synchronously inside the click handler (user gesture); it cannot go through the service worker.
    document.getElementById('open-panel').onclick = function () {
      try {
        chrome.sidePanel.open({ tabId: tab.id }).then(function () { window.close(); }).catch(function (e) {
          box.appendChild(h('div', 'banner err', 'Could not open the side panel: ' + e.message));
        });
      } catch (e) { box.appendChild(h('div', 'banner err', 'Could not open the side panel: ' + e.message)); }
    };
    document.getElementById('open-settings').onclick = function () { chrome.runtime.openOptionsPage(); window.close(); };
    if (!/^(https?|file):/i.test(tab.url || '')) { box.appendChild(h('div', 'banner warn', 'This page cannot be scanned. Open a survey form in a normal tab.')); return; }
    try {
      var r = await send({ sp: 'cmd', cmd: 'tab.send', tabId: tab.id, message: { type: 'detect' } });
      if (!r.response || !r.response.ok) throw new Error((r.response && r.response.error) || 'The page did not answer.');
      var d = r.response.detection;
      var chip = h('span', 'chip ' + (d.status === 'supported' ? 'ok' : d.status === 'partial' ? 'warn' : 'err'), d.status === 'supported' ? 'Supported' : d.status === 'partial' ? 'Partially supported' : 'Unsupported');
      var top = h('div', 'row spread'); top.appendChild(h('strong', null, d.status === 'unsupported' ? 'No survey detected' : (d.title || 'Form'))); top.appendChild(chip);
      box.appendChild(top);
      if (d.status === 'unsupported') box.appendChild(h('div', 'small muted', d.reason));
      else {
        var kv = h('div', 'kv');
        [['Kind', d.kind === 'google-forms' ? 'Google Forms' : 'HTML form'], ['Questions', String(d.questionCount)], ['Sections', String(d.sectionCount)], ['Required', String(d.requiredCount)]].forEach(function (p) { kv.appendChild(h('div', 'k', p[0])); kv.appendChild(h('div', null, p[1])); });
        box.appendChild(kv);
      }
    } catch (e) {
      box.appendChild(h('div', 'banner warn', /Receiving end|Cannot attach|Could not establish/i.test(e.message) ? 'Reload this tab so SurveyPilot can read it.' : e.message));
    }
  }
  init().catch(function (e) { document.getElementById('status').textContent = 'Error: ' + e.message; });
})();
