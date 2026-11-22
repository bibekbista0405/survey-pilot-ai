/* SurveyPilot AI - content script: reads the CURRENT DOM state of questions and validates sections. */
(function (root) {
  'use strict';
  var SP = (root.SP = root.SP || {});
  var Util = SP.Util, DOM = SP.DOM;

  var MSG_SEL = '[role=alert],[aria-live=assertive],.error,.error-message,.field-error,.invalid-feedback,.validation-error,[data-error],.freebirdFormviewerComponentsQuestionBaseError,[aria-invalid=true] ~ *';

  var Validation = {
    /** Returns the current value(s) as displayed by the DOM: string, string[] (checkbox) or '' when empty. */
    readState: function (q) {
      var c = q.controls, el;
      switch (q.kind) {
        case 'native-radio': {
          var r = c.filter(function (x) { return x.el.checked; })[0]; return r ? r.label : '';
        }
        case 'aria-radio': {
          var ar = c.filter(function (x) { return x.el.getAttribute('aria-checked') === 'true'; })[0]; return ar ? ar.label : '';
        }
        case 'native-checkbox':
          return c.filter(function (x) { return x.el.checked; }).map(function (x) { return x.label; });
        case 'aria-checkbox':
          return c.filter(function (x) { return x.el.getAttribute('aria-checked') === 'true'; }).map(function (x) { return x.label; });
        case 'native-select': {
          el = c[0].el;
          var o = el.options[el.selectedIndex];
          if (!o || (c[0].placeholder && o === c[0].placeholder.el)) return '';
          return Util.cleanLabel(o.textContent);
        }
        case 'native-select-multiple':
          return Array.prototype.filter.call(c[0].el.options, function (o) { return o.selected; }).map(function (o) { return Util.cleanLabel(o.textContent); });
        case 'aria-listbox': {
          el = c[0].el;
          var sel = el.querySelector('[role=option][aria-selected=true]');
          if (sel) { var t = sel.getAttribute('data-value') || sel.getAttribute('aria-label') || DOM.text(sel); return Util.cleanLabel(t); }
          var shown = el.getAttribute('data-sp-selected');
          return shown || '';
        }
        case 'multi-time': return Validation._multi(c, ['hour', 'minute']);
        case 'multi-date': return Validation._multi(c, ['year', 'month', 'day']);
        case 'native-range': return String(c[0].el.value);
        default:
          return c[0] ? String(c[0].el.value == null ? '' : c[0].el.value) : '';
      }
    },

    _multi: function (c, order) {
      var m = {};
      c.forEach(function (x) { m[x.part] = String(x.el.value || '').trim(); });
      var vals = order.map(function (p) { return m[p]; });
      return vals.every(function (v) { return v; }) ? vals.join(':') : '';
    },

    isAnswered: function (q) {
      var s = Validation.readState(q);
      return Array.isArray(s) ? s.length > 0 : String(s).trim() !== '';
    },

    /** Native constraint validation message for a question, or '' when valid. */
    nativeProblem: function (q) {
      for (var i = 0; i < q.controls.length; i++) {
        var el = q.controls[i].el;
        if (typeof el.checkValidity === 'function' && el.willValidate && !el.checkValidity()) {
          var visibleNeeded = q.kind === 'native-radio' || q.kind === 'native-checkbox';
          if (visibleNeeded && Validation.isAnswered(q)) continue;
          return el.validationMessage || 'Invalid value';
        }
      }
      return '';
    },

    /** Visible validation messages currently on the page (alerts, inline errors, native :invalid text). */
    pageMessages: function (doc, rootEl) {
      var out = [];
      Array.prototype.forEach.call((rootEl || doc).querySelectorAll(MSG_SEL), function (el) {
        if (!DOM.isVisible(el)) return;
        var t = DOM.text(el);
        if (t && t.length < 300 && out.indexOf(t) < 0) out.push(t);
      });
      return out.slice(0, 10);
    },

    /**
     * Validates the given (currently visible) questions.
     * answers: map key -> expected value (optional). When provided, mismatches are reported too.
     * Returns { valid, missing:[{key,text}], invalid:[{key,text,reason}], mismatched:[...], messages:[...] }.
     */
    validateSection: function (questions, answers, doc, rootEl) {
      var res = { valid: true, missing: [], invalid: [], mismatched: [], messages: [] };
      questions.forEach(function (q) {
        if (!q.supported || !q.visible) return;
        var answered = Validation.isAnswered(q);
        if (q.required && !answered) { res.missing.push({ key: q.key, text: q.text }); return; }
        if (answered) {
          var prob = Validation.nativeProblem(q);
          if (prob) res.invalid.push({ key: q.key, text: q.text, reason: prob });
          if (answers && answers[q.key] != null) {
            var ok = Validation.matches(q, answers[q.key]);
            if (!ok) res.mismatched.push({ key: q.key, text: q.text, expected: answers[q.key], actual: Validation.readState(q) });
          }
        }
      });
      res.messages = Validation.pageMessages(doc, rootEl);
      res.valid = !res.missing.length && !res.invalid.length && !res.mismatched.length;
      return res;
    },

    /** Compares the DOM state to an expected answer using the same normalisation the filler uses. */
    matches: function (q, expected) {
      var actual = Validation.readState(q);
      if (q.kind === 'multi-time' || q.kind === 'multi-date') return Validation._multiMatches(q, expected, actual);
      if (Array.isArray(actual)) {
        var want = (Array.isArray(expected) ? expected : [expected]).map(Util.normalize).sort();
        var got = actual.map(Util.normalize).sort();
        return want.length === got.length && want.every(function (w, i) { return w === got[i]; });
      }
      if (q.kind === 'text' || q.kind === 'textarea') return String(actual) === String(expected);
      if (q.kind === 'date' || q.kind === 'time' || q.kind === 'datetime') return Validation.normalizeDT(String(actual)) === Validation.normalizeDT(String(expected));
      return Util.normalize(actual) === Util.normalize(Array.isArray(expected) ? expected[0] : expected);
    },

    _multiMatches: function (q, expected, actual) {
      var parts = q.kind === 'multi-time' ? Validation.splitTime(String(expected)) : Validation.splitDate(String(expected));
      return actual !== '' && actual === parts.join(':');
    },

    normalizeDT: function (s) { return s.trim().replace(/^(\d{1,2}):(\d{2})(:00)?$/, function (m, h, mi) { return Util.pad2(+h) + ':' + mi; }); },
    splitTime: function (s) { var m = s.match(/(\d{1,2}):(\d{2})/); return m ? [String(+m[1]), m[2]] : ['', '']; },
    splitDate: function (s) { var m = s.match(/(\d{4})-(\d{2})-(\d{2})/); return m ? [m[1], String(+m[2]), String(+m[3])] : ['', '', '']; }
  };

  SP.validation = Validation;
})(typeof globalThis !== 'undefined' ? globalThis : self);
