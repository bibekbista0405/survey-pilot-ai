/*
 * SurveyPilot AI - Background Service Worker
 * Coordinates runs across the active tab, side panel, and content scripts.
 * Owns run state and persists it so the dashboard stays accurate if the side panel closes.
 *
 * Uses importScripts to load shared classic-script modules that attach to self.SurveyPilot.
 */
'use strict';

importScripts(
  '../core/storage.js',
  '../core/survey-parser.js',
  '../core/respondent-generator.js',
  '../core/answer-generator.js',
  '../core/statistics.js',
  '../core/export.js'
);

const SP = self.SurveyPilot || {};
const Storage = SP.Storage;
const Parser = SP.SurveyParser;
const Generator = SP.RespondentGenerator;
const AnswerGen = SP.AnswerGenerator;
const Stats = SP.Statistics;
const Export = SP.Export;

const STATE_KEY = 'run_state_v1';

// -------- Run state --------

let runState = null; // in-memory copy of the active run

async function loadRunState() {
  if (runState) return runState;
  const stored = await Storage.getSetting(STATE_KEY, null);
  if (stored) {
    runState = stored;
    // If the run was running when the panel closed, mark it as paused so user must resume explicitly
    if (runState.status === 'running') {
      runState.status = 'paused';
      await persistRunState();
    }
  }
  return runState;
}

async function persistRunState() {
  if (runState) {
    runState.lastActivityAt = Date.now();
    await Storage.setSetting(STATE_KEY, runState);
    // Also persist the run record itself
    await Storage.put('runs', runState);
  }
}

async function clearRunState() {
  runState = null;
  await Storage.setSetting(STATE_KEY, null);
}

// -------- Helpers --------

async function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!tabs || !tabs.length) return reject(new Error('No active tab'));
      resolve(tabs[0]);
    });
  });
}

// Content script files in load order (must match manifest.json)
const CONTENT_SCRIPT_FILES = [
  'core/storage.js',
  'core/survey-parser.js',
  'core/respondent-generator.js',
  'core/answer-generator.js',
  'core/statistics.js',
  'core/export.js',
  'content/form-detector.js',
  'content/form-reader.js',
  'content/form-filler.js',
  'content/form-navigation.js',
  'content/validation.js'
];

// Inject content scripts into a tab if they aren't already loaded.
// This handles tabs that were open BEFORE the extension was installed/reloaded
// (Chrome doesn't retroactively inject content_scripts into existing tabs).
async function ensureContentScriptsLoaded(tabId) {
  // First try a ping to see if the content script is already there
  try {
    const pong = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: 'surveypilot_ping' }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
    if (pong && pong.pong) return true;
  } catch (e) {
    // Not loaded — fall through to injection
  }
  try {
    for (const file of CONTENT_SCRIPT_FILES) {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    }
    return true;
  } catch (e) {
    // Injection failed (maybe a chrome:// page or no permission)
    return false;
  }
}

function sendToTabRaw(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(resp);
    });
  });
}

async function sendToTab(tabId, message) {
  try {
    return await sendToTabRaw(tabId, message);
  } catch (e) {
    // Content script not loaded — inject and retry once
    const ok = await ensureContentScriptsLoaded(tabId);
    if (!ok) throw new Error('Could not load content scripts on this page. Try reloading the tab.');
    // Small delay to let listeners attach
    await new Promise((r) => setTimeout(r, 50));
    return sendToTabRaw(tabId, message);
  }
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  return sendToTab(tab.id, message);
}

function logLine(runId, respondentId, action, question, result, errorDetails) {
  const entry = {
    id: 'log_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    timestamp: Date.now(),
    runId: runId || null,
    respondentId: respondentId || null,
    action: action || '',
    question: question || '',
    result: result || '',
    errorDetails: errorDetails || ''
  };
  // Await the storage write to ensure log entries are not lost if the service worker terminates.
  // Fire-and-forget was causing lost entries during service worker shutdown.
  const writePromise = Storage.put('logs', entry).catch(() => {});
  // Push to side panel if open
  chrome.runtime.sendMessage({ type: 'surveypilot_log', entry }).catch(() => {});
  // Attach the write promise so callers CAN await it if they want to ensure persistence
  entry._writePromise = writePromise;
  return entry;
}

function pushStateToPanel() {
  chrome.runtime.sendMessage({ type: 'surveypilot_state', runState }).catch(() => {});
}

// Resolve "auto" mode: use AI if API key is configured, else local
function resolveMode(settings) {
  const mode = settings.generationMode || 'auto';
  if (mode === 'auto') return settings.geminiApiKey ? 'ai' : 'local';
  return mode;
}

