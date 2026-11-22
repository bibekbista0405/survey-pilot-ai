'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { Storage } = require('../core/storage.js');
const { Util } = require('../core/util.js');
const { RespondentGen: Gen } = require('../core/respondent-generator.js');
const { AnswerGen } = require('../core/answer-generator.js');
const { Stats } = require('../core/statistics.js');
const { RunEngine } = require('../background/run-engine.js');
const { loadForm } = require('./helpers/harness.js');

const MP_URL = 'http://localhost/survey.html';
const GF_URL = 'https://docs.google.com/forms/d/e/TESTFORM/viewform';

async function freshStorage(settings) {
  Storage.close(); Storage._opening = null;
  await Storage.open({ indexedDB: new IDBFactory(), name: 'eng-' + Math.random().toString(36).slice(2) });
  await Storage.setSettings(Object.assign({ delayBetweenRunsMs: 0, delayBetweenActionsMs: 0, navigationTimeoutMs: 1500, retryLimit: 1, captureScreenshots: true }, settings || {}));
}

/** Fake browser around a jsdom page: every run starts by "reloading" the destination, exactly like the real navigate(). */
function makeEnv(file, url, hooks) {
  hooks = hooks || {};
  const st = { win: loadForm(file, url), submissions: [], messages: [], navigations: 0, urlOverride: null, closed: false, apiKey: '', events: [] };
  st.env = {
    getTab: async () => (st.closed ? null : { id: 1, url: st.urlOverride || st.win.location.href, status: 'complete' }),
    sendToTab: async (id, msg) => {
      if (st.closed) throw new Error('Could not establish connection. Receiving end does not exist.');
      st.messages.push(msg.type);
      if (hooks.onMessage) await hooks.onMessage(msg, st);
      return JSON.parse(JSON.stringify(await st.win.SP.content.handle(JSON.parse(JSON.stringify(msg)))));
    },
    navigate: async (id, u) => {
      st.navigations++;
      if (st.win.__submitted) st.submissions.push(st.win.__submitted);
      st.win.close(); st.win = loadForm(file, u);
    },
    waitForContent: async () => !st.closed,
    screenshot: async () => 'data:image/jpeg;base64,FAKESHOT',
    broadcast: (e) => st.events.push(e),
    getApiKey: async () => st.apiKey
  };
  return st;
}

async function seed(n, cfg) {
  const ps = Gen.generateMany(Object.assign({ seed: 77 }, cfg || {}), n);
  const recs = ps.map((p) => ({ id: p.id, index: p.index, surveyId: '', profile: p, answers: {}, source: 'local', createdAt: Date.now() }));
  await Storage.putMany('respondents', recs);
  return recs.map((r) => r.id);
}

const startOpts = (ids, url, extra) => Object.assign({ tabId: 1, destinationUrl: url, destinationConfirmed: true, confirmedAt: Date.now(), surveyId: 'sv', respondentIds: ids, mode: 'local' }, extra || {});

async function until(fn, ms) {
  const end = Date.now() + (ms || 15000);
  while (Date.now() < end) { if (await fn()) return true; await Util.sleep(25); }
  throw new Error('timed out waiting for condition');
}
const done = (eng) => until(() => eng.run && ['completed', 'stopped'].includes(eng.run.status) && !eng.loopActive);
const recsOf = (eng) => Storage.listRunRecords(eng.run.id);
const latest = (recs, id) => recs.filter((r) => r.respondentId === id).pop();

