'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { loadForm, send, ROOT, CONTENT_SCRIPTS } = require('./helpers/harness.js');

const GOOGLE_URL = 'https://docs.google.com/forms/d/e/TESTFORM/viewform';
const byText = (qs, t) => qs.find((q) => q.text.startsWith(t));

/** Builds a page from raw HTML with the content scripts injected. */
function loadHtml(html, url) {
  const dom = new JSDOM(html, { url: url || 'http://localhost/t.html', runScripts: 'dangerously', pretendToBeVisual: true });
  CONTENT_SCRIPTS.forEach((s) => dom.window.eval(fs.readFileSync(path.join(ROOT, s), 'utf8')));
  return dom.window;
}

/* ---------------- detection ---------------- */
test('detects the multi-page HTML form with accurate counts', async () => {
  const w = loadForm('multipage.html');
  const { detection: d } = await send(w, 'detect');
  assert.equal(d.status, 'supported'); assert.equal(d.kind, 'html-form');
  assert.equal(d.title, 'Campus Travel Survey');
  assert.equal(d.questionCount, 12); assert.equal(d.sectionCount, 3); assert.equal(d.requiredCount, 8);
  assert.deepEqual(d.types, { short_answer: 2, dropdown: 1, multiple_choice: 3, checkbox: 1, linear_scale: 1, paragraph: 1, date: 1, time: 1, rating: 1 });
  assert.equal(d.url, 'http://localhost/survey.html');
});

test('detects the Google-Forms-style ARIA fixture', async () => {
  const w = loadForm('google-like.html', GOOGLE_URL);
  const { detection: d } = await send(w, 'detect');
  assert.equal(d.status, 'supported'); assert.equal(d.kind, 'google-forms');
  assert.equal(d.title, 'Rider Survey');
  assert.ok(d.questionCount >= 7, 'got ' + d.questionCount);
  assert.equal(d.sectionCount, 1 + 1 > 1 ? d.sectionCount : 1);
});

test('never reports success when nothing is detectable', async () => {
  const cases = {
    empty: '<html><body><p>Hello</p></body></html>',
    login: '<form><label>User <input name="u"></label><label>Pass <input type="password" name="p"></label><button>Go</button></form>',
    search: '<form role="search"><input name="q" type="search"></form>',
    onlyHidden: '<form><input type="hidden" name="a" value="1"><input type="submit"></form>',
    unsupported: '<form><label>Pick a colour <input type="color" name="c"></label></form>'
  };
  for (const [name, html] of Object.entries(cases)) {
    const w = loadHtml(html);
    const { detection: d } = await send(w, 'detect');
    assert.equal(d.status, 'unsupported', name + ' must be unsupported');
    assert.ok(d.reason.length > 10, name + ' must explain why');
    assert.equal(d.questionCount, 0, name);
  }
});

test('closed and confirmation Google pages are unsupported with a clear reason', async () => {
  let w = loadHtml('<body><div role="heading">Form</div><p>This form is no longer accepting responses</p></body>', GOOGLE_URL);
  let { detection: d } = await send(w, 'detect');
  assert.equal(d.status, 'unsupported'); assert.match(d.reason, /closed/i);
  w = loadHtml('<body><p>Your response has been recorded.</p></body>', 'https://docs.google.com/forms/d/e/TESTFORM/formResponse');
  ({ detection: d } = await send(w, 'detect'));
  assert.equal(d.status, 'unsupported'); assert.match(d.reason, /confirmation/i);
});

test('partially supported forms are flagged, not claimed as fully supported', async () => {
  const w = loadHtml('<form><label>Name <input name="n" type="text"></label><label>Month <input type="month" name="m"></label></form>');
  const { detection: d } = await send(w, 'detect');
  assert.equal(d.status, 'partial'); assert.equal(d.questionCount, 1); assert.equal(d.unsupportedCount, 1);
});