// Use Gemini AI to read the form page when the DOM-based reader fails.
// Extracts all visible text from the page and asks Gemini to identify questions.
// CRITICAL: after AI identifies questions, we also call readFromInputs() to get
// questions WITH actual DOM element references, then merge the two by text similarity.
// This ensures every question that gets filled has real element references.
async function readWithAI(tabId) {
  const settings = await getSettingsFixed();
  if (!settings.geminiApiKey) return null;

  // Step 1: Extract page text and ask Gemini to identify questions
  let textResp;
  try {
    textResp = await sendToTab(tabId, { type: 'surveypilot_extract_form_text' });
  } catch (e) { return null; }
  if (!textResp || !textResp.text || textResp.text.length < 20) return null;

  const prompt = `You are analyzing a Google Forms survey page. Identify ALL questions visible on this page.

For each question, return a JSON object with these fields:
- "text": the question text (include both English and any other language)
- "type": one of "short_answer", "paragraph", "multiple_choice", "checkbox", "dropdown", "linear_scale", "rating", "date", "time"
- "options": array of option strings (for multiple_choice, checkbox, dropdown, linear_scale). For linear_scale, use the numeric values ["1","2","3","4","5"]
- "required": true if the question has a required indicator (* or "required"), false otherwise
- "minValue": for linear_scale, the minimum value (usually 1)
- "maxValue": for linear_scale, the maximum value (usually 5 or 7)

Return ONLY a JSON array of question objects. No explanation, no markdown.

Page text (visible elements only):
${textResp.text}`;

  let aiQuestions;
  try {
    const aiText = await AnswerGen.callGemini({
      apiKey: settings.geminiApiKey,
      model: settings.geminiModel,
      prompt,
      timeoutMs: 30000
    });

    // Parse the JSON array from the response
    const start = aiText.indexOf('[');
    const end = aiText.lastIndexOf(']');
    if (start < 0 || end < 0) return null;
    aiQuestions = JSON.parse(aiText.slice(start, end + 1));
    if (!Array.isArray(aiQuestions) || !aiQuestions.length) return null;
  } catch (e) {
    return null;
  }

  // Step 2: Validate AI questions — remove duplicates, ensure non-empty text, unique IDs
  const Parser = SP.SurveyParser;
  const seenTexts = new Set();
  aiQuestions = aiQuestions.filter((q) => {
    if (!q.text || q.text.length < 2) return false;
    const textKey = q.text.trim().toLowerCase().slice(0, 100);
    if (seenTexts.has(textKey)) return false; // duplicate
    seenTexts.add(textKey);
    return true;
  });
  if (!aiQuestions.length) return null;

  // Step 3: Get questions from readFromInputs() — these have actual DOM element references
  let inputQuestions = [];
  try {
    const inputResp = await sendToTab(tabId, { type: 'surveypilot_read_from_inputs' });
    if (inputResp && inputResp.ok && inputResp.questions) {
      inputQuestions = inputResp.questions;
    }
  } catch (e) {}

  // Step 4: Merge AI questions with input-based questions by text similarity.
  // For each AI question, find the best matching input question and copy its elementRefs.
  const converted = aiQuestions.map((q) => {
    const aiText = (q.text || '').trim().toLowerCase();
    // Find the best matching input question
    let bestMatch = null;
    let bestScore = 0;
    for (const inp of inputQuestions) {
      const inpText = (inp.text || '').trim().toLowerCase();
      // Score by text overlap
      let score = 0;
      if (inpText === aiText) score = 1.0;
      else if (inpText.indexOf(aiText) !== -1 || aiText.indexOf(inpText) !== -1) score = 0.8;
      else {
        // Check word overlap
        const aiWords = aiText.split(/\s+/).filter((w) => w.length > 3);
        const inpWords = inpText.split(/\s+/).filter((w) => w.length > 3);
        const common = aiWords.filter((w) => inpWords.includes(w));
        score = common.length / Math.max(aiWords.length, 1) * 0.5;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = inp;
      }
    }

    const merged = {
      id: 'aiq_' + Parser.hashString(q.text || ''),
      text: q.text || '',
      type: q.type || 'unknown',
      required: !!q.required,
      options: q.options || [],
      minValue: q.minValue || null,
      maxValue: q.maxValue || null,
      minChoices: null,
      maxChoices: null,
      maxLength: null,
      pattern: null,
      sectionIndex: 0,
      visible: true,
      // Use the input question's element references if we found a good match
      elementRefs: (bestMatch && bestScore > 0.3) ? bestMatch.elementRefs : [],
      containerRef: (bestMatch && bestScore > 0.3) ? bestMatch.containerRef : null
    };
    return merged;
  });

  // Step 5: Add any input questions that weren't matched by AI (AI might have missed some)
  for (const inp of inputQuestions) {
    const inpText = (inp.text || '').trim().toLowerCase();
    const matched = converted.some((c) => {
      const cText = (c.text || '').trim().toLowerCase();
      return cText === inpText || cText.indexOf(inpText) !== -1 || inpText.indexOf(cText) !== -1;
    });
    if (!matched) {
      converted.push(inp);
    }
  }

  return converted;
}

// -------- Settings --------

async function getSettings() {
  const s = await Storage.getAllSettings();
  const defaults = {
    geminiApiKey: '',
    geminiModel: AnswerGen.DEFAULT_MODEL,
    generationMode: 'local',
    defaultRespondentCount: 5,
    defaultBatchSize: 1,
    retryLimit: 2,
    delayBetweenRunsMs: 800,
    theme: 'light',
    language: 'en',
    dataRetentionDays: 30,
    diagnosticLogging: true,
    respondentConfig: Generator.DEFAULT_CONFIG
  };
  return Object.assign({}, defaults, s.settings || s);
}

// Actually getAllSettings returns a flat map of key->value with no nested wrapper.
// Fix that:
async function getSettingsFixed() {
  const s = await Storage.getAllSettings();
  const defaults = {
    geminiApiKey: '',
    geminiModel: AnswerGen.DEFAULT_MODEL,
    generationMode: 'auto',
    defaultRespondentCount: 5,
    defaultBatchSize: 1,
    retryLimit: 2,
    delayBetweenRunsMs: 600,
    theme: 'light',
    language: 'en',
    dataRetentionDays: 30,
    diagnosticLogging: true,
    respondentConfig: Generator.DEFAULT_CONFIG
  };
  // Only pick known keys
  const out = Object.assign({}, defaults);
  for (const k of Object.keys(defaults)) {
    if (k in s) out[k] = s[k];
  }
  return out;
}

async function saveSettings(partial) {
  for (const [k, v] of Object.entries(partial)) {
    await Storage.setSetting(k, v);
  }
}

