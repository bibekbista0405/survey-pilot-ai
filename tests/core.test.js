/*
 * Core module tests - pure JavaScript, no DOM.
 * Loads core modules by evaluating them in a sandbox with a fake `self` global.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadModulesIntoContext() {
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Map,
    Set,
    encodeURIComponent,
    decodeURIComponent,
    isNaN,
    parseInt,
    parseFloat,
    indexedDB: null, // will be replaced by shim
    self: {},
    navigator: { storage: {} }
  };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const files = [
    'core/storage.js',
    'core/survey-parser.js',
    'core/respondent-generator.js',
    'core/answer-generator.js',
    'core/statistics.js',
    'core/export.js'
  ];
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  return sandbox;
}

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function eq(name, a, b) {
  const cond = JSON.stringify(a) === JSON.stringify(b);
  ok(name, cond, 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a));
}

async function main() {
  console.log('Running core module tests...');

  const ctx = loadModulesIntoContext();
  const SP = ctx.self.SurveyPilot;

  // ---- Survey parser ----
  console.log('  Survey parser:');
  const Parser = SP.SurveyParser;
  eq('question types defined', Parser.QUESTION_TYPES.SHORT_ANSWER, 'short_answer');
  eq('compatibility supported', Parser.COMPATIBILITY.SUPPORTED, 'supported');

  const survey = Parser.buildSurvey({
    url: 'https://example.com/form',
    title: 'Test Form',
    formType: 'html_form',
    sections: [
      { id: 'sec1', title: 'Section 1', questions: [
        { id: 'q1', text: 'Name', type: 'short_answer', required: true, options: [] },
        { id: 'q2', text: 'Age', type: 'multiple_choice', required: false, options: ['18-24', '25-34'] }
      ] },
      { id: 'sec2', title: 'Section 2', questions: [
        { id: 'q3', text: 'Comments', type: 'paragraph', required: false, options: [] }
      ] }
    ]
  });
  eq('survey questionCount', survey.questionCount, 3);
  eq('survey sectionCount', survey.sectionCount, 2);
  eq('survey requiredCount', survey.requiredCount, 1);
  eq('survey compatibility', survey.compatibility, 'supported');
  eq('survey id stable', typeof survey.id, 'string');
  eq('survey fingerprint', typeof survey.fingerprint, 'string');

  // validateAnswerShape - multiple choice valid
  const r1 = Parser.validateAnswerShape({ id: 'q2', type: 'multiple_choice', options: ['18-24', '25-34'] }, { value: '18-24' });
  ok('multiple_choice valid', r1.ok);
  const r2 = Parser.validateAnswerShape({ id: 'q2', type: 'multiple_choice', options: ['18-24', '25-34'] }, { value: '99-99' });
  ok('multiple_choice invalid', !r2.ok);
  const r3 = Parser.validateAnswerShape({ id: 'q1', type: 'short_answer', required: true }, { value: '' });
  ok('required short_answer empty rejected', !r3.ok);
  const r4 = Parser.validateAnswerShape({ id: 'q1', type: 'short_answer', required: true }, { value: 'Alice' });
  ok('required short_answer ok', r4.ok);
  const r5 = Parser.validateAnswerShape({ id: 'qc', type: 'checkbox', options: ['A','B','C'], minChoices: 1, maxChoices: 2 }, { value: ['A'] });
  ok('checkbox within bounds', r5.ok);
  const r6 = Parser.validateAnswerShape({ id: 'qc', type: 'checkbox', options: ['A','B','C'], minChoices: 1, maxChoices: 2 }, { value: ['A','B','C'] });
  ok('checkbox over maxChoices rejected', !r6.ok);
  const r7 = Parser.validateAnswerShape({ id: 'qd', type: 'date' }, { value: '2024-05-10' });
  ok('date valid', r7.ok);
  const r8 = Parser.validateAnswerShape({ id: 'qt', type: 'time' }, { value: '13:45' });
  ok('time valid', r8.ok);
  const r9 = Parser.validateAnswerShape({ id: 'qt', type: 'time' }, { value: '25:99' });
  ok('time invalid rejected', !r9.ok);

  // ---- Respondent generator ----
  console.log('  Respondent generator:');
  const Gen = SP.RespondentGenerator;
  const generated = await Gen.generateRespondents({ count: 10, seed: 42 });
  eq('generated count', generated.length, 10);
  ok('all have ids', generated.every((r) => typeof r.id === 'string'));
  ok('all have profiles', generated.every((r) => r.profile && r.profile.age && r.profile.gender));
  ok('all have generationMode', generated.every((r) => r.generationMode === 'local'));
  // Reproducibility with same seed
  const g2 = await Gen.generateRespondents({ count: 5, seed: 42 });
  const g3 = await Gen.generateRespondents({ count: 5, seed: 42 });
  eq('seed reproducibility', g2.map((r) => r.profile.age), g3.map((r) => r.profile.age));
  // Variation: different seeds usually yield different profiles (at least one)
  const g4 = await Gen.generateRespondents({ count: 20, seed: 100 });
  const g5 = await Gen.generateRespondents({ count: 20, seed: 200 });
  const sameCount = g4.filter((r, i) => r.profile.age === g5[i].profile.age && r.profile.gender === g5[i].profile.gender).length;
  ok('seed variation yields different profiles', sameCount < 20);

  // Consistency: respondents under 22 should mostly be students
  const young = (await Gen.generateRespondents({ count: 30, seed: 7 })).filter((r) => r.profile.age < 22);
  ok('young respondents exist', young.length > 0);
  const studentRatio = young.filter((r) => r.profile.studentStatus !== 'not-a-student').length / young.length;
  ok('young mostly students', studentRatio > 0.6, 'ratio=' + studentRatio);

  // Consistency: 65+ unlikely to be Student
  const old = (await Gen.generateRespondents({ count: 30, seed: 9 })).filter((r) => r.profile.age >= 65);
  if (old.length) {
    const studentOld = old.filter((r) => r.profile.occupation === 'Student').length;
    ok('65+ rarely student', studentOld / old.length < 0.5, 'ratio=' + (studentOld / old.length));
  } else {
    ok('65+ generated', false, 'no 65+ generated in 30 samples');
  }

  // ---- Answer generator (local) ----
  console.log('  Answer generator (local):');
  const Ans = SP.AnswerGenerator;
  const respondent = generated[0];
  const localResult = await Ans.generateAnswersLocal(survey, respondent, { responseVariation: 0.7, consistencyLevel: 0.9 });
  ok('local answers generated', !!localResult.answers);
  ok('local answers for all questions', Object.keys(localResult.answers).length >= 3, 'got ' + Object.keys(localResult.answers).length);
  ok('local answer has value', Object.values(localResult.answers).every((a) => a.value != null));

  // Travel consistency: build a survey question that asks about bus usage; never-traveler should pick "Never"
  const travelSurvey = Parser.buildSurvey({
    url: 'x', title: 'Travel', formType: 'html_form',
    sections: [{ id: 's', title: 'S', questions: [
      { id: 'bus_q', text: 'How often do you use the bus for transit?', type: 'multiple_choice', required: false, options: ['Daily', 'Weekly', 'Monthly', 'Rarely', 'Never'] }
    ] }]
  });
  const neverResp = { id: 'r', profile: { age: 30, gender: 'female', occupation: 'Other', studentStatus: 'not-a-student', region: 'Urban', travelBehavior: 'never', language: 'en' }, answers: {} };
  const neverAns = await Ans.generateAnswersLocal(travelSurvey, neverResp, Math.random, { consistencyLevel: 0.9 });
  eq('never-traveler picks Never', neverAns.answers.bus_q.value, 'Never');
  const dailyResp = Object.assign({}, neverResp, { profile: Object.assign({}, neverResp.profile, { travelBehavior: 'daily' }) });
  const dailyAns = await Ans.generateAnswersLocal(travelSurvey, dailyResp, Math.random, { consistencyLevel: 0.9 });
  // Should pick Daily most of the time when consistency is high
  ok('daily-traveler tends toward Daily', ['Daily', 'Weekly', 'Monthly', 'Rarely'].includes(dailyAns.answers.bus_q.value));

  // Date answer is YYYY-MM-DD
  const dateSurvey = Parser.buildSurvey({
    url: 'x', title: 'D', formType: 'html_form',
    sections: [{ id: 's', title: 'S', questions: [
      { id: 'dq', text: 'Date', type: 'date', required: false, options: [] }
    ] }]
  });
  const dateAns = await Ans.generateAnswersLocal(dateSurvey, neverResp, Math.random, {});
  ok('date format YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(dateAns.answers.dq.value));

  // ---- Statistics ----
  console.log('  Statistics:');
  const St = SP.Statistics;
  const stats = St.computeFromRuns([
    {
      id: 'r1', startedAt: 1000, endedAt: 2000,
      executionItems: [
        { respondentId: 'a', status: 'completed', durationMs: 500, questionsCompleted: 3 },
        { respondentId: 'b', status: 'failed', durationMs: 100, questionsCompleted: 1 },
        { respondentId: 'c', status: 'skipped' },
        { respondentId: 'd', status: 'pending', questionsRemaining: 5 }
      ]
    }
  ]);
  eq('stats totalRespondents', stats.totalRespondents, 4);
  eq('stats completedRuns', stats.completedRuns, 1);
  eq('stats failedRuns', stats.failedRuns, 1);
  eq('stats skippedRuns', stats.skippedRuns, 1);
  eq('stats pendingRuns', stats.pendingRuns, 1);
  eq('stats questionsCompleted', stats.questionsCompleted, 4);
  eq('stats questionsRemaining', stats.questionsRemaining, 5);
  ok('stats averageCompletionMs computed', stats.averageCompletionMs > 0);

  // Empty stats
  const empty = St.computeFromRuns([]);
  eq('empty stats', empty.totalRespondents, 0);

  // formatDuration
  ok('formatDuration ms', St.formatDuration(500).indexOf('ms') !== -1);
  ok('formatDuration s', St.formatDuration(2500).indexOf('s') !== -1);

  // ---- Export ----
  console.log('  Export:');
  const Ex = SP.Export;
  const csv = Ex.toCsv([{ a: 'x', b: 'y, z' }, { a: 'p', b: 'q' }], ['a', 'b']);
  ok('csv header correct', csv.indexOf('a,b') === 0);
  ok('csv escapes commas', csv.indexOf('"y, z"') !== -1);

  const jsonOut = Ex.jsonDump({ apiKey: 'secret123', data: 'safe' });
  ok('json redacts apiKey', jsonOut.indexOf('secret123') === -1);
  ok('json keeps safe data', jsonOut.indexOf('safe') !== -1);

  const respCsv = Ex.respondentsToCsv([{ id: 'r1', index: 1, generatedAt: 1000, generationMode: 'local', profile: { age: 25, gender: 'female', occupation: 'Engineer', region: 'Urban', travelBehavior: 'daily', studentStatus: 'not-a-student' }, answers: {} }], null);
  ok('respondents csv has header', respCsv.indexOf('id,index') === 0);

  // ---- Storage shim ----
  console.log('  Storage:');
  // Use a simple in-memory IndexedDB shim
  const memStore = {};
  function makeIdbShim() {
    const stores = {};
    const keyPaths = {
      surveys: 'id', respondents: 'id', runs: 'id', logs: 'id', diagnostics: 'id', settings: 'key'
    };
    function keyOf(storeName, value) {
      const kp = keyPaths[storeName] || 'id';
      return value[kp];
    }
    return {
      open(name, version) {
        const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
        setTimeout(() => {
          const db = {
            objectStoreNames: { contains: (n) => Object.keys(stores).includes(n) },
            createObjectStore: (name) => { stores[name] = {}; return { createIndex: () => {} }; },
            transaction: (storeName) => ({
              objectStore: (n) => ({
                put: (v) => { const r2 = { onsuccess: null, onerror: null }; setTimeout(() => { stores[n] = stores[n] || {}; stores[n][keyOf(n, v)] = v; r2.onsuccess && r2.onsuccess(); }, 0); return r2; },
                get: (k) => { const r2 = { onsuccess: null, onerror: null, result: null }; setTimeout(() => { r2.result = (stores[n] && stores[n][k]) || null; r2.onsuccess && r2.onsuccess(); }, 0); return r2; },
                getAll: () => { const r2 = { onsuccess: null, onerror: null, result: null }; setTimeout(() => { r2.result = Object.values(stores[n] || {}); r2.onsuccess && r2.onsuccess(); }, 0); return r2; },
                delete: (k) => { const r2 = { onsuccess: null, onerror: null }; setTimeout(() => { if (stores[n]) delete stores[n][k]; r2.onsuccess && r2.onsuccess(); }, 0); return r2; },
                clear: () => { const r2 = { onsuccess: null, onerror: null }; setTimeout(() => { stores[n] = {}; r2.onsuccess && r2.onsuccess(); }, 0); return r2; },
                count: () => { const r2 = { onsuccess: null, onerror: null, result: null }; setTimeout(() => { r2.result = Object.keys(stores[n] || {}).length; r2.onsuccess && r2.onsuccess(); }, 0); return r2; },
                index: (idxName) => ({
                  getAll: (val) => {
                    const r2 = { onsuccess: null, onerror: null, result: null };
                    setTimeout(() => {
                      const kp = idxName.replace(/\./g, '_');
                      const realPath = idxName.replace(/_/g, '.');
                      // simple match by walking the path
                      const all = Object.values(stores[n] || {});
                      r2.result = all.filter((row) => {
                        let cur = row;
                        for (const part of realPath.split('.')) { cur = cur && cur[part]; }
                        return cur === val;
                      });
                      r2.onsuccess && r2.onsuccess();
                    }, 0);
                    return r2;
                  }
                })
              }),
              done: Promise.resolve()
            })
          };
          req.result = db;
          req.onupgradeneeded && req.onupgradeneeded({ oldVersion: 0 });
          req.onsuccess && req.onsuccess();
        }, 0);
        return req;
      }
    };
  }
  ctx.indexedDB = makeIdbShim();

  const Storage = SP.Storage;
  await Storage.setSetting('foo', 'bar');
  const v = await Storage.getSetting('foo', null);
  eq('storage set/get', v, 'bar');
  await Storage.put('respondents', { id: 'r1', profile: { age: 30 } });
  const got = await Storage.get('respondents', 'r1');
  eq('storage put/get respondent', got.id, 'r1');
  const all = await Storage.getAll('respondents');
  eq('storage getAll', all.length, 1);
  await Storage.del('respondents', 'r1');
  const all2 = await Storage.getAll('respondents');
  eq('storage delete', all2.length, 0);

  // ---- Summary ----
  console.log('\nCore tests: ' + pass + ' passed, ' + fail + ' failed.');
  if (fail > 0) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  return fail === 0;
}

module.exports = { main, loadModulesIntoContext };