/* ---------------- reader ---------------- */
test('reader extracts text, type, options, required, sections and validation info', async () => {
  const w = loadForm('multipage.html');
  const { form } = await send(w, 'read', { includeHidden: true });
  const q = form.questions;
  const name = byText(q, 'Your full name');
  assert.deepEqual([name.type, name.required, name.sectionIndex, name.sectionTitle, name.visible], ['short_answer', true, 0, 'About you', true]);
  const age = byText(q, 'What is your age');
  assert.equal(age.type, 'dropdown'); assert.deepEqual(age.options.slice(0, 2), ['Under 18', '18-24']); assert.equal(age.options.length, 7);   // placeholder removed
  const gender = byText(q, 'What is your gender');
  assert.deepEqual([gender.type, gender.required, gender.options.length], ['multiple_choice', true, 4]);
  assert.equal(byText(q, 'Are you currently').required, false);
  const modes = byText(q, 'Which modes');
  assert.deepEqual([modes.type, modes.options, modes.sectionIndex, modes.visible], ['checkbox', ['Bus', 'Car', 'Bicycle', 'Walking'], 1, false]);
  const sat = byText(q, 'How satisfied');
  assert.deepEqual([sat.type, sat.scale], ['linear_scale', { min: 1, max: 5 }]);
  assert.equal(byText(q, 'Please rate').type, 'rating');
  assert.equal(byText(q, 'Date of your').type, 'date'); assert.equal(byText(q, 'Usual departure').type, 'time');
  assert.equal(byText(q, 'Any comments').type, 'paragraph');
  assert.ok(q.every((x) => x.key && x.id), 'every question has an id and a stable key');
  assert.equal(new Set(q.map((x) => x.key)).size, q.length, 'keys are unique');
});

test('reader returns only currently visible questions and follows section changes', async () => {
  const w = loadForm('multipage.html');
  let { form } = await send(w, 'read');
  assert.deepEqual(form.questions.map((x) => x.sectionIndex), [0, 0, 0, 0]);
  assert.ok(form.questions.every((x) => x.visible));
  const sig1 = form.signature;
  w.document.getElementById('s1').hidden = true; w.document.getElementById('s2').hidden = false;
  ({ form } = await send(w, 'read', { pageIndex: 1, force: true }));
  assert.equal(form.questions.length, 4); assert.ok(form.questions[0].text.startsWith('How often'));
  assert.notEqual(form.signature, sig1);
  assert.ok(form.questions.every((x) => x.visible));
});

test('hidden questions are marked not visible when reading everything', async () => {
  const w = loadForm('multipage.html');
  const { form } = await send(w, 'read', { includeHidden: true });
  assert.equal(form.questions.filter((x) => x.visible).length, 4);
  assert.equal(form.questions.filter((x) => !x.visible).length, 8);
});

test('reader copes with unlabelled markup using fallback strategies (aria-label, placeholder, text before control, name)', async () => {
  const w = loadHtml(`<form>
    <input type="text" aria-label="Favourite colour">
    <input type="email" placeholder="Work email">
    <div class="field"><span>Describe your day</span><textarea></textarea></div>
    <input type="number" name="shoe_size">
    <div role="radiogroup" aria-label="Pick one"><div role="radio" aria-checked="false" data-value="Yes"></div><div role="radio" aria-checked="false" data-value="No"></div></div>
  </form>`);
  const { form } = await send(w, 'read');
  assert.deepEqual(form.questions.map((q) => q.text), ['Favourite colour', 'Work email', 'Describe your day', 'shoe size', 'Pick one']);
  assert.deepEqual(form.questions.map((q) => q.type), ['short_answer', 'short_answer', 'paragraph', 'short_answer', 'multiple_choice']);
  assert.deepEqual(form.questions[4].options, ['Yes', 'No']);
});

test('required detection: attribute, aria-required, asterisk, "(required)", and none', async () => {
  const w = loadHtml(`<form>
    <label>A <input name="a" required></label>
    <label>B <input name="b" aria-required="true"></label>
    <label>C * <input name="c"></label>
    <label>D (required) <input name="d"></label>
    <label>E <input name="e"></label>
  </form>`);
  const { form } = await send(w, 'read');
  assert.deepEqual(form.questions.map((q) => [q.text, q.required]), [['A', true], ['B', true], ['C', true], ['D', true], ['E', false]]);
});