test('full run: 3 synthetic respondents are filled, validated, submitted and confirmed', async () => {
  await freshStorage();
  const st = makeEnv('multipage.html', MP_URL);
  const eng = new RunEngine(st.env);
  const ids = await seed(3);
  await eng.start(startOpts(ids, MP_URL));
  await done(eng);
  const recs = await recsOf(eng);
  const finals = ids.map((id) => latest(recs, id));
  assert.deepEqual(finals.map((r) => r.status), ['Completed', 'Completed', 'Completed']);
  assert.ok(finals.every((r) => r.confirmed === true && r.durationMs > 0 && r.questionsFilled >= 10 && r.sectionTimings.length === 3 && r.questionTimings.length >= 10));
  assert.equal(eng.run.status, 'completed');
  // The pages really received the answers (not just "clicked"):
  if (st.win.__submitted) st.submissions.push(st.win.__submitted);
  assert.equal(st.submissions.length, 3);
  const survey = await Storage.get('surveys', 'sv');
  assert.equal(survey.questions.length, 12);
  for (let i = 0; i < 3; i++) {
    const r = await Storage.get('respondents', ids[i]);
    const nameQ = survey.questions.find((q) => q.text === 'Your full name');
    assert.equal(st.submissions[i].get('name'), r.answers[nameQ.key]);
    assert.equal(AnswerGen.Local.checkConsistency(r.profile, survey.questions, r.answers).length, 0);
    assert.equal(Object.keys(r.answers).length, 12);
  }
  assert.equal(st.navigations, 3, 'each respondent starts from a freshly loaded destination');
  // Statistics come from real records:
  const stats = Stats.compute({ run: eng.run, records: recs, respondents: await Storage.listRespondents() });
  assert.deepEqual([stats.completedRuns, stats.failedRuns, stats.pendingRuns, stats.successRate, stats.progress], [3, 0, 0, 1, 1]);
  assert.ok(stats.avgCompletionMs > 0 && stats.elapsedMs > 0);
  const logs = (await Storage.listLogs()).map((l) => l.action);
  for (const a of ['Run started', 'Respondent selected', 'Section 1 detected', 'Required question validation passed', 'Section 1 completed', 'Submitting', 'Respondent completed', 'Run completed']) assert.ok(logs.includes(a), 'missing log: ' + a);
});

test('Google-style fixture: complete run with confirmation via ARIA widgets', async () => {
  await freshStorage();
  const st = makeEnv('google-like.html', GF_URL);
  const eng = new RunEngine(st.env);
  const ids = await seed(2);
  await eng.start(startOpts(ids, GF_URL));
  await done(eng);
  const recs = await recsOf(eng);
  assert.deepEqual(ids.map((id) => latest(recs, id).status), ['Completed', 'Completed']);
  assert.ok(ids.every((id) => latest(recs, id).confirmed));
  const survey = await Storage.get('surveys', 'sv');
  assert.ok(survey.questions.length >= 7);
});

test('safety: destination must be confirmed, must match the tab, no concurrent runs, respondents required', async () => {
  await freshStorage();
  const st = makeEnv('multipage.html', MP_URL);
  const eng = new RunEngine(st.env);
  const ids = await seed(2);
  await assert.rejects(eng.start(startOpts(ids, MP_URL, { destinationConfirmed: false })), { code: 'DESTINATION_NOT_CONFIRMED' });
  await assert.rejects(eng.start(startOpts(ids, 'http://localhost/other.html')), { code: 'DESTINATION_MISMATCH' });
  await assert.rejects(eng.start(startOpts([], MP_URL)), { code: 'NO_RESPONDENTS' });
  st.closed = true;
  await assert.rejects(eng.start(startOpts(ids, MP_URL)), { code: 'TAB_CLOSED' });
  st.closed = false;
  assert.equal(st.messages.length, 0, 'nothing may touch the page when a start is refused');
  await eng.start(startOpts(ids, MP_URL));
  await assert.rejects(eng.start(startOpts(ids, MP_URL)), { code: 'RUN_ACTIVE' });
  await done(eng);
  assert.equal(eng.loopActive, false);
});

test('safety: navigating away mid-run stops all interaction, fails the respondent and pauses the run', async () => {
  await freshStorage();
  let after = [];
  const st = makeEnv('multipage.html', MP_URL, { onMessage: (msg, s) => { if (s.urlOverride) after.push(msg.type); if (msg.type === 'fillSection' && !s.urlOverride) s.urlOverride = 'http://evil.example/other'; } });
  const eng = new RunEngine(st.env);
  const ids = await seed(2);
  await eng.start(startOpts(ids, MP_URL));
  await until(() => eng.run.status === 'paused');
  await until(() => !eng.loopActive || true);
  const recs = await recsOf(eng);
  const r1 = latest(recs, ids[0]);
  assert.equal(r1.status, 'Failed'); assert.match(r1.error, /navigated away|different/i);
  assert.equal(after.filter((t) => ['fillSection', 'next', 'submit'].includes(t)).length, 0, 'no fill/next/submit after leaving the destination: ' + after);
  assert.equal(recs.filter((r) => r.respondentId === ids[1]).length, 0, 'second respondent must not start while paused');
  assert.ok((await Storage.listLogs()).some((l) => l.action === 'Run paused'));
  await eng.stop();
});

