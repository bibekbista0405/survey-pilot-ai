'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Util } = require('../core/util.js');
const { Parser } = require('../core/survey-parser.js');
const { RespondentGen: Gen } = require('../core/respondent-generator.js');
const { AnswerGen } = require('../core/answer-generator.js');
const { AI } = require('../core/ai-client.js');
const { Stats } = require('../core/statistics.js');
const { Export: Exp } = require('../core/export.js');

const Q = (o) => Object.assign({ key: 'k' + Math.random().toString(36).slice(2, 7), required: true, options: [] }, o);

/* ---------------- parsing ---------------- */
test('questionKey is stable and sensitive to content', () => {
  const a = { text: 'How old are you?', type: 'short_answer', options: [] };
  assert.equal(Parser.questionKey(a), Parser.questionKey({ ...a }));
  assert.notEqual(Parser.questionKey(a), Parser.questionKey({ ...a, text: 'How tall are you?' }));
  assert.equal(Parser.questionKey({ ...a, entryId: '123' }), 'e:123');
});

test('destinationKey treats Google viewform and formResponse as one destination', () => {
  const v = Parser.destinationKey('https://docs.google.com/forms/d/e/ABC/viewform?usp=sf_link');
  const r = Parser.destinationKey('https://docs.google.com/forms/d/e/ABC/formResponse');
  assert.equal(v, r);
  assert.notEqual(v, Parser.destinationKey('https://docs.google.com/forms/d/e/OTHER/viewform'));
  assert.notEqual(Parser.destinationKey('http://localhost/a.html?x=1'), Parser.destinationKey('http://localhost/a.html?x=2'));
});

test('matchOption: exact, numeric, prefix, token overlap, no match', () => {
  const opts = ['Never', 'A few times a week', 'Every day', '5'];
  assert.equal(Parser.matchOption(opts, 'never'), 0);
  assert.equal(Parser.matchOption(opts, 'every day'), 2);
  assert.equal(Parser.matchOption(opts, '5.0'), 3);
  assert.equal(Parser.matchOption(opts, 'few times a week'), 1);
  assert.equal(Parser.matchOption(opts, 'zebra'), -1);
  assert.equal(Parser.matchOption([], 'x'), -1);
});

test('buildSurvey merges new questions without losing old ones and summarises', () => {
  const s1 = Parser.buildSurvey({ url: 'http://x/y', title: 'T', questions: [{ text: 'Q1 *', type: 'short_answer', required: true, options: [], sectionIndex: 0 }] });
  const s2 = Parser.buildSurvey({ url: 'http://x/y', title: 'T', questions: [{ text: 'Q2', type: 'checkbox', required: false, options: ['a', 'b'], sectionIndex: 1 }] }, s1);
  assert.equal(s2.questions.length, 2);
  assert.equal(s2.questions[0].text, 'Q1');
  assert.deepEqual(s2.summary, { questionCount: 2, requiredCount: 1, sectionCount: 2, types: { short_answer: 1, checkbox: 1 } });
});

test('classify recognises semantic questions', () => {
  const c = (text) => Parser.classify({ text });
  assert.equal(c('How often do you use the bus?'), 'bus_freq');
  assert.equal(c('Do you use the bus?'), 'bus_use');
  assert.equal(c('What is your age group?'), 'age');
  assert.equal(c('Are you currently a student?'), 'student');
  assert.equal(c('Your email address'), 'email');
  assert.equal(c('Something unrelated'), 'generic');
});

/* ---------------- respondent generation ---------------- */
test('profiles are deterministic for a seed and different across seeds', () => {
  const a = Gen.generateMany({ seed: 11 }, 5), b = Gen.generateMany({ seed: 11 }, 5), c = Gen.generateMany({ seed: 12 }, 5);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((p) => p.age), c.map((p) => p.age));
});