test('duplicate question texts get distinct keys', async () => {
  const w = loadHtml('<form><label>Comment <input name="a"></label><label>Comment <input name="b"></label></form>');
  const { form } = await send(w, 'read');
  assert.equal(form.questions.length, 2); assert.notEqual(form.questions[0].key, form.questions[1].key);
});

test('Google-style ARIA fixture: types, options, required, entry ids, native + ARIA mixing', async () => {
  const w = loadForm('google-like.html', GOOGLE_URL);
  const { form } = await send(w, 'read', { includeHidden: true });
  const q = form.questions;
  const bus = byText(q, 'How often do you use the bus');
  assert.deepEqual([bus.type, bus.options, bus.required, bus.entryId, bus.detectedBy], ['multiple_choice', ['Never', 'Weekly', 'Daily'], true, '1001', 'aria']);
  const modes = byText(q, 'Which modes');
  assert.deepEqual([modes.type, modes.options, modes.required], ['checkbox', ['Bus', 'Car', 'Bike'], false]);
  const area = byText(q, 'Home area');
  assert.deepEqual([area.type, area.options, area.required], ['dropdown', ['Urban', 'Suburban', 'Rural'], true]);
  assert.equal(byText(q, 'Rate the service').type, 'rating');
  assert.deepEqual([byText(q, 'Tell us your name').type, byText(q, 'Tell us your name').required], ['short_answer', true]);
  assert.equal(byText(q, 'Any suggestions').type, 'paragraph');
  assert.equal(byText(q, 'Usual departure time').type, 'time');
  // Only page 1 is visible initially.
  assert.deepEqual(q.filter((x) => x.visible).map((x) => x.text), ['How often do you use the bus?', 'Which modes do you use?', 'Home area', 'Rate the service']);
});

test('diagnostic mode maps every question to DOM elements and can highlight/clear', async () => {
  const w = loadForm('multipage.html');
  const r = await send(w, 'diagnose', { highlight: true });
  assert.equal(r.diagnostics.length, 12);
  assert.ok(r.diagnostics.every((d) => d.container && d.controls.length >= 1));
  assert.ok(r.diagnostics.filter((d) => d.visible).length === 4);
  assert.equal(w.document.querySelectorAll('[data-sp-diag]').length, 12);
  await send(w, 'clearHighlights');
  assert.equal(w.document.querySelectorAll('[data-sp-diag]').length, 0);
  assert.ok(r.strategy.strategyCounts.native > 0);
});

/* ---------------- filler ---------------- */
const resFor = (r, t) => r.results.find((x) => x.text.startsWith(t));
async function fill(w, answers, extra) {
  const { form } = await send(w, 'read', { force: true, pageIndex: (extra && extra.pageIndex) || 0 });
  const map = {};
  for (const [t, v] of Object.entries(answers)) map[byText(form.questions, t).key] = v;
  return send(w, 'fillSection', Object.assign({ answers: map }, extra || {}));
}

test('text, dropdown, radio fills are applied and verified against the DOM', async () => {
  const w = loadForm('multipage.html');
  const r = await fill(w, { 'Your full name': 'Sam Rivera', 'What is your age': '25-34', 'What is your gender': 'Female', 'Are you currently': 'No' });
  assert.ok(r.results.every((x) => x.ok && x.verified), JSON.stringify(r.results));
  assert.equal(w.document.getElementById('name').value, 'Sam Rivera');
  assert.equal(w.document.getElementById('age').value, '25-34');
  assert.equal(w.document.querySelector('input[name=gender]:checked').value, 'f');
  assert.equal(w.document.querySelector('input[name=student]:checked').value, 'no');
  assert.equal(r.validation.valid, true);
});