// -------- Message handlers --------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  const handlers = {
    'surveypilot_get_state': async () => {
      const s = await loadRunState();
      sendResponse({ runState: s });
    },
    'surveypilot_detect_tab': async () => {
      try {
        const r = await sendToActiveTab({ type: 'surveypilot_detect' });
        sendResponse(r);
      } catch (e) { sendResponse({ ok: false, reason: e.message }); }
    },
    'surveypilot_read_tab': async () => {
      try {
        // Read the form. If no questions are found, this might be an intro page
        // or a confirmation page. Automatically click through these pages and retry.
        // CRITICAL: verify the page actually changed before retrying to avoid infinite loops.
        const tab = await getActiveTab();
        let survey = null;
        let lastSig = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const r = await sendToTab(tab.id, { type: 'surveypilot_read' });
          if (r && r.ok && r.sections && r.sections.length > 0 && r.sections.some((s) => s.questions.length > 0)) {
            // Found questions — build the survey
            survey = Parser.buildSurvey({
              url: tab.url,
              title: r.title || tab.title,
              formType: r.formType,
              sections: r.sections,
              detectedAt: Date.now()
            });
            await Storage.put('surveys', survey);
            break;
          }
          // No questions found — check if it's a confirmation page or intro page
          if (attempt < 4) {
            // Get the current page signature to detect if we're looping
            let curSig = null;
            try {
              const sigResp = await sendToTab(tab.id, { type: 'surveypilot_nav_signature' });
              curSig = sigResp && sigResp.hash;
            } catch (e) {}
            // If the signature hasn't changed since last attempt, we're in a loop — stop
            if (curSig && curSig === lastSig) {
              break;
            }
            lastSig = curSig;

            // Check for confirmation page (STRICT detection — only true if no form elements)
            let isConfirm = false;
            try {
              const confirmCheck = await sendToTab(tab.id, { type: 'surveypilot_nav_is_confirmation' });
              isConfirm = confirmCheck && confirmCheck.isConfirmation;
            } catch (e) {}
            if (isConfirm) {
              // Click "Submit another response" to reload the form
              try {
                const resub = await sendToTab(tab.id, { type: 'surveypilot_nav_resubmit' });
                if (resub && resub.ok) {
                  await sleep(2000);
                  try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
                  continue;
                }
              } catch (e) {}
            }
            // Check for intro page (has Next button but no questions)
            try {
              const btns = await sendToTab(tab.id, { type: 'surveypilot_nav_buttons' });
              if (btns && btns.hasNext) {
                const navRes = await sendToTab(tab.id, { type: 'surveypilot_nav_next' });
                if (navRes && navRes.ok) {
                  await sleep(1500);
                  try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
                  continue;
                }
              }
            } catch (e) {}
            await sleep(800);
          }
        }
        if (survey && survey.questionCount > 0) {
          sendResponse({ ok: true, survey });
        } else {
          // FALLBACK: Use Gemini AI to read the page if the DOM-based reader failed.
          // This extracts all visible text and asks Gemini to identify questions.
          const settings = await getSettingsFixed();
          if (settings.geminiApiKey) {
            const aiQuestions = await readWithAI(tab.id);
            if (aiQuestions && aiQuestions.length > 0) {
              const aiSurvey = Parser.buildSurvey({
                url: tab.url,
                title: tab.title || 'Google Form',
                formType: 'google_forms',
                sections: [{ id: Parser.makeId('sec'), title: 'AI-detected section', questions: aiQuestions }],
                detectedAt: Date.now()
              });
              await Storage.put('surveys', aiSurvey);
              sendResponse({ ok: true, survey: aiSurvey, source: 'ai' });
              return;
            }
          }
          sendResponse({ ok: false, reason: 'No questions found. If this is a Google Form intro page, try clicking Next manually first, then reopen the panel.' });
        }
      } catch (e) { sendResponse({ ok: false, reason: e.message }); }
    },
    'surveypilot_diagnostic_tab': async () => {
      try {
        const r = await sendToActiveTab({ type: 'surveypilot_diagnostic' });
        sendResponse(r);
      } catch (e) { sendResponse({ ok: false, reason: e.message }); }
    },
    'surveypilot_get_surveys': async () => {
      const surveys = await Storage.getAll('surveys');
      sendResponse({ surveys });
    },
    'surveypilot_get_respondents': async () => {
      const respondents = await Storage.getAll('respondents');
      sendResponse({ respondents });
    },
    'surveypilot_save_respondent': async () => {
      await Storage.put('respondents', msg.respondent);
      sendResponse({ ok: true });
    },
    'surveypilot_delete_respondent': async () => {
      await Storage.del('respondents', msg.id);
      sendResponse({ ok: true });
    },
    'surveypilot_generate_respondents': async () => {
      const settings = await getSettingsFixed();
      const cfg = Object.assign({}, settings.respondentConfig || Generator.DEFAULT_CONFIG, msg.config || {});
      const mode = msg.mode || settings.generationMode || 'local';
      const generated = await Generator.generateRespondents({
        count: msg.count || settings.defaultRespondentCount,
        config: cfg,
        seed: msg.seed,
        surveyId: msg.surveyId,
        mode
      });
      // Persist
      for (const r of generated) { await Storage.put('respondents', r); }
      sendResponse({ ok: true, respondents: generated });
    },
    'surveypilot_generate_answers': async () => {
      const settings = await getSettingsFixed();
      const survey = msg.survey;
      const respondent = msg.respondent;
      const opts = {
        mode: msg.mode || settings.generationMode,
        apiKey: settings.geminiApiKey,
        model: settings.geminiModel,
        retryLimit: settings.retryLimit,
        responseVariation: (settings.respondentConfig && settings.respondentConfig.responseVariation) || 0.7,
        consistencyLevel: (settings.respondentConfig && settings.respondentConfig.consistencyLevel) || 0.9,
        seed: msg.seed
      };
      const r = await AnswerGen.generateAnswers(survey, respondent, opts);
      await Storage.put('respondents', respondent);
      sendResponse({ ok: true, respondent, errors: r.errors || [] });
    },
    'surveypilot_generate_answers_for_questions': async () => {
      const settings = await getSettingsFixed();
      const questions = msg.questions || [];
      const respondent = msg.respondent;
      const opts = {
        mode: resolveMode(settings),
        apiKey: settings.geminiApiKey,
        model: settings.geminiModel,
        retryLimit: settings.retryLimit,
        responseVariation: (settings.respondentConfig && settings.respondentConfig.responseVariation) || 0.7,
        consistencyLevel: (settings.respondentConfig && settings.respondentConfig.consistencyLevel) || 0.9
      };
      const r = await AnswerGen.generateAnswersForQuestions(questions, respondent, opts);
      await Storage.put('respondents', respondent);
      sendResponse({ ok: true, respondent, generated: r.generated });
    },
    'surveypilot_get_runs': async () => {
      const runs = await Storage.getAll('runs');
      sendResponse({ runs });
    },
    'surveypilot_get_run': async () => {
      const run = await Storage.get('runs', msg.runId);
      sendResponse({ run });
    },
    'surveypilot_get_logs': async () => {
      const logs = msg.runId ? await Storage.queryByIndex('logs', 'runId', msg.runId) : await Storage.getAll('logs');
      logs.sort((a, b) => a.timestamp - b.timestamp);
      sendResponse({ logs });
    },
    'surveypilot_get_diagnostics': async () => {
      const diags = msg.runId ? await Storage.queryByIndex('diagnostics', 'runId', msg.runId) : await Storage.getAll('diagnostics');
      sendResponse({ diagnostics: diags });
    },
    'surveypilot_get_settings': async () => {
      const settings = await getSettingsFixed();
      // Strip the API key from anything we send back? No, the options page needs to show it (masked).
      // But never log it or include in exports.
      sendResponse({ settings });
    },
    'surveypilot_save_settings': async () => {
      await saveSettings(msg.settings);
      sendResponse({ ok: true });
    },
    'surveypilot_test_api_key': async () => {
      try {
        const text = await AnswerGen.callGemini({
          apiKey: msg.apiKey,
          model: msg.model || AnswerGen.DEFAULT_MODEL,
          prompt: 'Reply with the single word OK.',
          timeoutMs: 10000
        });
        sendResponse({ ok: true, sample: text.slice(0, 120) });
      } catch (e) {
        sendResponse({ ok: false, error: e.message, kind: AnswerGen.classifyError(e, e.httpStatus) });
      }
    },
    'surveypilot_backup': async () => {
      const payload = await Storage.backup();
      sendResponse({ payload });
    },
    'surveypilot_restore': async () => {
      try {
        await Storage.restore(msg.payload, { replace: !!msg.replace });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    },
    'surveypilot_clear_all': async () => {
      await Storage.clearAll();
      await clearRunState();
      sendResponse({ ok: true });
    },
    'surveypilot_clear_store': async () => {
      await Storage.clearStore(msg.store);
      sendResponse({ ok: true });
    },
    'surveypilot_export_respondents_csv': async () => {
      const respondents = await Storage.getAll('respondents');
      const survey = msg.surveyId ? await Storage.get('surveys', msg.surveyId) : null;
      const csv = Export.respondentsToCsv(respondents, survey);
      Export.downloadStringSW('surveypilot_respondents.csv', 'text/csv', csv);
      sendResponse({ ok: true });
    },
    'surveypilot_export_respondents_json': async () => {
      const respondents = await Storage.getAll('respondents');
      const survey = msg.surveyId ? await Storage.get('surveys', msg.surveyId) : null;
      const json = Export.respondentsToJson(respondents, survey);
      Export.downloadStringSW('surveypilot_respondents.json', 'application/json', json);
      sendResponse({ ok: true });
    },
    'surveypilot_export_logs_csv': async () => {
      const logs = msg.runId ? await Storage.queryByIndex('logs', 'runId', msg.runId) : await Storage.getAll('logs');
      const csv = Export.logsToCsv(logs);
      Export.downloadStringSW('surveypilot_logs.csv', 'text/csv', csv);
      sendResponse({ ok: true });
    },
    'surveypilot_export_runs_csv': async () => {
      const runs = await Storage.getAll('runs');
      const csv = Export.runsToCsv(runs);
      Export.downloadStringSW('surveypilot_runs.csv', 'text/csv', csv);
      sendResponse({ ok: true });
    },
    'surveypilot_export_backup': async () => {
      const payload = await Storage.backup();
      const json = Export.fullBackupJson(payload);
      Export.downloadStringSW('surveypilot_backup.json', 'application/json', json);
      sendResponse({ ok: true });
    },
    'surveypilot_stats': async () => {
      const runs = await Storage.getAll('runs');
      const stats = Stats.computeFromRuns(runs);
      sendResponse({ stats });
    },
    'surveypilot_storage_usage': async () => {
      const u = await Storage.usage();
      const counts = {};
      for (const name of Object.keys(Storage.STORES)) {
        counts[name] = await Storage.count(name);
      }
      sendResponse({ usage: u, counts });
    },
    // Run control
    'surveypilot_start_run': async () => {
      const existing = await loadRunState();
      if (existing && existing.status === 'running') {
        sendResponse({ ok: false, reason: 'A run is already in progress' });
        return;
      }
      // Require destination confirmation
      if (!msg.destinationUrl || !msg.confirmed) {
        sendResponse({ ok: false, reason: 'Destination must be confirmed before starting' });
        return;
      }
      const settings = await getSettingsFixed();
      const tab = await getActiveTab();
      if (tab.url !== msg.destinationUrl) {
        sendResponse({ ok: false, reason: 'Active tab URL does not match confirmed destination. Open the confirmed destination tab first.' });
        return;
      }
      const respondents = msg.respondentIds && msg.respondentIds.length
        ? (await Promise.all(msg.respondentIds.map((id) => Storage.get('respondents', id)))).filter(Boolean)
        : (await Storage.getAll('respondents'));
      if (!respondents.length) {
        sendResponse({ ok: false, reason: 'No respondents selected' });
        return;
      }
      runState = {
        id: 'run_' + Date.now().toString(36),
        mode: msg.mode || 'test',
        destinationUrl: msg.destinationUrl,
        surveyId: msg.surveyId || null,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        executionItems: respondents.map((r) => ({
          respondentId: r.id,
          profile: r.profile,
          status: 'pending',
          durationMs: 0,
          questionsCompleted: 0,
          questionsRemaining: 0,
          currentSection: null,
          attempts: 0,
          result: null
        })),
        retryLimit: settings.retryLimit,
        delayBetweenRunsMs: settings.delayBetweenRunsMs,
        paused: false,
        abortFlag: false,
        maxRetries: msg.maxRetries != null ? msg.maxRetries : settings.retryLimit,
        intervalMs: msg.intervalMs != null ? msg.intervalMs : settings.delayBetweenRunsMs
      };
      await persistRunState();
      logLine(runState.id, null, 'run_started', '', 'ok', { mode: runState.mode, destination: runState.destinationUrl, count: respondents.length });
      sendResponse({ ok: true, runState });
      pushStateToPanel();
      // Kick off the loop (do not await)
      runLoop();
    },
    'surveypilot_pause_run': async () => {
      const s = await loadRunState();
      if (!s) { sendResponse({ ok: false, reason: 'No active run' }); return; }
      s.status = 'paused';
      s.paused = true;
      await persistRunState();
      logLine(s.id, null, 'run_paused', '', 'ok', null);
      sendResponse({ ok: true, runState: s });
      pushStateToPanel();
    },
    'surveypilot_resume_run': async () => {
      const s = await loadRunState();
      if (!s) { sendResponse({ ok: false, reason: 'No active run' }); return; }
      if (s.status !== 'paused') { sendResponse({ ok: false, reason: 'Run is not paused' }); return; }
      s.status = 'running';
      s.paused = false;
      await persistRunState();
      logLine(s.id, null, 'run_resumed', '', 'ok', null);
      sendResponse({ ok: true, runState: s });
      pushStateToPanel();
      runLoop();
    },
    'surveypilot_stop_run': async () => {
      const s = await loadRunState();
      if (!s) { sendResponse({ ok: false, reason: 'No active run' }); return; }
      s.status = 'stopped';
      s.abortFlag = true;
      s.endedAt = Date.now();
      await persistRunState();
      logLine(s.id, null, 'run_stopped', '', 'ok', null);
      sendResponse({ ok: true, runState: s });
      pushStateToPanel();
    },
    'surveypilot_reset_run': async () => {
      await clearRunState();
      sendResponse({ ok: true });
      pushStateToPanel();
    },
    'surveypilot_retry_respondent': async () => {
      const s = await loadRunState();
      if (!s) { sendResponse({ ok: false, reason: 'No active run' }); return; }
      const item = s.executionItems.find((i) => i.respondentId === msg.respondentId);
      if (!item) { sendResponse({ ok: false, reason: 'Respondent not in run' }); return; }
      item.status = 'pending';
      item.attempts = 0;
      await persistRunState();
      sendResponse({ ok: true, runState: s });
      pushStateToPanel();
    },
    'surveypilot_skip_respondent': async () => {
      const s = await loadRunState();
      if (!s) { sendResponse({ ok: false, reason: 'No active run' }); return; }
      const item = s.executionItems.find((i) => i.respondentId === msg.respondentId);
      if (!item) { sendResponse({ ok: false, reason: 'Respondent not in run' }); return; }
      item.status = 'skipped';
      item.result = 'skipped by user';
      await persistRunState();
      logLine(s.id, msg.respondentId, 'skipped', '', 'skipped', null);
      sendResponse({ ok: true, runState: s });
      pushStateToPanel();
    },
    'surveypilot_fill_active_tab': async () => {
      // Fill mode: fill the active form with one respondent, do not submit
      try {
        const respondent = msg.respondent;
        const readRes = await sendToActiveTab({ type: 'surveypilot_read_visible' });
        if (!readRes.ok) { sendResponse({ ok: false, reason: readRes.reason || 'Could not read form' }); return; }
        const section = readRes.sections[0];
        if (!section) { sendResponse({ ok: false, reason: 'No visible section' }); return; }
        const fillRes = await sendToActiveTab({ type: 'surveypilot_fill_section', section, answers: respondent.answers });
        sendResponse(fillRes);
      } catch (e) { sendResponse({ ok: false, reason: e.message }); }
    }
  };

  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve(handler()).catch((e) => {
    try { sendResponse({ ok: false, reason: e && e.message || String(e) }); } catch (_) {}
  });
  return true; // async response
});

