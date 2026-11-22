(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function send(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (r) => resolve(r)); } catch (e) { resolve(null); }
    });
  }

  async function loadSettings() {
    const r = await send({ type: 'surveypilot_get_settings' });
    const s = r && r.settings;
    if (!s) return;
    $('apiKey').value = s.geminiApiKey || '';
    $('generationMode').value = s.generationMode || 'auto';
    $('aiModel').value = s.geminiModel || 'gemini-2.0-flash';
    $('defaultCount').value = s.defaultRespondentCount || 5;
    $('theme').value = s.theme || 'light';
    document.body.setAttribute('data-theme', s.theme || 'light');
  }

  async function saveSettings() {
    const settings = {
      geminiApiKey: $('apiKey').value.trim(),
      generationMode: $('generationMode').value,
      geminiModel: $('aiModel').value,
      defaultRespondentCount: parseInt($('defaultCount').value, 10) || 5,
      theme: $('theme').value
    };
    const r = await send({ type: 'surveypilot_save_settings', settings });
    if (r && r.ok) {
      $('saveResult').textContent = 'Saved.';
      document.body.setAttribute('data-theme', settings.theme);
      setTimeout(() => { $('saveResult').textContent = ''; }, 2500);
    } else {
      $('saveResult').textContent = 'Save failed.';
    }
  }

  async function testApiKey() {
    const apiKey = $('apiKey').value.trim();
    const model = $('aiModel').value;
    if (!apiKey) { $('apiTestResult').textContent = 'Enter an API key first.'; return; }
    $('apiTestResult').textContent = 'Testing…';
    $('testApiKey').disabled = true;
    const r = await send({ type: 'surveypilot_test_api_key', apiKey, model });
    $('testApiKey').disabled = false;
    if (r && r.ok) {
      $('apiTestResult').innerHTML = '<span style="color:var(--success)">OK</span>';
    } else {
      $('apiTestResult').innerHTML = '<span style="color:var(--danger)">Failed</span> — ' + (r && r.error || 'unknown');
    }
  }

  function toggleKeyVisibility() {
    const inp = $('apiKey');
    if (inp.type === 'password') { inp.type = 'text'; $('toggleKeyVisibility').textContent = 'Hide'; }
    else { inp.type = 'password'; $('toggleKeyVisibility').textContent = 'Show'; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    $('saveBtn').addEventListener('click', saveSettings);
    $('testApiKey').addEventListener('click', testApiKey);
    $('toggleKeyVisibility').addEventListener('click', toggleKeyVisibility);
    $('theme').addEventListener('change', () => {
      document.body.setAttribute('data-theme', $('theme').value);
    });
  });
})();