test('profile hard rules hold over 1500 respondents, including extreme configs', () => {
  const configs = [{ seed: 1 }, { seed: 2, studentShare: 1, travel: { busUseShare: 0 } }, { seed: 3, studentShare: 0, travel: { busUseShare: 1 } },
    { seed: 4, ageRanges: [{ min: 60, max: 90, weight: 1 }] }, { seed: 5, ageRanges: [{ min: 16, max: 19, weight: 1 }], studentShare: 0 }];
  let n = 0;
  configs.forEach((cfg) => Gen.generateMany(cfg, 300).forEach((p) => {
    const errs = Gen.validateProfile(p); n++;
    assert.deepEqual(errs, [], p.id + ': ' + errs.join('; '));
    assert.equal(p.synthetic, true);
    assert.match(p.email, /@example\.com$/);
    assert.match(p.phone, /^\+1 555-01\d\d$/);
  }));
  assert.equal(n, 1500);
});

test('config distributions are respected (bus share, gender, ages)', () => {
  const none = Gen.generateMany({ seed: 5, travel: { busUseShare: 0 } }, 300);
  assert.ok(none.every((p) => !p.travel.usesBus && p.travel.busFrequency === 'never'));
  const all = Gen.generateMany({ seed: 5, travel: { busUseShare: 1 }, geoProfiles: [{ name: 'urban', weight: 1 }] }, 300);
  assert.ok(all.filter((p) => p.travel.usesBus).length > 270);
  const women = Gen.generateMany({ seed: 6, genderDist: { female: 100, male: 0, nonbinary: 0, undisclosed: 0 } }, 100);
  assert.ok(women.every((p) => p.gender === 'female'));
  const old = Gen.generateMany({ seed: 7, ageRanges: [{ min: 70, max: 75, weight: 1 }] }, 100);
  assert.ok(old.every((p) => p.age >= 70 && p.age <= 75 && !p.isStudent));
});

test('normalizeConfig clamps bad input instead of throwing', () => {
  const c = Gen.normalizeConfig({ count: -4, consistency: 9, ageRanges: [{ min: 5, max: 3, weight: 1 }], geoProfiles: [{ name: 'moon', weight: 1 }] });
  assert.equal(c.count, 1); assert.equal(c.consistency, 1);
  assert.ok(c.ageRanges.length >= 1 && c.geoProfiles.every((g) => ['urban', 'suburban', 'rural'].includes(g.name)));
});

