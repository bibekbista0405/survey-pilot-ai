/*
 * SurveyPilot AI - Export
 * CSV and JSON export for respondents, runs, logs, and full backups.
 * Never includes the Gemini API key in any export.
 */
(function (global) {
  'use strict';

  function jsonDump(data) {
    // Strip any field that looks like an API key from all exports
    const cleaned = stripSecrets(data);
    return JSON.stringify(cleaned, null, 2);
  }

  function stripSecrets(obj) {
    if (obj == null) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(stripSecrets);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/apiKey|api_key|geminiKey|secret|token|password/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = stripSecrets(v);
      }
    }
    return out;
  }

  function csvEscape(v) {
    if (v == null) return '';
    const s = Array.isArray(v) ? v.join('; ') : String(v);
    if (/[",\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function toCsv(rows, columns) {
    if (!rows || !rows.length) {
      return (columns || []).join(',') + '\n';
    }
    const cols = columns || Object.keys(rows[0]);
    const lines = [cols.join(',')];
    for (const row of rows) {
      lines.push(cols.map((c) => csvEscape(row[c])).join(','));
    }
    return lines.join('\n') + '\n';
  }

  // Convert respondents + their survey into flat CSV rows
  function respondentsToCsv(respondents, survey) {
    const questionCols = [];
    const qById = {};
    if (survey) {
      (survey.sections || []).forEach((s, si) => {
        (s.questions || []).forEach((q) => {
          q.sectionIndex = si;
          qById[q.id] = q;
          questionCols.push({ id: q.id, label: (si + 1) + '. ' + (q.text || q.id).slice(0, 60) });
        });
      });
    }
    const baseCols = ['id', 'index', 'generatedAt', 'generationMode', 'profile.age', 'profile.gender', 'profile.occupation', 'profile.region', 'profile.travelBehavior', 'profile.studentStatus'];
    const cols = baseCols.concat(questionCols.map((q) => q.label));
    const rows = respondents.map((r) => {
      const row = {
        id: r.id,
        index: r.index,
        generatedAt: r.generatedAt ? new Date(r.generatedAt).toISOString() : '',
        generationMode: r.generationMode || '',
        'profile.age': r.profile && r.profile.age,
        'profile.gender': r.profile && r.profile.gender,
        'profile.occupation': r.profile && r.profile.occupation,
        'profile.region': r.profile && r.profile.region,
        'profile.travelBehavior': r.profile && r.profile.travelBehavior,
        'profile.studentStatus': r.profile && r.profile.studentStatus
      };
      questionCols.forEach((q) => {
        const a = r.answers && r.answers[q.id];
        row[q.label] = a ? (Array.isArray(a.value) ? a.value.join('; ') : a.value) : '';
      });
      return row;
    });
    return toCsv(rows, cols);
  }

  function respondentsToJson(respondents, survey) {
    return jsonDump({ exportedAt: new Date().toISOString(), survey: survey ? stripSecrets(survey) : null, respondents: stripSecrets(respondents) });
  }

  function logsToCsv(logs) {
    const cols = ['timestamp', 'runId', 'respondentId', 'action', 'question', 'result', 'errorDetails'];
    const rows = (logs || []).map((l) => ({
      timestamp: l.timestamp ? new Date(l.timestamp).toISOString() : '',
      runId: l.runId || '',
      respondentId: l.respondentId || '',
      action: l.action || '',
      question: l.question || '',
      result: l.result || '',
      errorDetails: l.errorDetails ? (typeof l.errorDetails === 'string' ? l.errorDetails : JSON.stringify(l.errorDetails)) : ''
    }));
    return toCsv(rows, cols);
  }

  function runsToCsv(runs) {
    const cols = ['id', 'mode', 'destinationUrl', 'startedAt', 'endedAt', 'status', 'totalRespondents', 'completed', 'failed', 'skipped', 'elapsedMs'];
    const rows = (runs || []).map((run) => {
      const items = run.executionItems || [];
      const completed = items.filter((i) => i.status === 'completed').length;
      const failed = items.filter((i) => i.status === 'failed').length;
      const skipped = items.filter((i) => i.status === 'skipped').length;
      const elapsedMs = run.startedAt ? ((run.endedAt || Date.now()) - run.startedAt) : 0;
      return {
        id: run.id,
        mode: run.mode,
        destinationUrl: run.destinationUrl,
        startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : '',
        endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : '',
        status: run.status,
        totalRespondents: items.length,
        completed,
        failed,
        skipped,
        elapsedMs
      };
    });
    return toCsv(rows, cols);
  }

  function fullBackupJson(payload) {
    return jsonDump(payload);
  }

  // Trigger a browser download from a string
  function downloadString(filename, mime, content) {
    const blob = new Blob([content], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  // In service worker context, fall back to chrome.downloads API
  function downloadStringSW(filename, mime, content) {
    if (typeof chrome !== 'undefined' && chrome.downloads) {
      const url = 'data:' + (mime || 'text/plain') + ';charset=utf-8,' + encodeURIComponent(content);
      return new Promise((resolve, reject) => {
        chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        });
      });
    }
    return downloadString(filename, mime, content);
  }

  const Export = {
    jsonDump,
    stripSecrets,
    toCsv,
    csvEscape,
    respondentsToCsv,
    respondentsToJson,
    logsToCsv,
    runsToCsv,
    fullBackupJson,
    downloadString,
    downloadStringSW
  };

  global.SurveyPilot = global.SurveyPilot || {};
  global.SurveyPilot.Export = Export;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
