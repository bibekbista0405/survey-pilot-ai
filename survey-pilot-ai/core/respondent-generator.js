/* SurveyPilot AI - synthetic respondent profile generator.
   Every profile is synthetic: names come from small fictional banks, emails use example.com,
   phone numbers use the reserved fictional 555-01xx range. */
(function (root, factory) {
  var dep = (typeof require === 'function' && typeof module === 'object') ? require('./util.js') : root.SP;
  var api = factory(dep.Util);
  if (typeof module === 'object' && module.exports) module.exports = api;
  var SP = (root.SP = root.SP || {});
  Object.keys(api).forEach(function (k) { SP[k] = api[k]; });
})(typeof globalThis !== 'undefined' ? globalThis : self, function (Util) {
  'use strict';

  var FIRST = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Riley', 'Casey', 'Avery', 'Quinn', 'Rowan',
    'Maya', 'Noah', 'Lena', 'Omar', 'Priya', 'Mateo', 'Sofia', 'Ravi', 'Hana', 'Luca', 'Zara', 'Eli'];
  var LAST = ['Rivera', 'Khan', 'Novak', 'Silva', 'Okafor', 'Tanaka', 'Meyer', 'Costa', 'Ivanov',
    'Haddad', 'Nguyen', 'Larsen', 'Moreau', 'Patel', 'Santos', 'Weber', 'Kowalski', 'Mendes'];

  /** category is used by the answer generator to match option text. */
  var OCCUPATIONS = [
    { name: 'Student', category: 'student', min: 16, max: 35, isStudent: true, w: 1 },
    { name: 'Software engineer', category: 'employed', min: 21, max: 66, w: 1 },
    { name: 'Teacher', category: 'employed', min: 23, max: 66, w: 1 },
    { name: 'Nurse', category: 'employed', min: 22, max: 66, w: 1 },
    { name: 'Retail worker', category: 'employed', min: 16, max: 70, w: 1 },
    { name: 'Office administrator', category: 'employed', min: 19, max: 68, w: 1 },
    { name: 'Delivery driver', category: 'employed', min: 20, max: 68, w: 0.6 },
    { name: 'Manager', category: 'employed', min: 28, max: 68, w: 0.8 },
    { name: 'Government employee', category: 'employed', min: 22, max: 66, w: 0.7 },
    { name: 'Self-employed', category: 'self-employed', min: 22, max: 75, w: 0.8 },
    { name: 'Freelancer', category: 'self-employed', min: 20, max: 70, w: 0.6 },
    { name: 'Homemaker', category: 'homemaker', min: 22, max: 80, w: 0.5 },
    { name: 'Unemployed', category: 'unemployed', min: 18, max: 65, w: 0.4 },
    { name: 'Retired', category: 'retired', min: 58, max: 95, w: 1 }
  ];

  var GEO = {
    urban: { label: 'Urban', busBoost: 1.5, carBoost: 0.8 },
    suburban: { label: 'Suburban', busBoost: 0.9, carBoost: 1.2 },
    rural: { label: 'Rural', busBoost: 0.35, carBoost: 1.5 }
  };

  var FREQS = ['never', 'rarely', 'monthly', 'weekly', 'daily'];

  var Gen = {
    OCCUPATIONS: OCCUPATIONS,
    FREQS: FREQS,

    defaultConfig: function () {
      return {
        count: 10,
        ageRanges: [
          { min: 18, max: 24, weight: 25 }, { min: 25, max: 34, weight: 30 },
          { min: 35, max: 49, weight: 25 }, { min: 50, max: 64, weight: 15 }, { min: 65, max: 80, weight: 5 }
        ],
        genderDist: { female: 48, male: 48, nonbinary: 3, undisclosed: 1 },
        occupations: OCCUPATIONS.map(function (o) { return { name: o.name, weight: o.w }; }),
        studentShare: 0.25,
        geoProfiles: [{ name: 'urban', weight: 55 }, { name: 'suburban', weight: 30 }, { name: 'rural', weight: 15 }],
        travel: { busUseShare: 0.45, carUseShare: 0.55, bikeShare: 0.2, dailyCommuterShare: 0.5 },
        responseVariation: 0.5,   // 0..1 spread of scale/choice answers
        randomization: 0.5,       // 0..1 how far answers drift from the most likely option
        consistency: 0.8,         // 0..1 how tightly answers follow the profile
        language: 'en',
        seed: null
      };
    },

    /** Merges a partial config over defaults and validates ranges. */
    normalizeConfig: function (partial) {
      var d = Gen.defaultConfig(), c = Object.assign({}, d, partial || {});
      c.travel = Object.assign({}, d.travel, (partial && partial.travel) || {});
      c.genderDist = Object.assign({}, d.genderDist, (partial && partial.genderDist) || {});
      ['responseVariation', 'randomization', 'consistency', 'studentShare'].forEach(function (k) {
        c[k] = Util.clamp(Number(c[k]), 0, 1); if (isNaN(c[k])) c[k] = d[k];
      });
      ['busUseShare', 'carUseShare', 'bikeShare', 'dailyCommuterShare'].forEach(function (k) {
        c.travel[k] = Util.clamp(Number(c.travel[k]), 0, 1); if (isNaN(c.travel[k])) c.travel[k] = d.travel[k];
      });
      c.count = Util.clamp(parseInt(c.count, 10) || d.count, 1, 5000);
      c.ageRanges = (c.ageRanges || []).filter(function (r) { return r && r.max >= r.min && r.min >= 16 && r.weight > 0; });
      if (!c.ageRanges.length) c.ageRanges = d.ageRanges;
      c.occupations = (c.occupations || []).filter(function (o) { return o && o.weight > 0; });
      if (!c.occupations.length) c.occupations = d.occupations;
      c.geoProfiles = (c.geoProfiles || []).filter(function (g) { return g && GEO[g.name] && g.weight > 0; });
      if (!c.geoProfiles.length) c.geoProfiles = d.geoProfiles;
      return c;
    },

    ageGroupLabel: function (age) {
      if (age < 25) return '18-24'; if (age < 35) return '25-34'; if (age < 45) return '35-44';
      if (age < 55) return '45-54'; if (age < 65) return '55-64'; return '65+';
    },

    /** Generates one respondent profile. Deterministic for (config, index, seed). */
    generate: function (partialConfig, index, seed) {
      var cfg = Gen.normalizeConfig(partialConfig);
      if (seed == null) seed = (cfg.seed != null ? cfg.seed : Math.floor(Math.random() * 2147483647)) + index * 7919;
      var rng = Util.rng(seed);

      // Age
      var range = rng.weighted(cfg.ageRanges, function (r) { return r.weight; });
      var age = rng.int(range.min, range.max);

      // Gender
      var gKeys = Object.keys(cfg.genderDist);
      var gender = rng.weighted(gKeys, function (k) { return cfg.genderDist[k]; });

      // Student status: decided first, then occupation must agree (age/occupation consistency).
      var studentP = age <= 24 ? Math.min(1, cfg.studentShare * 1.8) : age <= 35 ? cfg.studentShare * 0.5 : 0;
      var wantStudent = rng.chance(studentP);
      var pool = cfg.occupations.map(function (o) {
        var def = OCCUPATIONS.filter(function (d) { return d.name === o.name; })[0] ||
          { name: o.name, category: 'employed', min: 18, max: 70 };
        return { def: def, weight: o.weight };
      }).filter(function (o) { return age >= o.def.min && age <= o.def.max; });
      var nonStudents = pool.filter(function (o) { return !o.def.isStudent; });
      var students = pool.filter(function (o) { return o.def.isStudent; });
      var occ;
      if (wantStudent && students.length) occ = students[0].def;
      else if (nonStudents.length) occ = rng.weighted(nonStudents, function (o) { return o.weight; }).def;
      else occ = pool.length ? pool[0].def : { name: 'Retail worker', category: 'employed' };
      var isStudent = !!occ.isStudent;
      // Part-time students who also work (only when young and the config allows students).
      var alsoStudying = !isStudent && age <= 30 && rng.chance(cfg.studentShare * 0.15);
      if (alsoStudying) isStudent = true;

      var education = age < 20 ? 'high school' : isStudent ? rng.pick(['high school', 'bachelor', 'bachelor', 'master'])
        : rng.weighted(['high school', 'bachelor', 'master', 'doctorate'], function (e) {
          return e === 'bachelor' ? 4 : e === 'high school' ? 3 : e === 'master' ? 2 : 0.4;
        });

      var incomeBand = (isStudent || occ.category === 'unemployed') ? 'low'
        : occ.category === 'retired' ? rng.pick(['low', 'medium', 'medium'])
          : rng.weighted(['low', 'medium', 'high'], function (b) { return b === 'medium' ? 5 : b === 'low' ? 2.5 : 1.5; });

      // Geography
      var geoName = rng.weighted(cfg.geoProfiles, function (g) { return g.weight; }).name;
      var geo = GEO[geoName];

      // Travel behaviour with hard consistency: busFrequency 'never' <=> usesBus false.
      var busP = Util.clamp(cfg.travel.busUseShare * geo.busBoost * (isStudent ? 1.3 : 1) * (age > 70 ? 0.8 : 1), 0, 0.97);
      var usesBus = rng.chance(busP);
      var busFrequency = 'never';
      if (usesBus) {
        var commuter = rng.chance(cfg.travel.dailyCommuterShare * (occ.category === 'retired' || occ.category === 'homemaker' || occ.category === 'unemployed' ? 0.35 : 1));
        busFrequency = rng.weighted(['rarely', 'monthly', 'weekly', 'daily'], function (f) {
          if (f === 'daily') return commuter ? 5 : 0.6;
          if (f === 'weekly') return commuter ? 2.5 : 3;
          return commuter ? 0.7 : 2;
        });
      }
      var carP = Util.clamp(cfg.travel.carUseShare * geo.carBoost * (age < 20 ? 0.3 : 1) * (usesBus ? 0.8 : 1.1), 0, 0.97);
      var usesCar = rng.chance(carP);
      var usesBike = rng.chance(cfg.travel.bikeShare * (geoName === 'rural' ? 0.5 : 1));
      var walks = rng.chance(0.75);
      var modes = [];
      if (usesBus) modes.push('bus'); if (usesCar) modes.push('car'); if (usesBike) modes.push('bike'); if (walks) modes.push('walk');
      if (!modes.length) modes.push('walk');
      var mainMode = usesBus && busFrequency === 'daily' ? 'bus'
        : rng.weighted(modes, function (m) { return m === 'car' ? 3 : m === 'bus' ? (busFrequency === 'weekly' ? 3 : 1.5) : 1; });
      var tripsPerWeek = Util.clamp(Math.round(rng.normal(occ.category === 'retired' ? 5 : 9, 3)), 1, 25);

      var first = rng.pick(FIRST), last = rng.pick(LAST);
      var traits = {
        leniency: Util.clamp(rng.normal(0.1, 0.55), -1, 1),       // positive = rates things higher
        verbosity: rng.next(),
        extreme: rng.chance(0.15),                                 // tends to pick scale ends
        skipOptional: Util.clamp(0.1 + rng.next() * 0.25, 0, 0.5)  // chance to skip an optional question
      };

      return {
        id: 'SYN-' + String(index + 1).padStart(4, '0'),
        synthetic: true,
        seed: seed, index: index,
        name: first + ' ' + last,
        email: (first + '.' + last + (index + 1)).toLowerCase() + '@example.com',
        phone: '+1 555-01' + String(rng.int(0, 99)).padStart(2, '0'),
        age: age, ageGroup: Gen.ageGroupLabel(age), gender: gender,
        occupation: occ.name, occupationCategory: occ.category, isStudent: isStudent,
        education: education, incomeBand: incomeBand,
        region: geoName, regionLabel: geo.label,
        travel: { usesBus: usesBus, busFrequency: busFrequency, usesCar: usesCar, usesBike: usesBike,
          walks: walks, modes: modes, mainMode: mainMode, tripsPerWeek: tripsPerWeek },
        traits: traits,
        settings: { variation: cfg.responseVariation, randomization: cfg.randomization,
          consistency: cfg.consistency, language: cfg.language }
      };
    },

    generateMany: function (partialConfig, count, startIndex) {
      var cfg = Gen.normalizeConfig(partialConfig);
      var n = count == null ? cfg.count : count, out = [];
      var base = cfg.seed != null ? cfg.seed : Math.floor(Math.random() * 2147483647);
      for (var i = 0; i < n; i++) {
        var idx = (startIndex || 0) + i;
        out.push(Gen.generate(cfg, idx, base + idx * 7919));
      }
      return out;
    },

    /** Returns a list of hard-rule violations for a profile (empty when consistent). */
    validateProfile: function (p) {
      var errs = [];
      var occ = OCCUPATIONS.filter(function (o) { return o.name === p.occupation; })[0];
      if (occ && (p.age < occ.min || p.age > occ.max)) errs.push('age ' + p.age + ' outside range for ' + p.occupation);
      if (p.occupation === 'Student' && !p.isStudent) errs.push('Student occupation without student flag');
      if (p.occupationCategory === 'retired' && p.age < 55) errs.push('retired under 55');
      if (!p.travel.usesBus && p.travel.busFrequency !== 'never') errs.push('non bus user with bus frequency ' + p.travel.busFrequency);
      if (p.travel.usesBus && p.travel.busFrequency === 'never') errs.push('bus user with frequency never');
      if (p.travel.mainMode === 'bus' && !p.travel.usesBus) errs.push('main mode bus but not a bus user');
      if (p.travel.mainMode === 'car' && !p.travel.usesCar) errs.push('main mode car but not a car user');
      return errs;
    }
  };

  return { RespondentGen: Gen };
});
