/* UI smoke test: loads each extension page in real Chromium with a mocked chrome.* API and reports script errors.
   Needs Playwright (not an npm dependency of the extension). Run: node tests/ui-smoke.js */
'use strict';
const path = require('path');
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { console.error('playwright not installed: ' + e.message); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const MOCK = `
  window.__store = {};
  window.chrome = {
    runtime: { lastError: null, id: 'mock', sendMessage: (m, cb) => setTimeout(() => cb && cb({ ok: true, state: null, run: null, data: null }), 0),
      onMessage: { addListener() {} }, openOptionsPage() {} },
    storage: { local: { get: (k, cb) => { const r = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { if (x in window.__store) r[x] = window.__store[x]; }); cb ? cb(r) : null; return Promise.resolve(r); },
      set: (o, cb) => { Object.assign(window.__store, o); cb && cb(); return Promise.resolve(); }, remove: (k, cb) => { cb && cb(); return Promise.resolve(); } } },
    tabs: { query: (q, cb) => { const t = [{ id: 1, url: 'https://example.com/form', title: 'Form' }]; cb ? cb(t) : null; return Promise.resolve(t); },
      sendMessage: (id, m, cb) => { cb && cb(undefined); }, onActivated: { addListener() {} }, onUpdated: { addListener() {} } }
  };`;
(async () => {
  const browser = await chromium.launch();
  let failed = 0;
  for (const page of ['sidepanel/sidepanel.html', 'popup/popup.html', 'options/options.html']) {
    const p = await browser.newPage({ viewport: { width: 420, height: 800 } });
    const errs = [];
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await p.addInitScript(MOCK);
    await p.goto('file://' + path.join(ROOT, page));
    await p.waitForTimeout(800);
    const len = await p.evaluate(() => document.body.innerText.length);
    console.log((errs.length || len < 20 ? 'FAIL ' : 'ok   ') + page + ' (' + len + ' chars of text)');
    errs.forEach((e) => console.log('   ' + e));
    if (errs.length || len < 20) failed++;
    await p.screenshot({ path: path.join(process.env.SHOT_DIR || '/tmp', path.basename(page, '.html') + '.png') });
    await p.close();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