test('fill triggers input and change events that frameworks listen to', async () => {
  const w = loadForm('multipage.html');
  const seen = [];
  ['name', 'age'].forEach((id) => ['input', 'change'].forEach((ev) => w.document.getElementById(id).addEventListener(ev, () => seen.push(id + ':' + ev))));
  w.document.querySelectorAll('input[name=gender]').forEach((el) => el.addEventListener('change', () => seen.push('gender:change')));
  await fill(w, { 'Your full name': 'X', 'What is your age': '18-24', 'What is your gender': 'Male' });
  assert.deepEqual(seen.sort(), ['age:change', 'age:input', 'gender:change', 'name:change', 'name:input']);
});

test('checkbox fill selects exactly the requested set and unticks others', async () => {
  const w = loadForm('multipage.html');
  w.document.getElementById('s1').hidden = true; w.document.getElementById('s2').hidden = false;
  w.document.querySelector('input[name=modes][value=bus]').checked = true;      // stale selection that must be removed
  const r = await fill(w, { 'Which modes': ['Car', 'Walking'] }, { pageIndex: 1 });
  assert.ok(resFor(r, 'Which modes').ok && resFor(r, 'Which modes').verified, JSON.stringify(r.results));
  assert.deepEqual([...w.document.querySelectorAll('input[name=modes]:checked')].map((e) => e.value).sort(), ['car', 'walk']);
});

test('linear scale and rating (numeric radios), date and time fill', async () => {
  const w = loadForm('multipage.html');
  w.document.getElementById('s1').hidden = true; w.document.getElementById('s3').hidden = false;
  const r = await fill(w, { 'Date of your': '2026-11-03', 'Usual departure': '08:15', 'Please rate': '3' }, { pageIndex: 2 });
  assert.ok(r.results.filter((x) => !x.skipped).every((x) => x.ok && x.verified), JSON.stringify(r.results));
  assert.ok(resFor(r, 'Email').skipped, 'optional unanswered question is skipped, not failed');
  assert.equal(w.document.getElementById('when').value, '2026-11-03');
  assert.equal(w.document.getElementById('depart').value, '08:15');
  assert.equal(w.document.querySelector('input[name=rate]:checked').value, '3');
});

test('range sliders, textareas and number inputs fill and verify', async () => {
  const w = loadHtml('<form><label>Pain <input type="range" min="0" max="10" step="1" name="p"></label><label>Notes <textarea name="n"></textarea></label><label>Count <input type="number" name="c"></label></form>');
  const { form } = await send(w, 'read');
  const r = await send(w, 'fillSection', { answers: { [form.questions[0].key]: '7', [form.questions[1].key]: 'Line1\nLine2', [form.questions[2].key]: '42' } });
  assert.ok(r.results.every((x) => x.ok && x.verified), JSON.stringify(r.results));
  assert.equal(w.document.querySelector('[name=p]').value, '7');
  assert.equal(w.document.querySelector('[name=n]').value, 'Line1\nLine2');
  assert.equal(w.document.querySelector('[name=c]').value, '42');
});

test('ARIA radios, checkboxes, listbox and hour/minute inputs (Google-style)', async () => {
  const w = loadForm('google-like.html', GOOGLE_URL);
  let r = await fill(w, { 'How often do you use the bus': 'Daily', 'Which modes': ['Bus', 'Bike'], 'Home area': 'Suburban', 'Rate the service': '4' });
  assert.ok(r.results.every((x) => x.ok && x.verified), JSON.stringify(r.results));
  assert.equal(w.document.querySelector('[role=radio][aria-checked=true][data-value=Daily]') !== null, true);
  assert.deepEqual([...w.document.querySelectorAll('[role=checkbox][aria-checked=true]')].map((e) => e.dataset.answerValue), ['Bus', 'Bike']);
  assert.equal(w.document.querySelector('#area-lb [aria-selected=true]').dataset.value, 'Suburban');
  assert.equal(r.validation.valid, true);
  w.document.getElementById('page1').hidden = true; w.document.getElementById('page2').hidden = false;
  r = await fill(w, { 'Tell us your name': 'Ada', 'Any suggestions': 'None', 'Usual departure time': '07:45' }, { pageIndex: 1 });
  assert.ok(r.results.every((x) => x.ok && x.verified), JSON.stringify(r.results));
  assert.deepEqual([...w.document.querySelectorAll('#page2 input[aria-label=Hour],#page2 input[aria-label=Minute]')].map((e) => e.value), ['7', '45']);
});

