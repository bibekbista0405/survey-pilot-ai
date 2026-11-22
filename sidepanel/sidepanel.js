/*
 * SurveyPilot AI — Simple Side Panel Logic
 * Three screens: Home → Progress → Report.
 * Auto-detects the form, auto-runs everything on Start, shows live progress,
 * then a clean completion report.
 */
(function (global) {
  'use strict';

  const SP = global.SurveyPilot || {};
  const Stats = SP.Statistics;

  // -------- State --------
  let currentSurvey = null;
  let confirmedDestinationUrl = null;
  let pendingStartCount = 5;
  let runState = null;
  let elapsedTimer = null;
  let runStartedAt = 0;
  let lastActionText = 'Starting…';
  let isAutoDetecting = false;

  // -------- Helpers --------
  function $(id) { return document.getElementById(id); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }

  function toast(message, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = message;
    $('toastContainer').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      setTimeout(() => el.remove(), 250);
    }, 3000);
  }

  function fmtDuration(ms) {
    if (!ms) return '0s';
    if (ms < 1000) return ms + 'ms';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return m + 'm ' + rs + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showScreen(name) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
  }

  function openModal(id) {
    $(id).classList.add('open');
    $(id).setAttribute('aria-hidden', 'false');
  }
  function closeModal(id) {
    $(id).classList.remove('open');
    $(id).setAttribute('aria-hidden', 'true');
  }

  // -------- Theme --------
  async function loadTheme() {
    const r = await send({ type: 'surveypilot_get_settings' });
    const theme = (r && r.settings && r.settings.theme) || 'light';
    document.body.setAttribute('data-theme', theme);
  }
  async function toggleTheme() {
    const cur = document.body.getAttribute('data-theme');
    const next = cur === 'light' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', next);
    await send({ type: 'surveypilot_save_settings', settings: { theme: next } });
  }

  // -------- Auto-detect --------
  let detectRetryCount = 0;

  async function autoDetect() {
    if (isAutoDetecting) return;
    isAutoDetecting = true;
    detectRetryCount = 0;
    await runDetect();
    isAutoDetecting = false;
  }

  async function runDetect() {
    const card = $('formStatusCard');
    card.classList.remove('ok', 'bad');
    card.classList.add('loading');
    $('statusIcon').innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
    $('statusTitle').textContent = 'Looking for survey…';
    $('statusSubtitle').textContent = 'Scanning the active tab.';
    $('surveyInfo').style.display = 'none';
    $('startBtn').disabled = true;

    try {
      const det = await send({ type: 'surveypilot_detect_tab' });
      if (det && det.ok) {
        // Read the full form — the service worker will auto-click through intro pages
        // and confirmation pages to find the actual questions.
        if (det.pageType === 'intro') {
          $('statusSubtitle').textContent = 'Clicking through intro page…';
        } else if (det.pageType === 'confirmation') {
          $('statusSubtitle').textContent = 'Form already submitted — reloading…';
        } else {
          $('statusSubtitle').textContent = 'Reading questions…';
        }
        const read = await send({ type: 'surveypilot_read_tab' });
        if (read && read.ok && read.survey && read.survey.questionCount > 0) {
          currentSurvey = read.survey;
          confirmedDestinationUrl = det.url;
          card.classList.remove('loading', 'bad');
          card.classList.add('ok');
          $('statusIcon').innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
          $('statusTitle').textContent = 'Survey ready';
          $('statusSubtitle').textContent = (currentSurvey.compatibility === 'supported' ? '' : 'Partially supported — ') + 'Ready to automate.';
          $('surveyInfo').style.display = 'block';
          $('surveyName').textContent = currentSurvey.title.length > 32 ? currentSurvey.title.slice(0, 30) + '…' : currentSurvey.title;
          $('surveyQuestions').textContent = currentSurvey.questionCount;
          $('surveySections').textContent = currentSurvey.sectionCount;
          $('startBtn').disabled = false;
          return;
        } else {
          showDetectFailed(read && read.reason);
          return;
        }
      } else {
        // If the failure looks like a connection issue, retry up to 3 times
        const reason = (det && det.reason) || '';
        if (/Could not establish|Receiving end|content script|Could not load/i.test(reason) && detectRetryCount < 3) {
          detectRetryCount++;
          $('statusSubtitle').textContent = 'Connecting to page… (' + detectRetryCount + '/3)';
          await new Promise((r) => setTimeout(r, 600));
          return runDetect();
        }
        showDetectFailed(reason);
        return;
      }
    } catch (e) {
      if (detectRetryCount < 3) {
        detectRetryCount++;
        $('statusSubtitle').textContent = 'Connecting to page… (' + detectRetryCount + '/3)';
        await new Promise((r) => setTimeout(r, 600));
        return runDetect();
      }
      showDetectFailed(e.message);
    }
  }

  function showDetectFailed(reason) {
    const card = $('formStatusCard');
    card.classList.remove('loading', 'ok');
    card.classList.add('bad');
    $('statusIcon').innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    $('statusTitle').textContent = 'Open a supported survey';
    let hint = 'Open a Google Form or HTML survey in this tab.';
    if (reason && /Could not establish|Receiving end|content script|Could not load/i.test(reason)) {
      hint = 'Reload this tab, then reopen the panel.';
    } else if (reason) {
      hint = reason;
    }
    $('statusSubtitle').textContent = hint + ' Click here to retry.';
    $('surveyInfo').style.display = 'none';
    $('startBtn').disabled = true;
  }

  // -------- Count selection --------
  function selectCount(value) {
    $$('.pill').forEach((p) => p.classList.toggle('active', p.dataset.count === String(value)));
    if (value === 'custom') {
      $('customCount').style.display = 'block';
      $('customCount').focus();
      pendingStartCount = parseInt($('customCount').value, 10) || 1;
    } else {
      $('customCount').style.display = 'none';
      pendingStartCount = parseInt(value, 10);
    }
  }

  // -------- Start flow --------
  function handleStartClick() {
    if (!currentSurvey || !confirmedDestinationUrl) {
      toast('No survey detected. Open a survey first.', 'warn');
      return;
    }
    const count = pendingStartCount;
    $('confirmCount').textContent = count;
    $('confirmUrl').textContent = confirmedDestinationUrl;
    openModal('confirmModal');
  }

  async function confirmAndStart() {
    closeModal('confirmModal');
    await startAutomation();
  }

  async function startAutomation() {
    if (!currentSurvey) { toast('No survey loaded.', 'error'); return; }
    const count = pendingStartCount;
    const settings = await send({ type: 'surveypilot_get_settings' });
    const s = settings && settings.settings;
    const mode = (s && s.generationMode) || 'auto';
    const apiKey = (s && s.geminiApiKey) || '';
    // In "auto" mode, use AI if key present, else local
    let actualMode = mode;
    if (mode === 'auto') actualMode = apiKey ? 'ai' : 'local';

    // Switch to progress screen
    showScreen('progress');
    $('totalResp').textContent = count;
    $('currentResp').textContent = 0;
    $('progressFill').style.width = '0%';
    $('progressPct').textContent = '0%';
    $('progressAction').textContent = 'Generating respondents…';
    $('statSuccess').textContent = 0;
    $('statFailed').textContent = 0;
    $('statRemaining').textContent = count;
    $('elapsedTime').textContent = '0s';
    $('avgTime').textContent = '—';
    $('pauseBtn').disabled = false;
    $('resumeBtn').disabled = true;
    $('stopBtn').disabled = false;
    $('liveLog').innerHTML = '';
    runStartedAt = Date.now();
    startElapsedTimer();

    // Helper: reset to home screen on failure
    function failAndReset(message) {
      stopElapsedTimer();
      addLogLine('error', message);
      toast(message, 'error');
      // Reset to home screen
      runState = null;
      showScreen('home');
      autoDetect();
    }

    // Step 1: generate respondents
    const gen = await send({
      type: 'surveypilot_generate_respondents',
      count,
      mode: actualMode,
      surveyId: currentSurvey.id
    });
    if (!gen || !gen.ok) {
      failAndReset('Could not generate respondents: ' + (gen && gen.reason));
      return;
    }
    addLogLine('ok', 'Generated ' + gen.respondents.length + ' respondents');

    // Step 2: generate answers for each
    $('progressAction').textContent = 'Generating answers…';
    for (let i = 0; i < gen.respondents.length; i++) {
      const r = gen.respondents[i];
      $('currentResp').textContent = i + 1;
      addLogLine('', 'Generating answers for respondent ' + (i + 1));
      const aResp = await send({ type: 'surveypilot_generate_answers', survey: currentSurvey, respondent: r });
      if (aResp && aResp.ok) addLogLine('ok', 'Answers ready for respondent ' + (i + 1));
      else addLogLine('warn', 'Answer issues for respondent ' + (i + 1));
    }

    // Step 3: start the test run
    $('progressAction').textContent = 'Starting automation run…';
    addLogLine('', 'Starting test run against confirmed destination');
    const startResp = await send({
      type: 'surveypilot_start_run',
      mode: 'test',
      destinationUrl: confirmedDestinationUrl,
      respondentIds: gen.respondents.map((r) => r.id),
      surveyId: currentSurvey.id,
      confirmed: true,
      maxRetries: 2,
      intervalMs: 600
    });
    if (!startResp || !startResp.ok) {
      failAndReset('Run failed to start: ' + (startResp && startResp.reason));
      return;
    }
    runState = startResp.runState;
    addLogLine('ok', 'Automation started');
  }

  // -------- Progress tracking --------
  function startElapsedTimer() {
    stopElapsedTimer();
    elapsedTimer = setInterval(() => {
      const elapsed = Date.now() - runStartedAt;
      $('elapsedTime').textContent = fmtDuration(elapsed);
    }, 1000);
  }
  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function addLogLine(kind, text) {
    const el = $('liveLog');
    if (!el) return;
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cls = kind ? ' ' + kind : '';
    const line = document.createElement('div');
    line.className = 'log-line' + cls;
    line.innerHTML = '<span class="ts">' + ts + '</span> <span class="act">' + escapeHtml(text) + '</span>';
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    // Keep last 100 lines
    while (el.children.length > 100) el.removeChild(el.firstChild);
  }

  async function refreshRunState() {
    const r = await send({ type: 'surveypilot_get_state' });
    runState = r && r.runState;
    if (!runState) return;
    updateProgressUI();
    if (runState.status === 'completed' || runState.status === 'stopped') {
      await showReport();
    }
  }

  function updateProgressUI() {
    if (!runState) return;
    const items = runState.executionItems || [];
    const total = items.length;
    const success = items.filter((i) => i.status === 'completed').length;
    const failed = items.filter((i) => i.status === 'failed').length;
    const skipped = items.filter((i) => i.status === 'skipped').length;
    const remaining = items.filter((i) => i.status === 'pending' || i.status === 'generating' || i.status === 'filling' || i.status === 'validating').length;
    const done = success + failed + skipped;
    const pct = total ? Math.round((done / total) * 100) : 0;

    $('currentResp').textContent = done + (remaining > 0 ? 1 : 0);
    $('totalResp').textContent = total;
    $('progressFill').style.width = pct + '%';
    $('progressPct').textContent = pct + '%';
    $('statSuccess').textContent = success;
    $('statFailed').textContent = failed + skipped;
    $('statRemaining').textContent = remaining;

    // Average time
    const completedDurations = items.filter((i) => i.durationMs && i.status === 'completed').map((i) => i.durationMs);
    if (completedDurations.length) {
      const avg = completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length;
      $('avgTime').textContent = fmtDuration(Math.round(avg));
    }

    // Current action
    const active = items.find((i) => i.status === 'generating' || i.status === 'filling' || i.status === 'validating');
    if (active) {
      const actionMap = { generating: 'Generating answers…', filling: 'Filling questions…', validating: 'Checking answers…' };
      $('progressAction').textContent = actionMap[active.status] || 'Working…';
    } else if (remaining === 0) {
      $('progressAction').textContent = 'Finalizing…';
    }

    // Controls
    const running = runState.status === 'running';
    const paused = runState.status === 'paused';
    $('pauseBtn').disabled = !running;
    $('resumeBtn').disabled = !paused;
    $('stopBtn').disabled = (runState.status === 'completed' || runState.status === 'stopped');
  }

  // -------- Completion report --------
  async function showReport() {
    stopElapsedTimer();
    if (!runState) return;
    const items = runState.executionItems || [];
    const total = items.length;
    const success = items.filter((i) => i.status === 'completed').length;
    const failed = items.filter((i) => i.status === 'failed' || i.status === 'skipped').length;
    const totalTime = runState.endedAt ? runState.endedAt - runState.startedAt : (Date.now() - runState.startedAt);
    const completedDurations = items.filter((i) => i.durationMs && i.status === 'completed').map((i) => i.durationMs);
    const avg = completedDurations.length ? Math.round(completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length) : 0;

    $('reportTotal').textContent = total;
    $('reportSuccess').textContent = success;
    $('reportFailed').textContent = failed;
    $('reportTotalTime').textContent = fmtDuration(totalTime);
    $('reportAvgTime').textContent = fmtDuration(avg);

    addLogLine('ok', 'Automation completed: ' + success + '/' + total + ' successful');

    // Show report screen
    showScreen('report');
  }

  // -------- Controls --------
  async function pauseRun() {
    const r = await send({ type: 'surveypilot_pause_run' });
    if (r && r.ok) { runState = r.runState; updateProgressUI(); addLogLine('warn', 'Paused'); }
  }
  async function resumeRun() {
    const r = await send({ type: 'surveypilot_resume_run' });
    if (r && r.ok) { runState = r.runState; updateProgressUI(); addLogLine('ok', 'Resumed'); }
  }
  async function stopRun() {
    if (!confirm('Stop automation? Remaining respondents will not be processed.')) return;
    const r = await send({ type: 'surveypilot_stop_run' });
    if (r && r.ok) {
      runState = r.runState;
      updateProgressUI();
      addLogLine('warn', 'Stopped by user');
      await showReport();
    }
  }

  // -------- Report actions --------
  function exportCsv() {
    send({ type: 'surveypilot_export_respondents_csv', surveyId: currentSurvey ? currentSurvey.id : null });
    toast('CSV exported.', 'success');
  }

  async function runAgain() {
    // Reset and go home
    await send({ type: 'surveypilot_reset_run' });
    runState = null;
    showScreen('home');
    await autoDetect();
  }

  // -------- Settings --------
  async function openSettings() {
    const r = await send({ type: 'surveypilot_get_settings' });
    const s = r && r.settings;
    if (s) {
      $('setApiKey').value = s.geminiApiKey || '';
      $('setMode').value = s.generationMode || 'auto';
      $('setTheme').value = s.theme || 'light';
      $('setDefaultCount').value = s.defaultRespondentCount || 5;
    }
    openModal('settingsModal');
  }

  async function saveSettings() {
    const settings = {
      geminiApiKey: $('setApiKey').value.trim(),
      generationMode: $('setMode').value,
      theme: $('setTheme').value,
      defaultRespondentCount: parseInt($('setDefaultCount').value, 10) || 5
    };
    await send({ type: 'surveypilot_save_settings', settings });
    document.body.setAttribute('data-theme', settings.theme);
    // Apply default count to home screen
    if (settings.defaultRespondentCount && [1, 5, 10, 20, 50].includes(settings.defaultRespondentCount)) {
      selectCount(settings.defaultRespondentCount);
    }
    closeModal('settingsModal');
    toast('Settings saved.', 'success');
  }

  function toggleKeyVisibility() {
    const inp = $('setApiKey');
    if (inp.type === 'password') { inp.type = 'text'; $('setToggleKey').textContent = 'Hide'; }
    else { inp.type = 'password'; $('setToggleKey').textContent = 'Show'; }
  }

  // -------- History --------
  async function openHistory() {
    const r = await send({ type: 'surveypilot_get_runs' });
    const runs = (r && r.runs) || [];
    runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const list = $('historyList');
    if (!runs.length) {
      list.innerHTML = '<p class="muted small" style="text-align:center;padding:20px">No runs yet.</p>';
    } else {
      list.innerHTML = runs.slice(0, 20).map((run) => {
        const items = run.executionItems || [];
        const success = items.filter((i) => i.status === 'completed').length;
        const failed = items.filter((i) => i.status === 'failed' || i.status === 'skipped').length;
        const total = items.length;
        const date = new Date(run.startedAt).toLocaleString();
        const elapsed = run.endedAt ? fmtDuration(run.endedAt - run.startedAt) : '—';
        return '<div class="history-item">' +
          '<div class="h-date">' + escapeHtml(date) + '</div>' +
          '<div class="h-meta">' + escapeHtml(run.destinationUrl || '') + ' • ' + elapsed + ' • ' + total + ' respondents</div>' +
          '<div class="h-stats"><span class="ok">' + success + ' successful</span><span class="bad">' + failed + ' failed</span></div>' +
          '</div>';
      }).join('');
    }
    openModal('historyModal');
  }

  // -------- Tab change detection --------
  function setupTabListeners() {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;
    chrome.tabs.onActivated.addListener(() => {
      // Only re-detect if we're on the home screen and not running
      if ($('screen-home').classList.contains('active') && !runState) {
        autoDetect();
      }
    });
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (info.status === 'complete' && $('screen-home').classList.contains('active') && !runState) {
        autoDetect();
      }
    });
  }

  // -------- Init --------
  function init() {
    // Header buttons
    $('settingsBtn').addEventListener('click', openSettings);
    $('historyBtn').addEventListener('click', openHistory);

    // Home
    $$('.pill').forEach((p) => p.addEventListener('click', () => selectCount(p.dataset.count)));
    $('customCount').addEventListener('input', (e) => {
      pendingStartCount = parseInt(e.target.value, 10) || 1;
    });
    $('startBtn').addEventListener('click', handleStartClick);
    $('formStatusCard').addEventListener('click', () => { autoDetect(); });

    // Confirm modal
    $('confirmStartBtn').addEventListener('click', confirmAndStart);
    $$('[data-close]').forEach((el) => el.addEventListener('click', () => closeModal(el.dataset.close)));
    $$('.modal-backdrop').forEach((el) => el.addEventListener('click', () => {
      const modal = el.closest('.modal');
      if (modal) closeModal(modal.id);
    }));

    // Progress controls
    $('pauseBtn').addEventListener('click', pauseRun);
    $('resumeBtn').addEventListener('click', resumeRun);
    $('stopBtn').addEventListener('click', stopRun);

    // Report actions
    $('exportCsvBtn').addEventListener('click', exportCsv);
    $('runAgainBtn').addEventListener('click', runAgain);

    // Settings
    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('setToggleKey').addEventListener('click', toggleKeyVisibility);

    // Listen for state + log updates from the service worker
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'surveypilot_state') {
        runState = msg.runState;
        if ($('screen-progress').classList.contains('active')) {
          updateProgressUI();
          if (runState && (runState.status === 'completed' || runState.status === 'stopped')) {
            showReport();
          }
        }
      } else if (msg.type === 'surveypilot_log' && msg.entry) {
        if ($('screen-progress').classList.contains('active')) {
          const e = msg.entry;
          const kind = e.result === 'error' ? 'error' : (e.result === 'warn' ? 'warn' : (e.result === 'ok' || e.result === 'skipped' ? 'ok' : ''));
          const txt = e.action + (e.question ? ' — ' + e.question : '') + (e.errorDetails ? ' (' + (typeof e.errorDetails === 'string' ? e.errorDetails : JSON.stringify(e.errorDetails)) + ')' : '');
          addLogLine(kind, txt);
        }
      }
    });

    setupTabListeners();

    // Initial load
    loadTheme();
    // Apply default count from settings
    send({ type: 'surveypilot_get_settings' }).then((r) => {
      const s = r && r.settings;
      if (s && s.defaultRespondentCount) {
        const dc = s.defaultRespondentCount;
        if ([1, 5, 10, 20, 50].includes(dc)) {
          selectCount(dc);
        } else {
          selectCount('custom');
          $('customCount').value = dc;
          pendingStartCount = dc;
        }
      }
    });
    // Check if a run is already in progress
    send({ type: 'surveypilot_get_state' }).then((r) => {
      runState = r && r.runState;
      if (runState && (runState.status === 'running' || runState.status === 'paused')) {
        showScreen('progress');
        runStartedAt = runState.startedAt;
        startElapsedTimer();
        updateProgressUI();
      } else {
        // Auto-detect on open
        autoDetect();
      }
    });

    // Poll for state updates while on progress screen (covers cases where SW messages don't fire)
    setInterval(() => {
      if ($('screen-progress').classList.contains('active')) {
        refreshRunState();
      }
    }, 1500);
  }

  document.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