/* ---------------- local answer generation ---------------- */
const BATTERY = [
  Q({ key: 'age', text: 'What is your age group?', type: 'multiple_choice', options: ['Under 18', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'] }),
  Q({ key: 'gender', text: 'What is your gender?', type: 'multiple_choice', options: ['Female', 'Male', 'Non-binary', 'Prefer not to say'] }),
  Q({ key: 'student', text: 'Are you currently a student?', type: 'multiple_choice', options: ['Yes', 'No'] }),
  Q({ key: 'bususe', text: 'Do you use the bus?', type: 'multiple_choice', options: ['Yes, regularly', 'Sometimes', 'No'] }),
  Q({ key: 'busfreq', text: 'How often do you use the bus?', type: 'multiple_choice', options: ['Never', 'Rarely', 'A few times a week', 'Every day'] }),
  Q({ key: 'busfreq2', text: 'How often do you travel by bus?', type: 'dropdown', options: ['Daily', 'Weekly', 'Monthly', 'Rarely'] }),
  Q({ key: 'modes', text: 'Which modes of transport do you use?', type: 'checkbox', options: ['Bus', 'Car', 'Bicycle', 'Walking'] }),
  Q({ key: 'sat', text: 'How satisfied are you with the bus service?', type: 'linear_scale', options: ['1', '2', '3', '4', '5'] }),
  Q({ key: 'likert', text: 'The service is reliable', type: 'multiple_choice', options: ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'] }),
  Q({ key: 'name', text: 'Your full name', type: 'short_answer' }),
  Q({ key: 'email', text: 'Email address', type: 'short_answer' }),
  Q({ key: 'comment', text: 'Any comments about travelling?', type: 'paragraph', required: false }),
  Q({ key: 'when', text: 'Date of your last trip', type: 'date' }),
  Q({ key: 'depart', text: 'Usual departure time', type: 'time' })
].map((q) => Object.assign(q, { semantic: Parser.classify(q) }));

test('local answers never contradict the profile (800 respondents, full battery)', () => {
  const profiles = Gen.generateMany({ seed: 99 }, 800);
  profiles.forEach((p) => {
    const answers = AnswerGen.Local.generate(p, BATTERY);
    const errs = AnswerGen.Local.checkConsistency(p, BATTERY, answers);
    assert.deepEqual(errs, [], p.id + ': ' + errs.join('; '));
    BATTERY.filter((q) => q.required).forEach((q) => assert.notEqual(answers[q.key], null, 'required ' + q.key + ' left empty'));
  });
});

test('non bus users get never-style answers; bus users never get "Never"', () => {
  const profiles = Gen.generateMany({ seed: 5 }, 400);
  const freq = BATTERY.find((q) => q.key === 'busfreq');
  profiles.forEach((p) => {
    const a = AnswerGen.Local.answerQuestion(freq, p);
    if (!p.travel.usesBus) assert.equal(a, 'Never');
    else { assert.notEqual(a, 'Never'); assert.equal(a, { rarely: 'Rarely', monthly: 'Rarely', weekly: 'A few times a week', daily: 'Every day' }[p.travel.busFrequency]); }
  });
  const daily = BATTERY.find((q) => q.key === 'busfreq2');
  profiles.filter((p) => p.travel.busFrequency === 'daily').slice(0, 20).forEach((p) => assert.equal(AnswerGen.Local.answerQuestion(daily, p), 'Daily'));
});

test('age, gender and student answers follow the profile', () => {
  Gen.generateMany({ seed: 3 }, 200).forEach((p) => {
    const age = AnswerGen.Local.answerQuestion(BATTERY[0], p);
    const [lo, hi] = AnswerGen.parseAgeRange(age);
    assert.ok(p.age >= lo && p.age <= hi, `${p.age} not in ${age}`);
    assert.equal(AnswerGen.Local.answerQuestion(BATTERY[2], p), p.isStudent ? 'Yes' : 'No');
  });
});

test('answers are diverse across respondents (not identical patterns)', () => {
  const profiles = Gen.generateMany({ seed: 21 }, 60);
  const patterns = new Set(profiles.map((p) => JSON.stringify(AnswerGen.Local.generate(p, BATTERY))));
  assert.equal(patterns.size, 60);
  const sat = BATTERY.find((q) => q.key === 'sat');
  const values = new Set(profiles.filter((p) => p.travel.usesBus).map((p) => AnswerGen.Local.answerQuestion(sat, p)));
  assert.ok(values.size >= 3, 'scale answers should vary, got ' + [...values]);
});

test('bus-related scale answers: blank when optional, neutral when required, for non users', () => {
  const nonUser = Gen.generateMany({ seed: 5, travel: { busUseShare: 0 } }, 1)[0];
  const sat = BATTERY.find((q) => q.key === 'sat');
  assert.equal(AnswerGen.Local.answerQuestion(sat, nonUser), '3');
  const opt = AnswerGen.Local.answerQuestion({ ...sat, required: false, key: 'opt' }, { ...nonUser, traits: { ...nonUser.traits, skipOptional: 0 } });
  assert.equal(opt, '3', 'optional questions are answered by default');
  const blank = AnswerGen.Local.answerQuestion({ ...sat, required: false, key: 'opt' }, { ...nonUser, traits: { ...nonUser.traits, skipOptional: 0 } }, { allowSkip: true });
  assert.equal(blank, null, 'blank only when skipping is explicitly allowed');
});

test('every question is answered by default, optional ones included', () => {
  const qs = BATTERY.map((q) => ({ ...q, required: false }));
  Gen.generateMany({ seed: 21 }, 40).forEach((p) => {
    qs.forEach((q) => assert.notEqual(AnswerGen.Local.answerQuestion(q, { ...p, traits: { ...p.traits, skipOptional: 0.5 } }), null, q.text));
  });
});

test('checkbox answers: non users never tick bus; no contradictory "none of the above"', () => {
  const q = Q({ key: 'c', text: 'Which of these do you use?', type: 'checkbox', options: ['Bus', 'Train', 'None of the above', 'Taxi'] });
  q.semantic = Parser.classify(q);
  Gen.generateMany({ seed: 8, travel: { busUseShare: 0 } }, 200).forEach((p) => {
    const a = AnswerGen.Local.answerQuestion(q, p);
    assert.ok(Array.isArray(a) && a.length >= 1);
    assert.ok(!a.includes('Bus'));
    if (a.includes('None of the above')) assert.equal(a.length, 1);
  });
});

test('language banks produce text in the requested language', () => {
  const p = Gen.generateMany({ seed: 2, travel: { busUseShare: 0 } }, 1)[0];
  const q = Q({ key: 'x', text: 'Tell us about your travel', type: 'paragraph' });
  const es = AnswerGen.Local.answerQuestion(q, p, { language: 'es' });
  assert.match(es, /autob[uú]s|coche|bicicleta|pie|experiencia|creo|cambiar/i);
});

/* ---------------- AI client (mocked fetch) ---------------- */
function mockFetch(sequence) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = sequence[Math.min(calls.length - 1, sequence.length - 1)];
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(url, init);
    return { ok: step.status >= 200 && step.status < 300, status: step.status, headers: { get: (h) => (step.headers || {})[h.toLowerCase()] || null }, json: async () => step.body };
  };
  fn.calls = calls; return fn;
}
const okBody = (obj) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });
const noSleep = async () => {};
const AIQ = [Q({ key: 'a', text: 'Pick', type: 'multiple_choice', options: ['X', 'Y'] }), Q({ key: 'b', text: 'Name', type: 'short_answer' })];
const AIP = Gen.generateMany({ seed: 1 }, 1)[0];

test('AI: success returns parsed answers; key travels in a header, never in the URL', async () => {
  const f = mockFetch([okBody({ a: 'X', b: 'Sam' })]);
  const r = await AI.generateAnswers({ apiKey: 'AIzaSyFAKEKEYFAKEKEYFAKEKEY123456', model: 'gemini-test', profile: AIP, questions: AIQ, fetchImpl: f, sleepImpl: noSleep });
  assert.deepEqual(r.answers, { a: 'X', b: 'Sam' });
  assert.ok(!f.calls[0].url.includes('AIza'));
  assert.equal(f.calls[0].init.headers['x-goog-api-key'], 'AIzaSyFAKEKEYFAKEKEYFAKEKEY123456');
});

test('AI: invalid key, quota exhausted, missing key are typed and not retried', async () => {
  let f = mockFetch([{ status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } }]);
  await assert.rejects(AI.generateAnswers({ apiKey: 'k'.repeat(30), profile: AIP, questions: AIQ, fetchImpl: f, sleepImpl: noSleep }), { code: 'API_KEY_INVALID' });
  assert.equal(f.calls.length, 1);
  f = mockFetch([{ status: 429, body: { error: { message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } } }]);
  await assert.rejects(AI.generateAnswers({ apiKey: 'k'.repeat(30), profile: AIP, questions: AIQ, fetchImpl: f, sleepImpl: noSleep }), { code: 'QUOTA_EXHAUSTED' });
  assert.equal(f.calls.length, 1);
  await assert.rejects(AI.generateAnswers({ apiKey: '', profile: AIP, questions: AIQ }), { code: 'API_KEY_MISSING' });
});