test('stuck Next: respondent fails with NAV_TIMEOUT after one click, diagnostics are captured, run continues', async () => {
  await freshStorage({ navigationTimeoutMs: 600, retryLimit: 0 });
  let clicks = 0;
  const st = makeEnv('stuck.html', MP_URL);
  const origNavigate = st.env.navigate;
  st.env.navigate = async (id, u) => { await origNavigate(id, u); st.win.document.getElementById('next').addEventListener('click', () => clicks++); };
  st.win.document.getElementById('next').addEventListener('click', () => clicks++);
  st.win.__sp = true;
  const eng = new RunEngine(st.env);
  const ids = await seed(2);
  await eng.start(startOpts(ids, MP_URL));
  await done(eng);
  const recs = await recsOf(eng);
  assert.deepEqual(ids.map((id) => latest(recs, id).status), ['Failed', 'Failed']);
  assert.ok(ids.every((id) => /did not change/i.test(latest(recs, id).error)), latest(recs, ids[0]).error);
  assert.equal(clicks, 2, 'exactly one Next click per respondent, never a click loop');
  const diag = await Storage.get('diagnostics', latest(recs, ids[0]).diagnosticId);
  assert.equal(diag.code, 'NAV_TIMEOUT'); assert.equal(diag.screenshot, 'data:image/jpeg;base64,FAKESHOT');
  assert.equal(diag.url, MP_URL); assert.ok(diag.timestamp > 0);
  assert.deepEqual(diag.visibleQuestions, ['Your full name', 'How often do you use the bus?']);
  assert.ok(diag.currentSection && diag.currentSection.index === 0);
  assert.ok(Array.isArray(diag.missingQuestions) && Array.isArray(diag.validationMessages) && Array.isArray(diag.consoleErrors));
  const stats = Stats.compute({ run: eng.run, records: recs, respondents: [] });
  assert.deepEqual([stats.failedRuns, stats.completedRuns, stats.successRate], [2, 0, 0]);
});

test('retry re-runs a failed respondent and the latest record wins in the statistics', async () => {
  await freshStorage({ navigationTimeoutMs: 500, retryLimit: 0 });
  const st = makeEnv('stuck.html', MP_URL);
  const eng = new RunEngine(st.env);
  const ids = await seed(1);
  await eng.start(startOpts(ids, MP_URL));
  await done(eng);
  assert.equal(latest(await recsOf(eng), ids[0]).status, 'Failed');
  // Fix the "form": swap to a working fixture, then retry.
  const working = makeEnv('multipage.html', MP_URL);
  st.env.navigate = async (id, u) => { st.win.close(); st.win = loadForm('multipage.html', u); };
  st.win = loadForm('multipage.html', MP_URL);
  await eng.retry(ids[0]);
  await done(eng);
  const recs = await recsOf(eng);
  assert.equal(recs.filter((r) => r.respondentId === ids[0] && r.status === 'Failed').length, 1);
  assert.equal(latest(recs, ids[0]).status, 'Completed');
  const stats = Stats.compute({ run: eng.run, records: recs, respondents: [] });
  assert.deepEqual([stats.completedRuns, stats.failedRuns], [1, 0]);
  await assert.rejects(eng.retry(ids[0]), { code: 'NOT_RETRYABLE' });
  void working;
});

test('pause holds the loop, resume continues, paused time is excluded from elapsed', async () => {
  await freshStorage({ delayBetweenRunsMs: 250 });
  const st = makeEnv('multipage.html', MP_URL);
  const eng = new RunEngine(st.env);
  const ids = await seed(3);
  await eng.start(startOpts(ids, MP_URL));
  await until(async () => (await recsOf(eng)).some((r) => r.status === 'Completed'));
  await eng.pause();
  const countAtPause = (await recsOf(eng)).length;
  await Util.sleep(700);
  const recsWhilePaused = await recsOf(eng);
  const finishedDuringPause = recsWhilePaused.filter((r) => r.status === 'Completed').length;
  assert.ok(recsWhilePaused.length <= countAtPause + 1, 'at most the in-flight respondent may finish while paused');
  assert.equal(eng.run.status, 'paused');
  await assert.rejects(eng.pause(), { code: 'NOT_RUNNING' });
  const stillPending = ids.filter((id) => !latest(recsWhilePaused, id) || !['Completed'].includes(latest(recsWhilePaused, id).status)).length;
  assert.ok(finishedDuringPause < 3 || stillPending === 0);
  await eng.resume();
  await done(eng);
  const recs = await recsOf(eng);
  assert.deepEqual(ids.map((id) => latest(recs, id).status), ['Completed', 'Completed', 'Completed']);
  assert.ok(eng.run.pausedMs >= 600, 'pausedMs=' + eng.run.pausedMs);
  const total = eng.run.endedAt - eng.run.startedAt;
  const stats = Stats.compute({ run: eng.run, records: recs, respondents: [] });
  assert.ok(stats.elapsedMs <= total - 600 + 5);
});