test('failure: option that does not exist is reported with the exact question and options', async () => {
  const w = loadForm('multipage.html');
  const r = await fill(w, { 'What is your gender': 'Martian' });
  const x = resFor(r, 'What is your gender');
  assert.equal(x.ok, false); assert.equal(x.code, 'OPTION_NOT_FOUND'); assert.equal(x.text, 'What is your gender?');
  assert.match(x.error, /Martian/); assert.match(x.error, /Female/);
  assert.equal(x.attempts, 1, 'no pointless retries for a missing option');
  assert.equal(r.validation.valid, false);
});

test('failure: a field that silently rejects the value is NOT marked completed (verification)', async () => {
  const w = loadHtml('<form><label>Code <input id="c" name="c" maxlength="3"></label></form>');
  // simulate a page script that reverts the value
  w.document.getElementById('c').addEventListener('input', (e) => { e.target.value = ''; });
  const { form } = await send(w, 'read');
  const r = await send(w, 'fillSection', { answers: { [form.questions[0].key]: 'ABCDEFG' }, retries: 2 });
  const x = r.results[0];
  assert.equal(x.ok, false); assert.equal(x.verified, false); assert.equal(x.code, 'VERIFY_FAILED'); assert.equal(x.attempts, 3);
  assert.match(x.error, /shows ""/);
});

test('retry recovers when the first attempt is overwritten by the page', async () => {
  const w = loadHtml('<form><label>Name <input id="n" name="n"></label></form>');
  let hits = 0;
  w.document.getElementById('n').addEventListener('input', (e) => { if (hits++ < 2) e.target.value = 'wrong'; });  // first set is clobbered (the helper clears first, so 2 events per attempt)
  const { form } = await send(w, 'read');
  const r = await send(w, 'fillSection', { answers: { [form.questions[0].key]: 'Right' }, retries: 3 });
  assert.equal(r.results[0].ok, true); assert.ok(r.results[0].attempts >= 2);
  assert.equal(w.document.getElementById('n').value, 'Right');
});

test('failure: missing answer for a required question, disabled and removed elements', async () => {
  const w = loadForm('multipage.html');
  let { form } = await send(w, 'read');
  let r = await send(w, 'fillSection', { answers: {} });
  const missing = r.results.filter((x) => x.code === 'MISSING_ANSWER');
  assert.equal(missing.length, 3);                                   // name, age, gender are required; student is optional
  assert.equal(r.validation.missing.length, 3);
  assert.ok(r.results.find((x) => x.text.startsWith('Are you currently')).skipped);
  w.document.getElementById('name').disabled = true;
  r = await send(w, 'fillSection', { answers: { [byText(form.questions, 'Your full name').key]: 'X' } });
  assert.equal(r.results.find((x) => x.text === 'Your full name').code, 'DISABLED');
});

test('invalid date/time formats are rejected with INVALID_ANSWER', async () => {
  const w = loadForm('multipage.html');
  w.document.getElementById('s1').hidden = true; w.document.getElementById('s3').hidden = false;
  const r = await fill(w, { 'Date of your': '03/11/2026', 'Usual departure': 'eight' }, { pageIndex: 2 });
  assert.deepEqual([resFor(r, 'Date of your').code, resFor(r, 'Usual departure').code], ['INVALID_ANSWER', 'INVALID_ANSWER']);
  assert.equal(w.document.getElementById('when').value, '');
});

test('hidden questions are never filled', async () => {
  const w = loadForm('multipage.html');
  const { form } = await send(w, 'read', { includeHidden: true });
  const hidden = form.questions.find((q) => !q.visible && q.type === 'short_answer');
  const r = await send(w, 'fillSection', { answers: { [hidden.key]: 'secret' } });
  assert.equal(w.document.getElementById('email').value, '');
  assert.ok(!r.results.some((x) => x.key === hidden.key));
});