test('AI: transient rate limit retries with backoff then succeeds; server errors retry; retries are bounded', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let f = mockFetch([{ status: 429, body: { error: { message: 'Rate limit per minute', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '2s' }] } } }, { status: 503, body: { error: { message: 'overloaded' } } }, okBody({ a: 'Y', b: 'Z' })]);
  const r = await AI.generateAnswers({ apiKey: 'k'.repeat(30), profile: AIP, questions: AIQ, fetchImpl: f, sleepImpl: sleep, maxRetries: 3 });
  assert.equal(f.calls.length, 3); assert.equal(r.answers.a, 'Y');
  assert.equal(waits[0], 2000);                 // honours retryDelay
  assert.ok(waits[1] >= 2000 && waits[1] < 2600); // exponential step
  f = mockFetch([{ status: 500, body: { error: { message: 'boom' } } }]);
  await assert.rejects(AI.generateAnswers({ apiKey: 'k'.repeat(30), profile: AIP, questions: AIQ, fetchImpl: f, sleepImpl: noSleep, maxRetries: 2 }), { code: 'SERVER' });
  assert.equal(f.calls.length, 3);
});

test('AI: timeout and network errors are typed', async () => {
  const hang = () => new Promise((_, rej) => setTimeout(() => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }, 50));
  await assert.rejects(AI.generateAnswers({ apiKey: 'k'.repeat(30), profile: AIP, questions: AIQ, fetchImpl: mockFetch([hang]), sleepImpl: noSleep, maxRetries: 0, timeoutMs: 10 }), { code: 'TIMEOUT' });
  await assert.rejects(AI.generateAnswers({ apiKey: 'k'.repeat(30), profile: AIP, questions: AIQ, fetchImpl: mockFetch([new TypeError('Failed to fetch')]), sleepImpl: noSleep, maxRetries: 0 }), { code: 'NETWORK' });
});

