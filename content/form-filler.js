/* SurveyPilot AI - content script: form filling engine.
   Every fill: locate control -> interact -> fire input/change -> read DOM back -> compare -> retry on mismatch.
   A question is "verified" only when the final DOM state equals the requested answer. */
(function (root) {
  'use strict';
  var SP = (root.SP = root.SP || {});
  var Util = SP.Util, DOM = SP.DOM, Parser = SP.Parser, V = SP.validation;

  function fail(msg, code) { var e = new Error(msg); e.code = code || 'FILL_FAILED'; return e; }

  var Filler = {
    settleMs: 25,

    /* ---- interaction primitives: each returns after the DOM had a chance to react ---- */
    setText: function (q, value) {
      var el = q.controls[0].el;
      el.focus();
      DOM.setNativeValue(el, '');
      DOM.setNativeValue(el, String(value));
      DOM.fire(el, 'input'); DOM.fire(el, 'change');
      el.blur && el.blur();
    },

    setDateTime: function (q, value) {
      var el = q.controls[0].el, v = String(value);
      if (q.kind === 'date') { var d = v.match(/^\d{4}-\d{2}-\d{2}/); if (!d) throw fail('Date "' + v + '" is not in YYYY-MM-DD format', 'INVALID_ANSWER'); v = d[0]; }
      if (q.kind === 'time') { var t = v.match(/^(\d{1,2}):(\d{2})/); if (!t) throw fail('Time "' + v + '" is not in HH:MM format', 'INVALID_ANSWER'); v = Util.pad2(+t[1]) + ':' + t[2]; }
      if (q.kind === 'datetime' && /^\d{4}-\d{2}-\d{2}$/.test(v)) v += 'T12:00';
      el.focus(); DOM.setNativeValue(el, v); DOM.fire(el, 'input'); DOM.fire(el, 'change'); el.blur && el.blur();
    },

    setMulti: function (q, value) {
      var parts = q.kind === 'multi-time' ? V.splitTime(String(value)) : V.splitDate(String(value));
      var order = q.kind === 'multi-time' ? ['hour', 'minute'] : ['year', 'month', 'day'];
      if (parts.some(function (p) { return !p; })) throw fail('Value "' + value + '" cannot fill a ' + q.kind + ' question', 'INVALID_ANSWER');
      order.forEach(function (name, i) {
        var c = q.controls.filter(function (x) { return x.part === name; })[0];
        if (!c) throw fail('Missing "' + name + '" input', 'ELEMENT_NOT_FOUND');
        c.el.focus(); DOM.setNativeValue(c.el, parts[i]); DOM.fire(c.el, 'input'); DOM.fire(c.el, 'change'); c.el.blur && c.el.blur();
      });
    },

    pick: function (q, wanted) {
      var labels = q.controls.map(function (c) { return c.label; });
      var i = Parser.matchOption(labels, wanted);
      if (i < 0) throw fail('No option matches "' + wanted + '" (options: ' + labels.slice(0, 8).join(' / ') + ')', 'OPTION_NOT_FOUND');
      return q.controls[i];
    },

    fillOther: function (c, q) {
      var host = c.el.closest('label') || c.el.parentElement;
      var other = host && host.querySelector('input[type=text],input:not([type]),textarea');
      if (other && !other.value) { other.focus(); DOM.setNativeValue(other, 'Synthetic response'); DOM.fire(other, 'input'); DOM.fire(other, 'change'); }
    },

    setRadio: function (q, wanted) {
      var c = Filler.pick(q, Array.isArray(wanted) ? wanted[0] : wanted);
      if (q.kind === 'aria-radio') { if (c.el.getAttribute('aria-checked') !== 'true') DOM.mouseClick(c.el); }
      else { if (!c.el.checked) c.el.click(); }
      Filler.fillOther(c, q);
    },

    setCheckbox: function (q, wanted) {
      var list = Array.isArray(wanted) ? wanted : [wanted];
      var targets = list.map(function (w) { return Filler.pick(q, w); });
      q.controls.forEach(function (c) {
        var on = q.kind === 'aria-checkbox' ? c.el.getAttribute('aria-checked') === 'true' : c.el.checked;
        var want = targets.indexOf(c) >= 0;
        if (on !== want) { if (q.kind === 'aria-checkbox') DOM.mouseClick(c.el); else c.el.click(); }
        if (want) Filler.fillOther(c, q);
      });
    },

    setSelect: function (q, wanted) {
      var c = q.controls[0], list = Array.isArray(wanted) ? wanted : [wanted];
      var labels = c.options.map(function (o) { return o.label; });
      if (q.kind === 'native-select-multiple') {
        var idxs = list.map(function (w) { var i = Parser.matchOption(labels, w); if (i < 0) throw fail('No option matches "' + w + '"', 'OPTION_NOT_FOUND'); return i; });
        c.options.forEach(function (o, i) { o.el.selected = idxs.indexOf(i) >= 0; });
      } else {
        var i2 = Parser.matchOption(labels, list[0]);
        if (i2 < 0) throw fail('No option matches "' + list[0] + '" (options: ' + labels.slice(0, 8).join(' / ') + ')', 'OPTION_NOT_FOUND');
        c.el.focus();
        c.el.selectedIndex = Array.prototype.indexOf.call(c.el.options, c.options[i2].el);
      }
      DOM.fire(c.el, 'input'); DOM.fire(c.el, 'change');
    },

    /** Custom (ARIA) dropdown: open it, click the matching [role=option], wait for the popup to settle. */
    setListbox: function (q, wanted) {
      var c = q.controls[0], list = Array.isArray(wanted) ? wanted[0] : wanted;
      var labels = c.options.map(function (o) { return o.label; });
      var i = Parser.matchOption(labels, list);
      if (i < 0) return Promise.reject(fail('No option matches "' + list + '" (options: ' + labels.slice(0, 8).join(' / ') + ')', 'OPTION_NOT_FOUND'));
      var opt = c.options[i];
      DOM.mouseClick(c.el);
      return DOM.waitFor(function () { return DOM.isVisible(opt.el) || opt.el.getAttribute('aria-selected') != null; }, { timeout: 1200 })
        .then(function () { DOM.mouseClick(opt.el); return DOM.sleep(Filler.settleMs); });
    },

    setRange: function (q, wanted) {
      var el = q.controls[0].el;
      DOM.setNativeValue(el, String(Array.isArray(wanted) ? wanted[0] : wanted));
      DOM.fire(el, 'input'); DOM.fire(el, 'change');
    },

    /** One interaction attempt (does not verify). */
    attempt: function (q, answer) {
      switch (q.kind) {
        case 'text': case 'textarea': return Filler.setText(q, Array.isArray(answer) ? answer.join(', ') : answer);
        case 'date': case 'time': case 'datetime': return Filler.setDateTime(q, answer);
        case 'multi-time': case 'multi-date': return Filler.setMulti(q, answer);
        case 'native-radio': case 'aria-radio': return Filler.setRadio(q, answer);
        case 'native-checkbox': case 'aria-checkbox': return Filler.setCheckbox(q, answer);
        case 'native-select': case 'native-select-multiple': return Filler.setSelect(q, answer);
        case 'aria-listbox': return Filler.setListbox(q, answer);
        case 'native-range': return Filler.setRange(q, answer);
        default: throw fail('Question type "' + q.type + '" (' + q.kind + ') is not supported', 'UNSUPPORTED');
      }
    },

    /**
     * Fills one question and verifies the result against the DOM.
     * Resolves { ok, verified, key, text, expected, actual, attempts, ms, error, code }.
     * Never resolves ok:true without a successful read-back comparison.
     */
    fillQuestion: function (q, answer, opts) {
      opts = opts || {};
      var maxAttempts = 1 + (opts.retries == null ? 2 : opts.retries);
      var t0 = Util.mono(), n = 0;
      var res = { ok: false, verified: false, key: q.key, text: q.text, type: q.type, expected: answer, actual: null, attempts: 0, ms: 0, error: '', code: '' };
      function done() { res.ms = Util.mono() - t0; res.attempts = n; return res; }
      if (!q.supported) { res.error = 'Unsupported question type'; res.code = 'UNSUPPORTED'; return Promise.resolve(done()); }
      if (answer == null || (Array.isArray(answer) && !answer.length) || answer === '') {
        res.error = 'No answer was provided for this question'; res.code = 'MISSING_ANSWER'; return Promise.resolve(done());
      }
      if (!DOM.isVisible(q.container)) { res.error = 'Question is not visible'; res.code = 'NOT_VISIBLE'; return Promise.resolve(done()); }
      if (q.controls.some(function (c) { return !c.el.isConnected; })) { res.error = 'Question element was removed from the page'; res.code = 'ELEMENT_NOT_FOUND'; return Promise.resolve(done()); }
      if (q.controls.length && q.controls.every(function (c) { return c.el.disabled === true; })) { res.error = 'Question is disabled'; res.code = 'DISABLED'; return Promise.resolve(done()); }

      function loop() {
        n++;
        return Promise.resolve().then(function () { return Filler.attempt(q, answer); })
          .then(function () { return DOM.sleep(Filler.settleMs); })
          .then(function () {
            res.actual = V.readState(q);
            if (V.matches(q, answer)) { res.ok = true; res.verified = true; res.error = ''; res.code = ''; return done(); }
            res.error = 'After filling, the page shows ' + JSON.stringify(res.actual) + ' instead of ' + JSON.stringify(answer);
            res.code = 'VERIFY_FAILED';
            if (n < maxAttempts) return DOM.sleep(40 * n).then(loop);
            return done();
          }, function (err) {
            res.error = err.message; res.code = err.code || 'FILL_FAILED';
            // Invalid answers and missing options will not improve with a retry.
            if (n < maxAttempts && res.code !== 'INVALID_ANSWER' && res.code !== 'OPTION_NOT_FOUND') return DOM.sleep(40 * n).then(loop);
            return done();
          });
      }
      return loop();
    },

    /**
     * Fills all given visible questions in order.
     * answers: map key -> value. Required questions without an answer are reported as MISSING_ANSWER.
     * Optional questions with a null/undefined answer are skipped (recorded as skipped, not failed).
     */
    fillSection: function (questions, answers, opts) {
      opts = opts || {};
      var results = [], chain = Promise.resolve();
      questions.forEach(function (q) {
        chain = chain.then(function () {
          if (opts.shouldStop && opts.shouldStop()) { results.push({ key: q.key, text: q.text, ok: false, skipped: true, code: 'STOPPED', error: 'Stopped' }); return null; }
          if (!q.visible || !q.supported) {
            if (q.visible && !q.supported && q.required) results.push({ key: q.key, text: q.text, ok: false, code: 'UNSUPPORTED', error: 'Required question has an unsupported type (' + q.kind + ')', attempts: 0, ms: 0 });
            return null;
          }
          var a = answers[q.key];
          if (a == null || (Array.isArray(a) && !a.length)) {
            if (q.required) results.push({ key: q.key, text: q.text, ok: false, code: 'MISSING_ANSWER', error: 'No answer available for a required question', attempts: 0, ms: 0 });
            else results.push({ key: q.key, text: q.text, ok: true, skipped: true, verified: false, attempts: 0, ms: 0 });
            return null;
          }
          return Filler.fillQuestion(q, a, opts).then(function (r) {
            results.push(r);
            return DOM.sleep(opts.actionDelayMs || 0);
          });
        });
      });
      return chain.then(function () { return results; });
    }
  };

  SP.filler = Filler;
})(typeof globalThis !== 'undefined' ? globalThis : self);