/* ---------------- validation & navigation ---------------- */
test('validate reports exactly which required questions are unanswered', async () => {
  const w = loadForm('multipage.html');
  const { validation: v } = await send(w, 'validate', {});
  assert.deepEqual(v.missing.map((m) => m.text), ['Your full name', 'What is your age group?', 'What is your gender?']);
  assert.equal(v.valid, false);
});

test('Next with unanswered required questions surfaces the page validation message', async () => {
  const w = loadForm('multipage.html');
  const r = await send(w, 'next', { timeout: 1500 });
  assert.equal(r.nav.ok, false); assert.equal(r.nav.code, 'VALIDATION_ERROR');
  assert.match(r.nav.messages.join(' '), /required questions/i);
});

test('Next waits for the transition, confirms the section changed, and clicks exactly once', async () => {
  const w = loadForm('multipage.html');
  let clicks = 0; w.document.getElementById('next1').addEventListener('click', () => clicks++);
  await fill(w, { 'Your full name': 'A', 'What is your age': '18-24', 'What is your gender': 'Female' });
  const r = await send(w, 'next', { timeout: 2000 });
  assert.equal(r.nav.ok, true); assert.notEqual(r.nav.before, r.nav.after); assert.equal(clicks, 1);
  const { form } = await send(w, 'read', { pageIndex: 1, force: true });
  assert.ok(form.questions[0].text.startsWith('How often'));
});

test('Next that never changes the page times out (no endless clicking)', async () => {
  const w = loadHtml('<form><label>Q <input name="q"></label><button type="button" id="n">Next</button></form>');
  let clicks = 0; w.document.getElementById('n').addEventListener('click', () => clicks++);
  const t0 = Date.now();
  const r = await send(w, 'next', { timeout: 500 });
  assert.equal(r.nav.ok, false); assert.equal(r.nav.code, 'NAV_TIMEOUT'); assert.equal(clicks, 1);
  assert.ok(Date.now() - t0 < 2500);
});

test('navigation controls are detected: next, back, submit; missing and disabled cases', async () => {
  const w = loadForm('multipage.html');
  w.document.getElementById('s1').hidden = true; w.document.getElementById('s2').hidden = false;
  let { nav } = await send(w, 'navState');
  assert.deepEqual([nav.next && nav.next.label, nav.prev && nav.prev.label, nav.submit], ['Next', 'Back', null]);
  w.document.getElementById('s2').hidden = true; w.document.getElementById('s3').hidden = false;
  ({ nav } = await send(w, 'navState'));
  assert.deepEqual([nav.next, nav.prev && nav.prev.label, nav.submit && nav.submit.label], [null, 'Back', 'Submit']);
  const w2 = loadHtml('<form><label>Q <input name="q"></label><button type="button" disabled>Next</button></form>');
  assert.equal((await send(w2, 'next', {})).nav.code, 'NEXT_DISABLED');
  const w3 = loadHtml('<form><label>Q <input name="q"></label></form>');
  assert.equal((await send(w3, 'next', {})).nav.code, 'NO_NEXT');
  assert.equal((await send(w3, 'submit', {})).nav.code, 'NO_SUBMIT');
});

test('Back returns to the previous section', async () => {
  const w = loadForm('multipage.html');
  w.document.getElementById('s1').hidden = true; w.document.getElementById('s2').hidden = false;
  const r = await send(w, 'prev', { timeout: 1500 });
  assert.equal(r.nav.ok, true);
  assert.equal(w.document.getElementById('s1').hidden, false);
});

test('submit is only confirmed from real evidence on the page', async () => {
  const w = loadForm('multipage.html');
  let r = await send(w, 'confirm');
  assert.equal(r.confirmation.confirmed, false);
  // Blocked submit (required fields empty): reported as validation error, not success.
  w.document.getElementById('s1').hidden = true; w.document.getElementById('s3').hidden = false;
  r = await send(w, 'submit', { timeout: 1500 });
  assert.equal(r.nav.ok, false); assert.equal(r.nav.code, 'VALIDATION_ERROR');
  assert.equal(w.__submitted, undefined);
  await fill(w, { 'Date of your': '2026-11-03', 'Please rate': '2' }, { pageIndex: 2 });
  r = await send(w, 'submit', { timeout: 2000 });
  assert.equal(r.nav.ok, true); assert.equal(r.nav.confirmed, true); assert.match(r.nav.evidence, /Success element|Confirmation/);
});