test('AI: non-JSON reply is BAD_RESPONSE; fenced JSON is accepted', async () => {
  await assert.rejects(AI.generateAnswers({ apiKey: 'k'.repeat(30), profile: AIP, questions: AIQ, sleepImpl: noSleep, maxRetries: 0,
    fetchImpl: mockFetch([{ status: 200, body: { candidates: [{ content: { parts: [{ text: 'sorry, no' }] } }] } }]) }), { code: 'BAD_RESPONSE' });
  const r = await AI.generateAnswers({ apiKey: 'k'.repeat(30), profile: AIP, questions: AIQ, sleepImpl: noSleep,
    fetchImpl: mockFetch([{ status: 200, body: { candidates: [{ content: { parts: [{ text: '```json\n{"a":"X","b":"Q"}\n```' }] } }] } }]) });
  assert.equal(r.answers.a, 'X');
});

test('AI: partial generation across batches keeps earlier batches when a later one hits quota', async () => {
  const qs = Array.from({ length: 6 }, (_, i) => Q({ key: 'q' + i, text: 'Q' + i, type: 'short_answer' }));
  const f = mockFetch([okBody({ q0: 'a', q1: 'b', q2: 'c' }), { status: 429, body: { error: { message: 'Quota exceeded for quota metric per day', status: 'RESOURCE_EXHAUSTED' } } }]);
  const r = await AI.generateAnswers({ apiKey: 'k'.repeat(30), profile: AIP, questions: qs, fetchImpl: f, sleepImpl: noSleep, batchSize: 3 });
  assert.equal(r.partial, true); assert.deepEqual(Object.keys(r.answers), ['q0', 'q1', 'q2']);
  assert.equal(r.errors[0].code, 'QUOTA_EXHAUSTED');
});

