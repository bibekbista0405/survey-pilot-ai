/* SurveyPilot AI - content script: form reader.
   Detection strategies (in order, never a single selector):
     1. native form controls (input/select/textarea) grouped by name / fieldset
     2. ARIA widgets (role=radio|checkbox|listbox|combobox) grouped by radiogroup / group / listitem
     3. Google Forms list-item heuristic (flags list items whose widgets were not understood, for diagnostics)
   Question text uses a chain of fallbacks (legend, heading, aria-labelledby, aria-label, <label>, text before the first control). */
(function (root) {
  'use strict';
  var SP = (root.SP = root.SP || {});
  var Util = SP.Util, DOM = SP.DOM, Parser = SP.Parser;

  var IGNORED_INPUT = { hidden: 1, submit: 1, button: 1, reset: 1, image: 1, file: 1, password: 1 };
  var SECTION_SEL = '[data-sp-section],[data-section],[data-page],section,.survey-section,.form-section,.section,.page';
  var HEADING_SEL = 'h1,h2,h3,h4,h5,h6,[role=heading],legend,.question-title,[data-question-title]';
  var CONTROL_SEL = 'input, select, textarea, [role=radio], [role=checkbox], [role=listbox], [role=combobox]';

  function attr(el, n) { return (el.getAttribute && el.getAttribute(n)) || ''; }

  function byIds(el, ids) {
    var doc = el.ownerDocument;
    return ids.split(/\s+/).map(function (id) { var t = doc.getElementById(id); return t ? DOM.text(t) : ''; }).filter(Boolean).join(' ');
  }

  /** Label text of a single control using several strategies. */
  function labelOf(el) {
    var t = '';
    if (attr(el, 'aria-labelledby')) t = byIds(el, attr(el, 'aria-labelledby'));
    if (!t && el.labels && el.labels.length) t = Array.prototype.map.call(el.labels, function (l) { return DOM.text(l); }).join(' ').trim();
    if (!t && el.id) { var l = el.ownerDocument.querySelector('label[for="' + String(el.id).replace(/"/g, '\\"') + '"]'); if (l) t = DOM.text(l); }
    if (!t && el.closest) { var wrap = el.closest('label'); if (wrap) t = DOM.text(wrap); }
    if (!t) t = attr(el, 'aria-label') || attr(el, 'title') || attr(el, 'placeholder');
    return t.replace(/\s+/g, ' ').trim();
  }

  function optionLabelOf(c) {
    var el = c.el, t = '';
    if (c.kind === 'aria-radio' || c.kind === 'aria-checkbox') {
      t = attr(el, 'aria-label') || attr(el, 'data-value') || attr(el, 'data-answer-value') || DOM.text(el);
      if (!t && el.parentElement) t = DOM.text(el.parentElement);
    } else {
      t = labelOf(el);
      if (!t && el.nextSibling && el.nextSibling.nodeType === 3) t = el.nextSibling.textContent;
      if (!t && el.nextElementSibling && !el.nextElementSibling.matches(CONTROL_SEL)) t = DOM.text(el.nextElementSibling);
      if (!t) t = attr(el, 'value');
    }
    return Util.cleanLabel(t);
  }

  function describeControl(el) {
    var tag = el.tagName, role = attr(el, 'role'), kind = null, type = '';
    if (tag === 'INPUT') {
      type = (el.type || 'text').toLowerCase();
      if (IGNORED_INPUT[type]) return null;
      if (/^entry\.\d+_sentinel$/.test(el.name || '')) return null;
      if (el.closest('[role=radio],[role=checkbox],[role=listbox]')) return null; // owned by an ARIA widget
      kind = type === 'radio' ? 'native-radio' : type === 'checkbox' ? 'native-checkbox' : type === 'range' ? 'native-range'
        : type === 'date' ? 'date' : type === 'time' ? 'time' : type === 'datetime-local' ? 'datetime'
          : (type === 'month' || type === 'week' || type === 'color') ? 'unsupported' : 'text';
    } else if (tag === 'SELECT') kind = el.multiple ? 'native-select-multiple' : 'native-select';
    else if (tag === 'TEXTAREA') kind = 'textarea';
    else if (role === 'radio') kind = 'aria-radio';
    else if (role === 'checkbox') kind = 'aria-checkbox';
    else if (role === 'listbox' || role === 'combobox') kind = 'aria-listbox';
    if (!kind) return null;
    return { el: el, kind: kind, inputType: type };
  }

  function collectControls(rootEl) {
    var out = [];
    Array.prototype.forEach.call(rootEl.querySelectorAll(CONTROL_SEL), function (el) {
      if (el.closest('[data-sp-ignore]')) return;
      // A role on a native control (e.g. <input role=combobox>) is handled as that native control.
      var c = describeControl(el);
      if (c) out.push(c);
    });
    // Drop nested ARIA duplicates (a listbox inside a combobox, etc.).
    return out.filter(function (c) {
      if (c.kind !== 'aria-listbox') return true;
      return !out.some(function (o) { return o !== c && o.kind === 'aria-listbox' && o.el.contains(c.el); });
    });
  }

  function containerKey(c, all) {
    var el = c.el, form = el.form ? Array.prototype.indexOf.call(el.ownerDocument.forms, el.form) : -1;
    var same, anc;
    switch (c.kind) {
      case 'native-radio':
        if (el.name) return 'radio:' + form + ':' + el.name;
        return el.closest('fieldset,[role=radiogroup]') || el.parentElement;
      case 'native-checkbox':
        if (el.name) {
          same = all.filter(function (o) { return o.kind === 'native-checkbox' && o.el.name === el.name && o.el.form === el.form; });
          if (same.length > 1) return 'check:' + form + ':' + el.name;
        }
        anc = el.closest('fieldset,[role=group]');
        if (anc && all.filter(function (o) { return o.kind === 'native-checkbox' && anc.contains(o.el); }).length > 1) return anc;
        return el;
      case 'aria-radio':
        return el.closest('[role=radiogroup]') || el.closest('[role=listitem]') || (el.parentElement && el.parentElement.parentElement) || el;
      case 'aria-checkbox':
        anc = el.closest('[role=group]');
        if (anc && all.filter(function (o) { return o.kind === 'aria-checkbox' && anc.contains(o.el); }).length > 1) return anc;
        return el.closest('[role=listitem]') || (el.parentElement && el.parentElement.parentElement) || el;
      default: return el;
    }
  }

  /** Groups controls into prospective questions, preserving document order of first appearance. */
  function groupControls(controls) {
    var groups = [], keys = [];
    controls.forEach(function (c) {
      var k = containerKey(c, controls), i = keys.indexOf(k);
      if (i < 0) { keys.push(k); groups.push({ anchor: k, controls: [c] }); } else groups[i].controls.push(c);
    });
    // Merge Hour/Minute and Day/Month/Year inputs into single time / date questions.
    var merged = [], buckets = [];
    groups.forEach(function (g) {
      var c = g.controls[0], label = c.kind === 'text' ? attr(c.el, 'aria-label').toLowerCase() : '';
      var which = /^(hour|minute|minutes|hours)$/.test(label) ? 'time' : /^(day|month|year)$/.test(label) ? 'date' : null;
      if (!which) { merged.push(g); return; }
      var host = c.el.closest('[role=listitem],fieldset') || (c.el.parentElement && c.el.parentElement.parentElement && c.el.parentElement.parentElement.parentElement);
      var b = buckets.filter(function (x) { return x.host === host && x.which === which; })[0];
      if (!b) { b = { host: host, which: which, group: { anchor: host, controls: [], multi: which } }; buckets.push(b); merged.push(b.group); }
      c.part = label.replace(/s$/, '');
      b.group.controls.push(c);
    });
    return merged;
  }

  function primaryKind(g) {
    if (g.multi === 'time') return 'multi-time';
    if (g.multi === 'date') return 'multi-date';
    return g.controls[0].kind;
  }

  function isPlaceholderOption(o) {
    var v = o.value, t = Util.normalize(o.text || o.label || '');
    return v === '' || /^(choose|select|please select|--+|pick)\b/.test(t);
  }

  function readOptions(g, kind) {
    var opts = [];
    if (kind === 'native-radio' || kind === 'native-checkbox' || kind === 'aria-radio' || kind === 'aria-checkbox') {
      g.controls.forEach(function (c) { c.label = optionLabelOf(c); opts.push(c.label); });
    } else if (kind === 'native-select' || kind === 'native-select-multiple') {
      var sel = g.controls[0];
      sel.options = [];
      Array.prototype.forEach.call(sel.el.options, function (o) {
        var d = { el: o, label: Util.cleanLabel(o.textContent), value: o.value, text: o.textContent };
        if (kind === 'native-select' && isPlaceholderOption(d)) { sel.placeholder = d; return; }
        sel.options.push(d); opts.push(d.label);
      });
    } else if (kind === 'aria-listbox') {
      var lb = g.controls[0], list = lb.el;
      var items = list.querySelectorAll('[role=option]');
      if (!items.length) { var ctl = attr(list, 'aria-controls'); var target = ctl && list.ownerDocument.getElementById(ctl); if (target) items = target.querySelectorAll('[role=option]'); }
      lb.options = [];
      Array.prototype.forEach.call(items, function (it) {
        var d = { el: it, value: attr(it, 'data-value'), text: attr(it, 'data-value') || attr(it, 'aria-label') || DOM.text(it) };
        d.label = Util.cleanLabel(d.text);
        if (isPlaceholderOption(d) && !lb.options.length) { lb.placeholder = d; return; }
        lb.options.push(d); opts.push(d.label);
      });
    } else if (kind === 'native-range') {
      var r = g.controls[0].el, min = parseFloat(r.min || '0'), max = parseFloat(r.max || '100'), step = parseFloat(r.step || '1') || 1;
      var span = Math.round((max - min) / step);
      var stride = span > 10 ? Math.ceil(span / 10) : 1;
      for (var v = min; v <= max + 1e-9; v += step * stride) opts.push(String(+v.toFixed(6)));
      if (opts[opts.length - 1] !== String(max)) opts.push(String(max));
    }
    return opts;
  }

  function isNumericScale(opts) {
    if (opts.length < 3 || opts.length > 11) return false;
    var nums = opts.map(function (o) { return /^-?\d+$/.test(Util.normalize(o)) ? parseInt(o, 10) : NaN; });
    if (nums.some(isNaN)) return false;
    for (var i = 1; i < nums.length; i++) if (nums[i] - nums[i - 1] !== 1) return false;
    return true;
  }

  function typeFor(kind, opts, text) {
    switch (kind) {
      case 'text': return 'short_answer';
      case 'textarea': return 'paragraph';
      case 'date': case 'multi-date': case 'datetime': return 'date';
      case 'time': case 'multi-time': return 'time';
      case 'native-checkbox': case 'aria-checkbox': case 'native-select-multiple': return 'checkbox';
      case 'native-select': case 'aria-listbox': return 'dropdown';
      case 'native-range':
        return /\brat(e|ing)\b|stars?/i.test(text) ? 'rating' : 'linear_scale';
      case 'native-radio': case 'aria-radio':
        if (isNumericScale(opts)) return /\brat(e|ing)\b|stars?|★|⭐/i.test(text) ? 'rating' : 'linear_scale';
        if (opts.length && opts.every(function (o) { return /^[★☆⭐]+$/.test(o.trim()); })) return 'rating';
        return 'multiple_choice';
      default: return null;
    }
  }

  /** Smallest ancestor that holds the group and no control of another group. */
  function findContainer(g, groups, rootEl) {
    var els = g.controls.map(function (c) { return c.el; });
    var others = [];
    groups.forEach(function (o) { if (o !== g) o.controls.forEach(function (c) { others.push(c.el); }); });
    // Lowest common ancestor of the group's controls (the control itself for single-control groups).
    var node;
    if (els.length === 1) node = els[0];
    else {
      node = els[0].parentElement;
      while (node && !els.every(function (e) { return node.contains(e); })) node = node.parentElement;
    }
    if (!node || node === rootEl || node === els[0].ownerDocument.body) return els[0];   // no wrapper: the control is its own container
    function clean(n) { return n && n !== rootEl && n !== n.ownerDocument.body && !others.some(function (o) { return n.contains(o); }); }
    var preferred = node.closest && node.closest('fieldset,[role=listitem],[role=group],.question,[data-question],[data-question-id]');
    if (preferred && clean(preferred) && preferred.contains(node)) node = preferred;
    while (node.parentElement && clean(node.parentElement)) node = node.parentElement;
    return node;
  }

  function textBeforeControl(container, g) {
    var doc = container.ownerDocument, firstEl = g.controls[0].el, parts = [];
    var walker = doc.createTreeWalker(container, 4 /* SHOW_TEXT */, null);
    var n;
    while ((n = walker.nextNode())) {
      var p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|OPTION|NOSCRIPT)$/.test(p.tagName)) continue;
      if (firstEl.contains(n) || (firstEl.compareDocumentPosition(n) & 4 /* FOLLOWING */)) break;
      if (p.closest('label,[role=radio],[role=checkbox],[role=option]')) continue;
      var t = n.textContent.replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
      if (parts.join(' ').length > 300) break;
    }
    return parts.join(' ').trim();
  }

  function questionText(g, container, kind) {
    var t = '', first = g.controls[0].el, headEl;
    var fs = first.closest && first.closest('fieldset');
    if (fs && container.contains(fs) || (fs && fs.contains(container))) {
      var lg = fs.querySelector('legend'); if (lg) t = DOM.text(lg);
    }
    if (!t) {
      var heads = container.querySelectorAll(HEADING_SEL);
      for (var i = 0; i < heads.length && !t; i++) {
        headEl = heads[i];
        if (headEl.closest('label,[role=radio],[role=checkbox],[role=option]')) continue;
        if (g.controls.some(function (c) { return headEl.contains(c.el); })) continue;
        t = DOM.text(headEl);
      }
    }
    if (!t) {
      var grp = first.closest && first.closest('[role=radiogroup],[role=group],[role=listbox]');
      if (grp) t = (attr(grp, 'aria-labelledby') ? byIds(grp, attr(grp, 'aria-labelledby')) : '') || attr(grp, 'aria-label');
    }
    if (!t && g.controls.length === 1) t = labelOf(first);
    if (!t) t = textBeforeControl(container, g);
    if (!t && attr(first, 'name')) t = attr(first, 'name').replace(/[_\-\[\]]+/g, ' ').trim();
    return t.replace(/\s+/g, ' ').trim();
  }

  function isRequired(g, container, text, rawText) {
    var by = g.controls.some(function (c) { return c.el.required === true || attr(c.el, 'aria-required') === 'true' || attr(c.el, 'required') !== '' && c.el.hasAttribute && c.el.hasAttribute('required'); });
    if (by) return true;
    if (container.querySelector('[aria-label="Required question"],[aria-label="Required"],.required,.is-required,[data-required=true]')) return true;
    return /\*\s*$|\(\s*required\s*\)|\brequired\b\s*$/i.test(rawText || '') || /\s\*(\s|$)/.test(rawText || '');
  }

  function entryIdOf(container) {
    var inp = container.querySelector('input[name^="entry."],textarea[name^="entry."]');
    if (inp) return String(inp.name).replace(/_sentinel$/, '').replace(/\..*?(\d+).*$/, '.$1').replace(/^entry\./, '');
    var dp = container.querySelector('[data-params]') || (container.hasAttribute && container.hasAttribute('data-params') ? container : null);
    if (dp) { var m = attr(dp, 'data-params').match(/%\.@\.\[(\d+)/); if (m) return 'gf' + m[1]; }
    return '';
  }

  function validationOf(g) {
    var el = g.controls[0].el, v = { inputType: g.controls[0].inputType || g.controls[0].kind };
    ['pattern', 'minlength', 'maxlength', 'min', 'max', 'step'].forEach(function (a) { if (attr(el, a)) v[a] = attr(el, a); });
    if (attr(el, 'multiple') !== '' || el.multiple) v.multiple = true;
    return v;
  }

  function controlVisible(c) {
    if (DOM.isVisible(c.el)) return true;
    // Custom-styled inputs are often visually hidden while their label is visible.
    if (c.el.labels && c.el.labels.length) return Array.prototype.some.call(c.el.labels, DOM.isVisible);
    var wrap = c.el.closest && c.el.closest('label');
    return !!(wrap && DOM.isVisible(wrap));
  }

  function formTitle(doc, rootEl, loc) {
    var t = '';
    var h = rootEl.querySelector && rootEl.querySelector('h1,[role=heading][aria-level="1"]');
    if (h) t = DOM.text(h);
    if (!t) { var h1 = doc.querySelector('h1,[role=heading][aria-level="1"]'); if (h1) t = DOM.text(h1); }
    if (!t) t = attr(rootEl, 'aria-label') || attr(rootEl, 'name');
    if (!t) t = (doc.title || '').replace(/\s*-\s*Google Forms\s*$/i, '');
    return Util.cleanLabel(t || (loc && loc.hostname) || 'Untitled form');
  }

  var Reader = {
    /**
     * opts: { root, includeHidden (default false), pageIndex (section number to use when the DOM has no section containers) }
     * Returns { title, url, kind, questions, sections, signature, diagnostics }.
     */
    readForm: function (doc, opts) {
      opts = opts || {};
      var t0 = Util.mono();
      var loc = doc.defaultView.location;
      var rootEl = opts.root || doc.querySelector('form') || doc.body;
      var controls = collectControls(rootEl);
      var groups = groupControls(controls);
      var strategyCounts = { native: 0, aria: 0, 'google-listitem': 0 };

      // Section containers that actually hold controls (outermost only), in document order.
      var sectionEls = Array.prototype.filter.call(rootEl.querySelectorAll(SECTION_SEL), function (s) {
        return s !== rootEl && controls.some(function (c) { return s.contains(c.el); });
      });
      sectionEls = sectionEls.filter(function (s) { return !sectionEls.some(function (o) { return o !== s && o.contains(s); }); });

      var questions = [];
      groups.forEach(function (g) {
        var kind = primaryKind(g);
        var container = findContainer(g, groups, rootEl);
        var opts2 = kind === 'unsupported' ? [] : readOptions(g, kind);
        var raw = questionText(g, container, kind);
        var text = Util.cleanLabel(raw);
        var type = typeFor(kind, opts2, text);
        var supported = !!type;
        var vis = DOM.isVisible(container) && g.controls.some(controlVisible);
        var sIdx = 0, sTitle = '', sec = null;
        for (var i = 0; i < sectionEls.length; i++) if (sectionEls[i].contains(container)) { sIdx = i; sec = sectionEls[i]; break; }
        if (!sec) sIdx = opts.pageIndex || 0;
        if (sec) {
          sTitle = attr(sec, 'data-section-title') || attr(sec, 'aria-label');
          if (!sTitle) { var sh = sec.querySelector('h1,h2,h3,h4,h5,h6,legend,[role=heading]'); if (sh && !g.controls.some(function (c) { return sh.contains(c.el); })) sTitle = DOM.text(sh); }
        }
        var q = {
          text: text, type: type || 'unsupported', kind: kind, options: opts2, supported: supported,
          required: isRequired(g, container, text, raw), sectionIndex: sIdx, sectionTitle: Util.cleanLabel(sTitle),
          visible: vis, controls: g.controls, container: container, validation: validationOf(g),
          entryId: entryIdOf(container), detectedBy: /^aria/.test(kind) || kind === 'multi-time' && false ? 'aria' : 'native'
        };
        if (/^aria-/.test(kind)) q.detectedBy = 'aria';
        if (q.type === 'linear_scale' || q.type === 'rating') {
          var nums = opts2.map(parseFloat).filter(function (x) { return !isNaN(x); });
          q.scale = nums.length ? { min: Math.min.apply(null, nums), max: Math.max.apply(null, nums) } : null;
        }
        strategyCounts[q.detectedBy]++;
        questions.push(q);
      });

      // Strategy 3: Google Forms list items with widgets we did not understand -> report as unsupported for diagnostics.
      Array.prototype.forEach.call(rootEl.querySelectorAll('[role=listitem][data-params]'), function (li) {
        if (questions.some(function (q) { return li.contains(q.container) || q.container.contains(li); })) return;
        var h = li.querySelector('[role=heading]');
        var txt = h ? DOM.text(h) : '';
        if (!txt) return;
        strategyCounts['google-listitem']++;
        questions.push({ text: Util.cleanLabel(txt), type: 'unsupported', kind: 'unknown-widget', options: [], supported: false,
          required: !!li.querySelector('[aria-label="Required question"]'), sectionIndex: opts.pageIndex || 0, sectionTitle: '',
          visible: DOM.isVisible(li), controls: [], container: li, validation: {}, entryId: entryIdOf(li), detectedBy: 'google-listitem' });
      });

      // Stable keys; duplicates get a suffix so two identical questions stay distinguishable.
      var seen = {};
      questions.forEach(function (q, i) {
        var k = Parser.questionKey(q); seen[k] = (seen[k] || 0) + 1;
        q.key = seen[k] > 1 ? k + '#' + seen[k] : k;
        q.id = q.entryId ? 'entry.' + q.entryId : q.key;
        q.index = i;
      });

      var allQs = questions;
      var shown = opts.includeHidden ? allQs : allQs.filter(function (q) { return q.visible; });
      var sections = [];
      var idxs = {};
      allQs.forEach(function (q) { (idxs[q.sectionIndex] = idxs[q.sectionIndex] || []).push(q); });
      Object.keys(idxs).sort(function (a, b) { return a - b; }).forEach(function (k) {
        var qs = idxs[k];
        sections.push({ index: +k, title: qs[0].sectionTitle || '', questionKeys: qs.map(function (q) { return q.key; }),
          visible: qs.some(function (q) { return q.visible; }) });
      });
      var visibleKeys = allQs.filter(function (q) { return q.visible && q.supported; }).map(function (q) { return q.key; });
      return {
        title: formTitle(doc, rootEl, loc), url: loc.href,
        kind: SP.detector && SP.detector.isGoogleForm(loc) ? 'google-forms' : 'html-form',
        questions: shown, allQuestions: allQs, sections: sections,
        signature: Util.hash(visibleKeys.join('|')), visibleCount: visibleKeys.length,
        diagnostics: { strategyCounts: strategyCounts, controlCount: controls.length, groupCount: groups.length,
          sectionContainers: sectionEls.length, readMs: Util.mono() - t0 }
      };
    },

    /** Plain (serialisable) view of a question. DOM references are removed. */
    serialize: function (q) {
      return { id: q.id, key: q.key, entryId: q.entryId, text: q.text, type: q.type, kind: q.kind, options: q.options.slice(),
        required: q.required, sectionIndex: q.sectionIndex, sectionTitle: q.sectionTitle, visible: q.visible,
        supported: q.supported, validation: q.validation, detectedBy: q.detectedBy, scale: q.scale || null };
    },

    serializeResult: function (r) {
      return { title: r.title, url: r.url, kind: r.kind, questions: r.questions.map(Reader.serialize), sections: r.sections,
        signature: r.signature, visibleCount: r.visibleCount, diagnostics: r.diagnostics };
    },

    /** Diagnostic mode: maps every detected question to its DOM element(s). */
    diagnose: function (result) {
      return result.allQuestions.map(function (q) {
        return { index: q.index, key: q.key, text: q.text, type: q.type, kind: q.kind, visible: q.visible, required: q.required,
          supported: q.supported, detectedBy: q.detectedBy, section: q.sectionIndex, options: q.options.length,
          container: DOM.cssPath(q.container), controls: q.controls.slice(0, 6).map(function (c) { return DOM.cssPath(c.el); }) };
      });
    },

    highlight: function (result) {
      Reader.clearHighlights(result.allQuestions[0] && result.allQuestions[0].container.ownerDocument);
      result.allQuestions.forEach(function (q) {
        var el = q.container; if (!el || !el.style) return;
        el.setAttribute('data-sp-diag', String(q.index + 1));
        el.setAttribute('data-sp-diag-prev', el.style.outline || '');
        el.style.outline = '2px dashed ' + (q.supported ? (q.visible ? '#6d5efc' : '#9aa0b4') : '#e5484d');
        el.style.outlineOffset = '2px';
      });
    },

    clearHighlights: function (doc) {
      doc = doc || root.document;
      Array.prototype.forEach.call(doc.querySelectorAll('[data-sp-diag]'), function (el) {
        el.style.outline = el.getAttribute('data-sp-diag-prev') || ''; el.style.outlineOffset = '';
        el.removeAttribute('data-sp-diag'); el.removeAttribute('data-sp-diag-prev');
      });
    }
  };

  SP.reader = Reader;
})(typeof globalThis !== 'undefined' ? globalThis : self);
