/* SurveyPilot AI - content script entry: message router between the extension and the page.
   The content script is passive: it only reacts to messages with target "sp-content". */
(function (root) {
  'use strict';
  var SP = (root.SP = root.SP || {});
  var Util = SP.Util, DOM = SP.DOM, V = SP.validation;
  var doc = root.document;

  // Cache the last read; MutationObserver marks it dirty so unchanged pages are not rescanned.
  var cache = { key: '', result: null, dirty: true };
  if (typeof MutationObserver !== 'undefined' && doc && doc.documentElement) {
    new MutationObserver(function () { cache.dirty = true; })
      .observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['hidden', 'style', 'class', 'aria-hidden', 'aria-checked', 'aria-selected', 'disabled', 'open'] });
  }

  function currentRoot() {
    var d = SP.detector.detect(doc, root.location);
    return d.formEl || doc.querySelector('form') || doc.body;
  }

  function read(opts) {
    opts = opts || {};
    var key = JSON.stringify([!!opts.includeHidden, opts.pageIndex || 0]);
    if (!opts.force && !cache.dirty && cache.key === key && cache.result) return cache.result;
    var r = SP.reader.readForm(doc, { root: opts.root || currentRoot(), includeHidden: !!opts.includeHidden, pageIndex: opts.pageIndex || 0 });
    cache = { key: key, result: r, dirty: false };
    return r;
  }

  function strip(d) { var c = Object.assign({}, d); delete c.formEl; return c; }

  function snapshot(rootEl, pageIndex) {
    var r = SP.reader.readForm(doc, { root: rootEl, pageIndex: pageIndex || 0 });
    var v = V.validateSection(r.questions, null, doc, rootEl);
    return {
      url: root.location.href, title: doc.title, timestamp: Util.now(),
      section: { index: pageIndex || 0, title: (r.sections.filter(function (s) { return s.visible; })[0] || {}).title || '', pageInfo: SP.nav.pageInfo(doc, rootEl) },
      visibleQuestions: r.questions.filter(function (q) { return q.visible; }).map(function (q) { return q.text; }),
      missing: v.missing, invalid: v.invalid, validationMessages: v.messages,
      navigation: SP.nav.describe(doc, rootEl), consoleErrors: SP.nav.errors.slice(-20)
    };
  }

  var handlers = {
    ping: function () { return { ready: true, url: root.location.href, title: doc.title }; },

    detect: function () { return { detection: strip(SP.detector.detect(doc, root.location)) }; },

    read: function (m) {
      var r = read({ includeHidden: m.includeHidden, pageIndex: m.pageIndex, force: m.force });
      return { form: SP.reader.serializeResult(r), nav: SP.nav.describe(doc, currentRoot()) };
    },

    diagnose: function (m) {
      var r = read({ includeHidden: true, force: true, pageIndex: m.pageIndex });
      if (m.highlight) SP.reader.highlight(r); else SP.reader.clearHighlights(doc);
      return { diagnostics: SP.reader.diagnose(r), strategy: r.diagnostics, title: r.title, url: r.url };
    },

    clearHighlights: function () { SP.reader.clearHighlights(doc); return {}; },

    fillSection: function (m) {
      var rootEl = currentRoot();
      var r = SP.reader.readForm(doc, { root: rootEl, pageIndex: m.pageIndex || 0 });   // always fresh refs before interacting
      var t0 = Util.mono();
      return SP.filler.fillSection(r.questions, m.answers || {}, { retries: m.retries, actionDelayMs: m.actionDelayMs }).then(function (results) {
        cache.dirty = true;
        var r2 = SP.reader.readForm(doc, { root: rootEl, pageIndex: m.pageIndex || 0 });
        var validation = V.validateSection(r2.questions, m.answers || {}, doc, rootEl);
        var strip2 = validation; // serialisable already
        return { results: results, validation: strip2, ms: Util.mono() - t0, signature: SP.nav.signature(r2, doc, rootEl) };
      });
    },

    validate: function (m) {
      var rootEl = currentRoot();
      var r = SP.reader.readForm(doc, { root: rootEl, pageIndex: m.pageIndex || 0 });
      return { validation: V.validateSection(r.questions, m.answers || null, doc, rootEl) };
    },

    next: function (m) { return SP.nav.goNext(doc, currentRoot(), { timeout: m.timeout, pageIndex: (m.pageIndex || 0) + 1 }).then(function (r) { cache.dirty = true; return { nav: r }; }); },
    prev: function (m) { return SP.nav.goPrev(doc, currentRoot(), { timeout: m.timeout }).then(function (r) { cache.dirty = true; return { nav: r }; }); },
    submit: function (m) { return SP.nav.submit(doc, currentRoot(), { timeout: m.timeout }).then(function (r) { cache.dirty = true; return { nav: r }; }); },
    another: function () { return SP.nav.another(doc); },
    confirm: function () { return { confirmation: SP.nav.detectConfirmation(doc, root.location) }; },
    navState: function () { return { nav: SP.nav.describe(doc, currentRoot()) }; },
    snapshot: function (m) { return { snapshot: snapshot(currentRoot(), m.pageIndex) }; }
  };

  /** Single entry point (also used directly by the tests). Always resolves; never throws. */
  function handle(msg) {
    var fn = handlers[msg && msg.type];
    if (!fn) return Promise.resolve({ ok: false, code: 'UNKNOWN_MESSAGE', error: 'Unknown message type: ' + (msg && msg.type) });
    return Promise.resolve().then(function () { return fn(msg); }).then(function (r) {
      return Object.assign({ ok: true }, r);
    }, function (err) {
      return { ok: false, code: err.code || 'CONTENT_ERROR', error: err.message, stack: String(err.stack || '').split('\n').slice(0, 3).join(' | ') };
    });
  }

  SP.content = { handle: handle, read: read };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.target !== 'sp-content') return false;
      handle(msg).then(sendResponse);
      return true;   // keep the channel open for the async response
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
