/* SurveyPilot AI - settings page. */
(function () {
  'use strict';
  var SP = window.SP, Util = SP.Util, Storage = SP.Storage, AI = SP.AI, Exp = SP.Export;
  var settings = null, models = AI.DEFAULT_MODELS.slice();

  function $(id) { return document.getElementById(id); }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]); else if (k === 'class') el.className = attrs[k]; else el.setAttribute(k, attrs[k]); });
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return el;
  }
  function toast(msg, kind) { var t = h('div', { class: 'toast ' + (kind || ''), role: 'status' }, msg); $('toasts').appendChild(t); setTimeout(function () { t.remove(); }, kind === 'err' ? 7000 : 3200); }
  function banner(msg) { var b = $('banner'); b.textContent = ''; if (msg) b.appendChild(h('div', { class: 'banner err', role: 'alert' }, msg)); }

  function choiceDialog(title, message, choices) {
    return new Promise(function (resolve) {
      var d = $('dialog'); d.textContent = '';
      d.appendChild(h('div', { class: 'stack' }, h('h2', {}, title), h('p', { style: 'margin:0' }, message),
        h('div', { class: 'row', style: 'justify-content:flex-end;flex-wrap:wrap' }, choices.map(function (c) {
          return h('button', { class: 'btn ' + (c.cls || ''), type: 'button', onclick: function () { d.close(c.value); } }, c.label); }))));
      d.onclose = function () { resolve(d.returnValue || 'cancel'); };
      d.showModal();
    });
  }

  function applyTheme() {
    var t = settings.theme, dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  function fillModelSelect() {
    var sel = $('modelSelect'); sel.textContent = '';
    var cur = settings.model;
    var list = models.slice(); if (cur && list.indexOf(cur) < 0) list.unshift(cur);
    list.forEach(function (m) { var o = h('option', { value: m }, m); if (m === cur) o.selected = true; sel.appendChild(o); });
  }

  async function updateKeyState() {
    var key = await Storage.getApiKey();
    $('key-state').textContent = key ? 'A key is saved (' + Storage.maskKey(key) + ').' : 'No key saved.';
  }

  async function updateCounts() {
    var names = ['surveys', 'respondents', 'runs', 'runRecords', 'logs', 'diagnostics'];
    var counts = await Promise.all(names.map(function (n) { return Storage.count(n); }));
    $('data-counts').textContent = names.map(function (n, i) { return counts[i] + ' ' + n; }).join(' · ');
  }

  function load() {
    $('mode').value = settings.mode; $('autoFallback').checked = settings.autoFallback; $('aiRetries').value = settings.aiRetries;
    $('aiTimeoutS').value = Math.round(settings.aiTimeoutMs / 1000); $('language').value = settings.language;
    ['defaultRespondentCount', 'defaultBatchSize', 'retryLimit', 'delayBetweenRunsMs', 'delayBetweenActionsMs', 'navigationTimeoutMs', 'retentionDays', 'exportFilenamePrefix'].forEach(function (k) { $(k).value = settings[k]; });
    $('theme').value = settings.theme; $('csvDelimiter').value = settings.csvDelimiter;
    ['exportIncludeProfile', 'diagnosticLogging', 'captureScreenshots'].forEach(function (k) { $(k).checked = settings[k]; });
    fillModelSelect(); applyTheme();
  }

  function num(id, lo, hi, label) {
    var v = Number($(id).value);
    if (!isFinite(v) || v < lo || v > hi) throw new Error(label + ' must be between ' + lo + ' and ' + hi + '.');
    return Math.round(v);
  }

  async function save(e) {
    e.preventDefault();
    try {
      var next = {
        mode: $('mode').value, autoFallback: $('autoFallback').checked,
        model: ($('modelCustom').value.trim() || $('modelSelect').value || settings.model),
        aiRetries: num('aiRetries', 0, 8, 'AI retries'), aiTimeoutMs: num('aiTimeoutS', 5, 180, 'AI timeout') * 1000, language: $('language').value,
        defaultRespondentCount: num('defaultRespondentCount', 1, 500, 'Respondent count'), defaultBatchSize: num('defaultBatchSize', 1, 50, 'Batch size'),
        retryLimit: num('retryLimit', 0, 10, 'Retry limit'), delayBetweenRunsMs: num('delayBetweenRunsMs', 0, 600000, 'Delay between respondents'),
        delayBetweenActionsMs: num('delayBetweenActionsMs', 0, 10000, 'Delay between actions'), navigationTimeoutMs: num('navigationTimeoutMs', 2000, 120000, 'Navigation timeout'),
        theme: $('theme').value, retentionDays: num('retentionDays', 0, 3650, 'Retention'), csvDelimiter: $('csvDelimiter').value,
        exportFilenamePrefix: $('exportFilenamePrefix').value.replace(/[^\w\-]+/g, '-').slice(0, 40) || 'surveypilot',
        exportIncludeProfile: $('exportIncludeProfile').checked, diagnosticLogging: $('diagnosticLogging').checked, captureScreenshots: $('captureScreenshots').checked
      };
      var key = cleanKey($('apiKey').value);
      if (key && (/\s/.test(key) || key.length < 20)) throw new Error('That does not look like a Gemini API key (it should be one unbroken string of 20+ characters, no spaces).');
      if (next.mode === 'ai' && !key && !(await Storage.getApiKey())) toast('AI mode needs an API key; until one is saved SurveyPilot will fall back to local generation.', 'err');
      await Storage.setSettings(next);
      if (key) { await Storage.setApiKey(key); $('apiKey').value = ''; }
      settings = await Storage.getSettings(); load(); await updateKeyState();
      $('modelCustom').value = '';
      $('saved').textContent = 'Saved at ' + Util.formatClock(Date.now()); toast('Settings saved.', 'ok'); banner('');
    } catch (err) { toast(err.message, 'err'); }
  }

  /** Pastes often carry quotes, a "key=" prefix, an "Authorization: Bearer" prefix or line breaks; strip those before validating. */
  function cleanKey(v) { return String(v || '').replace(/^\s*(authorization:\s*)?(bearer\s+)?(key\s*=\s*)?/i, '').replace(/^["'`]+|["'`;,]+$/g, '').replace(/\s+/g, ''); }
  async function currentKey() { return cleanKey($('apiKey').value) || Storage.getApiKey(); }

  async function loadModels() {
    var btn = $('load-models'); btn.disabled = true;
    try {
      var key = await currentKey();
      if (!key) throw new Error('Enter an API key first.');
      var list = await AI.listModels(key);
      if (!list.length) throw new Error('The key is valid but exposes no generateContent models.');
      models = list; fillModelSelect(); $('model-hint').textContent = 'Loaded ' + list.length + ' model(s) available to your key.'; toast('Loaded ' + list.length + ' models.', 'ok');
    } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
  }

  async function testKey() {
    var out = $('test-result'); out.textContent = 'Testing…'; out.style.color = '';
    try {
      var key = await currentKey();
      if (!key) throw Object.assign(new Error('Enter an API key first.'), { code: 'API_KEY_MISSING' });
      var model = $('modelCustom').value.trim() || $('modelSelect').value;
      var r = await AI.requestOnce(key, model, 'Reply with the JSON object {"ok": true}.', 20000);
      out.textContent = r && r.ok ? '✓ Key works with ' + model + '.' : '✓ Reached Gemini, unexpected reply format.'; out.style.color = 'var(--ok)';
    } catch (err) { out.textContent = '✖ ' + (err.code ? err.code + ': ' : '') + err.message; out.style.color = 'var(--err)'; }
  }

  async function backup() {
    var dump = await Storage.dumpAll();
    var data = Exp.buildBackup(dump, { includeScreenshots: false });
    Exp.download((settings.exportFilenamePrefix || 'surveypilot') + '-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(data, null, 2), 'application/json');
    toast('Backup downloaded (API key and screenshots excluded).', 'ok');
  }

  async function restore(file) {
    var obj;
    try { obj = JSON.parse(await file.text()); } catch (e) { return toast('That file is not valid JSON.', 'err'); }
    try { Exp.validateBackup(obj); } catch (e) { return toast(e.message, 'err'); }
    var summary = Object.keys(obj.data).map(function (k) { return obj.data[k].length + ' ' + k; }).join(', ');
    var choice = await choiceDialog('Restore backup', 'This backup holds ' + summary + '. Merge adds and overwrites matching items; Replace erases current data first.',
      [{ label: 'Cancel', value: 'cancel' }, { label: 'Merge', value: 'merge' }, { label: 'Replace all', value: 'replace', cls: 'danger' }]);
    if (choice === 'cancel') return;
    await Storage.restoreAll(obj, choice);
    settings = await Storage.getSettings(); load(); await updateCounts();
    toast('Backup restored (' + choice + ').', 'ok');
  }

  async function clearAll() {
    var c = await choiceDialog('Clear all data', 'This permanently deletes surveys, respondents, runs, logs, diagnostics and settings. Your API key is kept unless you remove it. Download a backup first if unsure.',
      [{ label: 'Cancel', value: 'cancel' }, { label: 'Delete everything', value: 'yes', cls: 'danger' }]);
    if (c !== 'yes') return;
    await Storage.clearAllData(); settings = await Storage.getSettings(); load(); await updateCounts(); toast('All data cleared.', 'ok');
  }

  async function init() {
    try {
      await Storage.open();
      Storage.onError = function (e) { banner('Storage problem: ' + e.message); };
      settings = await Storage.getSettings(); load(); await updateKeyState(); await updateCounts();
    } catch (err) { banner('Could not open local storage: ' + err.message); return; }
    $('form').addEventListener('submit', save);
    $('toggle-key').addEventListener('click', function () { var i = $('apiKey'); var show = i.type === 'password'; i.type = show ? 'text' : 'password'; $('toggle-key').textContent = show ? 'Hide' : 'Show'; });
    $('load-models').addEventListener('click', loadModels);
    $('test-key').addEventListener('click', testKey);
    $('backup').addEventListener('click', function () { backup().catch(function (e) { toast(e.message, 'err'); }); });
    $('restore-file').addEventListener('change', function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) restore(f).catch(function (err) { toast('Restore failed: ' + err.message, 'err'); }); });
    $('clear').addEventListener('click', function () { clearAll().catch(function (e) { toast(e.message, 'err'); }); });
    $('theme').addEventListener('change', function () { settings.theme = $('theme').value; applyTheme(); });
  }
  init();
})();
