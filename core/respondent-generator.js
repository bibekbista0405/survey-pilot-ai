/*
 * SurveyPilot AI - Synthetic Respondent Generator
 * Generates diverse, internally-consistent synthetic respondent profiles using
 * weighted random distributions. Profiles drive answer generation in answer-generator.js.
 */
(function (global) {
  'use strict';

  const SP = global.SurveyPilot || {};
  const makeId = (SP.SurveyParser && SP.SurveyParser.makeId) || (() => 'r_' + Math.random().toString(36).slice(2));

  // Default configuration with weighted options
  const DEFAULT_CONFIG = {
    count: 1,
    ageRanges: [
      { label: '18-24', min: 18, max: 24, weight: 20 },
      { label: '25-34', min: 25, max: 34, weight: 25 },
      { label: '35-44', min: 35, max: 44, weight: 20 },
      { label: '45-54', min: 45, max: 54, weight: 15 },
      { label: '55-64', min: 55, max: 64, weight: 10 },
      { label: '65+',   min: 65, max: 80, weight: 10 }
    ],
    genderDistribution: [
      { label: 'female', weight: 49 },
      { label: 'male', weight: 48 },
      { label: 'non-binary', weight: 2 },
      { label: 'prefer-not-to-say', weight: 1 }
    ],
    occupations: [
      { label: 'Student', weight: 18 },
      { label: 'Engineer', weight: 10 },
      { label: 'Teacher', weight: 8 },
      { label: 'Healthcare worker', weight: 8 },
      { label: 'Sales', weight: 7 },
      { label: 'Designer', weight: 6 },
      { label: 'Manager', weight: 8 },
      { label: 'Retired', weight: 12 },
      { label: 'Unemployed', weight: 6 },
      { label: 'Other', weight: 17 }
    ],
    studentStatuses: [
      { label: 'full-time', weight: 15 },
      { label: 'part-time', weight: 8 },
      { label: 'not-a-student', weight: 77 }
    ],
    regions: [
      { label: 'Urban', weight: 55 },
      { label: 'Suburban', weight: 30 },
      { label: 'Rural', weight: 15 }
    ],
    travelBehaviors: [
      { label: 'daily', weight: 30 },
      { label: 'weekly', weight: 25 },
      { label: 'monthly', weight: 20 },
      { label: 'rarely', weight: 15 },
      { label: 'never', weight: 10 }
    ],
    languages: [
      { label: 'en', weight: 90 },
      { label: 'es', weight: 5 },
      { label: 'fr', weight: 3 },
      { label: 'de', weight: 2 }
    ],
    responseVariation: 0.7,    // 0..1, higher = more diverse
    randomizationLevel: 0.5,   // 0..1
    consistencyLevel: 0.9,     // 0..1, higher = stricter consistency
    language: 'en'
  };

  function weightedPick(options, rng) {
    const total = options.reduce((s, o) => s + (o.weight || 0), 0);
    let r = (rng ? rng() : Math.random()) * total;
    for (const o of options) {
      r -= (o.weight || 0);
      if (r <= 0) return o.label !== undefined ? o.label : o;
    }
    return options[options.length - 1].label !== undefined ? options[options.length - 1].label : options[options.length - 1];
  }

  // Mulberry32 seeded PRNG so runs are reproducible if a seed is supplied
  function makeRng(seed) {
    if (seed == null) return Math.random;
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pickInt(min, max, rng) {
    return Math.floor((rng ? rng() : Math.random()) * (max - min + 1)) + min;
  }

  function pickBool(prob, rng) {
    return (rng ? rng() : Math.random()) < prob;
  }

  // Build a single internally consistent respondent profile
  function generateProfile(config, rng) {
    config = config || DEFAULT_CONFIG;
    rng = rng || Math.random;

    const ageRange = weightedPick(config.ageRanges, rng);
    const matched = config.ageRanges.find((r) => r.label === ageRange) || config.ageRanges[0];
    const age = pickInt(matched.min, matched.max, rng);
    const gender = weightedPick(config.genderDistribution, rng);
    let occupation = weightedPick(config.occupations, rng);
    let studentStatus = weightedPick(config.studentStatuses, rng);

    // Consistency rule #1: age under 22 strongly biases to student status
    if (age < 22 && pickBool(config.consistencyLevel, rng)) {
      if (studentStatus === 'not-a-student') {
        studentStatus = pickBool(0.7, rng) ? 'full-time' : 'part-time';
      }
    }
    // Consistency rule #2: 65+ unlikely to be 'Student' (unless explicitly)
    if (age >= 65 && occupation === 'Student' && pickBool(config.consistencyLevel, rng)) {
      occupation = 'Retired';
    }
    // Consistency rule #3: Retired implies age >= 55 usually
    if (occupation === 'Retired' && age < 55 && pickBool(config.consistencyLevel, rng)) {
      occupation = 'Other';
    }
    if (studentStatus !== 'not-a-student' && occupation !== 'Student' && pickBool(0.6 * config.consistencyLevel, rng)) {
      // Reconcile: keep student flag, treat occupation as 'Student'
      occupation = 'Student';
    }

    const region = weightedPick(config.regions, rng);
    const travelBehavior = weightedPick(config.travelBehaviors, rng);
    const language = config.language || weightedPick(config.languages, rng);

    return {
      age,
      ageRange,
      gender,
      occupation,
      studentStatus,
      region,
      travelBehavior,
      language
    };
  }

  // Public API: generate N respondents, each with its own profile
  // Answers are generated lazily by answer-generator.js once the survey is known.
  async function generateRespondents({ count, config, seed, surveyId, mode }) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    cfg.ageRanges = config && config.ageRanges ? config.ageRanges : DEFAULT_CONFIG.ageRanges;
    cfg.genderDistribution = config && config.genderDistribution ? config.genderDistribution : DEFAULT_CONFIG.genderDistribution;
    cfg.occupations = config && config.occupations ? config.occupations : DEFAULT_CONFIG.occupations;
    cfg.studentStatuses = config && config.studentStatuses ? config.studentStatuses : DEFAULT_CONFIG.studentStatuses;
    cfg.regions = config && config.regions ? config.regions : DEFAULT_CONFIG.regions;
    cfg.travelBehaviors = config && config.travelBehaviors ? config.travelBehaviors : DEFAULT_CONFIG.travelBehaviors;
    cfg.languages = config && config.languages ? config.languages : DEFAULT_CONFIG.languages;

    const n = Math.max(1, Math.min(500, parseInt(count, 10) || 1));
    const rng = makeRng(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
      const profile = generateProfile(cfg, rng);
      const startedAt = Date.now();
      const respondent = {
        id: makeId('resp'),
        surveyId: surveyId || null,
        index: i + 1,
        profile,
        answers: {},
        generatedAt: startedAt,
        generationTime: 0,
        generationMode: mode || 'local'
      };
      respondent.generationTime = Date.now() - startedAt;
      out.push(respondent);
    }
    return out;
  }

  // Regenerate a single respondent (new profile, fresh id)
  async function regenerate(respondent, config, mode) {
    const fresh = (await generateRespondents({ count: 1, config, mode }))[0];
    fresh.id = respondent.id; // keep id stable for replacement
    fresh.surveyId = respondent.surveyId;
    fresh.index = respondent.index;
    return fresh;
  }

  // Duplicate a respondent (new id, same profile+answers)
  function duplicate(respondent) {
    const copy = JSON.parse(JSON.stringify(respondent));
    copy.id = makeId('resp');
    copy.generatedAt = Date.now();
    copy.index = null;
    return copy;
  }

  const RespondentGenerator = {
    DEFAULT_CONFIG,
    generateRespondents,
    generateProfile,
    regenerate,
    duplicate,
    makeRng,
    weightedPick
  };

  global.SurveyPilot = global.SurveyPilot || {};
  global.SurveyPilot.RespondentGenerator = RespondentGenerator;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
