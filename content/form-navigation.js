/* SurveyPilot AI - content script: section-aware navigation (Next / Back / Submit), transition and confirmation detection. */
(function (root) {
  'use strict';
  var SP = (root.SP = root.SP || {});
  var Util = SP.Util, DOM = SP.DOM, V = SP.validation;

  var NEXT_RE = /^(next|continue|next page|next step|continue to next( step| page)?|siguiente|continuar|suivant|weiter|volgende|avanti)\b/i;
  var PREV_RE = /^(back|previous|prev|previous page|previous step|atr[aá]s|anterior|pr[eé]c[eé]dent|zur[uü]ck|vorige|indietro)\b/i;
  var SUBMIT_RE = /^(submit|send|finish|finish survey|submit (response|answers|survey|form)|complete|enviar|envoyer|absenden|verzenden|invia)\b/i;
  var SUCCESS_RE = /(your response has been recorded|response (has been )?(recorded|submitted|received|saved)|thank you for (your|completing|taking|participating)|thanks for (your|completing|taking|participating)|successfully submitted|submission (was )?(received|successful|complete)|survey (is )?complete)/i;

  // Page-level JavaScript errors are visible to the isolated world as window events.
  var consoleErrors = [];
  function pushErr(kind, msg, src) {
    consoleErrors.push({ ts: Util.now(), kind: kind, message: String(msg).slice(0, 300), source: src || '' });
    if (consoleErrors.length > 50) consoleErrors.shift();
  }
  if (root.addEventListener) {
    root.addEventListener('error', function (e) { pushErr('error', e.message || 'error', e.filename ? e.filename + ':' + e.lineno : ''); });
    root.addEventListener('unhandledrejection', function (e) { pushErr('unhandledrejection', e.reason && e.reason.message || e.reason || 'rejection'); });
  }

  function btnLabel(b) {
    return Util.cleanLabel((b.tagName === 'INPUT' ? b.value : '') || b.getAttribute('aria-label') || DOM.text(b) || b.title || '');
  }
  function isDisabled(b) { return b.disabled === true || b.getAttribute('aria-disabled') === 'true'; }

  var Nav = {
    errors: consoleErrors,

    buttons: function (doc, rootEl) {
      var res = Nav._buttons(doc, rootEl || doc);
      // Google Forms keeps its navigation outside the question container on some layouts: look page-wide before giving up.
      if (rootEl && !res.next && !res.submit && !res.prev) res = Nav._buttons(doc, doc);
      return res;
    },

    _buttons: function (doc, scope) {
      var list = Array.prototype.filter.call(scope.querySelectorAll('button, input[type=submit], input[type=button], [role=button], a[role=button]'), function (b) {
        return DOM.isVisible(b);
      });
      var res = { next: null, prev: null, submit: null, all: [] };
      list.forEach(function (b) {
        var label = btnLabel(b);
        var kind = null;
        if (NEXT_RE.test(label)) kind = 'next';
        else if (PREV_RE.test(label)) kind = 'prev';
        else if (SUBMIT_RE.test(label) || ((b.type === 'submit') && !label)) kind = 'submit';
        else if (b.type === 'submit' && b.tagName !== 'A') kind = 'submit';
        res.all.push({ label: label, kind: kind, disabled: isDisabled(b) });
        if (kind && !res[kind]) res[kind] = b;
      });
      return res;
    },

    describe: function (doc, rootEl) {
      var b = Nav.buttons(doc, rootEl);
      function d(el) { return el ? { label: btnLabel(el), disabled: isDisabled(el) } : null; }
      return { next: d(b.next), prev: d(b.prev), submit: d(b.submit), pageInfo: Nav.pageInfo(doc, rootEl) };
    },

    /** "Page 2 of 4" style indicator when present. */
    pageInfo: function (doc, rootEl) {
      var scope = rootEl || doc.body;
      var m = DOM.text(scope).match(/\bpage\s+(\d+)\s+(?:of|\/)\s+(\d+)\b/i) || DOM.text(scope).match(/\bstep\s+(\d+)\s+(?:of|\/)\s+(\d+)\b/i);
      if (m) return { current: +m[1], total: +m[2], source: 'text' };
      var pb = doc.querySelector('[role=progressbar][aria-valuenow]');
      if (pb) return { percent: parseFloat(pb.getAttribute('aria-valuenow')), source: 'progressbar' };
      return null;
    },

    /** Signature of what the user currently sees: visible question keys + page indicator + first visible heading. */
    signature: function (readResult, doc, rootEl) {
      var pi = Nav.pageInfo(doc, rootEl);
      var scope = rootEl || doc.body;
      var h = Array.prototype.filter.call(scope.querySelectorAll('h1,h2,h3,[role=heading],legend'), DOM.isVisible)[0];
      return readResult.signature + '|' + (pi ? (pi.current || pi.percent) : '') + '|' + (h ? DOM.text(h) : '');
    },

    detectConfirmation: function (doc, loc) {
      loc = loc || doc.defaultView.location;
      if (/\/formResponse/i.test(loc.pathname)) {
        var gt = DOM.visibleText(doc.body);
        if (SUCCESS_RE.test(gt)) return { confirmed: true, evidence: 'Google Forms confirmation text on formResponse page' };
        return { confirmed: false, evidence: 'On /formResponse but no confirmation text found' };
      }
      var st = doc.querySelector('[data-sp-success],[role=status].success,.success-message,.thank-you,#thank-you,[data-testid=success]');
      if (st && DOM.isVisible(st) && DOM.text(st)) return { confirmed: true, evidence: 'Success element: "' + DOM.text(st).slice(0, 80) + '"' };
      var body = DOM.visibleText(doc.body);
      var m = body.match(SUCCESS_RE);
      if (m) {
        // Text alone is not enough when the questions are still on screen.
        var form = doc.querySelector('form');
        var formVisible = form && DOM.isVisible(form) && form.querySelector('input:not([type=hidden]),select,textarea') && SP.reader.readForm(doc, { root: form }).visibleCount > 0;
        if (!formVisible) return { confirmed: true, evidence: 'Confirmation text "' + m[0] + '" and the form is no longer shown' };
        return { confirmed: false, evidence: 'Confirmation-like text found but questions are still visible' };
      }
      return { confirmed: false, evidence: 'No confirmation text or success element detected' };
    },

    _click: function (b) { DOM.mouseClick(b); },

    /** On a confirmation page, finds and clicks "Submit another response" (Google Forms and similar). */
    another: function (doc) {
      if (!Nav.detectConfirmation(doc).confirmed) return { clicked: false, reason: 'Not on a confirmation page.' };
      var els = Array.prototype.filter.call(doc.querySelectorAll('a, button, [role=button], [role=link]'), DOM.isVisible);
      var el = els.filter(function (e) { return /^(submit|send|fill (out )?)\s*(another|a new|again)|another response|enviar otra|soumettre une autre/i.test(DOM.text(e) || e.getAttribute('aria-label') || ''); })[0];
      if (!el) return { clicked: false, reason: 'No "Submit another response" link was found.' };
      Nav._click(el);
      return { clicked: true, label: DOM.text(el) };
    },

    /**
     * Clicks Next and waits for the visible section to change.
     * Resolves { ok, code, message, messages, before, after } - never loops: exactly one click per call.
     */
    goNext: function (doc, rootEl, opts) {
      opts = opts || {};
      var timeout = opts.timeout || 8000;
      var b = Nav.buttons(doc, rootEl);
      if (!b.next) return Promise.resolve({ ok: false, code: 'NO_NEXT', message: 'No visible "Next" button was found.' });
      if (isDisabled(b.next)) return Promise.resolve({ ok: false, code: 'NEXT_DISABLED', message: 'The "Next" button is disabled.' });
      var r0 = SP.reader.readForm(doc, { root: rootEl, pageIndex: opts.pageIndex });
      var before = Nav.signature(r0, doc, rootEl);
      var msgsBefore = V.pageMessages(doc, rootEl);
      var invalidBefore = (rootEl || doc).querySelectorAll('[aria-invalid=true]').length;
      Nav._click(b.next);
      return DOM.waitFor(function () {
        var r = SP.reader.readForm(doc, { root: rootEl, pageIndex: opts.pageIndex });
        var sig = Nav.signature(r, doc, rootEl);
        if (sig !== before && r.visibleCount > 0) return { type: 'changed', sig: sig };
        if (sig !== before && r.visibleCount === 0 && Nav.detectConfirmation(doc).confirmed) return { type: 'confirmed' };
        var msgs = V.pageMessages(doc, rootEl).filter(function (m) { return msgsBefore.indexOf(m) < 0; });
        var inv = (rootEl || doc).querySelectorAll('[aria-invalid=true]').length;
        if (msgs.length || inv > invalidBefore) return { type: 'errors', messages: msgs };
        return null;
      }, { timeout: timeout, doc: doc, interval: 60 }).then(function (r) {
        if (!r) return { ok: false, code: 'NAV_TIMEOUT', message: 'The section did not change within ' + Math.round(timeout / 1000) + ' s after clicking Next.', before: before };
        if (r.type === 'errors') return { ok: false, code: 'VALIDATION_ERROR', message: 'The form reported validation errors after clicking Next.', messages: r.messages, before: before };
        return { ok: true, code: '', before: before, after: r.sig, confirmed: r.type === 'confirmed' };
      });
    },

    goPrev: function (doc, rootEl, opts) {
      opts = opts || {};
      var b = Nav.buttons(doc, rootEl);
      if (!b.prev) return Promise.resolve({ ok: false, code: 'NO_PREV', message: 'No visible "Back" button was found.' });
      var r0 = SP.reader.readForm(doc, { root: rootEl });
      var before = Nav.signature(r0, doc, rootEl);
      Nav._click(b.prev);
      return DOM.waitFor(function () {
        var r = SP.reader.readForm(doc, { root: rootEl });
        return Nav.signature(r, doc, rootEl) !== before && r.visibleCount > 0;
      }, { timeout: opts.timeout || 8000, doc: doc }).then(function (ok) {
        return ok ? { ok: true } : { ok: false, code: 'NAV_TIMEOUT', message: 'The section did not change after clicking Back.' };
      });
    },

    /** Clicks Submit once. Only called when a test run explicitly asks for it. Confirmation is never assumed. */
    submit: function (doc, rootEl, opts) {
      opts = opts || {};
      var b = Nav.buttons(doc, rootEl);
      if (!b.submit) return Promise.resolve({ ok: false, code: 'NO_SUBMIT', message: 'No visible Submit button was found.' });
      if (isDisabled(b.submit)) return Promise.resolve({ ok: false, code: 'SUBMIT_DISABLED', message: 'The Submit button is disabled.' });
      var msgsBefore = V.pageMessages(doc, rootEl);
      Nav._click(b.submit);
      return DOM.waitFor(function () {
        var c = Nav.detectConfirmation(doc);
        if (c.confirmed) return { type: 'confirmed', evidence: c.evidence };
        var msgs = V.pageMessages(doc, rootEl).filter(function (m) { return msgsBefore.indexOf(m) < 0; });
        if (msgs.length) return { type: 'errors', messages: msgs };
        return null;
      }, { timeout: opts.timeout || 8000, doc: doc, interval: 80 }).then(function (r) {
        if (!r) return { ok: true, confirmed: false, evidence: 'Submit was clicked but no confirmation was detected on this page (the page may be navigating).' };
        if (r.type === 'errors') return { ok: false, code: 'VALIDATION_ERROR', message: 'Submit was blocked by validation errors.', messages: r.messages };
        return { ok: true, confirmed: true, evidence: r.evidence };
      });
    }
  };

  SP.nav = Nav;
})(typeof globalThis !== 'undefined' ? globalThis : self);