test('orchestrator: quota failure falls back to local generation and the respondent is still complete', async () => {
  const f = mockFetch([{ status: 429, body: { error: { message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED' } } }]);
  const res = await AnswerGen.generate({ mode: 'ai', profile: AIP, questions: BATTERY, settings: { apiKey: 'AIza' + 'x'.repeat(30), autoFallback: true }, fetchImpl: f, sleepImpl: noSleep });
  assert.equal(res.source, 'local'); assert.equal(res.aiError.code, 'QUOTA_EXHAUSTED');
  assert.equal(Object.keys(res.answers).length, BATTERY.length);
  assert.ok(res.warnings[0].includes('Falling back'));
  assert.ok(!JSON.stringify(res).includes('x'.repeat(30)), 'API key must not leak into results');
  await assert.rejects(AnswerGen.generate({ mode: 'ai', profile: AIP, questions: BATTERY, settings: { apiKey: 'k'.repeat(30), autoFallback: false }, fetchImpl: f, sleepImpl: noSleep }), { code: 'QUOTA_EXHAUSTED' });
});

test('orchestrator: invalid / contradictory AI answers are dropped and filled locally ("mixed")', async () => {
  const nonUser = Gen.generateMany({ seed: 5, travel: { busUseShare: 0 } }, 1)[0];
  const qs = [BATTERY.find((q) => q.key === 'busfreq'), BATTERY.find((q) => q.key === 'gender'), BATTERY.find((q) => q.key === 'name')];
  const f = mockFetch([okBody({ [qs[0].key]: 'Every day', [qs[1].key]: 'Martian', [qs[2].key]: 'Ada Test' })]);
  const res = await AnswerGen.generate({ mode: 'ai', profile: nonUser, questions: qs, settings: { apiKey: 'k'.repeat(30) }, fetchImpl: f, sleepImpl: noSleep });
  assert.equal(res.answers[qs[0].key], 'Never');           // AI contradicted the profile -> replaced
  assert.ok(['Female', 'Male', 'Non-binary', 'Prefer not to say'].includes(res.answers[qs[1].key]));
  assert.equal(res.answers[qs[2].key], 'Ada Test');         // good AI answer kept
  assert.equal(res.source, 'mixed');
  assert.ok(res.warnings.length >= 2);
});

test('redact removes API keys from any text', () => {
  const k = 'AIzaSyD-FAKE_KEY_1234567890abcdefghij';
  assert.ok(!Util.redact('error with key ' + k + ' inside', []).includes(k));
  assert.ok(!Util.redact('secret=hunter2hunter2', ['hunter2hunter2']).includes('hunter2'));
});

/* ---------------- statistics ---------------- */
test('statistics are computed only from records', () => {
  const run = { respondentIds: ['a', 'b', 'c', 'd'], startedAt: 1000, endedAt: null, pausedMs: 2000, pauseStartedAt: null, currentRespondentId: 'c' };
  const records = [
    { respondentId: 'a', status: 'Completed', durationMs: 4000, questionsFilled: 10, questionsTotal: 10, generationMs: 20, readMs: 5, questionTimings: [{ ms: 10 }, { ms: 30 }], sectionTimings: [{ ms: 100 }] },
    { respondentId: 'b', status: 'Failed', durationMs: 1000, questionsFilled: 2, questionsTotal: 10 },
    { respondentId: 'b', status: 'Completed', durationMs: 6000, questionsFilled: 10, questionsTotal: 10, questionTimings: [{ ms: 20 }], sectionTimings: [{ ms: 300 }] },
    { respondentId: 'c', status: 'Filling', questionsFilled: 3, questionsTotal: 10, currentSection: 1 }
  ];
  const s = Stats.compute({ run, records, respondents: new Array(7).fill({}), now: 11000 });
  assert.equal(s.totalRespondents, 7); assert.equal(s.targetRespondents, 4);
  assert.equal(s.completedRuns, 2); assert.equal(s.failedRuns, 0);        // b's retry succeeded: latest record wins
  assert.equal(s.pendingRuns, 1); assert.equal(s.inFlightRuns, 1);
  assert.equal(s.successRate, 1); assert.equal(s.avgCompletionMs, 5000);
  assert.equal(s.elapsedMs, 11000 - 1000 - 2000);
  assert.equal(s.currentRespondentId, 'c'); assert.equal(s.currentSection, 1);
  assert.equal(s.questionsCompleted, 3); assert.equal(s.questionsRemaining, 7);
  assert.equal(s.progress, 0.5);
  const t = Stats.timings(records);
  assert.equal(t.avgQuestionFillMs, 20); assert.equal(t.avgSectionMs, 200); assert.equal(t.samples.respondents, 3);
});

test('statistics with no data report null, not made-up numbers', () => {
  const s = Stats.compute({ run: null, records: [], respondents: [] });
  assert.equal(s.successRate, null); assert.equal(s.avgCompletionMs, null); assert.equal(s.elapsedMs, null); assert.equal(s.progress, 0);
  const t = Stats.timings([]); assert.equal(t.avgRespondentMs, null);
});

/* ---------------- export ---------------- */
test('CSV escaping: quotes, delimiters, newlines, arrays, formula injection', () => {
  assert.equal(Exp.csvEscape('a,b'), '"a,b"');
  assert.equal(Exp.csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(Exp.csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(Exp.csvEscape(['x', 'y']), 'x | y');
  assert.equal(Exp.csvEscape('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(Exp.csvEscape('-5'), '-5');
  assert.equal(Exp.csvEscape('a;b', ';'), '"a;b"');
  assert.equal(Exp.csvEscape(null), '');
});

test('respondent CSV contains one row per respondent and one column per question', () => {
  const survey = { questions: [{ key: 'k1', text: 'Q one' }, { key: 'k2', text: 'Q, two' }] };
  const rs = Gen.generateMany({ seed: 4 }, 3).map((p) => ({ id: p.id, source: 'local', profile: p, answers: { k1: 'A', k2: ['B', 'C'] } }));
  const csv = Exp.respondentsToCSV(rs, survey, {});
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes('"Q, two"') && lines[0].startsWith('respondent_id,synthetic'));
  assert.ok(lines[1].includes('B | C'));
  assert.ok(!Exp.respondentsToCSV(rs, survey, { includeProfile: false }).includes('bus_frequency'));
});

test('backup never contains the API key and validates input', () => {
  const key = 'AIzaSyD-FAKE_KEY_1234567890abcdefghij';
  const dump = { surveys: [], respondents: [{ id: 'r1', profile: {}, answers: {} }], runs: [], runRecords: [], logs: [{ id: 1, ts: 1, action: 'x', error: 'failed with ' + key }],
    diagnostics: [{ id: 'd', screenshot: 'data:image/jpeg;base64,AAAA' }], settings: [{ key: 'apiKey', value: key }, { key: 'mode', value: 'ai' }] };
  const b = Exp.buildBackup(dump, {});
  assert.ok(!JSON.stringify(b).includes(key));
  assert.deepEqual(b.data.settings, [{ key: 'mode', value: 'ai' }]);
  assert.equal(b.data.diagnostics[0].screenshot, undefined);
  assert.equal(Exp.validateBackup(b), true);
  assert.throws(() => Exp.validateBackup(null), /not a JSON object/);
  assert.throws(() => Exp.validateBackup({ app: 'Other' }), /not a SurveyPilot/);
  assert.throws(() => Exp.validateBackup({ app: 'SurveyPilot AI', version: 99, data: {} }), /newer version/);
  assert.throws(() => Exp.validateBackup({ app: 'SurveyPilot AI', version: 2, data: { respondents: [{}] } }), /no id/);
});

test('log text export is readable and includes errors', () => {
  const t = Exp.logsToText([{ ts: new Date(2026, 0, 1, 14, 30, 2).getTime(), action: 'Form detected' }, { ts: new Date(2026, 0, 1, 14, 30, 3).getTime(), respondentId: 'SYN-0001', action: 'Question failed', question: 'Q1', error: 'boom' }]);
  assert.match(t, /^14:30:02 Form detected\n14:30:03 \[SYN-0001\] Question failed - Q1 !! boom$/);
});