test('skip marks only the current respondent as Skipped; stop ends the run and leaves the rest Pending', async () => {
  await freshStorage();
  let eng, reads = 0, skipped = false, stopped = false;
  const st = makeEnv('multipage.html', MP_URL, { onMessage: async (msg) => {
    if (msg.type !== 'read') return;
    reads++;
    if (!skipped && reads === 1) { skipped = true; await eng.skip(); }
  } });
  eng = new RunEngine(st.env);
  const ids = await seed(3);
  await eng.start(startOpts(ids, MP_URL));
  await done(eng);
  let recs = await recsOf(eng);
  assert.deepEqual(ids.map((id) => latest(recs, id).status), ['Skipped', 'Completed', 'Completed']);
  await eng.reset();

  // stop
  let eng2, seen = 0;
  const st2 = makeEnv('multipage.html', MP_URL, { onMessage: async (msg) => { if (msg.type === 'fillSection' && ++seen === 5 && !stopped) { stopped = true; await eng2.stop(); } } });
  eng2 = new RunEngine(st2.env);
  await eng2.start(startOpts(ids, MP_URL));
  await done(eng2);
  recs = await recsOf(eng2);
  assert.equal(eng2.run.status, 'stopped');
  assert.equal(latest(recs, ids[0]).status, 'Completed');
  assert.equal(latest(recs, ids[1]).status, 'Failed'); assert.match(latest(recs, ids[1]).error, /stopped/i);
  assert.equal(latest(recs, ids[2]), undefined, 'respondents after the stop stay pending');
  const stats = Stats.compute({ run: eng2.run, records: recs, respondents: [] });
  assert.equal(stats.pendingRuns, 1);
});

test('reset deletes run records only (respondents stay) and allows a new run', async () => {
  await freshStorage();
  const st = makeEnv('multipage.html', MP_URL);
  const eng = new RunEngine(st.env);
  const ids = await seed(1);
  await eng.start(startOpts(ids, MP_URL)); await done(eng);
  const runId = eng.run.id;
  await eng.reset();
  assert.equal(eng.run, null);
  assert.equal((await Storage.listRunRecords(runId)).length, 0);
  assert.equal((await Storage.listRespondents()).length, 1);
  await eng.start(startOpts(ids, MP_URL)); await done(eng);
  assert.equal(eng.run.status, 'completed');
});

test('AI quota exhausted during a run: respondent still completes through local fallback; API key never logged', async () => {
  await freshStorage({ mode: 'ai', autoFallback: true, aiRetries: 0 });
  const KEY = 'AIzaSyD-FAKE_KEY_1234567890abcdefghij';
  const savedFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: { message: 'You exceeded your current quota, please check your plan (key ' + KEY + ')', status: 'RESOURCE_EXHAUSTED' } }) }; };
  try {
    const st = makeEnv('multipage.html', MP_URL); st.apiKey = KEY;
    const eng = new RunEngine(st.env);
    const ids = await seed(2);
    await eng.start(startOpts(ids, MP_URL, { mode: 'ai' }));
    await done(eng);
    const recs = await recsOf(eng);
    assert.deepEqual(ids.map((id) => latest(recs, id).status), ['Completed', 'Completed']);
    assert.ok(calls >= 2, 'AI was attempted');
    const r = await Storage.get('respondents', ids[0]);
    assert.equal(r.source, 'local');
    const logs = await Storage.listLogs();
    assert.ok(logs.some((l) => l.level === 'warn' && /QUOTA_EXHAUSTED/.test(l.error)), 'quota problem is surfaced');
    const everything = JSON.stringify([logs, recs, await Storage.dumpAll()]);
    assert.ok(!everything.includes(KEY) && !everything.includes('FAKE_KEY'), 'API key leaked into stored data');
  } finally { globalThis.fetch = savedFetch; }
});

