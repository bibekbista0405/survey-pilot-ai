/* Real-Chromium end-to-end: loads the unpacked extension, serves the local multi-page fixture, starts a run through the
   real service worker and checks that every respondent was submitted. Run: node tests/e2e-chromium.js */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const N = 3;
(async () => {
  let submits = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__submit')) { submits++; res.end('ok'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(fs.readFileSync(path.join(ROOT, "tests/forms/" + (process.env.FIXTURE || "multipage.html")), "utf8").replace(/window\.__submitted = new FormData\((\w+)\);/, (m) => m + " fetch(\"/__submit\");"));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/survey';
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-')), {
    headless: false, args: ['--headless=new', '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT, '--no-sandbox'] });
  try {
    let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    const form = await ctx.newPage(); await form.goto(url);
    const panel = await ctx.newPage(); const errs = [];
    panel.on('pageerror', (e) => errs.push(e.message));
    await panel.goto('chrome-extension://' + extId + '/sidepanel/sidepanel.html');
    await panel.waitForSelector('.tabs');
    const out = await panel.evaluate(async ({ url, N }) => {
      const SP = window.SP; await SP.Storage.open();
      const tabs = await new Promise((r) => chrome.tabs.query({}, r));
      const tab = tabs.find((t) => t.url === url);
      const profiles = SP.RespondentGen.generateMany(SP.RespondentGen.defaultConfig(), N, 0);
      const recs = profiles.map((p) => ({ id: p.id, index: p.index, surveyId: SP.Parser.surveyId(url), profile: p, answers: {}, source: 'local', createdAt: Date.now(), generationMs: 0 }));
      await SP.Storage.putMany('respondents', recs);
      const call = (c, extra) => new Promise((r) => chrome.runtime.sendMessage(Object.assign({ sp: 'cmd', cmd: c }, extra), r));
      const st = await call('run.start', { options: { tabId: tab.id, destinationUrl: url, destinationConfirmed: true, confirmedAt: Date.now(), surveyId: SP.Parser.surveyId(url), respondentIds: recs.map((r) => r.id), mode: 'local' } });
      if (!st || !st.ok) return { error: JSON.stringify(st) };
      const t0 = Date.now(); let run;
      while (Date.now() - t0 < 90000) { run = (await call('run.state', {})).run; if (run && run.status !== 'running') break; await new Promise((r) => setTimeout(r, 500)); }
      const records = await SP.Storage.listRunRecords(run.id);
      return { status: run.status, records: records.map((r) => ({ id: r.respondentId, status: r.status, confirmed: r.confirmed, error: r.error, result: r.result })) };
    }, { url, N });
    console.log(JSON.stringify(out, null, 1));
    const done = out.records && out.records.filter((r) => r.status === 'Completed').length;
    console.log('server saw submits:', submits, '| completed records:', done, '| panel errors:', errs.length ? errs : 'none');
    const ok = !out.error && out.status === 'completed' && done === N && submits === N;
    console.log(ok ? 'E2E PASS' : 'E2E FAIL');
    process.exitCode = ok ? 0 : 1;
  } finally { await ctx.close(); server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
