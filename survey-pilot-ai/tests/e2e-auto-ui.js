/* Real-Chromium end-to-end of the Auto tab: ticks the authorisation box, presses Start Auto and checks the server received every submission. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..'), N = 2;
(async () => {
  let submits = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__submit')) { submits++; return res.end('ok'); }
    res.setHeader('content-type', 'text/html');
    res.end(fs.readFileSync(path.join(ROOT, "tests/forms/" + (process.env.FIXTURE || "multipage.html")), "utf8").replace(/window\.__submitted = new FormData\((\w+)\);/, (m) => m + " fetch(\"/__submit\");"));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/survey';
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-')), { headless: false, args: ['--headless=new', '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT, '--no-sandbox'] });
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    const panel = await ctx.newPage(); const errs = [];
    panel.on('pageerror', (e) => errs.push(e.message));
    await panel.goto('chrome-extension://' + extId + '/sidepanel/sidepanel.html');
    await panel.waitForSelector('text=Start Auto');
    const form = await ctx.newPage(); await form.goto(url); await form.bringToFront();
    await panel.waitForFunction((u) => document.body.innerText.includes(u.split('/survey')[0].replace('http://', '')) || document.body.innerText.includes('Survey (test form)'), url, { timeout: 10000 });
    await panel.fill('input[type=number]', String(N));
    await panel.check('input[type=checkbox]');
    await panel.click('button:has-text("Start Auto")');
    await panel.waitForFunction(() => /completed/i.test(document.body.innerText) && !/Running…/.test(document.body.innerText), null, { timeout: 60000, polling: 1000 }).catch(async (e) => { console.log('STUCK. panel text:', (await panel.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 1500)); throw e; });
    await panel.waitForTimeout(1500);
    const text = await panel.evaluate(() => document.body.innerText);
    await panel.screenshot({ path: process.env.SHOT || '/tmp/auto.png' });
    console.log(text.split('\n').filter(Boolean).slice(0, 40).join(' | '));
    console.log('submits at server:', submits, '| panel errors:', errs.length ? errs : 'none');
    const ok = submits === N && !errs.length; console.log(ok ? 'AUTO UI PASS' : 'AUTO UI FAIL'); process.exitCode = ok ? 0 : 1;
  } finally { await ctx.close(); server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
