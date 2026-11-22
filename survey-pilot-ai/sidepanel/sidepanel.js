/* SurveyPilot AI - side panel UI. All page-derived text is inserted with textContent (never innerHTML). */
(function () {
  'use strict';
  var SP = window.SP, Util = SP.Util, Parser = SP.Parser, Gen = SP.RespondentGen, AnswerGen = SP.AnswerGen,
    Storage = SP.Storage, Stats = SP.Stats, Exp = SP.Export;

  var S = {
    view: 'auto', auto: { count: null, authorised: false, busy: '' }, tab: null, detection: null, scanError: '', survey: null, respondents: [], selected: new Set(), settings: null,
    run: null, records: [], mode: 'preview', destination: null, diag: null, genConfig: null, gen: null, openRespondent: null,
    openRecord: null, filters: { text: '', source: 'all', region: 'all', selectedOnly: false }, logFilter: { level: 'all', text: '', respondent: '' },
    fillResult: null, previewId: '', loading: true, fatal: '', scanning: false, busy: {}
  };

  /* ---------------- tiny DOM helpers ---------------- */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open') el[k] = !!v;
      else if (k === 'style') el.setAttribute('style', v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(function (x) { append(el, x); });
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function toast(msg, kind) {
    var t = h('div', { class: 'toast ' + (kind || ''), role: 'status' }, msg);
    $('#toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'err' ? 7000 : 3200);
  }
  function banner(msg, kind) {
    var b = $('#banner'); clear(b);
    if (msg) b.appendChild(h('div', { class: 'banner ' + (kind || 'err'), role: 'alert' }, msg));
  }
  function confirmDialog(message, o) {
    o = o || {};
    return new Promise(function (resolve) {
      var d = $('#dialog'); clear(d);
      d.appendChild(h('div', { class: 'stack' },
        h('h2', {}, o.title || 'Please confirm'), h('p', { style: 'margin:0' }, message),
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { class: 'btn', onclick: function () { d.close('no'); } }, 'Cancel'),
          h('button', { class: 'btn ' + (o.danger ? 'danger' : 'primary'), onclick: function () { d.close('yes'); } }, o.confirmText || 'Confirm'))));
      d.onclose = function () { resolve(d.returnValue === 'yes'); };
      d.showModal();
    });
  }

  /* ---------------- extension plumbing ---------------- */
  function cmd(name, payload) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(Object.assign({ sp: 'cmd', cmd: name }, payload || {}), function (res) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('The background service did not answer. Reload the extension from chrome://extensions.'));
        if (!res.ok) { var e = new Error(res.error || 'Command failed'); e.code = res.code; return reject(e); }
        resolve(res);
      });
    });
  }
  function tabSend(message) {
    if (!S.tab) return Promise.reject(new Error('No active tab.'));
    return cmd('tab.send', { tabId: S.tab.id, message: message }).then(function (r) {
      if (!r.response) throw new Error('The page did not answer. Reload the page and try again.');
      if (!r.response.ok) throw new Error(r.response.error || 'The page reported an error.');
      return r.response;
    });
  }
  function isScriptable(url) { return /^(https?|file):/i.test(url || '') && !/^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/i.test(url); }
  function guard(fn) {
    return function () {
      var a = arguments;
      return Promise.resolve().then(function () { return fn.apply(null, a); }).catch(function (err) { toast(err.message, 'err'); console.error(err); });
    };
  }

  /* ---------------- data loading ---------------- */
  async function loadSettings() { S.settings = await Storage.getSettings(); applyTheme(); S.genConfig = Gen.normalizeConfig(S.settings.generatorConfig || { count: S.settings.defaultRespondentCount }); }
  async function loadRespondents() { S.respondents = await Storage.listRespondents(); var ids = {}; S.respondents.forEach(function (r) { ids[r.id] = true; }); S.selected.forEach(function (id) { if (!ids[id]) S.selected.delete(id); }); }
  async function loadSurvey() {
    S.survey = null;
    if (S.tab && S.tab.url) S.survey = (await Storage.get('surveys', Parser.surveyId(S.tab.url))) || null;
    if (!S.survey && S.destination) S.survey = (await Storage.get('surveys', S.destination.surveyId)) || null;
  }
  async function loadRun() {
    var runs = await Storage.getAll('runs');
    runs.sort(function (a, b) { return b.startedAt - a.startedAt; });
    var active = runs.filter(function (r) { return r.status === 'running' || r.status === 'paused'; })[0];
    S.run = active || runs[0] || null;
    S.records = S.run ? await Storage.listRunRecords(S.run.id) : [];
    if (S.run && (S.run.status === 'running' || S.run.status === 'paused') && !S.destination) {
      S.destination = { tabId: S.run.tabId, url: S.run.destinationUrl, key: S.run.destinationKey, surveyId: S.run.surveyId, confirmedAt: S.run.confirmedAt };
    }
  }
  async function refreshTab() {
    var tabs = await new Promise(function (res) { chrome.tabs.query({ active: true, currentWindow: true }, res); });
    var t = tabs && tabs[0];
    var changed = !S.tab || !t || S.tab.id !== t.id || S.tab.url !== t.url;
    S.tab = t ? { id: t.id, url: t.url, title: t.title } : null;
    if (changed) { S.detection = null; S.scanError = ''; S.diag = null; await loadSurvey(); }
    return changed;
  }

  function applyTheme() {
    var t = S.settings ? S.settings.theme : 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  /* ---------------- scanning ---------------- */
  async function scan() {
    S.scanning = true; S.scanError = ''; render();
    try {
      await refreshTab();
      if (!S.tab) throw new Error('No active tab to scan.');
      if (!isScriptable(S.tab.url)) throw new Error('This page cannot be scanned (browser-internal or store pages are blocked). Open your survey form in a normal tab.');
      var d = (await tabSend({ type: 'detect' })).detection;
      S.detection = d;
      if (d.status === 'unsupported') { S.survey = null; return; }
      var f = (await tabSend({ type: 'read', includeHidden: true, force: true })).form;
      var existing = await Storage.get('surveys', Parser.surveyId(f.url));
      S.survey = Parser.buildSurvey({ url: f.url, title: f.title, kind: f.kind, questions: f.questions.filter(function (q) { return q.supported; }) }, existing);
      await Storage.put('surveys', S.survey);
      toast('Read ' + S.survey.questions.length + ' question(s).', 'ok');
    } catch (err) {
      S.scanError = err.message; S.detection = null;
      if (/Receiving end|Could not establish/i.test(err.message)) S.scanError = 'The page has no SurveyPilot script yet. Reload the tab and scan again (file:// pages also need "Allow access to file URLs").';
    } finally { S.scanning = false; render(); }
  }

  /* ---------------- views: Survey ---------------- */
  function statusChip(d) {
    if (!d) return h('span', { class: 'chip' }, 'Not scanned');
    var map = { supported: ['ok', 'Supported'], partial: ['warn', 'Partially supported'], unsupported: ['err', 'Unsupported'] };
    var m = map[d.status] || ['', d.status];
    return h('span', { class: 'chip ' + m[0] }, m[1]);
  }
  var TYPE_NAMES = { short_answer: 'Short answer', paragraph: 'Paragraph', multiple_choice: 'Multiple choice', checkbox: 'Checkbox', dropdown: 'Dropdown', linear_scale: 'Linear scale', rating: 'Rating', date: 'Date', time: 'Time' };

  function viewSurvey(root) {
    var d = S.detection;
    root.appendChild(h('div', { class: 'card stack' },
      h('div', { class: 'row spread' }, h('h2', {}, 'Active page'), statusChip(d)),
      h('div', {}, h('div', { style: 'font-weight:600' }, S.tab ? (S.tab.title || '(untitled)') : 'No tab'), h('div', { class: 'small muted mono', style: 'word-break:break-all' }, S.tab ? S.tab.url : '')),
      S.scanError ? h('div', { class: 'banner err', role: 'alert' }, S.scanError) : null,
      d && d.status === 'unsupported' ? h('div', { class: 'banner err', role: 'alert' }, 'Unsupported: ' + d.reason) : null,
      d && d.status === 'partial' ? h('div', { class: 'banner warn' }, d.reason) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary grow', disabled: S.scanning, onclick: guard(scan) }, S.scanning ? [h('span', { class: 'spinner' }), ' Scanning…'] : 'Scan this form'),
        h('button', { class: 'btn', disabled: !d || d.status === 'unsupported', title: 'Outline every detected question on the page', onclick: guard(toggleDiagnostics) }, S.diag ? 'Hide diagnostics' : 'Diagnostics'))));

    if (d && d.status !== 'unsupported') {
      root.appendChild(h('div', { class: 'card stack' },
        h('h2', {}, d.title || 'Untitled form'),
        h('div', { class: 'kv' },
          h('div', { class: 'k' }, 'Kind'), h('div', {}, d.kind === 'google-forms' ? 'Google Forms' : 'Standard HTML form'),
          h('div', { class: 'k' }, 'Questions'), h('div', {}, String(d.questionCount)),
          h('div', { class: 'k' }, 'Sections'), h('div', {}, String(d.sectionCount) + (d.kind === 'google-forms' ? ' (only the visible page is readable)' : '')),
          h('div', { class: 'k' }, 'Required'), h('div', {}, String(d.requiredCount)),
          h('div', { class: 'k' }, 'Unsupported'), h('div', {}, String(d.unsupportedCount))),
        h('div', { class: 'row wrap' }, Object.keys(d.types).map(function (t) { return h('span', { class: 'chip' }, (TYPE_NAMES[t] || t) + ' · ' + d.types[t]); }))));
    }

    if (S.diag) {
      root.appendChild(h('div', { class: 'card stack' },
        h('div', { class: 'row spread' }, h('h2', {}, 'Diagnostics'), h('span', { class: 'chip' }, S.diag.items.length + ' elements')),
        h('div', { class: 'small muted' }, 'Detection strategies: native ' + S.diag.strategy.strategyCounts.native + ', ARIA ' + S.diag.strategy.strategyCounts.aria + ', Google list items ' + S.diag.strategy.strategyCounts['google-listitem'] + ' · ' + S.diag.strategy.readMs.toFixed(1) + ' ms'),
        S.diag.items.map(function (q) {
          return h('div', { class: 'qrow' },
            h('div', { class: 'row spread' }, h('span', { class: 't' }, (q.index + 1) + '. ' + (q.text || '(no label found)')),
              h('span', { class: 'chip ' + (q.supported ? '' : 'err') }, q.supported ? (TYPE_NAMES[q.type] || q.type) : 'unsupported')),
            h('div', { class: 'small muted mono' }, 'via ' + q.detectedBy + ' · ' + (q.visible ? 'visible' : 'hidden') + ' · section ' + (q.section + 1) + ' · ' + q.container),
            h('div', { class: 'small muted mono' }, q.controls.join('  |  ')));
        })));
    }

    if (S.survey && S.survey.questions.length) {
      root.appendChild(h('div', { class: 'card' },
        h('div', { class: 'row spread' }, h('h2', {}, 'Questions'), h('span', { class: 'chip' }, S.survey.questions.length + ' stored')),
        S.survey.questions.map(function (q, i) {
          return h('div', { class: 'qrow' },
            h('div', { class: 'row spread' }, h('span', { class: 't' }, (i + 1) + '. ' + q.text), q.required ? h('span', { class: 'chip err' }, 'required') : null),
            h('div', { class: 'small muted' }, (TYPE_NAMES[q.type] || q.type) + ' · section ' + ((q.sectionIndex || 0) + 1) + (q.sectionTitle ? ' (' + q.sectionTitle + ')' : '') + (q.options.length ? ' · ' + q.options.length + ' options' : '')));
        })));
    } else if (!S.scanning && !d) {
      root.appendChild(h('div', { class: 'card empty' }, h('div', { class: 'big' }, '🧭'), h('div', {}, 'Open your own survey or test form in this tab, then press "Scan this form".'),
        h('div', { class: 'small' }, 'SurveyPilot reads questions locally and never sends page content anywhere unless you enable AI mode.')));
    }
  }

  async function toggleDiagnostics() {
    if (S.diag) { await tabSend({ type: 'clearHighlights' }); S.diag = null; return render(); }
    var r = await tabSend({ type: 'diagnose', highlight: true });
    S.diag = { items: r.diagnostics, strategy: r.strategy }; render();
  }

  /* ---------------- generation ---------------- */
  async function genOptions() {
    var key = await Storage.getApiKey();
    return { mode: S.settings.mode, settings: { apiKey: key, model: S.settings.model, language: S.settings.language, aiRetries: S.settings.aiRetries, aiTimeoutMs: S.settings.aiTimeoutMs, autoFallback: S.settings.autoFallback } };
  }

  async function answersFor(profile, questions, opts) {
    if (!questions.length) return { answers: {}, source: 'local', warnings: [], ms: 0 };
    return AnswerGen.generate({ mode: opts.mode, profile: profile, questions: questions, settings: opts.settings });
  }

  async function generateRespondents(count) {
    if (S.gen) return;
    var cfg = S.genConfig; cfg.count = count;
    S.settings.generatorConfig = cfg;
    await Storage.setSettings({ generatorConfig: cfg });
    var start = S.respondents.reduce(function (m, r) { return Math.max(m, (r.index || 0) + 1); }, 0);
    var profiles = Gen.generateMany(cfg, count, start);
    var opts = await genOptions(), questions = S.survey ? S.survey.questions : [];
    S.gen = { done: 0, total: count, warnings: [] }; render();
    var made = [], batch = Math.max(1, S.settings.defaultBatchSize | 0), t0 = Util.mono();
    try {
      for (var i = 0; i < profiles.length; i += batch) {
        var slice = profiles.slice(i, i + batch);
        for (var j = 0; j < slice.length; j++) {
          var p = slice[j], tg = Util.mono();
          var res = await answersFor(p, questions, opts);
          var rec = { id: p.id, index: p.index, surveyId: S.survey ? S.survey.id : '', profile: p, answers: res.answers, source: res.source, createdAt: Util.now(), generationMs: Util.mono() - tg };
          var errs = Gen.validateProfile(p);
          if (errs.length) throw new Error('Generated profile ' + p.id + ' is inconsistent: ' + errs[0]);
          made.push(rec); S.gen.done++; res.warnings.forEach(function (w) { if (S.gen.warnings.indexOf(w) < 0) S.gen.warnings.push(w); });
        }
        await Storage.putMany('respondents', made.slice(i, i + slice.length));
        render();
      }
      toast('Generated ' + made.length + ' synthetic respondent(s) in ' + Util.formatDuration(Util.mono() - t0) + '.', 'ok');
      if (S.gen.warnings.length) toast(S.gen.warnings[0], 'err');
    } catch (err) {
      await Storage.putMany('respondents', made);   // keep everything generated so far (partial generation)
      toast('Generation stopped after ' + made.length + ' of ' + count + ': ' + err.message, 'err');
    } finally { S.gen = null; await loadRespondents(); render(); }
  }

  /* ---------------- views: Respondents ---------------- */
  function parseAgeRanges(text) {
    var out = [];
    String(text).split(',').forEach(function (part) {
      var m = part.trim().match(/^(\d+)\s*-\s*(\d+)(?:\s*:\s*(\d+(?:\.\d+)?))?$/);
      if (m) out.push({ min: +m[1], max: +m[2], weight: m[3] ? +m[3] : 1 });
    });
    return out;
  }
  function formatAgeRanges(r) { return r.map(function (x) { return x.min + '-' + x.max + ':' + x.weight; }).join(', '); }

  function slider(label, key, obj, hint) {
    var out = h('output', { class: 'small muted' }, String(Math.round(obj[key] * 100)) + '%');
    return h('label', { class: 'field' }, h('span', { class: 'row spread' }, label, out),
      h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: obj[key], oninput: function (e) { obj[key] = +e.target.value; out.textContent = Math.round(obj[key] * 100) + '%'; } }),
      hint ? h('span', { class: 'hint' }, hint) : null);
  }
  function numField(label, obj, key, o) {
    o = o || {};
    return h('label', { class: 'field' }, label, h('input', { type: 'number', min: o.min, max: o.max, step: o.step || 1, value: obj[key], oninput: function (e) { obj[key] = +e.target.value; } }));
  }

  function generatorCard() {
    var c = S.genConfig;
    var geo = { urban: 0, suburban: 0, rural: 0 };
    c.geoProfiles.forEach(function (g) { geo[g.name] = g.weight; });
    function geoField(name, label) {
      return h('label', { class: 'field' }, label, h('input', { type: 'number', min: 0, value: geo[name], oninput: function (e) {
        geo[name] = Math.max(0, +e.target.value || 0);
        var list = ['urban', 'suburban', 'rural'].filter(function (n) { return geo[n] > 0; }).map(function (n) { return { name: n, weight: geo[n] }; });
        c.geoProfiles = list.length ? list : [{ name: 'urban', weight: 1 }];
      } }));
    }
    var ageInput = h('input', { type: 'text', value: formatAgeRanges(c.ageRanges), onchange: function (e) {
      var r = parseAgeRanges(e.target.value);
      if (!r.length) { toast('Age ranges look like "18-24:25, 25-34:30" (min-max:weight, minimum age 16).', 'err'); e.target.value = formatAgeRanges(c.ageRanges); return; }
      c.ageRanges = r; e.target.value = formatAgeRanges(r);
    } });
    var countInput = h('input', { type: 'number', min: 1, max: 500, value: c.count || S.settings.defaultRespondentCount });
    var occSet = {}; c.occupations.forEach(function (o) { occSet[o.name] = o.weight; });
    var mode = S.settings.mode;
    return h('details', { class: 'card', open: !S.respondents.length },
      h('summary', {}, 'Generate respondents'),
      h('div', { class: 'stack', style: 'margin-top:10px' },
        h('div', { class: 'banner info' }, 'All respondents are synthetic: fictional names, example.com emails and 555-01xx phone numbers.'),
        h('div', { class: 'row spread' }, h('span', { class: 'chip ' + (mode === 'ai' ? 'accent' : '') }, mode === 'ai' ? 'AI mode (' + S.settings.model + ')' : 'Local mode (offline)'), h('button', { class: 'btn sm', onclick: function () { chrome.runtime.openOptionsPage(); } }, 'Change mode')),
        S.survey ? h('div', { class: 'small muted' }, 'Answers will be generated for the ' + S.survey.questions.length + ' scanned question(s).') : h('div', { class: 'banner warn' }, 'No survey scanned yet: profiles are created now and answers are generated when each section is read during Fill or Test.'),
        h('label', { class: 'field' }, 'Number of respondents', countInput),
        h('label', { class: 'field' }, 'Age ranges', ageInput, h('span', { class: 'hint' }, 'min-max:weight, comma separated')),
        h('div', { class: 'grid2' },
          numField('Female %', c.genderDist, 'female', { min: 0 }), numField('Male %', c.genderDist, 'male', { min: 0 }),
          numField('Non-binary %', c.genderDist, 'nonbinary', { min: 0 }), numField('Undisclosed %', c.genderDist, 'undisclosed', { min: 0 })),
        h('div', { class: 'field' }, h('span', {}, 'Occupations'), h('div', { class: 'row wrap' }, Gen.OCCUPATIONS.map(function (o) {
          return h('label', { class: 'chip', style: 'cursor:pointer' }, h('input', { type: 'checkbox', checked: o.name in occSet, onchange: function (e) {
            c.occupations = c.occupations.filter(function (x) { return x.name !== o.name; });
            if (e.target.checked) c.occupations.push({ name: o.name, weight: o.w });
            if (!c.occupations.length) { c.occupations = [{ name: o.name, weight: o.w }]; e.target.checked = true; toast('At least one occupation is required.', 'err'); }
          } }), ' ' + o.name);
        }))),
        slider('Student share', 'studentShare', c, 'Only applied to ages that plausibly study (under ~35).'),
        h('div', { class: 'grid2' }, geoField('urban', 'Urban weight'), geoField('suburban', 'Suburban weight')),
        geoField('rural', 'Rural weight'),
        slider('Uses the bus', 'busUseShare', c.travel), slider('Uses a car', 'carUseShare', c.travel), slider('Cycles', 'bikeShare', c.travel), slider('Daily commuters (among bus users)', 'dailyCommuterShare', c.travel),
        slider('Response variation', 'responseVariation', c), slider('Randomization', 'randomization', c), slider('Consistency', 'consistency', c, 'Higher = answers follow the profile more tightly. Hard rules (e.g. non bus users never report bus use) always apply.'),
        h('label', { class: 'field' }, 'Answer language', h('select', { onchange: function (e) { c.language = e.target.value; S.settings.language = e.target.value; Storage.setSettings({ language: e.target.value }); } },
          [['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch']].map(function (l) { return h('option', { value: l[0], selected: c.language === l[0] || S.settings.language === l[0] }, l[1]); }))),
        h('label', { class: 'field' }, 'Seed (optional, for reproducible sets)', h('input', { type: 'number', value: c.seed == null ? '' : c.seed, placeholder: 'random', oninput: function (e) { c.seed = e.target.value === '' ? null : +e.target.value; } })),
        h('button', { class: 'btn primary', disabled: !!S.gen, onclick: guard(function () {
          var n = Util.clamp(parseInt(countInput.value, 10) || 0, 1, 500);
          S.genConfig = Gen.normalizeConfig(Object.assign({}, c, { count: n }));
          return generateRespondents(n);
        }) }, S.gen ? [h('span', { class: 'spinner' }), ' Generating ' + S.gen.done + '/' + S.gen.total] : 'Generate')));
  }

  function filteredRespondents() {
    var f = S.filters, t = f.text.trim().toLowerCase();
    return S.respondents.filter(function (r) {
      var p = r.profile;
      if (f.source !== 'all' && r.source !== f.source) return false;
      if (f.region !== 'all' && p.region !== f.region) return false;
      if (f.selectedOnly && !S.selected.has(r.id)) return false;
      if (t) {
        var hay = [r.id, p.name, p.occupation, p.gender, p.regionLabel, p.ageGroup, String(p.age), p.travel.busFrequency].join(' ').toLowerCase();
        if (hay.indexOf(t) < 0) return false;
      }
      return true;
    });
  }

  function respCard(r) {
    var p = r.profile, sel = S.selected.has(r.id);
    return h('div', { class: 'respcard' + (sel ? ' sel' : ''), role: 'button', tabindex: 0, onclick: function (e) { if (e.target.tagName === 'INPUT') return; S.openRespondent = r.id; render(); },
      onkeydown: function (e) { if (e.key === 'Enter') { S.openRespondent = r.id; render(); } } },
      h('input', { type: 'checkbox', checked: sel, 'aria-label': 'Select ' + r.id, onchange: function (e) { if (e.target.checked) S.selected.add(r.id); else S.selected.delete(r.id); renderRespondentList(); updateSelCount(); } }),
      h('div', { class: 'grow' },
        h('div', { class: 'row spread' }, h('strong', {}, r.id), h('span', { class: 'chip synthetic tag-synth' }, 'synthetic · ' + r.source)),
        h('div', {}, p.age + ' · ' + p.gender + ' · ' + p.occupation),
        h('div', { class: 'small muted' }, p.regionLabel + ' · bus: ' + p.travel.busFrequency + ' · main: ' + p.travel.mainMode + ' · ' + Object.keys(r.answers || {}).length + ' answers')));
  }

  function updateSelCount() { var el = $('#selcount'); if (el) el.textContent = S.selected.size + ' selected'; }

  function renderRespondentList() {
    var box = $('#resplist'); if (!box) return;
    clear(box);
    var list = filteredRespondents();
    if (!S.respondents.length) box.appendChild(h('div', { class: 'empty' }, h('div', { class: 'big' }, '👥'), h('div', {}, 'No respondents yet. Generate some above.')));
    else if (!list.length) box.appendChild(h('div', { class: 'empty' }, 'No respondents match the current search or filters.'));
    else list.slice(0, 200).forEach(function (r) { box.appendChild(respCard(r)); });
    if (list.length > 200) box.appendChild(h('div', { class: 'small muted' }, 'Showing 200 of ' + list.length + '. Refine the search to see others.'));
    var cnt = $('#listcount'); if (cnt) cnt.textContent = list.length + ' of ' + S.respondents.length;
  }

  function viewRespondents(root) {
    if (S.openRespondent) return viewRespondentDetail(root);
    root.appendChild(generatorCard());
    if (S.gen) root.appendChild(h('div', { class: 'card stack' }, h('div', { class: 'row spread' }, h('strong', {}, 'Generating…'), h('span', { class: 'small muted' }, S.gen.done + ' / ' + S.gen.total)),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': S.gen.done, 'aria-valuemax': S.gen.total }, h('div', { style: 'width:' + (100 * S.gen.done / S.gen.total) + '%' }))));
    var regions = ['all', 'urban', 'suburban', 'rural'];
    root.appendChild(h('div', { class: 'card stack' },
      h('div', { class: 'row spread' }, h('h2', {}, 'Respondents'), h('span', { class: 'small muted' }, h('span', { id: 'listcount' }, ''), ' · ', h('span', { id: 'selcount' }, S.selected.size + ' selected'))),
      h('input', { type: 'search', placeholder: 'Search by ID, occupation, gender, area…', value: S.filters.text, oninput: function (e) { S.filters.text = e.target.value; renderRespondentList(); } }),
      h('div', { class: 'grid2' },
        h('select', { 'aria-label': 'Filter by source', onchange: function (e) { S.filters.source = e.target.value; renderRespondentList(); } }, ['all', 'local', 'ai', 'mixed'].map(function (v) { return h('option', { value: v, selected: S.filters.source === v }, v === 'all' ? 'Any source' : 'Source: ' + v); })),
        h('select', { 'aria-label': 'Filter by area', onchange: function (e) { S.filters.region = e.target.value; renderRespondentList(); } }, regions.map(function (v) { return h('option', { value: v, selected: S.filters.region === v }, v === 'all' ? 'Any area' : 'Area: ' + v); }))),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: S.filters.selectedOnly, onchange: function (e) { S.filters.selectedOnly = e.target.checked; renderRespondentList(); } }), 'Show selected only'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn sm', onclick: function () { filteredRespondents().forEach(function (r) { S.selected.add(r.id); }); renderRespondentList(); updateSelCount(); } }, 'Select shown'),
        h('button', { class: 'btn sm', onclick: function () { S.selected.clear(); renderRespondentList(); updateSelCount(); } }, 'Clear selection'),
        h('button', { class: 'btn sm danger', onclick: guard(deleteSelected) }, 'Delete selected'),
        h('button', { class: 'btn sm', disabled: !S.respondents.length, onclick: function () { exportRespondents('csv'); } }, 'Export CSV'),
        h('button', { class: 'btn sm', disabled: !S.respondents.length, onclick: function () { exportRespondents('json'); } }, 'Export JSON')),
      h('div', { class: 'stack', id: 'resplist' })));
    renderRespondentList();
  }

  async function deleteSelected() {
    var ids = Array.from(S.selected);
    if (!ids.length) return toast('Select respondents first.', 'err');
    if (!(await confirmDialog('Delete ' + ids.length + ' respondent(s)? This cannot be undone.', { danger: true, confirmText: 'Delete', title: 'Delete respondents' }))) return;
    await Storage.deleteMany('respondents', ids); S.selected.clear(); await loadRespondents(); render(); toast('Deleted ' + ids.length + ' respondent(s).', 'ok');
  }

  function answerEditor(q, r, draft) {
    var cur = draft[q.key], label = h('div', { class: 't' }, q.text + (q.required ? ' *' : ''));
    var body;
    if (q.type === 'checkbox') {
      var set = Array.isArray(cur) ? cur : [];
      body = h('div', {}, q.options.map(function (o) { return h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: set.indexOf(o) >= 0, onchange: function (e) {
        var arr = Array.isArray(draft[q.key]) ? draft[q.key].slice() : [];
        if (e.target.checked) arr.push(o); else arr = arr.filter(function (x) { return x !== o; });
        draft[q.key] = arr.length ? arr : null;
      } }), o); }));
    } else if (q.type === 'multiple_choice' || q.type === 'linear_scale' || q.type === 'rating' || q.type === 'dropdown') {
      body = h('select', { onchange: function (e) { draft[q.key] = e.target.value === '' ? null : e.target.value; } }, [h('option', { value: '' }, q.required ? '(no answer)' : '(skip)')].concat(q.options.map(function (o) { return h('option', { value: o, selected: cur === o }, o); })));
    } else if (q.type === 'paragraph') {
      body = h('textarea', { oninput: function (e) { draft[q.key] = e.target.value || null; } }, cur || '');
    } else {
      body = h('input', { type: q.type === 'date' ? 'date' : q.type === 'time' ? 'time' : 'text', value: cur || '', oninput: function (e) { draft[q.key] = e.target.value || null; } });
    }
    return h('div', { class: 'answer-edit' }, label, body);
  }

  function viewRespondentDetail(root) {
    var r = S.respondents.filter(function (x) { return x.id === S.openRespondent; })[0];
    if (!r) { S.openRespondent = null; return viewRespondents(root); }
    var p = r.profile, draft = Util.clone(r.answers || {});
    var qs = S.survey ? S.survey.questions : [];
    var missing = qs.filter(function (q) { return !(q.key in (r.answers || {})); });
    root.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: function () { S.openRespondent = null; render(); } }, '← Back'), h('span', { class: 'chip synthetic' }, 'Synthetic data – not a real person')));
    root.appendChild(h('div', { class: 'card stack' },
      h('h2', {}, r.id + ' — ' + p.name),
      h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'Age / gender'), h('div', {}, p.age + ' (' + p.ageGroup + ') · ' + p.gender),
        h('div', { class: 'k' }, 'Occupation'), h('div', {}, p.occupation + (p.isStudent ? ' · student' : '')),
        h('div', { class: 'k' }, 'Education / income'), h('div', {}, p.education + ' · ' + p.incomeBand),
        h('div', { class: 'k' }, 'Area'), h('div', {}, p.regionLabel),
        h('div', { class: 'k' }, 'Bus'), h('div', {}, p.travel.usesBus ? 'uses the bus (' + p.travel.busFrequency + ')' : 'does not use the bus'),
        h('div', { class: 'k' }, 'Other travel'), h('div', {}, 'modes: ' + p.travel.modes.join(', ') + ' · main: ' + p.travel.mainMode + ' · ~' + p.travel.tripsPerWeek + ' trips/week'),
        h('div', { class: 'k' }, 'Contact (fictional)'), h('div', { class: 'mono' }, p.email + ' · ' + p.phone),
        h('div', { class: 'k' }, 'Source'), h('div', {}, r.source + (r.generationMs ? ' · generated in ' + Util.formatDuration(r.generationMs) : ''))),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn sm', onclick: guard(function () { return regenerate(r); }) }, 'Regenerate'),
        h('button', { class: 'btn sm', onclick: guard(function () { return duplicate(r); }) }, 'Duplicate'),
        h('button', { class: 'btn sm', onclick: function () { if (S.selected.has(r.id)) S.selected.delete(r.id); else S.selected.add(r.id); render(); } }, S.selected.has(r.id) ? 'Unselect for testing' : 'Select for testing'),
        h('button', { class: 'btn sm danger', onclick: guard(function () { return deleteOne(r); }) }, 'Delete'))));
    var card = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Answers'), missing.length ? h('button', { class: 'btn sm', onclick: guard(function () { return fillMissing(r); }) }, 'Generate ' + missing.length + ' missing') : null));
    if (!qs.length) card.appendChild(h('div', { class: 'empty' }, 'Scan a form (Survey tab) to see and edit answers by question.'));
    qs.forEach(function (q) { card.appendChild(answerEditor(q, r, draft)); });
    root.appendChild(card);
    if (qs.length) root.appendChild(h('div', { class: 'sticky-actions' }, h('button', { class: 'btn primary', style: 'width:100%', onclick: guard(async function () {
      var problems = Local().checkConsistency(p, qs, draftClean(draft));
      var req = qs.filter(function (q) { return q.required && (draft[q.key] == null || (Array.isArray(draft[q.key]) && !draft[q.key].length)); });
      if (req.length) return toast('Required question without an answer: "' + req[0].text + '"', 'err');
      if (problems.length && !(await confirmDialog('These edits contradict the profile:\n' + problems.slice(0, 3).join('\n') + '\nSave anyway?', { title: 'Inconsistent answers' }))) return;
      r.answers = draftClean(draft); r.source = r.source === 'ai' ? 'mixed' : r.source; r.editedAt = Util.now();
      await Storage.put('respondents', r); toast('Answers saved.', 'ok');
    }) }, 'Save answers')));
  }
  function Local() { return AnswerGen.Local; }
  function draftClean(d) { var o = {}; Object.keys(d).forEach(function (k) { if (d[k] != null) o[k] = d[k]; }); return o; }

  async function regenerate(r) {
    var seed = Math.floor(Math.random() * 2147483647);
    var p = Gen.generate(S.genConfig, r.index, seed); p.id = r.id;
    var opts = await genOptions(), t0 = Util.mono();
    var res = await answersFor(p, S.survey ? S.survey.questions : [], opts);
    Object.assign(r, { profile: p, answers: res.answers, source: res.source, generationMs: Util.mono() - t0, editedAt: null });
    await Storage.put('respondents', r); render(); toast('Respondent regenerated.', 'ok');
  }
  async function duplicate(r) {
    var idx = S.respondents.reduce(function (m, x) { return Math.max(m, (x.index || 0) + 1); }, 0);
    var copy = Util.clone(r); copy.index = idx; copy.id = 'SYN-' + String(idx + 1).padStart(4, '0'); copy.profile.id = copy.id; copy.profile.index = idx; copy.profile.name = r.profile.name; copy.createdAt = Util.now(); copy.duplicateOf = r.id;
    await Storage.put('respondents', copy); await loadRespondents(); S.openRespondent = copy.id; render(); toast('Duplicated as ' + copy.id + '.', 'ok');
  }
  async function deleteOne(r) {
    if (!(await confirmDialog('Delete ' + r.id + '?', { danger: true, confirmText: 'Delete' }))) return;
    await Storage.delete('respondents', r.id); S.selected.delete(r.id); S.openRespondent = null; await loadRespondents(); render();
  }
  async function fillMissing(r) {
    var missing = S.survey.questions.filter(function (q) { return !(q.key in r.answers); });
    var res = await answersFor(r.profile, missing, await genOptions());
    r.answers = Object.assign({}, r.answers, res.answers); await Storage.put('respondents', r); render();
    toast('Generated ' + missing.length + ' answer(s) via ' + res.source + '.', 'ok');
  }

  /* ---------------- exports ---------------- */
  function fname(ext, part) { return (S.settings.exportFilenamePrefix || 'surveypilot') + '-' + part + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.' + ext; }
  function exportRespondents(kind) {
    var list = S.selected.size ? S.respondents.filter(function (r) { return S.selected.has(r.id); }) : S.respondents;
    if (kind === 'csv') Exp.download(fname('csv', 'respondents'), Exp.respondentsToCSV(list, S.survey, { delimiter: S.settings.csvDelimiter, includeProfile: S.settings.exportIncludeProfile }), 'text/csv');
    else Exp.download(fname('json', 'respondents'), JSON.stringify({ synthetic: true, exportedAt: new Date().toISOString(), respondents: list }, null, 2), 'application/json');
    toast('Exported ' + list.length + ' respondent(s)' + (S.selected.size ? ' (selection only)' : '') + '.', 'ok');
  }

  /* ---------------- views: Run ---------------- */
  /* ---------------- views: Auto (one-click everything) ---------------- */
  async function autoStart(n) {
    var A = S.auto;
    try {
      A.busy = 'Reading the form…'; render();
      await refreshTab();
      if (!S.tab || !isScriptable(S.tab.url)) throw new Error('Open your survey form in the active tab first.');
      await scan();
      if (!S.detection || S.detection.status === 'unsupported') throw new Error(S.scanError || (S.detection ? S.detection.reason : 'No survey was detected on this page.'));
      if (S.survey && S.survey.questions.some(function (q) { return q.required && !q.type; })) throw new Error('A required question has an unknown type.');
      A.busy = 'Generating ' + n + ' synthetic respondent(s)…'; render();
      var before = {}; S.respondents.forEach(function (r) { before[r.id] = true; });
      await generateRespondents(n);
      var fresh = S.respondents.filter(function (r) { return !before[r.id]; });
      if (!fresh.length) throw new Error('No respondents could be generated. See the message above, or switch to Local mode in Settings.');
      A.busy = 'Starting…'; render();
      var dest = { tabId: S.tab.id, url: S.tab.url, key: currentKey(), surveyId: S.survey ? S.survey.id : Parser.surveyId(S.tab.url), confirmedAt: Util.now() };
      S.destination = dest;
      await cmd('run.start', { options: { tabId: dest.tabId, destinationUrl: dest.url, destinationConfirmed: true, confirmedAt: dest.confirmedAt, surveyId: dest.surveyId, respondentIds: fresh.map(function (r) { return r.id; }), mode: S.settings.mode } });
      await loadRun();
      toast('Auto run started with ' + fresh.length + ' respondent(s).', 'ok');
    } finally { A.busy = ''; render(); }
  }

  function viewAuto(root) {
    var A = S.auto, active = runActive(), d = S.detection;
    if (A.count == null) A.count = S.settings.defaultRespondentCount || 10;
    var count = h('input', { type: 'number', min: 1, max: 500, value: A.count, disabled: active || !!A.busy, oninput: function (e) { A.count = Util.clamp(parseInt(e.target.value, 10) || 1, 1, 500); } });
    var mode = S.settings.mode === 'ai' ? 'AI answers (' + S.settings.model + ', falls back to local if it fails)' : 'Local answers (offline)';
    root.appendChild(h('div', { class: 'card stack' },
      h('h2', {}, 'Auto fill & submit'),
      h('div', { class: 'small muted' }, 'One click: reads the form, creates synthetic respondents, picks answers, fills every section, clicks Next, submits, clicks "Submit another response", and repeats.'),
      h('div', { class: 'kv' }, h('div', { class: 'k' }, 'Page'), h('div', { style: 'word-break:break-all' }, S.tab ? (S.tab.title || S.tab.url) : 'No tab'),
        h('div', { class: 'k' }, 'Answers'), h('div', {}, mode)),
      S.scanError ? h('div', { class: 'banner err', role: 'alert' }, S.scanError) : null,
      d && d.status === 'unsupported' ? h('div', { class: 'banner err', role: 'alert' }, 'Unsupported: ' + d.reason) : null,
      h('label', { class: 'field' }, 'How many responses?', count),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: A.authorised, disabled: active || !!A.busy, onchange: function (e) { A.authorised = e.target.checked; render(); } }),
        h('span', {}, 'This is my own form (or I am authorised to send test responses), and the data is synthetic.')),
      h('button', { class: 'btn primary big', disabled: active || !!A.busy || !A.authorised, onclick: guard(function () { return autoStart(Util.clamp(parseInt(count.value, 10) || 1, 1, 500)); }) },
        A.busy ? [h('span', { class: 'spinner' }), ' ' + A.busy] : (active ? 'Running…' : '▶ Start Auto')),
      !A.authorised && !active ? h('div', { class: 'small muted' }, 'Tick the box above to enable Start.') : null,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', disabled: !(S.run && S.run.status === 'running'), onclick: guard(function () { return cmd('run.pause'); }) }, 'Pause'),
        h('button', { class: 'btn', disabled: !(S.run && S.run.status === 'paused'), onclick: guard(function () { return cmd('run.resume'); }) }, 'Resume'),
        h('button', { class: 'btn', disabled: !(S.run && S.run.currentRespondentId), onclick: guard(function () { return cmd('run.skip'); }) }, 'Skip current'),
        h('button', { class: 'btn danger', disabled: !active, onclick: guard(async function () { if (await confirmDialog('Stop the run? The respondent in progress will be marked failed.', { danger: true, confirmText: 'Stop' })) await cmd('run.stop'); }) }, 'Stop'),
        h('button', { class: 'btn', disabled: !S.run || S.run.status === 'running', onclick: guard(async function () { if (await confirmDialog('Clear this run\'s results so you can start a new one? (respondents are kept)', { confirmText: 'Clear' })) { await cmd('run.reset'); S.openRecord = null; await loadRun(); render(); } }) }, 'New run'))));
    root.appendChild(h('div', { id: 'dash' }));
    renderDashboard();
  }

  function runActive() { return S.run && (S.run.status === 'running' || S.run.status === 'paused'); }
  function selectedRespondents() { return S.respondents.filter(function (r) { return S.selected.has(r.id); }); }
  function currentKey() { return S.tab ? Parser.destinationKey(S.tab.url) : ''; }

  function respondentSelect(label, valueKey) {
    var list = S.respondents;
    return h('label', { class: 'field' }, label, h('select', { onchange: function (e) { S[valueKey] = e.target.value; render(); } },
      [h('option', { value: '' }, list.length ? 'Choose a respondent…' : 'No respondents yet')].concat(list.map(function (r) { return h('option', { value: r.id, selected: S[valueKey] === r.id }, r.id + ' · ' + r.profile.age + ' · ' + r.profile.occupation); }))));
  }

  function viewRun(root) {
    root.appendChild(h('div', { class: 'card stack' },
      h('div', { class: 'row spread' }, h('h2', {}, 'Mode'), h('div', { class: 'seg', role: 'group', 'aria-label': 'Execution mode' }, [['preview', 'Preview'], ['fill', 'Fill'], ['test', 'Test']].map(function (m) {
        return h('button', { 'aria-pressed': S.mode === m[0], disabled: runActive() && m[0] !== 'test', onclick: function () { S.mode = m[0]; render(); } }, m[1]); }))),
      h('div', { class: 'small muted' }, { preview: 'Preview shows what a respondent would answer. The form is never touched.',
        fill: 'Fill enters answers into the active form and verifies each one. It never submits.',
        test: 'Test runs several respondents against a destination you confirm, including submission.' }[S.mode])));
    if (S.mode === 'preview') return viewPreview(root);
    if (S.mode === 'fill') return viewFill(root);
    viewTest(root);
  }

  function viewPreview(root) {
    var r = S.respondents.filter(function (x) { return x.id === S.previewId; })[0];
    root.appendChild(h('div', { class: 'card stack' }, respondentSelect('Respondent to preview', 'previewId'),
      !r ? h('div', { class: 'empty' }, 'Choose a respondent to preview their answers.') : [
        h('div', { class: 'row spread' }, h('strong', {}, r.id), h('span', { class: 'chip synthetic' }, 'synthetic')),
        !S.survey || !S.survey.questions.length ? h('div', { class: 'banner warn' }, 'Scan a form first to see answers per question.') :
          h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Question'), h('th', {}, 'Answer'))),
            h('tbody', {}, S.survey.questions.map(function (q) {
              var a = r.answers[q.key];
              return h('tr', {}, h('td', {}, q.text + (q.required ? ' *' : '')), h('td', {}, a == null ? h('span', { class: 'muted' }, q.required ? 'missing' : '(skipped)') : Array.isArray(a) ? a.join(', ') : String(a)));
            })))]));
  }

  function viewFill(root) {
    var d = S.detection, ok = d && d.status !== 'unsupported';
    root.appendChild(h('div', { class: 'card stack' },
      !ok ? h('div', { class: 'banner warn' }, 'Scan the active form on the Survey tab first.') : h('div', { class: 'small muted' }, 'Target: ' + (d.title || S.tab.title)),
      respondentSelect('Respondent', 'previewId'),
      h('label', { class: 'switch' }, h('input', { id: 'fill-advance', type: 'checkbox', checked: true }), 'Advance through sections (never clicks Submit)'),
      h('button', { class: 'btn primary', disabled: !ok || !S.previewId || S.busy.fill, onclick: guard(async function () {
        S.busy.fill = true; S.fillResult = null; render();
        try {
          var res = await cmd('fill.start', { options: { tabId: S.tab.id, respondentId: S.previewId, surveyId: S.survey ? S.survey.id : Parser.surveyId(S.tab.url), advance: $('#fill-advance').checked, mode: S.settings.mode } });
          S.fillResult = res.summary; await loadRespondents(); await loadSurvey();
        } finally { S.busy.fill = false; render(); }
      }) }, S.busy.fill ? [h('span', { class: 'spinner' }), ' Filling…'] : 'Fill active form')));
    var f = S.fillResult;
    if (f) root.appendChild(h('div', { class: 'card stack' },
      h('div', { class: 'banner ' + (f.ok ? 'ok' : 'err'), role: 'alert' }, f.message),
      h('div', { class: 'stats' }, stat('Sections', f.sections), stat('Verified answers', f.filled), stat('Problems', f.failures.length)),
      f.failures.map(function (x) { return h('div', { class: 'qrow' }, h('div', { class: 't' }, x.question), h('div', { class: 'small', style: 'color:var(--err)' }, x.code + ': ' + x.error)); })));
  }

  function stat(k, v) { return h('div', { class: 'stat' }, h('div', { class: 'v' }, v == null ? '–' : String(v)), h('div', { class: 'k' }, k)); }

  function viewTest(root) {
    var dest = S.destination, active = runActive();
    var sel = selectedRespondents();
    var destCard;
    if (dest) {
      var mismatch = S.tab && !active && currentKey() !== dest.key;
      destCard = h('div', { class: 'card stack' }, h('div', { class: 'row spread' }, h('h2', {}, 'Destination'), h('span', { class: 'chip ok' }, 'Confirmed')),
        h('div', { class: 'small mono', style: 'word-break:break-all' }, dest.url),
        h('div', { class: 'small muted' }, 'Confirmed ' + new Date(dest.confirmedAt).toLocaleTimeString() + '. The runner refuses to touch any other URL.'),
        mismatch ? h('div', { class: 'banner warn' }, 'The active tab is on a different page. The run still targets the tab and URL above.') : null,
        h('button', { class: 'btn sm', disabled: active, onclick: function () { S.destination = null; render(); } }, 'Change destination'));
    } else {
      var boxId = 'confirm-own';
      var d = S.detection;
      destCard = h('div', { class: 'card stack' }, h('h2', {}, 'Confirm test destination'),
        h('div', { class: 'small muted' }, 'Test runs submit synthetic responses. Only use a form you own or are authorised to test, or a duplicate of it.'),
        h('div', { class: 'small mono', style: 'word-break:break-all' }, S.tab ? S.tab.url : 'No active tab'),
        !d || d.status === 'unsupported' ? h('div', { class: 'banner warn' }, 'Scan this tab on the Survey tab before confirming it.') : null,
        h('label', { class: 'switch' }, h('input', { id: boxId, type: 'checkbox' }), h('span', {}, 'This is my own test form (or I am authorised to send test responses to it), and the data is synthetic.')),
        h('button', { class: 'btn primary', disabled: !d || d.status === 'unsupported', onclick: guard(function () {
          if (!$('#' + boxId).checked) return toast('Tick the confirmation box first.', 'err');
          S.destination = { tabId: S.tab.id, url: S.tab.url, key: currentKey(), surveyId: S.survey ? S.survey.id : Parser.surveyId(S.tab.url), confirmedAt: Util.now() };
          render();
        }) }, 'Confirm this destination'));
    }
    root.appendChild(destCard);

    var count = h('input', { type: 'number', min: 1, max: Math.max(1, sel.length), value: Math.min(Math.max(1, sel.length), S.settings.defaultRespondentCount), disabled: active });
    var retries = h('input', { type: 'number', min: 0, max: 10, value: S.settings.retryLimit, disabled: active });
    var delay = h('input', { type: 'number', min: 0, step: 500, value: S.settings.delayBetweenRunsMs, disabled: active });
    root.appendChild(h('div', { class: 'card stack' }, h('h2', {}, 'Run setup'),
      h('div', { class: 'small muted' }, sel.length + ' respondent(s) selected on the Respondents tab' + (sel.length ? '' : ' – select some first') + '.'),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Respondents to run', count), h('label', { class: 'field' }, 'Max retries', retries)),
      h('label', { class: 'field' }, 'Time between respondents (ms)', delay),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', disabled: active || !dest || !sel.length, onclick: guard(async function () {
          var n = Util.clamp(parseInt(count.value, 10) || 1, 1, sel.length);
          var ok = await confirmDialog('Run ' + n + ' respondent(s) against\n' + dest.url + '\n\nEach one will be SUBMITTED to this form.', { title: 'Start test run', confirmText: 'Start run' });
          if (!ok) return;
          await Storage.setSettings({ retryLimit: Util.clamp(parseInt(retries.value, 10) || 0, 0, 10), delayBetweenRunsMs: Math.max(0, parseInt(delay.value, 10) || 0) });
          S.settings = await Storage.getSettings();
          await cmd('run.start', { options: { tabId: dest.tabId, destinationUrl: dest.url, destinationConfirmed: true, confirmedAt: dest.confirmedAt, surveyId: dest.surveyId, respondentIds: sel.slice(0, n).map(function (r) { return r.id; }), mode: S.settings.mode } });
          await loadRun(); render();
        }) }, 'Start'),
        h('button', { class: 'btn', disabled: !(S.run && S.run.status === 'running'), onclick: guard(function () { return cmd('run.pause'); }) }, 'Pause'),
        h('button', { class: 'btn', disabled: !(S.run && S.run.status === 'paused'), onclick: guard(function () { return cmd('run.resume'); }) }, 'Resume'),
        h('button', { class: 'btn danger', disabled: !active, onclick: guard(async function () { if (await confirmDialog('Stop the run? The respondent in progress will be marked failed.', { danger: true, confirmText: 'Stop' })) await cmd('run.stop'); }) }, 'Stop'),
        h('button', { class: 'btn', disabled: !(S.run && S.run.currentRespondentId), onclick: guard(function () { return cmd('run.skip'); }) }, 'Skip current'),
        h('button', { class: 'btn danger', disabled: !S.run || (S.run.status === 'running'), onclick: guard(async function () { if (await confirmDialog('Reset the run? Run records for this run are deleted (respondents are kept).', { danger: true, confirmText: 'Reset' })) { await cmd('run.reset'); S.openRecord = null; await loadRun(); render(); } }) }, 'Reset run'))));

    root.appendChild(h('div', { id: 'dash' }));
    renderDashboard();
  }

  function latestRecords() { return Stats.latestPerRespondent(S.records); }

  function renderDashboard() {
    var box = $('#dash'); if (!box) return; clear(box);
    if (!S.run) { box.appendChild(h('div', { class: 'card empty' }, h('div', { class: 'big' }, '📊'), h('div', {}, 'No run yet. Statistics appear here once a test run starts.'))); return; }
    var st = Stats.compute({ run: S.run, records: S.records, respondents: S.respondents, now: Date.now() });
    var tm = Stats.timings(S.records);
    var pct = Math.round(st.progress * 100);
    var statusChipRun = h('span', { class: 'chip ' + ({ running: 'accent', paused: 'warn', completed: 'ok', stopped: 'err' }[S.run.status] || '') }, S.run.status + (S.run.interrupted ? ' (interrupted)' : ''));
    box.appendChild(h('div', { class: 'card stack' },
      h('div', { class: 'row spread' }, h('h2', {}, 'Live dashboard'), statusChipRun),
      S.run.interrupted ? h('div', { class: 'banner warn' }, 'The browser restarted the extension during this run. Press Resume to continue from the next respondent.') : null,
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: 'width:' + pct + '%' })),
      h('div', { class: 'small muted' }, pct + '% of ' + st.targetRespondents + ' respondent(s) finished'),
      h('div', { class: 'stats' }, stat('Total respondents', st.totalRespondents), stat('Generated', st.generatedRespondents), stat('Completed', st.completedRuns), stat('Failed', st.failedRuns), stat('Pending', st.pendingRuns),
        stat('Success rate', st.successRate == null ? '–' : Math.round(st.successRate * 100) + '%'), stat('Avg completion', Util.formatDuration(st.avgCompletionMs)), stat('Elapsed', Util.formatDuration(st.elapsedMs))),
      h('div', { class: 'kv' }, h('div', { class: 'k' }, 'Current respondent'), h('div', {}, st.currentRespondentId || '–'),
        h('div', { class: 'k' }, 'Current section'), h('div', {}, st.currentSection == null ? '–' : String(st.currentSection + 1)),
        h('div', { class: 'k' }, 'Questions completed'), h('div', {}, st.currentRespondentId ? String(st.questionsCompleted) : '–'),
        h('div', { class: 'k' }, 'Questions remaining'), h('div', {}, st.questionsRemaining == null ? '–' : String(st.questionsRemaining))),
      tm.samples.respondents ? h('details', {}, h('summary', {}, 'Timings'), h('div', { class: 'kv', style: 'margin-top:8px' },
        h('div', { class: 'k' }, 'Generation'), h('div', {}, Util.formatDuration(tm.avgGenerationMs)), h('div', { class: 'k' }, 'Form reading'), h('div', {}, Util.formatDuration(tm.avgReadMs)),
        h('div', { class: 'k' }, 'Per question'), h('div', {}, Util.formatDuration(tm.avgQuestionFillMs)), h('div', { class: 'k' }, 'Per section'), h('div', {}, Util.formatDuration(tm.avgSectionMs)),
        h('div', { class: 'k' }, 'Per respondent'), h('div', {}, Util.formatDuration(tm.avgRespondentMs)))) : null));

    var latest = {}; latestRecords().forEach(function (r) { latest[r.respondentId] = r; });
    var rows = S.run.respondentIds.map(function (id) {
      var rec = latest[id], r = S.respondents.filter(function (x) { return x.id === id; })[0];
      return { id: id, rec: rec, r: r };
    });
    box.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('h2', {}, 'Respondent activity'), h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: function () { Exp.download(fname('csv', 'results'), Exp.runRecordsToCSV(S.records, { delimiter: S.settings.csvDelimiter }), 'text/csv'); } }, 'CSV'),
        h('button', { class: 'btn sm', onclick: function () { Exp.download(fname('json', 'results'), JSON.stringify({ run: Object.assign({}, S.run), records: S.records.map(function (x) { return Object.assign({}, x); }) }, null, 2), 'application/json'); } }, 'JSON'))),
      h('table', {}, h('thead', {}, h('tr', {}, ['ID', 'Profile', 'Status', 'Duration', 'Questions', 'Result'].map(function (c) { return h('th', {}, c); }))),
        h('tbody', {}, rows.map(function (x) {
          var rec = x.rec, status = rec ? rec.status : 'Pending';
          return h('tr', { class: 'clickable', onclick: function () { S.openRecord = S.openRecord === x.id ? null : x.id; renderDashboard(); } },
            h('td', {}, x.id), h('td', {}, x.r ? x.r.profile.age + ' · ' + x.r.profile.occupation : '(deleted)'), h('td', {}, h('span', { class: 'chip ' + status }, status)),
            h('td', {}, rec && rec.durationMs != null ? Util.formatDuration(rec.durationMs) : '–'), h('td', {}, rec ? rec.questionsFilled + '/' + (rec.questionsTotal || '?') : '–'),
            h('td', {}, rec ? (rec.status === 'Completed' ? (rec.confirmed ? 'Confirmed' : 'Done') : (rec.result || '')) : ''));
        })))));
    if (S.openRecord) box.appendChild(recordDetail(latest[S.openRecord], S.openRecord));
  }

  function recordDetail(rec, id) {
    var card = h('div', { class: 'card stack' }, h('h2', {}, 'Details for ' + id));
    if (!rec) { card.appendChild(h('div', { class: 'muted' }, 'Not started yet.')); return card; }
    card.appendChild(h('div', { class: 'kv' }, h('div', { class: 'k' }, 'Status'), h('div', {}, rec.status), h('div', { class: 'k' }, 'Submission confirmed'), h('div', {}, rec.confirmed ? 'yes' : 'no'),
      h('div', { class: 'k' }, 'Generation / read'), h('div', {}, Util.formatDuration(rec.generationMs) + ' / ' + Util.formatDuration(rec.readMs)),
      h('div', { class: 'k' }, 'Sections'), h('div', {}, (rec.sectionTimings || []).map(function (s) { return (s.section + 1) + ': ' + Util.formatDuration(s.ms); }).join(' · ') || '–')));
    if (rec.error) card.appendChild(h('div', { class: 'banner err', role: 'alert' }, rec.error));
    if (rec.status === 'Failed' || rec.status === 'Skipped') card.appendChild(h('button', { class: 'btn sm', disabled: S.run.status === 'running', onclick: guard(function () { return cmd('run.retry', { respondentId: id }).then(loadRun).then(render); }) }, 'Retry this respondent'));
    if (rec.diagnosticId) {
      var holder = h('div', { class: 'small muted' }, 'Loading diagnostics…'); card.appendChild(holder);
      Storage.get('diagnostics', rec.diagnosticId).then(function (dg) {
        clear(holder);
        if (!dg) return holder.appendChild(document.createTextNode('Diagnostics were removed by the retention policy.'));
        holder.appendChild(h('details', { open: true }, h('summary', {}, 'Failure diagnostics'), h('div', { class: 'kv', style: 'margin-top:6px' },
          h('div', { class: 'k' }, 'Code'), h('div', {}, dg.code), h('div', { class: 'k' }, 'Time'), h('div', {}, new Date(dg.timestamp).toLocaleString()), h('div', { class: 'k' }, 'URL'), h('div', { class: 'mono', style: 'word-break:break-all' }, dg.url),
          h('div', { class: 'k' }, 'Section'), h('div', {}, dg.currentSection ? (dg.currentSection.index + 1) + (dg.currentSection.title ? ' · ' + dg.currentSection.title : '') : String(dg.section + 1)),
          h('div', { class: 'k' }, 'Visible questions'), h('div', {}, (dg.visibleQuestions || []).join(' | ') || '–'),
          h('div', { class: 'k' }, 'Missing required'), h('div', {}, (dg.missingQuestions || []).map(function (m) { return m.text; }).join(' | ') || '–'),
          h('div', { class: 'k' }, 'Validation text'), h('div', {}, (dg.validationMessages || []).join(' | ') || '–'),
          h('div', { class: 'k' }, 'Console errors'), h('div', {}, (dg.consoleErrors || []).map(function (c) { return c.message; }).join(' | ') || 'none captured')),
          dg.screenshot ? h('img', { class: 'shot', src: dg.screenshot, alt: 'Screenshot at time of failure' }) : h('div', { class: 'small muted' }, 'No screenshot' + (dg.screenshotError ? ' (' + dg.screenshotError + ')' : ''))));
      }).catch(function (e) { holder.textContent = 'Could not load diagnostics: ' + e.message; });
    }
    return card;
  }

  /* ---------------- views: Logs ---------------- */
  async function viewLogs(root) {
    var f = S.logFilter;
    var filter = {}; if (f.level !== 'all') filter.level = f.level; if (f.text) filter.text = f.text; if (f.respondent) filter.respondentId = f.respondent;
    var logs = await Storage.listLogs(filter);
    var shown = logs.slice(-400);
    root.appendChild(h('div', { class: 'card stack' }, h('div', { class: 'row spread' }, h('h2', {}, 'Execution log'), h('span', { class: 'chip' }, logs.length + ' entries')),
      h('input', { type: 'search', placeholder: 'Filter text…', value: f.text, onchange: function (e) { f.text = e.target.value; render(); } }),
      h('div', { class: 'grid2' },
        h('select', { 'aria-label': 'Level', onchange: function (e) { f.level = e.target.value; render(); } }, ['all', 'info', 'warn', 'error', 'debug'].map(function (v) { return h('option', { value: v, selected: f.level === v }, v === 'all' ? 'All levels' : v); })),
        h('input', { type: 'text', placeholder: 'Respondent ID', value: f.respondent, onchange: function (e) { f.respondent = e.target.value.trim(); render(); } })),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn sm', onclick: guard(function () { return navigator.clipboard.writeText(Exp.logsToText(logs)).then(function () { toast('Copied ' + logs.length + ' log line(s).', 'ok'); }); }) }, 'Copy log'),
        h('button', { class: 'btn sm', onclick: function () { Exp.download(fname('csv', 'log'), Exp.logsToCSV(logs, { delimiter: S.settings.csvDelimiter }), 'text/csv'); } }, 'Export CSV'),
        h('button', { class: 'btn sm', onclick: function () { Exp.download(fname('txt', 'log'), Exp.logsToText(logs), 'text/plain'); } }, 'Export text'),
        h('button', { class: 'btn sm danger', onclick: guard(async function () { if (await confirmDialog('Delete all log entries?', { danger: true, confirmText: 'Delete logs' })) { await Storage.clear('logs'); render(); } }) }, 'Clear logs')),
      !shown.length ? h('div', { class: 'empty' }, h('div', { class: 'big' }, '🧾'), h('div', {}, 'No log entries match. Logs appear when you fill forms or run tests.'),
        !S.settings.diagnosticLogging ? h('div', { class: 'small' }, 'Enable "Diagnostic logging" in Settings to log every question.') : null) :
        h('div', {}, shown.map(function (l) {
          var text = Util.formatClock(l.ts) + ' ' + (l.respondentId ? '[' + l.respondentId + '] ' : '') + l.action + (l.question ? ' – ' + l.question : '') + (l.result ? ' → ' + l.result : '') + (l.error ? ' ✖ ' + l.error : '');
          return h('div', { class: 'logline ' + l.level }, text);
        }))));
  }

  /* ---------------- render ---------------- */
  var rendering = 0;
  async function render() {
    var token = ++rendering;
    var root = $('#view');
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.setAttribute('aria-selected', String(b.dataset.view === S.view)); });
    if (S.fatal) { clear(root); return root.appendChild(h('div', { class: 'card stack' }, h('div', { class: 'banner err', role: 'alert' }, S.fatal), h('button', { class: 'btn', onclick: function () { location.reload(); } }, 'Retry'))); }
    if (S.loading) { clear(root); return root.appendChild(h('div', { class: 'card stack' }, h('div', { class: 'skeleton', style: 'width:60%' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'width:80%' }))); }
    var frag = h('div', { class: 'stack' });
    if (S.view === 'auto') viewAuto(frag);
    else if (S.view === 'survey') viewSurvey(frag);
    else if (S.view === 'respondents') viewRespondents(frag);
    else if (S.view === 'run') viewRun(frag);
    else await viewLogs(frag);
    if (token !== rendering) return;      // a newer render superseded this one
    var scroll = window.scrollY;
    clear(root); while (frag.firstChild) root.appendChild(frag.firstChild);
    if (S.view === 'respondents') renderRespondentList();
    if (S.view === 'run' || S.view === 'auto') renderDashboard();
    window.scrollTo(0, scroll);
  }

  /* ---------------- events from the service worker ---------------- */
  var refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async function () {
      try { await loadRun(); await loadRespondents(); if (S.view === 'run' || S.view === 'auto' || S.view === 'logs') { if (S.view === 'run' && $('#dash')) renderDashboard(); else render(); } } catch (e) { banner('Could not refresh: ' + e.message, 'err'); }
    }, 250);
  }
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.sp !== 'event') return;
    var ev = msg.event;
    if (ev.type === 'storageError') banner('Storage problem: ' + ev.message, 'err');
    else if (ev.type === 'log') { if (S.view === 'logs') scheduleRefreshLogs(); }
    else scheduleRefresh();
  });
  var logTimer = null;
  function scheduleRefreshLogs() { clearTimeout(logTimer); logTimer = setTimeout(render, 500); }

  var tabTimer = null;
  function onTabChange() {
    clearTimeout(tabTimer);
    tabTimer = setTimeout(async function () { if (await refreshTab()) render(); }, 200);
  }
  chrome.tabs.onActivated.addListener(onTabChange);
  chrome.tabs.onUpdated.addListener(function (id, info) { if (S.tab && id === S.tab.id && (info.url || info.status === 'complete')) onTabChange(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  setInterval(function () { if (S.run && S.run.status === 'running' && (S.view === 'run' || S.view === 'auto') && $('#dash')) renderDashboard(); }, 1000);

  /* ---------------- boot ---------------- */
  $('#tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-view]'); if (!b) return;
    S.view = b.dataset.view; S.openRespondent = null; render();
  });
  $('#btn-settings').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
  $('#btn-theme').addEventListener('click', guard(async function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    S.settings.theme = dark ? 'light' : 'dark'; await Storage.setSettings({ theme: S.settings.theme }); applyTheme();
  }));

  (async function boot() {
    render();
    try {
      await Storage.open();
      Storage.onError = function (e) { banner('Storage problem: ' + e.message, 'err'); };
      await loadSettings(); await loadRespondents(); await refreshTab(); await loadRun();
      S.loading = false;
    } catch (err) { S.fatal = 'SurveyPilot could not open its local database: ' + err.message; S.loading = false; }
    render();
  })();
})();
