/* SurveyPilot AI - CSV / JSON export and backup validation. The API key is never part of any export. */
(function (root, factory) {
  var dep = (typeof require === 'function' && typeof module === 'object') ? require('./util.js') : root.SP;
  var api = factory(dep.Util);
  if (typeof module === 'object' && module.exports) module.exports = api;
  var SP = (root.SP = root.SP || {});
  Object.keys(api).forEach(function (k) { SP[k] = api[k]; });
})(typeof globalThis !== 'undefined' ? globalThis : self, function (Util) {
  'use strict';

  var BACKUP_VERSION = 2;
  var STORES = ['surveys', 'respondents', 'runs', 'runRecords', 'logs', 'diagnostics', 'settings'];

  var Exp = {
    BACKUP_VERSION: BACKUP_VERSION,

    /** RFC 4180 escaping plus neutralisation of spreadsheet formula injection. */
    csvEscape: function (value, delimiter) {
      delimiter = delimiter || ',';
      if (value == null) return '';
      var s = Array.isArray(value) ? value.join(' | ') : (typeof value === 'object' ? JSON.stringify(value) : String(value));
      if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
      if (s.indexOf('"') >= 0 || s.indexOf(delimiter) >= 0 || /[\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    },

    toCSV: function (rows, columns, opts) {
      var d = (opts && opts.delimiter) || ',';
      var lines = [columns.map(function (c) { return Exp.csvEscape(c.header, d); }).join(d)];
      rows.forEach(function (r) {
        lines.push(columns.map(function (c) { return Exp.csvEscape(typeof c.get === 'function' ? c.get(r) : r[c.key], d); }).join(d));
      });
      return lines.join('\r\n') + '\r\n';
    },

    respondentsToCSV: function (respondents, survey, opts) {
      opts = opts || {};
      var cols = [
        { header: 'respondent_id', get: function (r) { return r.id; } },
        { header: 'synthetic', get: function () { return 'true'; } },
        { header: 'source', get: function (r) { return r.source; } }
      ];
      if (opts.includeProfile !== false) {
        [['age', 'age'], ['gender', 'gender'], ['occupation', 'occupation'], ['student', 'isStudent'], ['region', 'region'],
          ['uses_bus', 'travel.usesBus'], ['bus_frequency', 'travel.busFrequency'], ['main_mode', 'travel.mainMode']].forEach(function (p) {
          cols.push({ header: p[0], get: function (r) {
            var v = p[1].split('.').reduce(function (o, k) { return o && o[k]; }, r.profile || {}); return v;
          } });
        });
      }
      ((survey && survey.questions) || []).forEach(function (q) {
        cols.push({ header: q.text || q.key, get: function (r) { return r.answers ? r.answers[q.key] : ''; } });
      });
      return Exp.toCSV(respondents, cols, opts);
    },

    runRecordsToCSV: function (records, opts) {
      var cols = ['respondentId', 'attempt', 'status', 'result', 'confirmed', 'startedAt', 'durationMs', 'generationMs', 'readMs',
        'questionsFilled', 'questionsTotal', 'error'].map(function (k) {
        return { header: k, get: function (r) { return k === 'startedAt' && r[k] ? new Date(r[k]).toISOString() : r[k]; } };
      });
      return Exp.toCSV(records, cols, opts);
    },

    logsToCSV: function (logs, opts) {
      var cols = [
        { header: 'timestamp', get: function (l) { return new Date(l.ts).toISOString(); } },
        { header: 'run_id', key: 'runId' }, { header: 'respondent_id', key: 'respondentId' },
        { header: 'level', key: 'level' }, { header: 'action', key: 'action' },
        { header: 'question', key: 'question' }, { header: 'result', key: 'result' }, { header: 'error', key: 'error' }
      ];
      return Exp.toCSV(logs, cols, opts);
    },

    logsToText: function (logs) {
      return logs.map(function (l) {
        var parts = [Util.formatClock(l.ts)];
        if (l.respondentId) parts.push('[' + l.respondentId + ']');
        parts.push(l.action);
        if (l.question) parts.push('- ' + l.question);
        if (l.result) parts.push('=> ' + l.result);
        if (l.error) parts.push('!! ' + l.error);
        return parts.join(' ');
      }).join('\n');
    },

    /** Builds a backup object from a storage dump. Strips diagnostics screenshots unless requested. */
    buildBackup: function (dump, opts) {
      opts = opts || {};
      var out = { app: 'SurveyPilot AI', version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data: {} };
      STORES.forEach(function (s) {
        var rows = (dump[s] || []);
        if (s === 'settings') rows = rows.filter(function (r) { return r.key !== 'apiKey'; });
        if (s === 'diagnostics' && !opts.includeScreenshots) rows = rows.map(function (d) { var c = Object.assign({}, d); delete c.screenshot; return c; });
        out.data[s] = Util.clone(rows);
      });
      // Defence in depth: nothing that looks like an API key may leave in an export.
      return JSON.parse(Util.redact(JSON.stringify(out), []));
    },

    /** Throws Error with an actionable message when a backup file is not usable. */
    validateBackup: function (obj) {
      if (!obj || typeof obj !== 'object') throw new Error('Backup file is not a JSON object.');
      if (obj.app !== 'SurveyPilot AI') throw new Error('This file is not a SurveyPilot AI backup.');
      if (typeof obj.version !== 'number') throw new Error('Backup has no version number.');
      if (obj.version > BACKUP_VERSION) throw new Error('Backup was made by a newer version (v' + obj.version + '). Update the extension first.');
      if (!obj.data || typeof obj.data !== 'object') throw new Error('Backup has no data section.');
      STORES.forEach(function (s) {
        if (obj.data[s] != null && !Array.isArray(obj.data[s])) throw new Error('Backup section "' + s + '" is malformed.');
      });
      (obj.data.respondents || []).forEach(function (r, i) {
        if (!r || !r.id) throw new Error('Respondent #' + (i + 1) + ' in the backup has no id.');
      });
      return true;
    },

    /** Browser only: triggers a file download from an extension page. */
    download: function (filename, text, mime) {
      var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }
  };

  return { Export: Exp };
});
