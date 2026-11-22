/* Static extension check: manifest structure, referenced files exist, HTML script/css references resolve, JS syntax is valid. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const problems = [];
const fail = (m) => problems.push(m);
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
if (m.manifest_version !== 3) fail('manifest_version must be 3');
['name', 'version', 'description'].forEach((k) => { if (!m[k]) fail('manifest missing ' + k); });
const refs = [];
if (m.background) refs.push(m.background.service_worker);
if (m.side_panel) refs.push(m.side_panel.default_path);
if (m.options_ui) refs.push(m.options_ui.page);
if (m.action) { refs.push(m.action.default_popup); Object.values(m.action.default_icon || {}).forEach((i) => refs.push(i)); }
Object.values(m.icons || {}).forEach((i) => refs.push(i));
(m.content_scripts || []).forEach((cs) => (cs.js || []).concat(cs.css || []).forEach((f) => refs.push(f)));
refs.filter(Boolean).forEach((f) => { if (!exists(f)) fail('manifest references missing file: ' + f); });
const allowed = ['storage', 'unlimitedStorage', 'sidePanel', 'tabs', 'scripting', 'activeTab', 'alarms'];
(m.permissions || []).forEach((p) => { if (!allowed.includes(p)) fail('unexpected permission: ' + p); });
if (!(m.permissions || []).includes('sidePanel')) fail('sidePanel permission missing');

// HTML references
['sidepanel/sidepanel.html', 'popup/popup.html', 'options/options.html'].forEach((h) => {
  const html = fs.readFileSync(path.join(ROOT, h), 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(html)) fail(h + ': inline script violates the extension CSP');
  const re = /(?:src|href)="([^"#?]+)"/g; let x;
  while ((x = re.exec(html))) {
    if (/^(https?:|data:|mailto:)/.test(x[1])) { fail(h + ': external resource ' + x[1]); continue; }
    const p = path.normalize(path.join(path.dirname(h), x[1]));
    if (!exists(p)) fail(h + ' references missing file ' + x[1]);
  }
});

// importScripts in the service worker
const sw = fs.readFileSync(path.join(ROOT, 'background/service-worker.js'), 'utf8');
const imp = sw.match(/importScripts\(([\s\S]*?)\)/);
if (imp) (imp[1].match(/'([^']+)'/g) || []).forEach((s) => { const f = path.join('background', s.replace(/'/g, '')); if (!exists(path.normalize(f))) fail('importScripts missing: ' + f); });

// JS syntax
function walk(d, out) {
  fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    if (e.name === 'node_modules' || e.name === '.git') return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
  });
  return out;
}
const files = walk(ROOT, []);
files.forEach((f) => { try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }); } catch (e) { fail('syntax error in ' + path.relative(ROOT, f) + ': ' + e.message); } });
const bad = files.filter((f) => /\b(TODO|FIXME|XXX)\b/.test(fs.readFileSync(f, 'utf8')) && !f.includes('check-extension'));
bad.forEach((f) => fail('placeholder marker in ' + path.relative(ROOT, f)));

if (problems.length) { console.error('FAILED:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log('OK: manifest valid, ' + refs.filter(Boolean).length + ' manifest references and all HTML/importScripts references resolve, ' + files.length + ' JS files parse, no TODO markers.');