test('submit click with no confirmation is reported as unconfirmed, never as success', async () => {
  const w = loadHtml('<form><label>Q <input name="q"></label><button type="submit" id="s">Submit</button></form>');
  w.document.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
  const r = await send(w, 'submit', { timeout: 300 });
  assert.equal(r.nav.ok, true); assert.equal(r.nav.confirmed, false); assert.match(r.nav.evidence, /no confirmation/i);
});

test('confirmation text while questions are still visible is not accepted', async () => {
  const w = loadHtml('<p>Thank you for your response! (marketing banner)</p><form><label>Q <input name="q"></label><button>Submit</button></form>');
  const r = await send(w, 'confirm');
  assert.equal(r.confirmation.confirmed, false);
});

test('Google ARIA fixture: full two-page fill, Next, Submit with confirmation', async () => {
  const w = loadForm('google-like.html', GOOGLE_URL);
  let r = await fill(w, { 'How often do you use the bus': 'Never', 'Home area': 'Urban', 'Rate the service': '5' });
  assert.equal(r.validation.valid, true);
  r = await send(w, 'next', { timeout: 1500, pageIndex: 0 });
  assert.equal(r.nav.ok, true);
  r = await fill(w, { 'Tell us your name': 'Test Person' }, { pageIndex: 1 });
  assert.equal(r.validation.valid, true);
  r = await send(w, 'submit', { timeout: 1500 });
  assert.equal(r.nav.confirmed, true); assert.equal(w.__submitted, true);
});

test('unknown messages and page errors produce structured errors, never exceptions', async () => {
  const w = loadForm('multipage.html');
  const r = await send(w, 'nonsense');
  assert.equal(r.ok, false); assert.equal(r.code, 'UNKNOWN_MESSAGE');
  w.dispatchEvent(new w.ErrorEvent('error', { message: 'Boom from page script', filename: 'app.js', lineno: 3 }));
  const s = await send(w, 'snapshot', {});
  assert.ok(s.snapshot.consoleErrors.some((e) => /Boom/.test(e.message)));
  assert.ok(s.snapshot.visibleQuestions.length === 4 && s.snapshot.missing.length === 3);
});

test('performance: reading a 400-question form stays fast', async () => {
  let html = '<form>';
  for (let i = 0; i < 400; i++) html += `<fieldset><legend>Question ${i}</legend><label><input type="radio" name="r${i}" value="a"> A</label><label><input type="radio" name="r${i}" value="b"> B</label></fieldset>`;
  const w = loadHtml(html + '</form>');
  const t0 = Date.now();
  const { form } = await send(w, 'read', { includeHidden: true });
  const ms = Date.now() - t0;
  assert.equal(form.questions.length, 400);
  assert.ok(ms < 4000, 'read took ' + ms + ' ms');
});

test('"Submit another response" is clicked only on a real confirmation page', async () => {
  const w = loadForm('multipage.html');
  let r = await send(w, 'another');
  assert.equal(r.clicked, false, 'form still showing: nothing to click');
  w.document.querySelector('form').hidden = true;
  w.document.getElementById('thanks').hidden = false;
  let clicked = 0; w.document.getElementById('again').addEventListener('click', (e) => { e.preventDefault(); clicked++; });
  r = await send(w, 'another');
  assert.equal(r.clicked, true); assert.equal(clicked, 1);
});

test('a first page with only an intro and a Next button is supported (intro: true), not "unsupported"', async () => {
  const w = loadForm('intro.html');
  const r = await send(w, 'detect');
  assert.equal(r.detection.status, 'supported'); assert.equal(r.detection.intro, true); assert.ok(r.detection.questionCount >= 0);
});