test('service worker restart: an interrupted run is restored as paused (never silently continues) and can be resumed', async () => {
  await freshStorage();
  const st = makeEnv('multipage.html', MP_URL);
  const ids = await seed(2);
  const run = { id: 'run_old', surveyId: 'sv', tabId: 1, destinationUrl: MP_URL, destinationKey: 'http://localhost/survey.html', confirmedAt: 1, mode: 'local', respondentIds: ids,
    status: 'running', startedAt: Date.now() - 5000, endedAt: null, pausedMs: 0, pauseStartedAt: null, currentRespondentId: ids[0], currentRecordId: 'rec_x', config: {} };
  await Storage.put('runs', run);
  await Storage.put('runRecords', { id: 'rec_x', runId: 'run_old', respondentId: ids[0], status: 'Filling', startedAt: Date.now() - 4000, questionTimings: [], sectionTimings: [] });
  const eng = new RunEngine(st.env);                         // brand new instance = restarted worker
  await eng.restore();
  assert.equal(eng.run.status, 'paused'); assert.equal(eng.run.interrupted, true); assert.equal(eng.loopActive, false);
  assert.equal((await Storage.get('runRecords', 'rec_x')).status, 'Paused');
  assert.equal(st.messages.length, 0, 'restoring must not touch the page');
  assert.ok((await Storage.listLogs()).some((l) => /interrupted/i.test(l.action)));
  await eng.resume(); await done(eng);
  const recs = await recsOf(eng);
  assert.equal(latest(recs, ids[0]).status, 'Completed'); assert.equal(latest(recs, ids[1]).status, 'Completed');
});

test('fill mode: fills every section, verifies, stops before Submit and never submits', async () => {
  await freshStorage();
  const st = makeEnv('multipage.html', MP_URL);
  const eng = new RunEngine(st.env);
  const [id] = await seed(1);
  const sum = await eng.fillActive({ tabId: 1, respondentId: id, surveyId: 'sv', advance: true, mode: 'local' });
  assert.equal(sum.ok, true, sum.message); assert.equal(sum.sections, 3); assert.ok(sum.filled >= 10);
  assert.match(sum.message, /NOT been submitted/);
  assert.equal(st.win.__submitted, undefined, 'fill mode must never submit');
  assert.equal(st.win.document.getElementById('s3').hidden, false);
  assert.ok(!st.messages.includes('submit'));
  assert.equal(st.win.document.getElementById('when').value !== '', true, 'last section is really filled');
});

test('fill mode without advance fills only the current section', async () => {
  await freshStorage();
  const st = makeEnv('multipage.html', MP_URL);
  const eng = new RunEngine(st.env);
  const [id] = await seed(1);
  const sum = await eng.fillActive({ tabId: 1, respondentId: id, surveyId: 'sv', advance: false, mode: 'local' });
  assert.equal(sum.ok, true); assert.equal(sum.sections, 1);
  assert.equal(st.win.document.getElementById('s1').hidden, false);
  assert.ok(!st.messages.includes('next'));
});

test('fill mode reports the exact failing question and stops (stuck form)', async () => {
  await freshStorage({ navigationTimeoutMs: 500 });
  const st = makeEnv('stuck.html', MP_URL);
  const eng = new RunEngine(st.env);
  const [id] = await seed(1);
  const sum = await eng.fillActive({ tabId: 1, respondentId: id, surveyId: 'sv', advance: true, mode: 'local' });
  assert.equal(sum.ok, false); assert.equal(sum.code, 'NAV_TIMEOUT'); assert.match(sum.message, /did not change/);
});

test('fill mode refuses to run while a test run is active', async () => {
  await freshStorage({ delayBetweenRunsMs: 200 });
  const st = makeEnv('multipage.html', MP_URL);
  const eng = new RunEngine(st.env);
  const ids = await seed(2);
  await eng.start(startOpts(ids, MP_URL));
  await assert.rejects(eng.fillActive({ tabId: 1, respondentId: ids[0], surveyId: 'sv', advance: false }), { code: 'RUN_ACTIVE' });
  await done(eng);
});

test('intro page without questions: Next is clicked, every question (optional too) is answered, form is submitted', async () => {
  await freshStorage();
  const st = makeEnv('intro.html', MP_URL);
  const eng = new RunEngine(st.env);
  const ids = await seed(2);
  await eng.start(startOpts(ids, MP_URL));
  await done(eng);
  const recs = await recsOf(eng);
  assert.deepEqual(ids.map((id) => latest(recs, id).status), ['Completed', 'Completed']);
  assert.ok(latest(recs, ids[0]).confirmed);
  assert.equal(st.submissions.length + (st.win.__submitted ? 1 : 0), 2);
  const sub = st.submissions[0] || st.win.__submitted;
  assert.ok(sub.get('nm'), 'name filled'); assert.ok(sub.get('t'), 'radio chosen'); assert.ok(sub.get('opt'), 'optional question is answered too, not skipped');
});
