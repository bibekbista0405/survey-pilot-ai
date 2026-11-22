/* SurveyPilot AI - run engine (executes in the service worker, testable in Node with injected `env`).
   One run at a time. State is persisted after every step so the dashboard stays correct if the panel closes
   and a service-worker restart pauses (never silently continues) an interrupted run. */
(function (root, factory) {
  var isNode = typeof require === 'function' && typeof module === 'object';
  var deps = isNode ? {
    Util: require('../core/util.js').Util, Parser: require('../core/survey-parser.js').Parser,
    Storage: require('../core/storage.js').Storage, AnswerGen: require('../core/answer-generator.js').AnswerGen
  } : { Util: root.SP.Util, Parser: root.SP.Parser, Storage: root.SP.Storage, AnswerGen: root.SP.AnswerGen };
  var api = factory(deps);
  if (isNode) module.exports = api;
  var SP = (root.SP = root.SP || {});
  Object.keys(api).forEach(function (k) { SP[k] = api[k]; });
})(typeof globalThis !== 'undefined' ? globalThis : self, function (deps) {
  'use strict';
  var Util = deps.Util, Parser = deps.Parser, Storage = deps.Storage, AnswerGen = deps.AnswerGen;

  var MAX_SECTIONS = 60;   // hard stop against endless Next loops

  /**
   * env: injected browser access (real chrome.* in the service worker, fakes in tests)
   *   env.sendToTab(tabId, message) -> Promise<response>      (rejects when the tab/page is gone)
   *   env.getTab(tabId) -> Promise<{id, url, status}|null>
   *   env.navigate(tabId, url) -> Promise<void>               (resolves when the page finished loading)
   *   env.waitForContent(tabId, timeoutMs) -> Promise<boolean> (content script answers ping)
   *   env.screenshot(tabId) -> Promise<string|null>
   *   env.broadcast(event) -> void
   *   env.getApiKey() -> Promise<string>
   */
  function Engine(env) {
    this.env = env;
    this.run = null;            // persisted run object
    this.loopActive = false;    // guards against duplicate execution loops
    this.stopRequested = false;
    this.skipRequested = false;
  }

  Engine.prototype.log = function (entry) {
    var self = this;
    var e = Object.assign({ runId: self.run && self.run.id, ts: Util.now(), level: 'info' }, entry);
    if (e.level === 'debug' && !(self.settings && self.settings.diagnosticLogging)) return Promise.resolve();
    return Storage.put('logs', e).then(function () { self.env.broadcast({ type: 'log' }); },
      function (err) { self.env.broadcast({ type: 'storageError', message: err.message }); });
  };

  Engine.prototype.save = function () {
    var self = this;
    return Storage.put('runs', self.run).then(function () { self.env.broadcast({ type: 'run', run: self.run }); });
  };

  Engine.prototype.saveRecord = function (rec) {
    var self = this;
    return Storage.put('runRecords', rec).then(function () { self.env.broadcast({ type: 'record', record: rec }); });
  };

  /** Loads the persisted active run on service worker start. Interrupted runs become 'paused'. */
  Engine.prototype.restore = function () {
    var self = this;
    return Storage.getAll('runs').then(function (runs) {
      var active = runs.filter(function (r) { return r.status === 'running' || r.status === 'paused'; })
        .sort(function (a, b) { return b.startedAt - a.startedAt; })[0];
      if (!active) return null;
      self.run = active;
      return Storage.getSettings().then(function (s) {
        self.settings = s;
        if (active.status === 'running') {
          active.status = 'paused'; active.pauseStartedAt = Util.now(); active.interrupted = true;
          return self.interruptCurrentRecord().then(function () { return self.log({ action: 'Run interrupted', result: 'The browser restarted the extension while a run was active. Press Resume to continue.', level: 'warn' }); })
            .then(function () { return self.save(); });
        }
      });
    });
  };

  Engine.prototype.interruptCurrentRecord = function () {
    var self = this;
    if (!self.run || !self.run.currentRecordId) return Promise.resolve();
    return Storage.get('runRecords', self.run.currentRecordId).then(function (rec) {
      if (rec && ['Generating', 'Filling', 'Validating'].indexOf(rec.status) >= 0) {
        rec.status = 'Paused'; rec.error = 'Interrupted by extension restart'; return Storage.put('runRecords', rec);
      }
    });
  };

  /**
   * opts: { tabId, destinationUrl (confirmed by the user), confirmedAt, surveyId, respondentIds[], mode: 'local'|'ai' }
   * Rejects when another run is active or the destination was not confirmed.
   */
  Engine.prototype.start = function (opts) {
    var self = this;
    if (self.loopActive || (self.run && (self.run.status === 'running' || self.run.status === 'paused'))) {
      return Promise.reject(Object.assign(new Error('A run is already active. Stop or reset it before starting another.'), { code: 'RUN_ACTIVE' }));
    }
    if (!opts.destinationConfirmed || !opts.destinationUrl) {
      return Promise.reject(Object.assign(new Error('Confirm the test destination before starting.'), { code: 'DESTINATION_NOT_CONFIRMED' }));
    }
    if (!opts.respondentIds || !opts.respondentIds.length) {
      return Promise.reject(Object.assign(new Error('Select at least one respondent.'), { code: 'NO_RESPONDENTS' }));
    }
    return Storage.getSettings().then(function (settings) {
      self.settings = Object.assign({}, settings, opts.settingsOverride || {});
      return self.env.getTab(opts.tabId);
    }).then(function (tab) {
      if (!tab) throw Object.assign(new Error('The target tab no longer exists.'), { code: 'TAB_CLOSED' });
      if (Parser.destinationKey(tab.url) !== Parser.destinationKey(opts.destinationUrl)) {
        throw Object.assign(new Error('The tab is on a different page than the confirmed destination. Re-open the destination and confirm again.'), { code: 'DESTINATION_MISMATCH' });
      }
      self.run = {
        id: Util.uid('run'), surveyId: opts.surveyId, tabId: opts.tabId,
        destinationUrl: opts.destinationUrl, destinationKey: Parser.destinationKey(opts.destinationUrl),
        confirmedAt: opts.confirmedAt || Util.now(), mode: opts.mode || self.settings.mode,
        respondentIds: opts.respondentIds.slice(), status: 'running', startedAt: Util.now(), endedAt: null,
        pausedMs: 0, pauseStartedAt: null, currentRespondentId: null, currentRecordId: null,
        config: { retryLimit: self.settings.retryLimit, delayBetweenRunsMs: self.settings.delayBetweenRunsMs }
      };
      self.stopRequested = false; self.skipRequested = false;
      return self.save();
    }).then(function () {
      return self.log({ action: 'Run started', result: self.run.respondentIds.length + ' respondent(s), destination confirmed: ' + self.run.destinationKey });
    }).then(function () {
      self.loop();   // intentionally not awaited: runs in the background; state is observable through storage/broadcasts
      return self.run;
    });
  };

  Engine.prototype.pause = function () {
    var self = this;
    if (!self.run || self.run.status !== 'running') return Promise.reject(Object.assign(new Error('No running run to pause.'), { code: 'NOT_RUNNING' }));
    self.run.status = 'paused'; self.run.pauseStartedAt = Util.now();
    return self.log({ action: 'Pause requested', result: 'Will pause at the next safe point' }).then(function () { return self.save(); });
  };

  Engine.prototype.resume = function () {
    var self = this;
    if (!self.run || self.run.status !== 'paused') return Promise.reject(Object.assign(new Error('No paused run to resume.'), { code: 'NOT_PAUSED' }));
    if (self.run.pauseStartedAt) self.run.pausedMs += Util.now() - self.run.pauseStartedAt;
    self.run.pauseStartedAt = null; self.run.interrupted = false; self.run.status = 'running';
    return self.log({ action: 'Run resumed' }).then(function () { return self.save(); }).then(function () {
      if (!self.loopActive) self.loop();
      return self.run;
    });
  };

  Engine.prototype.stop = function () {
    var self = this;
    if (!self.run || (self.run.status !== 'running' && self.run.status !== 'paused')) return Promise.reject(Object.assign(new Error('No active run to stop.'), { code: 'NOT_ACTIVE' }));
    self.stopRequested = true;
    if (!self.loopActive) return self.finish('stopped');
    return self.log({ action: 'Stop requested' });
  };

  Engine.prototype.skip = function () {
    var self = this;
    if (!self.run || !self.run.currentRespondentId) return Promise.reject(Object.assign(new Error('There is no current respondent to skip.'), { code: 'NOTHING_TO_SKIP' }));
    self.skipRequested = true;
    return self.log({ action: 'Skip requested', respondentId: self.run.currentRespondentId });
  };

  /** Re-queues a failed/skipped respondent of the current (or last) run. */
  Engine.prototype.retry = function (respondentId) {
    var self = this;
    var run = self.run;
    if (!run) return Promise.reject(Object.assign(new Error('There is no run to retry in.'), { code: 'NO_RUN' }));
    if (run.status === 'running') return Promise.reject(Object.assign(new Error('Wait for the current respondent to finish, or pause the run first.'), { code: 'RUN_ACTIVE' }));
    return Storage.listRunRecords(run.id).then(function (recs) {
      var last = recs.filter(function (r) { return r.respondentId === respondentId; }).pop();
      if (!last || (last.status !== 'Failed' && last.status !== 'Skipped')) throw Object.assign(new Error('Only failed or skipped respondents can be retried.'), { code: 'NOT_RETRYABLE' });
      run.retryQueue = (run.retryQueue || []).concat([respondentId]);
      if (run.status === 'completed' || run.status === 'stopped') { run.status = 'paused'; run.pauseStartedAt = Util.now(); run.endedAt = null; }
      return self.log({ action: 'Retry queued', respondentId: respondentId }).then(function () { return self.save(); });
    }).then(function () { return self.run.status === 'paused' ? self.resume() : self.run; });
  };

  Engine.prototype.reset = function () {
    var self = this;
    if (self.run && self.run.status === 'running') return Promise.reject(Object.assign(new Error('Stop the run before resetting it.'), { code: 'RUN_ACTIVE' }));
    var run = self.run;
    self.run = null; self.stopRequested = false; self.skipRequested = false;
    if (!run) return Promise.resolve();
    return Storage.listRunRecords(run.id).then(function (recs) {
      return Storage.deleteMany('runRecords', recs.map(function (r) { return r.id; }));
    }).then(function () { return Storage.delete('runs', run.id); }).then(function () {
      self.env.broadcast({ type: 'reset' });
    });
  };

  Engine.prototype.finish = function (status) {
    var self = this;
    if (!self.run) return Promise.resolve();
    if (self.run.pauseStartedAt) { self.run.pausedMs += Util.now() - self.run.pauseStartedAt; self.run.pauseStartedAt = null; }
    self.run.status = status; self.run.endedAt = Util.now(); self.run.currentRespondentId = null; self.run.currentRecordId = null;
    return self.log({ action: 'Run ' + status, result: 'Elapsed ' + Util.formatDuration(self.run.endedAt - self.run.startedAt - self.run.pausedMs) })
      .then(function () { return self.save(); });
  };

  /** Waits while paused. Resolves 'go' | 'stop'. */
  Engine.prototype.gate = function () {
    var self = this;
    return new Promise(function (resolve) {
      (function check() {
        if (self.stopRequested) return resolve('stop');
        if (self.run.status === 'running') return resolve('go');
        setTimeout(check, 150);
      })();
    });
  };

  Engine.prototype.loop = function () {
    var self = this;
    if (self.loopActive) return Promise.resolve();   // never two loops
    self.loopActive = true;
    function nextId() {
      var run = self.run;
      if (run.retryQueue && run.retryQueue.length) return run.retryQueue.shift();
      return Storage.getAllByIndex('runRecords', 'runId', run.id).then(function (recs) {
        var done = {}; recs.forEach(function (r) { if (['Completed', 'Failed', 'Skipped'].indexOf(r.status) >= 0) done[r.respondentId] = true; });
        return run.respondentIds.filter(function (id) { return !done[id]; })[0] || null;
      });
    }
    function step(first) {
      return self.gate().then(function (g) {
        if (g === 'stop') return self.finish('stopped');
        return Promise.resolve(nextId()).then(function (id) {
          if (!id) return self.finish('completed');
          var wait = first ? 0 : self.settings.delayBetweenRunsMs;
          return Util.sleep(wait).then(function () { return self.gate(); }).then(function (g2) {
            if (g2 === 'stop') return self.finish('stopped');
            return self.runRespondent(id);
          }).then(function () { return self.save(); }).then(function () { return step(false); });
        });
      });
    }
    return step(true).catch(function (err) {
      return self.log({ action: 'Run crashed', error: Util.redact(err.message, []), level: 'error' }).then(function () {
        if (self.run) { self.run.status = 'paused'; self.run.pauseStartedAt = Util.now(); return self.save(); }
      });
    }).then(function () { self.loopActive = false; });
  };

  /* ---------------- per-respondent execution ---------------- */

  Engine.prototype.assertDestination = function () {
    var self = this;
    return self.env.getTab(self.run.tabId).then(function (tab) {
      if (!tab) throw Object.assign(new Error('The tab was closed.'), { code: 'TAB_CLOSED' });
      if (Parser.destinationKey(tab.url) !== self.run.destinationKey) {
        throw Object.assign(new Error('The tab navigated away from the confirmed destination (now on ' + tab.url + ').'), { code: 'DESTINATION_MISMATCH' });
      }
      return tab;
    });
  };

  Engine.prototype.send = function (msg) {
    return this.env.sendToTab(this.run.tabId, Object.assign({ target: 'sp-content' }, msg)).then(function (res) {
      if (!res) throw Object.assign(new Error('The page did not answer. Reload the form tab and try again.'), { code: 'NO_RESPONSE' });
      return res;
    });
  };

  function failWith(code, message, extra) { return Object.assign(new Error(message), { code: code }, extra || {}); }

  Engine.prototype.runRespondent = function (respondentId) {
    var self = this, run = self.run, cfg = self.settings;
    var t0 = Util.mono();
    var rec = { id: Util.uid('rec'), runId: run.id, respondentId: respondentId, attempt: 1, status: 'Generating', startedAt: Util.now(),
      durationMs: null, generationMs: 0, readMs: 0, questionsFilled: 0, questionsTotal: 0, currentSection: 0,
      questionTimings: [], sectionTimings: [], result: '', error: '', confirmed: false };
    var respondent = null, survey = null, sectionIndex = 0, sectionsDone = 0, seenSignatures = {};
    self.skipRequested = false;

    function setStatus(s) { rec.status = s; return self.saveRecord(rec); }
    function end(status, result, error, diagnostics) {
      rec.status = status; rec.result = result || ''; rec.error = error || ''; rec.durationMs = Util.mono() - t0;
      run.currentRecordId = null;
      var p = Promise.resolve();
      if (diagnostics) p = Storage.put('diagnostics', Object.assign({ id: Util.uid('diag'), ts: Util.now(), runId: run.id, respondentId: respondentId, recordId: rec.id }, diagnostics)).then(function (id) { rec.diagnosticId = diagnostics.id; });
      return p.then(function () { return self.saveRecord(rec); }).then(function () {
        return self.log({ respondentId: respondentId, action: 'Respondent ' + status.toLowerCase(), result: result, error: error, level: status === 'Failed' ? 'error' : 'info' });
      });
    }
    function checkInterrupts() {
      if (self.stopRequested) throw failWith('STOPPED', 'Run stopped by user');
      if (self.skipRequested) throw failWith('SKIPPED', 'Respondent skipped by user');
      return self.gate().then(function (g) { if (g === 'stop') throw failWith('STOPPED', 'Run stopped by user'); });
    }

    run.currentRespondentId = respondentId; run.currentRecordId = rec.id;
    return Storage.get('respondents', respondentId).then(function (r) {
      if (!r) throw failWith('MISSING_RESPONDENT', 'Respondent ' + respondentId + ' no longer exists.');
      respondent = r;
      return Storage.get('surveys', run.surveyId);
    }).then(function (s) {
      survey = s || { id: run.surveyId, questions: [] };
      return self.saveRecord(rec);
    }).then(function () {
      return self.log({ respondentId: respondentId, action: 'Respondent selected', result: respondent.profile.ageGroup + ', ' + respondent.profile.occupation });
    }).then(function () {
      // Fresh page for every respondent so no state leaks between runs.
      return self.assertDestination().then(function () {
        // After a confirmed submission prefer the page's own "Submit another response" link; otherwise load the destination fresh.
        if (!run.lastConfirmed) return self.env.navigate(run.tabId, run.destinationUrl);
        return self.send({ type: 'another' }).then(function (a) {
          if (a && a.ok && a.clicked) {
            return self.log({ respondentId: respondentId, action: 'Clicked "' + a.label + '"' }).then(function () {
              return self.env.waitForContent(run.tabId, 10000);
            }).then(function () { return self.assertDestination(); }).then(function () {
              // The link only counts if a fillable form is really back on screen; otherwise load the destination directly.
              var tries = 0;
              return (function check() {
                return self.send({ type: 'read', pageIndex: 0, force: true }).then(function (r) {
                  return r && r.ok && r.form && r.form.questions.some(function (q) { return q.visible && q.supported; });
                }).catch(function () { return false; }).then(function (ok) {
                  if (ok) return true;
                  if (++tries >= 6) return false;
                  return Util.sleep(400).then(check);
                });
              })();
            }).then(function (back) {
              if (back) return null;
              return self.log({ respondentId: respondentId, action: '"Submit another response" did not bring the form back; loading the destination directly', level: 'warn' })
                .then(function () { return self.env.navigate(run.tabId, run.destinationUrl); });
            }).catch(function () { return self.env.navigate(run.tabId, run.destinationUrl); });
          }
          return self.env.navigate(run.tabId, run.destinationUrl);
        }, function () { return self.env.navigate(run.tabId, run.destinationUrl); });
      });
    }).then(function () {
      return self.env.waitForContent(run.tabId, 10000).then(function (ok) { if (!ok) throw failWith('PAGE_TIMEOUT', 'The form page did not become ready within 10 s.'); });
    }).then(function () { return self.assertDestination(); })
      .then(function () { return sectionLoop(); })
      .then(function (outcome) { run.lastConfirmed = !!outcome.confirmed; return end('Completed', outcome.message, '', null); })
      .catch(function (err) {
        run.lastConfirmed = false;
        if (err.code === 'STOPPED') return end('Failed', 'Stopped by user', 'Run stopped by user', null);
        if (err.code === 'SKIPPED') return end('Skipped', 'Skipped by user', '', null);
        // Capture diagnostics for every genuine failure.
        return self.captureDiagnostics(sectionIndex, err).then(function (diag) {
          var fatalForRun = err.code === 'TAB_CLOSED' || err.code === 'DESTINATION_MISMATCH';
          return end('Failed', err.code || 'ERROR', err.message, diag).then(function () {
            if (fatalForRun && self.run.status === 'running') {
              self.run.status = 'paused'; self.run.pauseStartedAt = Util.now();
              return self.log({ respondentId: respondentId, action: 'Run paused', error: 'Paused because: ' + err.message, level: 'warn' });
            }
          });
        });
      });

    function sectionLoop() {
      return checkInterrupts().then(function () {
        if (sectionsDone >= MAX_SECTIONS) throw failWith('TOO_MANY_SECTIONS', 'More than ' + MAX_SECTIONS + ' sections were visited. Aborting to avoid an endless loop.');
        var tRead = Util.mono();
        return self.assertDestination().then(function () { return self.send({ type: 'read', pageIndex: sectionIndex, force: true }); }).then(function (res) {
          if (!res.ok) throw failWith(res.code || 'READ_FAILED', res.error || 'Could not read the form.');
          rec.readMs += Util.mono() - tRead;
          return res;
        });
      }).then(function (res) {
        var form = res.form, visible = form.questions.filter(function (q) { return q.visible && q.supported; });
        rec.currentSection = sectionIndex;
        if (!visible.length) {
          // No questions: either a confirmation page or a broken form.
          return self.send({ type: 'confirm' }).then(function (c) {
            if (c.ok && c.confirmation && c.confirmation.confirmed) return { message: 'Submission confirmed: ' + c.confirmation.evidence, confirmed: true };
            // Intro / description page: nothing to fill, just click Next (goNext waits for the section to change, so this cannot loop).
            return self.send({ type: 'navState' }).then(function (st) {
              if (st.ok && st.nav && st.nav.next && !st.nav.next.disabled) {
                return self.log({ respondentId: respondentId, action: 'Section ' + (sectionIndex + 1) + ' has no questions (intro page)', result: 'Clicking Next' }).then(goNext);
              }
              throw failWith('NO_QUESTIONS', 'No visible questions were detected on section ' + (sectionIndex + 1) + ' and there is no Next button.');
            });
          });
        }
        if (seenSignatures[form.signature]) throw failWith('SECTION_REPEATED', 'The same section appeared again (section ' + (sectionIndex + 1) + '). Not filling it twice.');
        seenSignatures[form.signature] = true;

        // Merge newly discovered questions into the stored survey definition.
        survey = Parser.buildSurvey({ url: form.url, title: form.title, kind: form.kind, questions: form.questions }, survey);
        var known = {}; Object.keys(respondent.answers || {}).forEach(function (k) { known[k] = true; });
        var fresh = survey.questions.filter(function (q) { return visible.some(function (v) { return v.key === q.key; }) && !(q.key in respondent.answers); });
        rec.questionsTotal = Math.max(rec.questionsTotal, Object.keys(respondent.answers || {}).length + fresh.length);
        var tGen = Util.mono();
        return Storage.put('surveys', survey).then(function () {
          if (!fresh.length) return null;
          return self.setStatusGenerating(rec).then(function () { return self.ensureAnswers(respondent, fresh); });
        }).then(function (genRes) {
          if (genRes) {
            rec.generationMs += Util.mono() - tGen;
            return self.log({ respondentId: respondentId, action: 'Answers generated', result: fresh.length + ' answer(s) via ' + genRes.source + (genRes.warnings.length ? ' (' + genRes.warnings.length + ' warning(s))' : '') });
          }
        }).then(function () {
          return self.log({ respondentId: respondentId, action: 'Section ' + (sectionIndex + 1) + ' detected', result: visible.length + ' question(s)' });
        }).then(function () { return setStatus('Filling'); }).then(function () { return fillAndValidate(visible); });
      }).then(function (outcome) {
        if (outcome && outcome.confirmed) return outcome;
        return advance();
      });
    }

    function fillAndValidate(visible) {
      var tSec = Util.mono(), attempt = 0;
      function once() {
        attempt++;
        return checkInterrupts().then(function () { return self.assertDestination(); }).then(function () {
          return self.send({ type: 'fillSection', answers: respondent.answers, pageIndex: sectionIndex, retries: self.settings.retryLimit, actionDelayMs: self.settings.delayBetweenActionsMs });
        }).then(function (res) {
          if (!res.ok) throw failWith(res.code || 'FILL_FAILED', res.error || 'Filling failed');
          var chain = Promise.resolve();
          var filledNow = 0;
          res.results.forEach(function (r) {
            if (r.skipped) return;
            if (r.ok && r.verified) { filledNow++; rec.questionTimings.push({ key: r.key, text: r.text, ms: r.ms, ok: true }); }
            else rec.questionTimings.push({ key: r.key, text: r.text, ms: r.ms || 0, ok: false });
            chain = chain.then(function () {
              return self.log({ respondentId: respondentId, question: r.text, level: r.ok ? 'debug' : 'error',
                action: r.ok ? (r.skipped ? 'Question skipped (optional)' : 'Question filled') : 'Question failed',
                result: r.ok ? 'verified' : '', error: r.ok ? '' : (r.code + ': ' + r.error) });
            });
          });
          rec.questionsFilled += filledNow;
          return chain.then(function () { return res; });
        }).then(function (res) {
          var failed = res.results.filter(function (r) { return !r.ok; });
          return setStatus('Validating').then(function () {
            if (failed.length) {
              var f = failed[0];
              throw failWith(f.code || 'FILL_FAILED', 'Question "' + f.text + '" could not be filled: ' + f.error, { question: f.text });
            }
            var v = res.validation;
            if (v.missing.length) throw failWith('REQUIRED_UNANSWERED', 'Required question(s) unanswered: ' + v.missing.map(function (m) { return '"' + m.text + '"'; }).join(', '), { question: v.missing[0].text });
            if (v.invalid.length) throw failWith('INVALID_ANSWER', 'Invalid answer for "' + v.invalid[0].text + '": ' + v.invalid[0].reason, { question: v.invalid[0].text });
            if (v.mismatched.length) throw failWith('VERIFY_FAILED', 'Page shows a different value than requested for "' + v.mismatched[0].text + '".', { question: v.mismatched[0].text });
            return self.log({ respondentId: respondentId, action: 'Required question validation passed', result: 'Section ' + (sectionIndex + 1) });
          });
        }).catch(function (err) {
          // A failed section is retried (re-read, re-fill) up to retryLimit times before the respondent fails.
          if (['STOPPED', 'SKIPPED', 'TAB_CLOSED', 'DESTINATION_MISMATCH', 'MISSING_ANSWER'].indexOf(err.code) >= 0 || attempt > self.settings.retryLimit) throw err;
          return self.log({ respondentId: respondentId, action: 'Retrying section ' + (sectionIndex + 1), error: err.message, level: 'warn' }).then(function () { return Util.sleep(200 * attempt); }).then(once);
        });
      }
      return once().then(function () {
        rec.sectionTimings.push({ section: sectionIndex, ms: Util.mono() - tSec });
        return self.log({ respondentId: respondentId, action: 'Section ' + (sectionIndex + 1) + ' completed', result: Util.formatDuration(Util.mono() - tSec) });
      }).then(function () { return null; });
    }

    function advance() {
      return checkInterrupts().then(function () { return self.assertDestination(); })
        .then(function () { return self.send({ type: 'navState' }); })
        .then(function (st) {
          if (!st.ok) throw failWith(st.code || 'NAV_FAILED', st.error || 'Could not read navigation controls.');
          var nav = st.nav;
          if (nav.next && !nav.next.disabled) return goNext();
          if (nav.submit && !nav.submit.disabled) return doSubmit();
          throw failWith('NO_NAVIGATION', 'No usable Next or Submit button was found on section ' + (sectionIndex + 1) + '.');
        });
    }

    function goNext() {
      return self.send({ type: 'next', pageIndex: sectionIndex, timeout: self.settings.navigationTimeoutMs }).then(function (res) {
        if (!res.ok) throw failWith(res.code || 'NAV_FAILED', res.error || 'Navigation failed');
        if (!res.nav.ok) throw failWith(res.nav.code || 'NAV_FAILED', res.nav.message + (res.nav.messages && res.nav.messages.length ? ' Page says: ' + res.nav.messages.join(' | ') : ''), { messages: res.nav.messages });
        sectionsDone++; sectionIndex++;
        if (res.nav.confirmed) return { message: 'Submission confirmed (page shows confirmation)', confirmed: true };
        return self.log({ respondentId: respondentId, action: 'Section ' + (sectionIndex + 1) + ' detected' }).then(sectionLoop);
      }, function (err) {
        // The message channel closes when Next triggers a full page load: wait for the new page and carry on.
        if (/message channel closed|context invalidated|Receiving end does not exist|port closed/i.test(err.message || '')) {
          return self.env.waitForContent(run.tabId, 10000).then(function (ok) {
            if (!ok) throw failWith('PAGE_TIMEOUT', 'The next page did not load within 10 s.');
            sectionsDone++; sectionIndex++;
            return sectionLoop();
          });
        }
        throw err;
      });
    }

    function doSubmit() {
      return self.log({ respondentId: respondentId, action: 'Submitting', result: 'Destination ' + run.destinationKey }).then(function () { return self.assertDestination(); }).then(function () {
        return self.send({ type: 'submit', timeout: self.settings.navigationTimeoutMs });
      }).then(function (res) {
        if (!res.ok) throw failWith(res.code || 'SUBMIT_FAILED', res.error || 'Submit failed');
        if (!res.nav.ok) throw failWith(res.nav.code || 'SUBMIT_FAILED', res.nav.message + (res.nav.messages && res.nav.messages.length ? ' Page says: ' + res.nav.messages.join(' | ') : ''));
        if (res.nav.confirmed) { rec.confirmed = true; return { message: 'Submission confirmed: ' + res.nav.evidence, confirmed: true }; }
        return confirmAfterNavigation(res.nav.evidence);
      }, function (err) {
        if (/message channel closed|context invalidated|Receiving end does not exist|port closed/i.test(err.message || '')) return confirmAfterNavigation('Page navigated after submit');
        throw err;
      }).then(function (o) { if (o.confirmed) rec.confirmed = true; return o; });
    }

    /** The page may reload after submit: poll the (new) page for explicit confirmation evidence. */
    function confirmAfterNavigation(why) {
      var deadline = Util.mono() + self.settings.navigationTimeoutMs;
      function poll() {
        return self.env.waitForContent(run.tabId, 3000).then(function (ok) {
          if (!ok) { if (Util.mono() > deadline) throw failWith('SUBMIT_UNCONFIRMED', 'Submit was clicked but the page never showed a confirmation (' + why + ').'); return Util.sleep(300).then(poll); }
          return self.send({ type: 'confirm' }).then(function (c) {
            if (c.ok && c.confirmation.confirmed) return { message: 'Submission confirmed: ' + c.confirmation.evidence, confirmed: true };
            if (Util.mono() > deadline) throw failWith('SUBMIT_UNCONFIRMED', 'Submit was clicked but no confirmation was found: ' + (c.confirmation ? c.confirmation.evidence : why));
            return Util.sleep(300).then(poll);
          });
        });
      }
      return poll();
    }
  };


  /**
   * Fill mode: fills the active form for one respondent and NEVER clicks Submit.
   * opts: { tabId, respondentId, surveyId, advance (walk through sections), mode }
   * Resolves { ok, sections, filled, failures[], stoppedAt, message }.
   */
  Engine.prototype.fillActive = function (opts) {
    var self = this;
    if (self.loopActive) return Promise.reject(Object.assign(new Error('A test run is active. Stop it before using Fill mode.'), { code: 'RUN_ACTIVE' }));
    if (self.fillBusy) return Promise.reject(Object.assign(new Error('Fill mode is already working on a form.'), { code: 'FILL_BUSY' }));
    self.fillBusy = true;
    var sum = { ok: false, sections: 0, filled: 0, failures: [], stoppedAt: '', message: '' };
    var respondent, survey, sectionIndex = 0, startKey, seen = {};
    function send(msg) {
      return self.env.sendToTab(opts.tabId, Object.assign({ target: 'sp-content' }, msg)).then(function (res) {
        if (!res) throw failWith('NO_RESPONSE', 'The page did not answer. Reload the form tab and try again.');
        return res;
      });
    }
    function logf(entry) { return self.log(Object.assign({ runId: 'fill', respondentId: opts.respondentId }, entry)); }
    function guard() {
      return self.env.getTab(opts.tabId).then(function (tab) {
        if (!tab) throw failWith('TAB_CLOSED', 'The tab was closed.');
        if (Parser.destinationKey(tab.url) !== startKey) throw failWith('DESTINATION_MISMATCH', 'The tab navigated to a different page (' + tab.url + ').');
      });
    }
    function section() {
      return guard().then(function () { return send({ type: 'read', pageIndex: sectionIndex, force: true }); }).then(function (res) {
        if (!res.ok) throw failWith(res.code || 'READ_FAILED', res.error || 'Could not read the form.');
        var form = res.form, visible = form.questions.filter(function (q) { return q.visible && q.supported; });
        if (!visible.length) throw failWith('NO_QUESTIONS', 'No visible questions were detected on section ' + (sectionIndex + 1) + '.');
        if (seen[form.signature]) throw failWith('SECTION_REPEATED', 'The same section appeared twice; stopping.');
        seen[form.signature] = true;
        survey = Parser.buildSurvey({ url: form.url, title: form.title, kind: form.kind, questions: form.questions }, survey);
        var fresh = survey.questions.filter(function (q) { return visible.some(function (v) { return v.key === q.key; }) && !(q.key in respondent.answers); });
        return Storage.put('surveys', survey).then(function () { return fresh.length ? self.ensureAnswers(respondent, fresh, opts.mode) : null; })
          .then(function () { return logf({ action: 'Section ' + (sectionIndex + 1) + ' detected', result: visible.length + ' question(s)' }); })
          .then(function () { return send({ type: 'fillSection', answers: respondent.answers, pageIndex: sectionIndex, retries: self.settings.retryLimit, actionDelayMs: self.settings.delayBetweenActionsMs }); });
      }).then(function (res) {
        if (!res.ok) throw failWith(res.code || 'FILL_FAILED', res.error || 'Filling failed');
        sum.sections++;
        res.results.forEach(function (r) {
          if (r.ok && r.verified) sum.filled++;
          if (!r.ok) sum.failures.push({ question: r.text, code: r.code, error: r.error });
        });
        var v = res.validation;
        v.missing.forEach(function (m) { sum.failures.push({ question: m.text, code: 'REQUIRED_UNANSWERED', error: 'Required question is still unanswered' }); });
        v.mismatched.forEach(function (m) { sum.failures.push({ question: m.text, code: 'VERIFY_FAILED', error: 'Page shows a different value than requested' }); });
        if (sum.failures.length) { sum.stoppedAt = 'section ' + (sectionIndex + 1); throw failWith('SECTION_FAILED', sum.failures.length + ' question(s) need attention in section ' + (sectionIndex + 1) + '.'); }
        return logf({ action: 'Section ' + (sectionIndex + 1) + ' completed', result: 'all verified' });
      }).then(function () {
        if (!opts.advance) { sum.message = 'Section filled and verified. Nothing was submitted.'; return null; }
        return send({ type: 'navState' }).then(function (st) {
          if (!st.ok) throw failWith(st.code || 'NAV_FAILED', st.error || 'Could not read navigation controls.');
          if (st.nav.next && !st.nav.next.disabled) {
            return send({ type: 'next', pageIndex: sectionIndex, timeout: self.settings.navigationTimeoutMs }).then(function (n) {
              if (!n.ok || !n.nav.ok) throw failWith((n.nav && n.nav.code) || n.code || 'NAV_FAILED', (n.nav && n.nav.message) || n.error || 'Navigation failed');
              sectionIndex++;
              if (sum.sections >= MAX_SECTIONS) throw failWith('TOO_MANY_SECTIONS', 'Too many sections visited.');
              return section();
            });
          }
          sum.message = st.nav.submit ? 'Reached the last section. The form is filled and has NOT been submitted - review it and press Submit yourself.' : 'No further navigation button found. Nothing was submitted.';
        });
      });
    }
    return Storage.getSettings().then(function (s) { self.settings = s; return Promise.all([Storage.get('respondents', opts.respondentId), Storage.get('surveys', opts.surveyId), self.env.getTab(opts.tabId)]); })
      .then(function (r) {
        respondent = r[0]; survey = r[1] || { id: opts.surveyId, questions: [] };
        if (!respondent) throw failWith('MISSING_RESPONDENT', 'Respondent not found.');
        if (!r[2]) throw failWith('TAB_CLOSED', 'The target tab no longer exists.');
        startKey = Parser.destinationKey(r[2].url);
        return logf({ action: 'Fill mode started', result: 'Respondent ' + respondent.id + (opts.advance ? ' (advance through sections, no submit)' : ' (current section)') });
      }).then(section).then(function () { sum.ok = true; return logf({ action: 'Fill mode finished', result: sum.message }); })
      .catch(function (err) {
        sum.ok = false; sum.message = err.message; sum.code = err.code || 'ERROR';
        return logf({ action: 'Fill mode stopped', error: err.message, level: 'error' });
      }).then(function () { self.fillBusy = false; return sum; });
  };

  Engine.prototype.setStatusGenerating = function (rec) { rec.status = 'Generating'; return this.saveRecord(rec); };

  /** Generates (and persists) answers for questions the respondent does not have yet. */
  Engine.prototype.ensureAnswers = function (respondent, questions, mode) {
    var self = this;
    return self.env.getApiKey().then(function (key) {
      return AnswerGen.generate({
        mode: mode || (self.run && self.run.mode) || self.settings.mode, profile: respondent.profile, questions: questions,
        settings: { apiKey: key, model: self.settings.model, language: self.settings.language, aiRetries: self.settings.aiRetries,
          aiTimeoutMs: self.settings.aiTimeoutMs, autoFallback: self.settings.autoFallback }
      });
    }).then(function (res) {
      respondent.answers = Object.assign({}, respondent.answers, res.answers);
      respondent.source = res.source === 'ai' ? 'ai' : (respondent.source === 'ai' ? 'mixed' : res.source);
      return Storage.put('respondents', respondent).then(function () {
        if (res.aiError) return self.log({ respondentId: respondent.id, action: 'AI generation problem', error: res.aiError.code + ': ' + res.aiError.message, level: 'warn' });
      }).then(function () { return res; });
    });
  };

  Engine.prototype.captureDiagnostics = function (sectionIndex, err) {
    var self = this;
    var diag = { code: err.code || 'ERROR', message: Util.redact(err.message, []), section: sectionIndex, question: err.question || '',
      url: '', timestamp: Util.now(), snapshot: null, screenshot: null, consoleErrors: [] };
    return self.env.getTab(self.run.tabId).then(function (tab) {
      diag.url = tab ? tab.url : '(tab closed)';
      if (!tab) return diag;
      return self.env.sendToTab(self.run.tabId, { target: 'sp-content', type: 'snapshot', pageIndex: sectionIndex }).then(function (res) {
        if (res && res.ok) { diag.snapshot = res.snapshot; diag.consoleErrors = res.snapshot.consoleErrors; diag.currentSection = res.snapshot.section; diag.visibleQuestions = res.snapshot.visibleQuestions; diag.missingQuestions = res.snapshot.missing; diag.validationMessages = res.snapshot.validationMessages; }
      }, function (e) { diag.snapshotError = e.message; }).then(function () {
        if (!self.settings.captureScreenshots) return null;
        return self.env.screenshot(self.run.tabId).then(function (s) { diag.screenshot = s; }, function (e) { diag.screenshotError = e.message; });
      }).then(function () { return diag; });
    }).catch(function (e) { diag.captureError = e.message; return diag; })
      .then(function (d) { d.id = d.id || Util.uid('diag'); return d; });
  };

  return { RunEngine: Engine };
});
