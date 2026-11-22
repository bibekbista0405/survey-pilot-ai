/* SurveyPilot AI - survey definition helpers: keys, semantic classification, option matching. */
(function (root, factory) {
  var dep = (typeof require === 'function' && typeof module === 'object') ? require('./util.js') : root.SP;
  var api = factory(dep.Util);
  if (typeof module === 'object' && module.exports) module.exports = api;
  var SP = (root.SP = root.SP || {});
  Object.keys(api).forEach(function (k) { SP[k] = api[k]; });
})(typeof globalThis !== 'undefined' ? globalThis : self, function (Util) {
  'use strict';

  var TYPES = ['short_answer', 'paragraph', 'multiple_choice', 'checkbox', 'dropdown',
    'linear_scale', 'rating', 'date', 'time'];

  /** Ordered semantic rules; first match wins. Tested on normalized question text. */
  var SEMANTIC_RULES = [
    ['email', /\be-?mail\b/],
    ['phone', /\b(phone|mobile|telephone|cell)\b/],
    ['name', /\b(your (full |first |last )?name|full name|first name|last name|surname)\b/],
    ['age', /\b(age|how old|year of birth|birth year|date of birth)\b/],
    ['gender', /\b(gender|sex)\b/],
    ['student', /\b(are you a student|student status|currently a student|enrolled|studying)\b/],
    ['occupation', /\b(occupation|profession|job|employment|work status|what do you do)\b/],
    ['education', /\b(education|degree|qualification|highest level of school)\b/],
    ['income', /\b(income|salary|earn)\b/],
    ['bus_freq', /\b(bus|buses|public bus)\b.*\b(how often|frequency|times|per week|per month|often)\b|\b(how often|frequency)\b.*\b(bus|buses)\b/],
    ['bus_use', /\b(do you|did you|have you|ever)\b.*\b(use|take|ride|travel by|taken)\b.*\b(bus|buses)\b|\bbus (user|rider|usage)\b/],
    ['travel_freq', /\b(how often|how frequently|frequency)\b.*\b(travel|commute|trip|trips|journey|journeys)\b|\b(travel|commute|trips?)\b.*\b(per week|per month|how often)\b/],
    ['travel_mode', /\b(mode of (transport|travel)|how do you (travel|commute|get)|transport(ation)? (mode|method)|main (mode|means)|which (modes|transport|vehicles))\b/],
    ['travel_purpose', /\b(purpose of (your )?(trip|travel|journey)|why do you travel|reason for (travel|travelling|traveling))\b/],
    ['region', /\b(where do you live|area do you live|type of area|urban|rural|suburban|city or town|place of residence|residence)\b/],
    ['nps', /\b(recommend)\b.*\b(friend|colleague|others|family)\b/],
    ['satisfaction', /\b(satisf|rate|rating|how (good|well|comfortable|safe)|agree|quality|experience)\b/],
    ['comments', /\b(comment|suggest|feedback|anything else|improve|tell us|additional|describe|explain|why)\b/],
    ['date', /\b(date)\b/],
    ['time', /\b(time)\b/]
  ];

  var Parser = {
    TYPES: TYPES,

    classify: function (q) {
      var text = Util.normalize(q.text || '');
      for (var i = 0; i < SEMANTIC_RULES.length; i++) {
        if (SEMANTIC_RULES[i][1].test(text)) return SEMANTIC_RULES[i][0];
      }
      return 'generic';
    },

    /** Stable key for a question across page loads and sessions. */
    questionKey: function (q) {
      if (q.entryId) return 'e:' + q.entryId;
      var basis = Util.normalize(Util.cleanLabel(q.text)) + '|' + q.type + '|' +
        (q.options || []).map(Util.normalize).join('/');
      return 'q:' + Util.hash(basis);
    },

    /** Normalizes a destination so /viewform and /formResponse of one Google Form compare equal. */
    destinationKey: function (url) {
      try {
        var u = new URL(url);
        var path = u.pathname.replace(/\/+$/, '');
        var m = path.match(/^(\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?[^/]+)/);
        if (u.hostname === 'docs.google.com' && m) path = m[1].replace(/\/u\/\d+/, '');
        var key = u.protocol + '//' + u.host + path;
        // Non-Google forms: query string is part of the identity (e.g. ?survey=12).
        if (!(u.hostname === 'docs.google.com' && m)) key += u.search;
        return key;
      } catch (e) {
        return String(url || '');
      }
    },

    surveyId: function (url) { return 's_' + Util.hash(Parser.destinationKey(url)); },

    /** Builds/updates a serializable survey definition from reader output. */
    buildSurvey: function (info, existing) {
      var survey = existing ? Util.clone(existing) : {
        id: Parser.surveyId(info.url), url: info.url, title: info.title || '',
        kind: info.kind || 'html-form', createdAt: Util.now(), questions: []
      };
      survey.title = info.title || survey.title;
      survey.url = info.url || survey.url;
      survey.kind = info.kind || survey.kind;
      survey.updatedAt = Util.now();
      var known = {};
      survey.questions.forEach(function (q) { known[q.key] = q; });
      (info.questions || []).forEach(function (rq) {
        var key = rq.key || Parser.questionKey(rq);
        var def = {
          key: key, id: rq.id || key, text: Util.cleanLabel(rq.text), type: rq.type,
          options: (rq.options || []).slice(), required: !!rq.required,
          sectionIndex: rq.sectionIndex || 0, sectionTitle: rq.sectionTitle || '',
          scale: rq.scale || null, semantic: Parser.classify(rq)
        };
        if (known[key]) {
          Object.assign(known[key], def);
        } else {
          survey.questions.push(def); known[key] = def;
        }
      });
      survey.summary = Parser.summarize(survey);
      return survey;
    },

    summarize: function (survey) {
      var types = {}, required = 0, sections = {};
      survey.questions.forEach(function (q) {
        types[q.type] = (types[q.type] || 0) + 1;
        if (q.required) required++;
        sections[q.sectionIndex || 0] = true;
      });
      return { questionCount: survey.questions.length, requiredCount: required,
        sectionCount: Object.keys(sections).length, types: types };
    },

    /** Returns the index of the option best matching `wanted`, or -1. */
    matchOption: function (options, wanted) {
      if (!options || !options.length || wanted == null) return -1;
      var w = Util.normalize(wanted);
      if (!w) return -1;
      var norm = options.map(Util.normalize), i;
      for (i = 0; i < norm.length; i++) if (norm[i] === w) return i;
      var wn = parseFloat(w);
      if (!isNaN(wn) && /^-?\d+(\.\d+)?$/.test(w)) {
        for (i = 0; i < norm.length; i++) if (/^-?\d+(\.\d+)?$/.test(norm[i]) && parseFloat(norm[i]) === wn) return i;
      }
      for (i = 0; i < norm.length; i++) if (norm[i] && (norm[i].indexOf(w) === 0 || w.indexOf(norm[i]) === 0)) return i;
      for (i = 0; i < norm.length; i++) if (norm[i] && (norm[i].indexOf(w) >= 0 || w.indexOf(norm[i]) >= 0) && Math.min(norm[i].length, w.length) >= 3) return i;
      var wt = w.split(' '), best = -1, bestScore = 0;
      for (i = 0; i < norm.length; i++) {
        var ot = norm[i].split(' '), common = 0;
        wt.forEach(function (t) { if (t.length > 2 && ot.indexOf(t) >= 0) common++; });
        var score = common / Math.max(wt.length, ot.length);
        if (score > bestScore) { bestScore = score; best = i; }
      }
      return bestScore >= 0.5 ? best : -1;
    }
  };

  return { Parser: Parser };
});