// -------- Run loop (single-threaded, async) --------

async function runLoop() {
  const s = await loadRunState();
  if (!s) return;
  if (s.status !== 'running') return;

  // Prevent duplicate loops via a guard flag
  if (runLoop._busy) return;
  runLoop._busy = true;

  try {
    while (true) {
      const state = await loadRunState();
      if (!state || state.status !== 'running') break;
      if (state.abortFlag) break;

      const item = state.executionItems.find((i) => i.status === 'pending');
      if (!item) {
        // All done
        state.status = 'completed';
        state.endedAt = Date.now();
        await persistRunState();
        logLine(state.id, null, 'run_completed', '', 'ok', null);
        pushStateToPanel();
        break;
      }

      // Execute this respondent
      await executeRespondent(state, item);

      // Honor delay between runs
      if (state.intervalMs && state.status === 'running') {
        await sleep(state.intervalMs);
      }
    }
  } finally {
    runLoop._busy = false;
  }
}

async function executeRespondent(run, item) {
  const respondent = await Storage.get('respondents', item.respondentId);
  if (!respondent) {
    item.status = 'failed';
    item.result = 'respondent record missing';
    await persistRunState();
    logLine(run.id, item.respondentId, 'failed', '', 'error', 'respondent record missing');
    pushStateToPanel();
    return;
  }

  item.status = 'generating';
  item.attempts = (item.attempts || 0) + 1;
  await persistRunState();
  pushStateToPanel();
  logLine(run.id, item.respondentId, 'respondent_selected', '', 'ok', { profile: respondent.profile });

  const t0 = Date.now();
  try {
    // If answers not generated yet, generate them now using the current survey
    if (!respondent.answers || !Object.keys(respondent.answers).length) {
      const survey = run.surveyId ? await Storage.get('surveys', run.surveyId) : null;
      if (survey) {
        const settings = await getSettingsFixed();
        const opts = {
          mode: resolveMode(settings),
          apiKey: settings.geminiApiKey,
          model: settings.geminiModel,
          retryLimit: settings.retryLimit,
          responseVariation: (settings.respondentConfig && settings.respondentConfig.responseVariation) || 0.7,
          consistencyLevel: (settings.respondentConfig && settings.respondentConfig.consistencyLevel) || 0.9
        };
        await AnswerGen.generateAnswers(survey, respondent, opts);
        await Storage.put('respondents', respondent);
      }
    }

    // Get active tab
    let tab;
    try { tab = await getActiveTab(); }
    catch (e) {
      await failRespondent(run, item, 'Could not access active tab: ' + e.message, respondent);
      return;
    }
    if (tab.url !== run.destinationUrl) {
      await failRespondent(run, item, 'Active tab URL does not match confirmed destination', respondent);
      return;
    }

    // For preview mode, just mark complete with no DOM interaction
    if (run.mode === 'preview') {
      item.status = 'completed';
      item.result = 'preview_only';
      item.durationMs = Date.now() - t0;
      item.questionsCompleted = Object.keys(respondent.answers || {}).length;
      await persistRunState();
      logLine(run.id, item.respondentId, 'preview_completed', '', 'ok', null);
      pushStateToPanel();
      return;
    }

    // For fill/test mode, walk through the form section by section
    await navigateFormForRespondent(run, item, respondent, tab);
  } catch (e) {
    await failRespondent(run, item, 'Unhandled error: ' + (e && e.message), respondent);
  }
}

