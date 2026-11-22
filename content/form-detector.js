/* SurveyPilot AI - content script: shared DOM helpers and form detection.
   Load order (see manifest): util, survey-parser, form-detector, form-reader, validation, form-filler, form-navigation, content-main. */
(function (root) {
  'use strict';
  var SP = (root.SP = root.SP || {});
  var Util = SP.Util;

  var DOM = {
    /** Real layout is checked in browsers; jsdom has no layout engine so only style/attribute checks apply. */
    useLayout: !(typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)),

    text: function (el) {
      if (!el) return '';
      var t = (typeof el.innerText === 'string' && el.innerText) ? el.innerText : (el.textContent || '');
      return t.replace(/\s+/g, ' ').trim();
    },

    /** Text a user can actually see: hidden subtrees are skipped (innerText does this in browsers; jsdom needs the walk). */
    visibleText: function (rootEl) {
      var doc = rootEl.ownerDocument, parts = [], cache = new Map();
      var walker = doc.createTreeWalker(rootEl, 4, null), n;
      while ((n = walker.nextNode())) {
        var p = n.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
        if (!cache.has(p)) cache.set(p, DOM.isVisible(p));
        if (cache.get(p)) parts.push(n.textContent);
      }
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    },

    isVisible: function (el) {
      if (!el || el.nodeType !== 1 || !el.ownerDocument) return false;
      var win = el.ownerDocument.defaultView;
      if (!win) return false;
      if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
      for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
        var cs = win.getComputedStyle(n);
        if (cs.display === 'none') return false;
        if (n === el && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
      }
      if (DOM.useLayout && typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
      return true;
    },

    sleep: Util.sleep,

    /** Polls `fn` (and wakes early on DOM mutations) until it returns a truthy value or the timeout elapses. */
    waitFor: function (fn, opts) {
      opts = opts || {};
      var timeout = opts.timeout == null ? 3000 : opts.timeout, interval = opts.interval || 50;
      var doc = opts.doc || root.document;
      return new Promise(function (resolve) {
        var start = Util.mono(), done = false, mo = null, timer = null;
        function finish(v) {
          if (done) return; done = true;
          if (mo) mo.disconnect(); if (timer) clearTimeout(timer); resolve(v);
        }
        function check() {
          if (done) return;
          var v; try { v = fn(); } catch (e) { v = null; }
          if (v) return finish(v);
          if (Util.mono() - start >= timeout) return finish(null);
          timer = setTimeout(check, interval);
        }
        if (doc && typeof MutationObserver !== 'undefined') {
          mo = new MutationObserver(function () { if (!done) { clearTimeout(timer); check(); } });
          mo.observe(doc.documentElement || doc, { childList: true, subtree: true, attributes: true, characterData: true });
        }
        check();
      });
    },

    cssPath: function (el) {
      if (!el || el.nodeType !== 1) return '';
      var parts = [];
      while (el && el.nodeType === 1 && parts.length < 6) {
        var s = el.tagName.toLowerCase();
        if (el.id) { parts.unshift(s + '#' + el.id); break; }
        var parent = el.parentElement;
        if (parent) {
          var sib = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
          if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')';
        }
        parts.unshift(s); el = parent;
      }
      return parts.join(' > ');
    },

    /** Sets a value through the native setter so framework-controlled inputs (React etc.) notice it. */
    setNativeValue: function (el, value) {
      var win = el.ownerDocument.defaultView;
      var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    },

    fire: function (el, type) {
      var win = el.ownerDocument.defaultView, ev;
      if (type === 'input' && typeof win.InputEvent === 'function') ev = new win.InputEvent('input', { bubbles: true, composed: true, cancelable: false });
      else ev = new win.Event(type, { bubbles: true, cancelable: type !== 'change' && type !== 'input' });
      el.dispatchEvent(ev);
    },

    /** Full pointer/mouse sequence for custom (ARIA) widgets, ending with a click. */
    mouseClick: function (el) {
      var win = el.ownerDocument.defaultView;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) {
        var Ctor = /^pointer/.test(t) && typeof win.PointerEvent === 'function' ? win.PointerEvent : win.MouseEvent;
        el.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, view: win, button: 0 }));
      });
      el.click();
    },

    attr: function (el, name) { return (el.getAttribute && el.getAttribute(name)) || ''; }
  };

  var Detector = {
    GOOGLE_RE: /^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)/,

    isGoogleForm: function (loc) { return Detector.GOOGLE_RE.test(loc.href); },

    /**
     * Detects the best supported form on the page.
     * Returns { status: 'supported'|'partial'|'unsupported', kind, reason, title, url, questionCount, ... }.
     * Never returns 'supported' unless real questions were read.
     */
    detect: function (doc, loc) {
      loc = loc || doc.defaultView.location;
      var base = { url: loc.href, kind: null, status: 'unsupported', reason: '', title: doc.title || '', questionCount: 0,
        sectionCount: 0, types: {}, requiredCount: 0, unsupportedCount: 0, hiddenCount: 0, formCount: 0 };
      try {
        if (Detector.isGoogleForm(loc)) return Detector.detectGoogle(doc, loc, base);
        return Detector.detectHtml(doc, loc, base);
      } catch (err) {
        base.reason = 'Detection crashed: ' + err.message;
        base.error = err.message;
        return base;
      }
    },

    detectGoogle: function (doc, loc, base) {
      base.kind = 'google-forms';
      var text = DOM.visibleText(doc.body).toLowerCase();
      if (/no longer accepting responses|is no longer accepting/.test(text)) { base.reason = 'This Google Form is closed (no longer accepting responses).'; return base; }
      if (/\/formresponse/.test(loc.pathname) || /your response has been recorded/.test(text)) {
        base.reason = 'This is the confirmation page of a submitted response, not a fillable form.'; return base;
      }
      if (/accounts\.google\.com/.test(loc.hostname)) { base.reason = 'Sign-in is required before this form can be read.'; return base; }
      var formEl = doc.querySelector('form[action*="formResponse"]') || doc.querySelector('form') || doc.body;
      return Detector.finish(doc, formEl, base);
    },

    detectHtml: function (doc, loc, base) {
      base.kind = 'html-form';
      var forms = Array.prototype.slice.call(doc.querySelectorAll('form'));
      base.formCount = forms.length;
      var roots = forms.length ? forms : [doc.body];
      var best = null, bestScore = -1, passwordReason = '';
      roots.forEach(function (f) {
        if (f.querySelector('input[type=password]')) { passwordReason = 'Login form detected (password field). SurveyPilot never fills login forms.'; return; }
        if (f.getAttribute('role') === 'search') return;
        var r = SP.reader.readForm(doc, { root: f, includeHidden: true });
        var vis = r.questions.filter(function (q) { return q.visible && q.supported; }).length;
        var score = vis * 100 + r.questions.length;
        if (r.questions.length && score > bestScore) { best = f; bestScore = score; }
      });
      if (!best) {
        base.reason = passwordReason || (forms.length ? 'No supported question fields were found in the form(s) on this page.' : 'No form or question fields were found on this page.');
        return base;
      }
      var res = Detector.finish(doc, best, base);
      if (res.status !== 'unsupported' && res.questionCount === 1 && res.types.short_answer === 1 && /search|query|q$/i.test((best.querySelector('input') || {}).name || '')) {
        res.status = 'unsupported'; res.reason = 'Looks like a search box, not a survey.';
      }
      return res;
    },

    finish: function (doc, formEl, base) {
      var r = SP.reader.readForm(doc, { root: formEl, includeHidden: true });
      var qs = r.questions;
      base.title = r.title || base.title;
      base.questionCount = qs.filter(function (q) { return q.supported; }).length;
      base.unsupportedCount = qs.filter(function (q) { return !q.supported; }).length;
      base.hiddenCount = qs.filter(function (q) { return !q.visible; }).length;
      base.sectionCount = r.sections.length;
      qs.forEach(function (q) {
        if (!q.supported) return;
        base.types[q.type] = (base.types[q.type] || 0) + 1;
        if (q.required) base.requiredCount++;
      });
      base.formEl = formEl;
      if (!qs.some(function (q) { return q.supported && q.visible; }) && !base.unsupportedCount && SP.nav) {
        // An intro / welcome section has no visible questions but a Next button: it is a valid first page, the runner just clicks Next.
        var nb = SP.nav.buttons(doc, formEl);
        if (nb.next && !nb.next.disabled) {
          base.intro = true;
          if (!base.questionCount) {
            base.status = 'supported';
            base.reason = 'Intro page without questions detected. The runner will click Next, then fill the following sections.';
            return base;
          }
        }
      }
      if (!base.questionCount) {
        base.status = 'unsupported';
        base.reason = qs.length ? 'Only unsupported field types were found (' + base.unsupportedCount + ').'
          : (base.kind === 'google-forms' ? 'No questions were found yet. The form may still be loading, require sign-in, or use an unsupported layout.' : 'No questions were found.');
        return base;
      }
      base.status = base.unsupportedCount ? 'partial' : 'supported';
      base.reason = base.unsupportedCount ? base.unsupportedCount + ' field(s) use unsupported types and will be skipped or flagged.' : 'All detected question types are supported.';
      return base;
    }
  };

  SP.DOM = DOM;
  SP.detector = Detector;
})(typeof globalThis !== 'undefined' ? globalThis : self);
