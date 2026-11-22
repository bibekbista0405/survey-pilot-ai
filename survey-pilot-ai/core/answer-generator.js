/* SurveyPilot AI - answer generation (local weighted/conditional engine + orchestration with AI mode). */
(function (root, factory) {
  var isNode = typeof require === 'function' && typeof module === 'object';
  var dep = isNode ? require('./util.js') : root.SP;
  var parser = isNode ? require('./survey-parser.js') : root.SP;
  var api = factory(dep.Util, parser.Parser, function () { return isNode ? require('./ai-client.js').AI : root.SP.AI; });
  if (typeof module === 'object' && module.exports) module.exports = api;
  var SP = (root.SP = root.SP || {});
  Object.keys(api).forEach(function (k) { SP[k] = api[k]; });
})(typeof globalThis !== 'undefined' ? globalThis : self, function (Util, Parser, getAI) {
  'use strict';

  /* ---------------- language banks ---------------- */
  var BANK = {
    en: {
      generic: ['Not much to add', 'It depends on the day', 'Works fine for me', 'No strong opinion', 'Mostly satisfied', 'Could be better', 'Fine overall'],
      open: ['Overall my experience has been reasonable.', 'I think it is generally fine.', 'There are a few things I would change.', 'It mostly works for what I need.'],
      close: ['More frequent service would help.', 'Clearer information would be useful.', 'Prices are a factor for me.', 'I have no major complaints.', 'Reliability matters most to me.'],
      noBus: 'I do not use the bus; I usually get around by {mode}.',
      bus: { daily: 'I rely on the bus every day.', weekly: 'I take the bus a few times a week.', monthly: 'I use the bus once or twice a month.', rarely: 'I only take the bus occasionally.' },
      modes: { bus: 'bus', car: 'car', bike: 'bike', walk: 'foot' }
    },
    es: {
      generic: ['Nada que añadir', 'Depende del día', 'Me funciona bien', 'Sin opinión fuerte', 'Bastante satisfecho', 'Podría mejorar', 'Bien en general'],
      open: ['En general mi experiencia ha sido razonable.', 'Creo que en general está bien.', 'Cambiaría algunas cosas.', 'Casi siempre cumple lo que necesito.'],
      close: ['Más frecuencia ayudaría.', 'Información más clara sería útil.', 'El precio influye para mí.', 'No tengo quejas importantes.', 'La fiabilidad es lo más importante.'],
      noBus: 'No uso el autobús; normalmente me muevo en {mode}.',
      bus: { daily: 'Dependo del autobús todos los días.', weekly: 'Uso el autobús varias veces por semana.', monthly: 'Uso el autobús una o dos veces al mes.', rarely: 'Solo uso el autobús de vez en cuando.' },
      modes: { bus: 'autobús', car: 'coche', bike: 'bicicleta', walk: 'a pie' }
    },
    fr: {
      generic: ['Rien à ajouter', 'Cela dépend des jours', 'Cela me convient', 'Pas d\'avis tranché', 'Plutôt satisfait', 'Peut mieux faire', 'Correct dans l\'ensemble'],
      open: ['Dans l\'ensemble mon expérience est correcte.', 'Je pense que c\'est globalement bien.', 'Je changerais quelques choses.', 'Cela répond à mes besoins la plupart du temps.'],
      close: ['Plus de fréquence aiderait.', 'Une information plus claire serait utile.', 'Le prix compte pour moi.', 'Je n\'ai pas de plainte majeure.', 'La fiabilité est essentielle pour moi.'],
      noBus: 'Je ne prends pas le bus ; je me déplace en général en {mode}.',
      bus: { daily: 'Je prends le bus tous les jours.', weekly: 'Je prends le bus plusieurs fois par semaine.', monthly: 'Je prends le bus une ou deux fois par mois.', rarely: 'Je prends le bus de temps en temps.' },
      modes: { bus: 'bus', car: 'voiture', bike: 'vélo', walk: 'à pied' }
    },
    de: {
      generic: ['Nichts hinzuzufügen', 'Kommt auf den Tag an', 'Funktioniert für mich', 'Keine starke Meinung', 'Überwiegend zufrieden', 'Könnte besser sein', 'Insgesamt in Ordnung'],
      open: ['Insgesamt war meine Erfahrung ordentlich.', 'Ich finde es im Großen und Ganzen gut.', 'Ich würde einiges ändern.', 'Es erfüllt meistens meinen Bedarf.'],
      close: ['Häufigere Verbindungen würden helfen.', 'Klarere Informationen wären nützlich.', 'Der Preis spielt für mich eine Rolle.', 'Ich habe keine größeren Beschwerden.', 'Zuverlässigkeit ist mir am wichtigsten.'],
      noBus: 'Ich fahre nicht mit dem Bus; ich bin meistens mit {mode} unterwegs.',
      bus: { daily: 'Ich fahre jeden Tag mit dem Bus.', weekly: 'Ich fahre mehrmals pro Woche mit dem Bus.', monthly: 'Ich fahre ein- bis zweimal im Monat mit dem Bus.', rarely: 'Ich fahre nur gelegentlich mit dem Bus.' },
      modes: { bus: 'Bus', car: 'Auto', bike: 'Fahrrad', walk: 'zu Fuß' }
    }
  };

  /* ---------------- token tables ---------------- */
  var FREQ_TOKENS = {
    never: ['never', 'not at all', 'do not use', "don't use", 'dont use', 'none', 'not applicable', 'n a', 'i do not', 'zero', '0 times', 'no use'],
    rarely: ['rarely', 'seldom', 'less than once a month', 'few times a year', 'once or twice a year', 'occasionally', 'less than monthly', 'less than once'],
    monthly: ['monthly', 'once a month', 'few times a month', '1-3 times a month', '1 3 times a month', 'once or twice a month', '2-3 times a month'],
    weekly: ['weekly', 'once a week', 'few times a week', '2-3 times a week', '1-2 times a week', '1-2 days', '2-3 days', '3-4 days', 'several times a week', 'times a week'],
    daily: ['daily', 'every day', 'almost every day', 'most days', '5 days', '5-7', '6-7', '7 days', 'everyday', 'every weekday']
  };
  var FREQ_ORDER = ['never', 'rarely', 'monthly', 'weekly', 'daily'];
  var OCC_TOKENS = {
    student: ['student', 'studying', 'pupil'],
    'self-employed': ['self employed', 'self-employed', 'freelance', 'business owner', 'entrepreneur'],
    unemployed: ['unemployed', 'not working', 'looking for work', 'seeking work'],
    retired: ['retired', 'pension'],
    homemaker: ['homemaker', 'housewife', 'stay at home', 'caregiver', 'house person'],
    employed: ['employed', 'full time', 'full-time', 'part time', 'part-time', 'employee', 'working', 'salaried', 'professional', 'worker']
  };
  var MODE_TOKENS = {
    bus: [/\bbus(es)?\b/, /\bcoach\b/],
    car: [/\bcar\b/, /\bdriv(e|ing)\b/, /\btaxi\b/, /\bcab\b/, /\bmotorbike\b/, /\bvan\b/],
    bike: [/\bbike\b/, /\bbicycle\b/, /\bcycl(e|ing)\b/],
    walk: [/\bwalk(ing)?\b/, /\bon foot\b/, /\bfoot\b/]
  };
  var SENTIMENT = [
    [/\b(strongly disagree|very dissatisfied|very poor|very unlikely|extremely unlikely|terrible|awful|never)\b/, -2],
    [/\b(disagree|dissatisfied|poor|unlikely|bad|rarely)\b/, -1],
    [/\b(neutral|neither|fair|average|undecided|sometimes|moderate|not sure)\b/, 0],
    [/\b(strongly agree|very satisfied|excellent|very likely|extremely likely|outstanding|always)\b/, 2],
    [/\b(agree|satisfied|good|likely|often|great)\b/, 1]
  ];

  function nrm(s) { return Util.normalize(s); }
  function hasWord(text, token) {
    var t = nrm(token);
    return (' ' + text + ' ').indexOf(' ' + t + ' ') >= 0 || (t.length > 3 && text.indexOf(t) >= 0);
  }
  function sentiment(text) {
    var t = nrm(text);
    for (var i = 0; i < SENTIMENT.length; i++) if (SENTIMENT[i][0].test(t)) return SENTIMENT[i][1];
    return null;
  }
  function freqLevel(optText) {
    var t = nrm(optText);
    // Check from most specific to least: weekly/monthly phrases can contain "day".
    var order = ['never', 'rarely', 'monthly', 'weekly', 'daily'];
    for (var i = 0; i < order.length; i++) {
      var toks = FREQ_TOKENS[order[i]];
      for (var j = 0; j < toks.length; j++) if (hasWord(t, toks[j])) return order[i];
    }
    return null;
  }
  function isNoise(optText) {
    var t = nrm(optText);
    return /^(other|prefer not|rather not|n a|not applicable|none of the above|choose|select)/.test(t);
  }
  function isBusText(text) { return /\bbus(es)?\b/.test(nrm(text)); }
  function isNeverOption(o) { return freqLevel(o) === 'never' || /not applicable|\bn a\b|do not use|don't use/.test(nrm(o)); }
  function hasNeverOption(opts) { return opts.some(isNeverOption); }

  function yesNoIndex(options, yes) {
    var norm = options.map(nrm), i;
    var yesRe = /^(yes|y|true|sure|i do|definitely)\b/, noRe = /^(no|n|false|never|not|i do not|i don't)\b/;
    for (i = 0; i < norm.length; i++) if (yes ? yesRe.test(norm[i]) : noRe.test(norm[i])) return i;
    for (i = 0; i < norm.length; i++) if (yes ? /\byes\b/.test(norm[i]) : /\bno\b/.test(norm[i])) return i;
    return -1;
  }

  function parseAgeRange(opt) {
    var t = nrm(opt), m;
    if ((m = t.match(/(\d+)\s*(?:-|to)\s*(\d+)/))) return [+m[1], +m[2]];
    if ((m = t.match(/(?:under|below|less than|younger than)\s*(\d+)/))) return [0, +m[1] - 1];
    if ((m = t.match(/(\d+)\s*\+/)) || (m = t.match(/(\d+)\s*(?:and|or) (?:over|above|older|more)/)) ||
      (m = t.match(/(?:over|above|older than)\s*(\d+)/))) return [+m[1], Infinity];
    return null;
  }

  function ordinalPick(options, level01) {
    var idx = Math.round(Util.clamp(level01, 0, 1) * (options.length - 1));
    return options[idx];
  }

  /** Orders option indexes ascending by "positivity" when a Likert-like lexicon is detected, else null. */
  function likertOrder(options) {
    var s = options.map(sentiment);
    var known = s.filter(function (v) { return v !== null; }).length;
    if (options.length < 3 || known < Math.ceil(options.length / 2)) return null;
    var idx = options.map(function (o, i) { return i; });
    idx.sort(function (a, b) {
      var sa = s[a] == null ? 0 : s[a], sb = s[b] == null ? 0 : s[b];
      return sa === sb ? a - b : sa - sb;
    });
    return idx;
  }

  function bankFor(lang) { return BANK[lang] || BANK.en; }

  var Local = {
    /** Per-question RNG: independent of question order, stable for (profile, question). */
    rngFor: function (profile, q) {
      return Util.rng((profile.seed >>> 0) ^ parseInt(Util.hash(q.key || q.text), 36));
    },

    /** Returns a string, an array of strings (checkbox), or null (leave an optional question blank). */
    answerQuestion: function (q, profile, ctx) {
      ctx = ctx || {};
      var rng = Local.rngFor(profile, q);
      var s = profile.settings || { variation: 0.5, randomization: 0.5, consistency: 0.8, language: 'en' };
      var lang = ctx.language || s.language || 'en';
      var sem = q.semantic || Parser.classify(q);
      var opts = (q.options || []).slice();

      // 
      // By default every question is answered (including optional ones); blanks only when ctx.allowSkip is set.
      Local._mayBlank = !q.required && ctx.allowSkip === true;
      if (Local._mayBlank && rng.chance(profile.traits.skipOptional * (sem === 'income' ? 2 : 1))) return null;

      var busRelated = isBusText(q.text);
      switch (q.type) {
        case 'short_answer': return Local.text(q, profile, rng, sem, lang, false, ctx);
        case 'paragraph': return Local.text(q, profile, rng, sem, lang, true, ctx);
        case 'date': return Local.date(q, profile, rng, ctx);
        case 'time': return Local.time(q, rng);
        case 'linear_scale':
        case 'rating': return Local.scale(q, profile, rng, s, busRelated);
        case 'checkbox': return Local.checkbox(q, profile, rng, sem, s, opts);
        case 'multiple_choice':
        case 'dropdown': return Local.choice(q, profile, rng, sem, s, opts, busRelated);
        default: return null;
      }
    },

    text: function (q, p, rng, sem, lang, long, ctx) {
      var b = bankFor(lang), t = nrm(q.text);
      switch (sem) {
        case 'email': return p.email;
        case 'phone': return p.phone;
        case 'name': return /\bfirst\b/.test(t) ? p.name.split(' ')[0] : /\b(last|surname)\b/.test(t) ? p.name.split(' ')[1] : p.name;
        case 'age': return /birth/.test(t) ? String(new Date(ctx.today || Date.now()).getFullYear() - p.age) : String(p.age);
        case 'occupation': return p.occupation;
        case 'education': return p.education;
        case 'region': return p.regionLabel;
        case 'travel_mode': return b.modes[p.travel.mainMode] || p.travel.mainMode;
        case 'income': return p.incomeBand;
        default: break;
      }
      if (/\b(city|town)\b/.test(t)) return p.regionLabel;
      if (/\b(number|how many)\b/.test(t) && !long) return String(p.travel.tripsPerWeek);
      if (!long) return rng.pick(b.generic);
      var parts = [rng.pick(b.open)];
      if (isBusText(q.text) || /travel|commut|transport/.test(t)) {
        parts.push(p.travel.usesBus ? b.bus[p.travel.busFrequency] : b.noBus.replace('{mode}', b.modes[p.travel.mainMode] || p.travel.mainMode));
      }
      if (p.traits.verbosity > 0.35) parts.push(rng.pick(b.close));
      if (p.traits.verbosity > 0.8) parts.push(rng.pick(b.open));
      return parts.join(' ');
    },

    date: function (q, p, rng, ctx) {
      var today = new Date(ctx.today || Date.now()), d;
      if (/birth/i.test(q.text)) d = new Date(today.getFullYear() - p.age, rng.int(0, 11), rng.int(1, 28));
      else d = new Date(today.getTime() - rng.int(0, 30) * 86400000);
      return d.getFullYear() + '-' + Util.pad2(d.getMonth() + 1) + '-' + Util.pad2(d.getDate());
    },

    time: function (q, rng) {
      var commute = /commut|depart|leave|arriv|travel|trip/i.test(q.text);
      var h = commute ? rng.int(6, 9) : rng.int(8, 21), m = rng.pick([0, 5, 10, 15, 20, 30, 40, 45, 50]);
      return Util.pad2(h) + ':' + Util.pad2(m);
    },

    scale: function (q, p, rng, s, busRelated) {
      var opts = q.options || [];
      if (!opts.length) return null;
      if (busRelated && !p.travel.usesBus) {
        // Non-users have no experience of the bus: neutral value when forced, blank when optional.
        return (q.required || !Local._mayBlank) ? opts[Math.floor((opts.length - 1) / 2)] : null;
      }
      var n = opts.length, mid = (n - 1) / 2;
      var lean = p.traits.leniency * ((n - 1) / 4) * (0.5 + s.consistency / 2);
      var sd = Math.max(0.35, (n - 1) * (0.1 + 0.28 * s.variation));
      var idx;
      if (rng.chance(s.randomization * 0.25)) idx = rng.int(0, n - 1);
      else if (p.traits.extreme && rng.chance(0.35)) idx = p.traits.leniency >= 0 ? n - 1 : 0;
      else idx = Math.round(Util.clamp(rng.normal(mid + lean, sd), 0, n - 1));
      return opts[idx];
    },

    choiceWeights: function (q, p, rng, s, opts) {
      var pref = opts.map(function () { return 0.3 + 1.4 * rng.next(); });
      var exp = 1 + (1 - s.randomization) * 1.5;
      return opts.map(function (o, i) {
        var w = Math.pow(pref[i], exp);
        if (/^other\b/.test(nrm(o))) w *= 0.3;
        if (/^(prefer not|rather not)/.test(nrm(o))) w *= 0.15;
        if (/^none of the above/.test(nrm(o))) w *= 0.2;
        return w;
      });
    },

    choice: function (q, p, rng, sem, s, opts, busRelated) {
      if (!opts.length) return null;
      var idx = -1, t = p.travel;
      switch (sem) {
        case 'age':
          var best = -1, bestD = 1e9;
          opts.forEach(function (o, i) {
            var r = parseAgeRange(o); if (!r) return;
            var d = p.age < r[0] ? r[0] - p.age : p.age > r[1] ? p.age - r[1] : 0;
            if (d < bestD) { bestD = d; best = i; }
          });
          idx = best; break;
        case 'gender':
          var gre = { female: /\b(female|woman|girl)\b/, male: /\b(male|man|boy)\b/, nonbinary: /non[- ]?binary|genderqueer|\bother\b/, undisclosed: /prefer not|rather not|undisclosed/ }[p.gender];
          idx = opts.findIndex(function (o) { return gre.test(nrm(o)); }); break;
        case 'student':
          idx = yesNoIndex(opts, p.isStudent); break;
        case 'occupation':
          idx = Parser.matchOption(opts, p.occupation);
          if (idx < 0 || (p.isStudent && p.occupationCategory === 'student' && !/student/.test(nrm(opts[idx])) && opts.some(function (o) { return /student/.test(nrm(o)); }))) {
            var cat = p.occupationCategory;
            idx = opts.findIndex(function (o) { var n = nrm(o); return (OCC_TOKENS[cat] || []).some(function (tk) { return hasWord(n, tk); }); });
            if (idx < 0 && p.isStudent) idx = opts.findIndex(function (o) { return /student/.test(nrm(o)); });
          }
          break;
        case 'education':
          var edre = { 'high school': /high school|secondary|diploma/, bachelor: /bachelor|undergrad|college|university/, master: /master|postgrad|graduate/, doctorate: /doctor|phd/ }[p.education];
          idx = opts.findIndex(function (o) { return edre.test(nrm(o)); }); break;
        case 'income':
          var cand = opts.map(function (o, i) { return i; }).filter(function (i) { return !isNoise(opts[i]); });
          if (cand.length) {
            var lvl = { low: 0.1, medium: 0.5, high: 0.9 }[p.incomeBand];
            idx = cand[Math.round(lvl * (cand.length - 1))];
          }
          break;
        case 'region':
          var rre = { urban: /urban|city|metropol/, suburban: /suburb/, rural: /rural|village|countryside|small town/ }[p.region];
          idx = opts.findIndex(function (o) { return rre.test(nrm(o)); }); break;
        case 'bus_use':
          if (!t.usesBus) idx = yesNoIndex(opts, false);
          else {
            if (/rarely|monthly/.test(t.busFrequency)) idx = opts.findIndex(function (o) { return /sometimes|occasion|rare/.test(nrm(o)); });
            if (idx < 0) idx = yesNoIndex(opts, true);
          }
          break;
        case 'bus_freq':
          // A non user with no "never"/"N/A" option cannot answer truthfully: leave optional questions blank.
          if (!t.usesBus && Local._mayBlank && !hasNeverOption(opts)) return null;
          idx = Local.freqIndex(opts, t.busFrequency, !t.usesBus, q.required); break;
        case 'travel_freq':
          var lvl2 = t.tripsPerWeek >= 14 ? 'daily' : t.tripsPerWeek >= 5 ? 'weekly' : t.tripsPerWeek >= 2 ? 'monthly' : 'rarely';
          idx = Local.freqIndex(opts, lvl2, false, q.required); break;
        case 'travel_mode':
          idx = Local.modeIndex(opts, t.mainMode, t); break;
        default: break;
      }
      if (idx >= 0) return opts[idx];

      // Bus-related generic question for non-users: prefer a "never/not applicable" style option.
      if (busRelated && !t.usesBus) {
        var na = opts.findIndex(function (o) { var l = freqLevel(o); return l === 'never' || /not applicable|n a|do not use|don't use/.test(nrm(o)); });
        if (na >= 0) return opts[na];
      }
      // Ordinal (Likert-like) lists follow the respondent's leniency.
      var lo = likertOrder(opts);
      if (lo && q.type === 'multiple_choice' || (lo && q.type === 'dropdown')) {
        var n = lo.length, mid = (n - 1) / 2;
        var lean = p.traits.leniency * ((n - 1) / 4) * (0.5 + s.consistency / 2);
        var sd = Math.max(0.35, (n - 1) * (0.1 + 0.28 * s.variation));
        var pos = rng.chance(s.randomization * 0.2) ? rng.int(0, n - 1) : Math.round(Util.clamp(rng.normal(mid + lean, sd), 0, n - 1));
        return opts[lo[pos]];
      }
      var w = Local.choiceWeights(q, p, rng, s, opts);
      return opts[rng.weighted(opts.map(function (o, i) { return i; }), function (i) { return w[i]; })];
    },

    /** Picks the option for a frequency level; never contradicts a 'never' profile. */
    freqIndex: function (opts, freq, forceLowest, required) {
      var levels = opts.map(freqLevel);
      var target = FREQ_ORDER.indexOf(freq), i;
      for (i = 0; i < opts.length; i++) if (levels[i] === freq) return i;
      var detected = levels.map(function (l, ix) { return l ? ix : -1; }).filter(function (ix) { return ix >= 0; });
      if (forceLowest) {
        // No explicit "never"/"N/A" option: pick the lowest available level (or the lowest ordinal position).
        if (detected.length >= 2) {
          return detected.sort(function (a, b) { return FREQ_ORDER.indexOf(levels[a]) - FREQ_ORDER.indexOf(levels[b]); })[0];
        }
        var firstHigh = levels[0] === 'daily' || /\bmost|every\b/.test(nrm(opts[0]));
        return firstHigh ? opts.length - 1 : 0;
      }
      if (detected.length >= 2) {
        var bestI = detected[0], bestD = 99;
        detected.forEach(function (ix) {
          var d = Math.abs(FREQ_ORDER.indexOf(levels[ix]) - target);
          if (d < bestD) { bestD = d; bestI = ix; }
        });
        return bestI;
      }
      // Ordinal fallback assuming ascending order, flipped when the first option reads as the highest.
      var desc = /\b(daily|every|most|always)\b/.test(nrm(opts[0])) || /\b(never|rarely|none|less)\b/.test(nrm(opts[opts.length - 1]));
      var lv = target / 4;
      return opts.indexOf(ordinalPick(opts, desc ? 1 - lv : lv));
    },

    modeIndex: function (opts, mode, t) {
      var res = MODE_TOKENS[mode] || [];
      var idx = opts.findIndex(function (o) { var n = nrm(o); return res.some(function (re) { return re.test(n); }); });
      return idx;
    },

    checkbox: function (q, p, rng, sem, s, opts) {
      if (!opts.length) return null;
      var t = p.travel, chosen = [], i;
      if (sem === 'travel_mode') {
        opts.forEach(function (o, ix) {
          var n = nrm(o);
          Object.keys(MODE_TOKENS).forEach(function (m) {
            if (t.modes.indexOf(m) >= 0 && MODE_TOKENS[m].some(function (re) { return re.test(n); })) chosen.push(o);
          });
        });
        chosen = chosen.filter(function (o, ix) { return chosen.indexOf(o) === ix; });
        if (chosen.length) return chosen;
      }
      var busQ = isBusText(q.text);
      var w = Local.choiceWeights(q, p, rng, s, opts);
      var k = 1 + Math.floor(rng.next() * (1 + Math.min(opts.length - 1, 2 + Math.round(s.variation * 2))));
      var pool = opts.map(function (o, ix) { return ix; });
      for (i = 0; i < k && pool.length; i++) {
        var ix = rng.weighted(pool, function (j) {
          var o = nrm(opts[j]);
          if (!t.usesBus && /\bbus(es)?\b/.test(o)) return 0;       // consistency: non-users never tick bus options
          if (/^none of the above/.test(o)) return w[j] * 0.1;
          return w[j];
        });
        pool.splice(pool.indexOf(ix), 1);
        if (!(!t.usesBus && /\bbus(es)?\b/.test(nrm(opts[ix])))) chosen.push(opts[ix]);
      }
      var none = chosen.filter(function (o) { return /^none of the above/.test(nrm(o)); });
      if (none.length && chosen.length > 1) chosen = chosen.filter(function (o) { return none.indexOf(o) < 0; });
      if (!chosen.length && q.required) chosen.push(opts[0]);
      return chosen.length ? chosen : (q.required ? [opts[0]] : null);
    },

    /** Generates answers for all given questions. Returns { key: value|null }. */
    generate: function (profile, questions, ctx) {
      var out = {};
      (questions || []).forEach(function (q) {
        out[q.key] = Local.answerQuestion(q, profile, ctx);
      });
      return out;
    },

    /** Returns contradictions between a profile and the answers given for semantic questions. */
    checkConsistency: function (profile, questions, answers) {
      var errs = [], t = profile.travel;
      (questions || []).forEach(function (q) {
        var a = answers[q.key]; if (a == null) return;
        var sem = q.semantic || Parser.classify(q);
        var text = Array.isArray(a) ? a.join(' ') : String(a);
        if (sem === 'bus_freq' && !t.usesBus && q.options && q.options.length) {
          var lvl = freqLevel(text);
          if (hasNeverOption(q.options)) {
            if (lvl && lvl !== 'never') errs.push(q.text + ': non bus user answered "' + text + '"');
          } else {
            // No truthful option exists: the answer must at least be the lowest frequency on offer.
            var ranks = q.options.map(freqLevel).filter(Boolean).map(function (l) { return FREQ_ORDER.indexOf(l); });
            if (lvl && ranks.length && FREQ_ORDER.indexOf(lvl) > Math.min.apply(null, ranks)) errs.push(q.text + ': non bus user answered "' + text + '" although a lower frequency was available');
          }
        }
        if (sem === 'bus_use') {
          var yes = /^(yes|y)\b/.test(nrm(text));
          if (!t.usesBus && yes) errs.push(q.text + ': non bus user answered yes');
          if (t.usesBus && /^no\b/.test(nrm(text))) errs.push(q.text + ': bus user answered no');
        }
        if (sem === 'student') {
          var sy = /^(yes|y)\b/.test(nrm(text));
          if (sy !== profile.isStudent) errs.push(q.text + ': student answer contradicts profile');
        }
        if (sem === 'age' && q.options && q.options.length) {
          var r = parseAgeRange(text);
          if (r && (profile.age < r[0] || profile.age > r[1])) errs.push(q.text + ': age option "' + text + '" excludes age ' + profile.age);
        }
        if (sem === 'travel_mode' && !t.usesBus && /\bbus(es)?\b/.test(nrm(text))) errs.push(q.text + ': non bus user selected bus mode');
        if (q.type === 'checkbox' && !t.usesBus && Array.isArray(a) && a.some(function (o) { return /\bbus(es)?\b/.test(nrm(o)); })) {
          errs.push(q.text + ': non bus user ticked a bus option');
        }
        if (q.options && q.options.length && (q.type === 'multiple_choice' || q.type === 'dropdown' || q.type === 'linear_scale' || q.type === 'rating') && q.options.indexOf(a) < 0) {
          errs.push(q.text + ': answer "' + a + '" is not one of the options');
        }
      });
      return errs;
    }
  };

  /** Makes AI output safe: every choice answer must be one of the real options. */
  function sanitizeAnswers(questions, raw, profile) {
    var out = {}, issues = [];
    questions.forEach(function (q) {
      if (!(q.key in raw)) return;
      var v = raw[q.key];
      if (v === null || v === '') { out[q.key] = q.required ? undefined : null; if (q.required) delete out[q.key]; return; }
      var opts = q.options || [];
      if (q.type === 'checkbox') {
        var arr = Array.isArray(v) ? v : [v];
        var mapped = [];
        arr.forEach(function (x) { var i = Parser.matchOption(opts, x); if (i >= 0 && mapped.indexOf(opts[i]) < 0) mapped.push(opts[i]); });
        if (!mapped.length) { issues.push('unusable checkbox answer for ' + q.text); return; }
        out[q.key] = mapped;
      } else if (q.type === 'multiple_choice' || q.type === 'dropdown' || q.type === 'linear_scale' || q.type === 'rating') {
        var ix = Parser.matchOption(opts, Array.isArray(v) ? v[0] : v);
        if (ix < 0) { issues.push('answer "' + v + '" not an option for ' + q.text); return; }
        out[q.key] = opts[ix];
      } else {
        out[q.key] = Array.isArray(v) ? v.join(', ') : String(v);
      }
    });
    // Hard consistency check against the profile; violating answers are dropped so local mode can fill them.
    if (profile) {
      var bad = Local.checkConsistency(profile, questions.filter(function (q) { return q.key in out; }), out);
      if (bad.length) {
        questions.forEach(function (q) {
          var one = Local.checkConsistency(profile, [q], out);
          if (one.length) { delete out[q.key]; issues.push('AI answer contradicted profile: ' + one[0]); }
        });
      }
    }
    return { answers: out, issues: issues };
  }

  var AnswerGen = {
    Local: Local,
    sanitizeAnswers: sanitizeAnswers,
    parseAgeRange: parseAgeRange,
    freqLevel: freqLevel,

    /**
     * Orchestrates generation for one respondent.
     * opts: { mode: 'local'|'ai', profile, questions, settings: {apiKey, model, language, aiRetries, aiTimeoutMs, autoFallback}, fetchImpl, sleepImpl, today }
     * Resolves { answers, source: 'local'|'ai'|'mixed', warnings: [], aiError: {code,message}|null, ms }
     */
    generate: function (opts) {
      var t0 = Util.mono();
      var settings = opts.settings || {};
      var profile = opts.profile, questions = opts.questions || [];
      var ctx = { language: settings.language, today: opts.today };
      var warnings = [];

      function finish(answers, source, aiError) {
        return { answers: answers, source: source, warnings: warnings, aiError: aiError || null, ms: Util.mono() - t0 };
      }
      if (opts.mode !== 'ai') return Promise.resolve(finish(Local.generate(profile, questions, ctx), 'local'));

      var AI = getAI();
      return AI.generateAnswers({
        apiKey: settings.apiKey, model: settings.model, profile: profile, questions: questions,
        language: settings.language, maxRetries: settings.aiRetries, timeoutMs: settings.aiTimeoutMs,
        fetchImpl: opts.fetchImpl, sleepImpl: opts.sleepImpl
      }).then(function (res) {
        var clean = sanitizeAnswers(questions, res.answers || {}, profile);
        warnings = warnings.concat(clean.issues);
        if (res.errors && res.errors.length) warnings = warnings.concat(res.errors.map(function (e) { return e.message; }));
        var missing = questions.filter(function (q) { return !(q.key in clean.answers); });
        if (!missing.length) return finish(clean.answers, 'ai', null);
        // Partial generation: fill the rest locally so the respondent is still usable.
        var local = Local.generate(profile, missing, ctx);
        warnings.push(missing.length + ' answer(s) filled locally because AI output was missing or unusable.');
        return finish(Object.assign({}, clean.answers, local), Object.keys(clean.answers).length ? 'mixed' : 'local', res.errors && res.errors[0] || null);
      }).catch(function (err) {
        var info = { code: err.code || 'UNKNOWN', message: Util.redact(err.message, [settings.apiKey]) };
        if (settings.autoFallback === false) throw err;
        warnings.push('AI generation failed (' + info.code + '): ' + info.message + ' Falling back to local generation.');
        return finish(Local.generate(profile, questions, ctx), 'local', info);
      });
    }
  };

  return { AnswerGen: AnswerGen };
});