async function navigateFormForRespondent(run, item, respondent, tab) {
  let sectionIdx = 0;
  let attemptsThisRespondent = 0;
  const maxSectionRetries = 4; // Increased from 2 to 4 — don't give up easily
  let lastSignature = null;
  let sameSigCount = 0;
  while (true) {
    if (run.abortFlag || run.status !== 'running') {
      item.status = run.abortFlag ? 'failed' : item.status;
      item.result = run.abortFlag ? 'aborted' : item.result;
      await persistRunState();
      return;
    }
    // Read visible section
    item.status = 'filling';
    item.currentSection = sectionIdx + 1;
    await persistRunState();
    pushStateToPanel();

    // Read with retry — navigation can cause "message channel closed" errors
    let readRes = null;
    for (let readAttempt = 0; readAttempt < 3; readAttempt++) {
      try {
        readRes = await sendToTab(tab.id, { type: 'surveypilot_read_visible' });
        if (readRes && readRes.ok && readRes.sections && readRes.sections.length > 0 && readRes.sections.some((s) => s.questions && s.questions.length > 0)) break;
      } catch (e) {
        // Message channel closed — wait and retry (content script may be reloading)
        logLine(run.id, item.respondentId, 'read_retry', '', 'warn', { attempt: readAttempt + 1, error: e.message });
        await sleep(1000);
        try { await ensureContentScriptsLoaded(tab.id); } catch (e2) {}
      }
      await sleep(500);
    }
    // FALLBACK: If DOM-based reading found no questions, use Gemini AI to read the page
    if (!readRes || !readRes.ok || !readRes.sections || !readRes.sections.some((s) => s.questions && s.questions.length > 0)) {
      const settings = await getSettingsFixed();
      if (settings.geminiApiKey) {
        logLine(run.id, item.respondentId, 'ai_reading', 'Using Gemini to read page', 'ok', null);
        const aiQuestions = await readWithAI(tab.id);
        if (aiQuestions && aiQuestions.length > 0) {
          logLine(run.id, item.respondentId, 'ai_read_success', aiQuestions.length + ' questions found by AI', 'ok', null);
          readRes = {
            ok: true,
            formType: 'google_forms',
            sections: [{ id: 'ai_sec', title: 'Current section', questions: aiQuestions }]
          };
        }
      }
    }
    // SECOND FALLBACK: If AI reading also failed, check if there are visible form inputs
    // on the page. If yes, create questions directly from the input elements.
    // This prevents the extension from clicking Next and SKIPPING a page with questions.
    if (!readRes || !readRes.ok || !readRes.sections || !readRes.sections.some((s) => s.questions && s.questions.length > 0)) {
      try {
        const hasInputs = await sendToTab(tab.id, { type: 'surveypilot_has_visible_inputs' });
        if (hasInputs && hasInputs.hasInputs) {
          logLine(run.id, item.respondentId, 'input_based_reading', 'Found form inputs — reading from elements', 'ok', null);
          const inputRead = await sendToTab(tab.id, { type: 'surveypilot_read_from_inputs' });
          if (inputRead && inputRead.ok && inputRead.questions && inputRead.questions.length > 0) {
            logLine(run.id, item.respondentId, 'input_read_success', inputRead.questions.length + ' questions found from inputs', 'ok', null);
            readRes = {
              ok: true,
              formType: 'google_forms',
              sections: [{ id: 'inp_sec', title: 'Current section', questions: inputRead.questions }]
            };
          }
        }
      } catch (e) {}
    }
    if (!readRes || !readRes.ok) {
      // No visible section found. This could be:
      // 1. An intro/start page (no questions, just a "Next" button) — click Next and retry
      // 2. A transition page between sections — click Next and retry
      // 3. The confirmation page after submit — check for resubmit link
      // 4. A real error — retry a few times, then fail

      // First check if this is a confirmation page (form already submitted)
      let isConfirm = false;
      try {
        const confirmCheck = await sendToTab(tab.id, { type: 'surveypilot_nav_is_confirmation' });
        isConfirm = confirmCheck && confirmCheck.isConfirmation;
      } catch (e) {}
      if (isConfirm) {
        // Form was already submitted (maybe by a previous respondent). Click resubmit to reload.
        logLine(run.id, item.respondentId, 'confirmation_page_detected', '', 'ok', null);
        const resub = await sendToTab(tab.id, { type: 'surveypilot_nav_resubmit' });
        if (resub && resub.ok) {
          logLine(run.id, item.respondentId, 'resubmit_clicked', '', 'ok', { href: resub.href });
          await sleep(2000); // wait for form to reload
          try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
          continue; // re-read the form
        }
      }

      // Try clicking Next — might be an intro page
      let navRes = null;
      try { navRes = await sendToTab(tab.id, { type: 'surveypilot_nav_next' }); } catch (e) {
        logLine(run.id, item.respondentId, 'nav_error', '', 'warn', { error: e.message });
      }
      if (navRes && navRes.ok) {
        // Clicked Next on an intro/transition page — wait and re-read
        logLine(run.id, item.respondentId, 'intro_page_skipped', '', 'ok', null);
        await sleep(1000);
        try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
        continue;
      }
      if (navRes && navRes.isLastPage && navRes.submitAvailable) {
        // This is the last page — submit
        const subRes = await sendToTab(tab.id, { type: 'surveypilot_nav_submit' });
        if (subRes && subRes.ok) {
          item.status = 'completed';
          item.result = 'submitted';
          item.durationMs = Date.now() - (item.startedAt || Date.now());
          await persistRunState();
          logLine(run.id, item.respondentId, 'submitted', '', 'ok', null);
          pushStateToPanel();
          // Click resubmit to prepare the form for the next respondent
          await sleep(2000);
          try {
            const resub = await sendToTab(tab.id, { type: 'surveypilot_nav_resubmit' });
            if (resub && resub.ok) {
              logLine(run.id, item.respondentId, 'resubmit_clicked', '', 'ok', { href: resub.href });
              await sleep(2000);
              try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
            }
          } catch (e) {}
          return;
        }
        await failRespondent(run, item, 'Submit failed: ' + (subRes && subRes.reason), respondent);
        return;
      }
      // Real failure — retry a few times
      attemptsThisRespondent++;
      if (attemptsThisRespondent > maxSectionRetries) {
        await failRespondent(run, item, 'Could not read visible section: ' + (readRes && readRes.reason), respondent);
        await captureDiagnostics(run, item, respondent, tab, 'read_failed', readRes);
        return;
      }
      await sleep(800);
      try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
      continue;
    }
    // Read the visible section — ALWAYS update answers for any new questions discovered.
    // This is critical for multi-section forms: the initial survey read only captured
    // the first section, so later sections' questions won't have answers yet.
    const section = readRes.sections[0];

    // LOOP DETECTION: check if this is the same section as last time.
    // If the signature hasn't changed after clicking Next, we're stuck in a loop.
    let currentSig = null;
    try {
      const sigResp = await sendToTab(tab.id, { type: 'surveypilot_nav_signature' });
      currentSig = sigResp && sigResp.hash;
    } catch (e) {}
    if (currentSig && currentSig === lastSignature) {
      sameSigCount++;
      if (sameSigCount >= 3) {
        // Stuck in a loop — the Next button click isn't working.
        // Try to find and click the Submit button instead (maybe this is the last section).
        logLine(run.id, item.respondentId, 'loop_detected', 'Section not advancing after 3 attempts', 'warn', null);
        const btns = await sendToTab(tab.id, { type: 'surveypilot_nav_buttons' });
        if (btns && btns.hasSubmit) {
          const subRes = await sendToTab(tab.id, { type: 'surveypilot_nav_submit' });
          if (subRes && subRes.ok) {
            item.status = 'completed';
            item.result = 'submitted_after_loop';
            item.durationMs = Date.now() - (item.startedAt || Date.now());
            await persistRunState();
            logLine(run.id, item.respondentId, 'submitted', '', 'ok', null);
            pushStateToPanel();
            // Click resubmit for next respondent
            await sleep(2000);
            try {
              const resub = await sendToTab(tab.id, { type: 'surveypilot_nav_resubmit' });
              if (resub && resub.ok) {
                await sleep(2000);
                try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
              }
            } catch (e) {}
            return;
          }
        }
        // No submit button — mark as completed (best effort) and move on
        item.status = 'completed';
        item.result = 'section_loop_break';
        item.durationMs = Date.now() - (item.startedAt || Date.now());
        await persistRunState();
        logLine(run.id, item.respondentId, 'completed', 'Broke out of section loop', 'warn', null);
        pushStateToPanel();
        return;
      }
    } else {
      sameSigCount = 0;
    }
    lastSignature = currentSig;

    if (!section || !section.questions || section.questions.length === 0) {
      // Section has no questions. BEFORE clicking Next, check if there are visible
      // form inputs on the page. If yes, DON'T skip — read from inputs and fill them.
      let hasInputs = false;
      try {
        const check = await sendToTab(tab.id, { type: 'surveypilot_has_visible_inputs' });
        hasInputs = check && check.hasInputs;
      } catch (e) {}
      if (hasInputs) {
        // There ARE form inputs on the page — read them and fill
        logLine(run.id, item.respondentId, 'input_based_reading', 'Found form inputs — reading from elements', 'ok', null);
        try {
          const inputRead = await sendToTab(tab.id, { type: 'surveypilot_read_from_inputs' });
          if (inputRead && inputRead.ok && inputRead.questions && inputRead.questions.length > 0) {
            // Replace the empty section with the input-based questions
            section.questions = inputRead.questions;
            logLine(run.id, item.respondentId, 'input_read_success', inputRead.questions.length + ' questions found from inputs', 'ok', null);
            // Don't click Next — continue to the filling step below
          }
        } catch (e) {}
      }
      if (!section.questions || section.questions.length === 0) {
        // Still no questions — this is truly an intro/transition page. Click Next.
        logLine(run.id, item.respondentId, 'empty_section_skipped', section && section.title || '', 'ok', null);
        const navRes = await sendToTab(tab.id, { type: 'surveypilot_nav_next' });
        if (navRes && navRes.ok) {
          await sleep(800);
          try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
          sectionIdx++;
          continue;
        }
        if (navRes && navRes.isLastPage && navRes.submitAvailable) {
          // Submit
          const subRes = await sendToTab(tab.id, { type: 'surveypilot_nav_submit' });
          if (subRes && subRes.ok) {
            item.status = 'completed';
            item.result = 'submitted';
            item.durationMs = Date.now() - (item.startedAt || Date.now());
            await persistRunState();
            logLine(run.id, item.respondentId, 'submitted', '', 'ok', null);
            pushStateToPanel();
            await sleep(2000);
            try {
              const resub = await sendToTab(tab.id, { type: 'surveypilot_nav_resubmit' });
              if (resub && resub.ok) {
                logLine(run.id, item.respondentId, 'resubmit_clicked', '', 'ok', { href: resub.href });
                await sleep(2000);
                try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
              }
            } catch (e) {}
            return;
          }
        }
        // No Next and no Submit — must be the end
        break;
      }
    }

    // Check for questions without answers and generate them on-the-fly (AI or local)
    const missingQuestions = (section.questions || []).filter((q) => {
      const a = respondent.answers && respondent.answers[q.id];
      return !a || a.value == null || a.value === '' || (Array.isArray(a.value) && a.value.length === 0);
    });
    if (missingQuestions.length) {
      item.status = 'generating';
      await persistRunState();
      pushStateToPanel();
      const settings = await getSettingsFixed();
      const actualMode = resolveMode(settings);
      logLine(run.id, item.respondentId, 'generating_section_answers', section.title, 'ok',
        { newQuestions: missingQuestions.length, mode: actualMode, hasApiKey: !!settings.geminiApiKey });
      const opts = {
        mode: actualMode,
        apiKey: settings.geminiApiKey,
        model: settings.geminiModel,
        retryLimit: settings.retryLimit,
        responseVariation: (settings.respondentConfig && settings.respondentConfig.responseVariation) || 0.7,
        consistencyLevel: (settings.respondentConfig && settings.respondentConfig.consistencyLevel) || 0.9
      };
      await AnswerGen.generateAnswersForQuestions(section.questions, respondent, opts);
      await Storage.put('respondents', respondent);
      // Also update the stored survey with this section if it's new
      const storedSurvey = run.surveyId ? await Storage.get('surveys', run.surveyId) : null;
      if (storedSurvey) {
        const existingSectionIds = (storedSurvey.sections || []).map((s) => s.id);
        if (!existingSectionIds.includes(section.id) && section.questions.length > 0) {
          storedSurvey.sections = storedSurvey.sections || [];
          storedSurvey.sections.push(section);
          storedSurvey.questionCount = (storedSurvey.sections || []).reduce((n, s) => n + (s.questions || []).length, 0);
          storedSurvey.sectionCount = storedSurvey.sections.length;
          await Storage.put('surveys', storedSurvey);
        }
      }
    }

    // Validate answers exist for required questions in this section
    const validation = await sendToTab(tab.id, { type: 'surveypilot_validate_section', section, answers: respondent.answers });
    if (!validation || !validation.ok) {
      const missing = (validation && validation.missing) || [];
      if (missing.length) {
        const missingTexts = missing.map((m) => m.questionText).join('; ');
        logLine(run.id, item.respondentId, 'missing_answers', missingTexts, 'warn', null);
        // We already tried to generate answers above. If still missing, skip this respondent.
        if (item.attempts > run.maxRetries) {
          await failRespondent(run, item, 'Required questions missing answers: ' + missingTexts, respondent);
          await captureDiagnostics(run, item, respondent, tab, 'missing_answers', { missing });
          return;
        }
        // Retry once more — generate for the specific missing questions
        const settings = await getSettingsFixed();
        const opts = {
          mode: resolveMode(settings),
          apiKey: settings.geminiApiKey,
          model: settings.geminiModel,
          responseVariation: (settings.respondentConfig && settings.respondentConfig.responseVariation) || 0.7
        };
        const missingQs = (section.questions || []).filter((q) => missing.some((m) => m.questionId === q.id));
        await AnswerGen.generateAnswersForQuestions(missingQs, respondent, opts);
        await Storage.put('respondents', respondent);
        continue;
      }
    }

    // Fill the section
    let fillRes = await sendToTab(tab.id, { type: 'surveypilot_fill_section', section, answers: respondent.answers });
    if (!fillRes || !fillRes.ok) {
      const failed = (fillRes && fillRes.failed) || [];
      const failedTexts = failed.map((f) => f.questionText).join('; ');
      logLine(run.id, item.respondentId, 'fill_failed', failedTexts, 'error', JSON.stringify(failed));
      if (item.attempts > run.maxRetries) {
        await failRespondent(run, item, 'Failed to fill section: ' + failedTexts, respondent);
        await captureDiagnostics(run, item, respondent, tab, 'fill_failed', fillRes);
        return;
      }
      continue;
    }
    // Log each filled question
    (fillRes.results || []).forEach((r) => {
      logLine(run.id, item.respondentId, 'question_filled', r.questionText, r.ok ? 'ok' : 'error', r.reason || null);
    });
    item.questionsCompleted += (fillRes.results || []).filter((r) => r.ok).length;

    // Retry failed questions individually (up to 2 extra rounds)
    for (let retryRound = 0; retryRound < 2; retryRound++) {
      const failedResults = (fillRes.results || []).filter((r) => !r.ok);
      if (!failedResults.length) break;
      logLine(run.id, item.respondentId, 'retrying_failed_questions', failedResults.length + ' questions', 'warn', null);
      await sleep(500);
      // Re-fill only the failed questions
      const failedQs = (section.questions || []).filter((q) => failedResults.some((fr) => fr.questionId === q.id));
      for (const fq of failedQs) {
        const ans = respondent.answers[fq.id];
        if (!ans || ans.value == null) {
          // Generate a default answer if missing
          const settings = await getSettingsFixed();
          await AnswerGen.generateAnswersForQuestions([fq], respondent, { mode: resolveMode(settings), apiKey: settings.geminiApiKey, model: settings.geminiModel });
          await Storage.put('respondents', respondent);
        }
        const retryAns = respondent.answers[fq.id];
        if (retryAns) {
          const retryRes = await sendToTab(tab.id, { type: 'surveypilot_fill_question', question: fq, answer: retryAns });
          logLine(run.id, item.respondentId, 'question_filled', fq.text, retryRes && retryRes.ok ? 'ok' : 'error', retryRes && retryRes.reason || null);
          if (retryRes && retryRes.ok) {
            item.questionsCompleted++;
            // Update the fillRes to mark this question as ok
            const fr = (fillRes.results || []).find((r) => r.questionId === fq.id);
            if (fr) { fr.ok = true; fr.reason = null; }
          }
        }
      }
    }

    // Validate after fill
    item.status = 'validating';
    await persistRunState();
    pushStateToPanel();
    const verify = await sendToTab(tab.id, { type: 'surveypilot_validate_section', section, answers: respondent.answers });
    if (verify && !verify.ok && verify.mismatched.length) {
      logLine(run.id, item.respondentId, 'verification_mismatch', verify.mismatched.map((m) => m.questionText).join('; '), 'warn', JSON.stringify(verify.mismatched));
    }
    logLine(run.id, item.respondentId, 'section_completed', section.title, 'ok', { sectionIndex: sectionIdx });

    // For fill mode: stop after the current visible section (do not auto-navigate)
    if (run.mode === 'fill') {
      item.status = 'completed';
      item.result = 'filled_one_section';
      item.durationMs = Date.now() - (item.startedAt || Date.now());
      await persistRunState();
      logLine(run.id, item.respondentId, 'fill_completed', '', 'ok', null);
      pushStateToPanel();
      return;
    }

    // Test mode: navigate next
    const navRes = await sendToTab(tab.id, { type: 'surveypilot_nav_next' });
    if (!navRes) {
      await failRespondent(run, item, 'No navigation response', respondent);
      await captureDiagnostics(run, item, respondent, tab, 'nav_no_response', null);
      return;
    }
    if (navRes.isLastPage && navRes.submitAvailable) {
      // Submit
      const subRes = await sendToTab(tab.id, { type: 'surveypilot_nav_submit' });
      if (!subRes || !subRes.ok) {
        await failRespondent(run, item, 'Submit failed: ' + (subRes && subRes.reason), respondent);
        await captureDiagnostics(run, item, respondent, tab, 'submit_failed', subRes);
        return;
      }
      item.status = 'completed';
      item.result = 'submitted';
      item.durationMs = Date.now() - (item.startedAt || Date.now());
      await persistRunState();
      logLine(run.id, item.respondentId, 'submitted', '', 'ok', null);
      pushStateToPanel();
      // Wait for the confirmation page to load, then click "Submit another response"
      // to reload the form for the next respondent.
      await sleep(2000);
      try {
        const resub = await sendToTab(tab.id, { type: 'surveypilot_nav_resubmit' });
        if (resub && resub.ok) {
          logLine(run.id, item.respondentId, 'resubmit_clicked', '', 'ok', { href: resub.href });
          // Wait for the form to reload
          await sleep(2000);
          try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
        } else {
          logLine(run.id, item.respondentId, 'no_resubmit_link', '', 'warn', null);
        }
      } catch (e) {
        logLine(run.id, item.respondentId, 'resubmit_error', '', 'warn', { error: e.message });
      }
      return;
    }
    if (!navRes.ok) {
      if (navRes.reason === 'navigation_timeout') {
        await captureDiagnostics(run, item, respondent, tab, 'nav_timeout', navRes);
        if (item.attempts > run.maxRetries) {
          await failRespondent(run, item, 'Navigation timeout', respondent);
          return;
        }
        await sleep(500);
        continue;
      }
      // No next button and not last page: consider done
      if (navRes.reason === 'no_next_button' && !navRes.submitAvailable) {
        item.status = 'completed';
        item.result = 'no_more_sections';
        item.durationMs = Date.now() - (item.startedAt || Date.now());
        await persistRunState();
        logLine(run.id, item.respondentId, 'completed', '', 'ok', null);
        pushStateToPanel();
        return;
      }
      await failRespondent(run, item, 'Navigation failed: ' + (navRes.reason || 'unknown'), respondent);
      await captureDiagnostics(run, item, respondent, tab, 'nav_failed', navRes);
      return;
    }
    // Navigation succeeded — wait for the new section to fully render before reading it.
    // Google Forms navigates asynchronously; reading too quickly causes "message channel closed" errors.
    await sleep(800);
    // Also re-inject content scripts in case the navigation caused a page reload
    try { await ensureContentScriptsLoaded(tab.id); } catch (e) {}
    sectionIdx++;
  }
}

async function failRespondent(run, item, reason, respondent) {
  item.status = 'failed';
  item.result = reason;
  item.durationMs = Date.now() - (item.startedAt || Date.now());
  await persistRunState();
  logLine(run.id, item.respondentId, 'failed', '', 'error', reason);
  pushStateToPanel();
}

async function captureDiagnostics(run, item, respondent, tab, kind, extra) {
  const settings = await getSettingsFixed();
  if (!settings.diagnosticLogging) return;
  let signature = null;
  let buttons = null;
  try {
    signature = await sendToTab(tab.id, { type: 'surveypilot_nav_signature' });
    buttons = await sendToTab(tab.id, { type: 'surveypilot_nav_buttons' });
  } catch (e) { /* ignore */ }

  const diag = {
    id: 'diag_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    timestamp: Date.now(),
    runId: run.id,
    respondentId: item.respondentId,
    kind,
    sectionIndex: item.currentSection,
    url: tab.url,
    title: tab.title,
    signature,
    buttons,
    extra: extra || null
  };
  await Storage.put('diagnostics', diag);
  chrome.runtime.sendMessage({ type: 'surveypilot_diagnostic', diag }).catch(() => {});
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// -------- Side panel lifecycle --------

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

// Open side panel on action click when setPanelBehavior isn't honored
chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

// If a tab is closed or navigated away during a run, capture that
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await loadRunState();
  if (!s || s.status !== 'running') return;
  // We don't track the run's tab id explicitly; just log a warning
  logLine(s.id, null, 'tab_closed', '', 'warn', { tabId });
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url) {
    const s = await loadRunState();
    if (!s || s.status !== 'running') return;
    if (tab.url !== s.destinationUrl) {
      logLine(s.id, null, 'tab_navigated', '', 'warn', { url: tab.url });
    }
  }
});

// Wake the service worker if it was asleep when the user asked for state
chrome.runtime.onStartup.addListener(() => {
  loadRunState().catch(() => {});
});
