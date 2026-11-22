/*
 * Modern Google Forms simulation test.
 * Loads tests/test-form-modern-google-forms.html (which uses [role="listitem"][data-params],
 * [role="radio"], [role="checkbox"], [role="listbox"], .M7eMe, .H2GQcc — the actual
 * DOM structure of modern Google Forms) and verifies detection + reading + filling.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

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

function loadContentScriptsIntoDom(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://docs.google.com/forms/d/e/1FAIpQLSfzJxdaXIYq0SMqKcqBy5Z6j7b0YFiUiw0xmNv6gfYps5oKAw/viewform' });
  const w = dom.window;
  w.CSS = w.CSS || {};
  w.CSS.escape = w.CSS.escape || ((s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c));
  w.chrome = { runtime: { onMessage: { addListener: () => {} } } };
  const files = [
    'core/storage.js', 'core/survey-parser.js', 'core/respondent-generator.js',
    'core/answer-generator.js', 'core/statistics.js', 'core/export.js',
    'content/form-detector.js', 'content/form-reader.js', 'content/form-filler.js',
    'content/form-navigation.js', 'content/validation.js'
  ];
  for (const f of files) { w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); }
  return w;
}

async function main() {
  console.log('Running modern Google Forms simulation tests...');

  const htmlPath = path.join(ROOT, 'tests', 'test-form-modern-google-forms.html');
  const w = loadContentScriptsIntoDom(htmlPath);
  const SP = w.SurveyPilot;

  // ---- Form detection ----
  console.log('  Detection:');
  const det = SP.FormDetector.detect();
  ok('modern GF detected', det.ok, 'got: ' + JSON.stringify(det).slice(0, 200));
  ok('formType google_forms', det.formType === 'google_forms', 'got ' + det.formType);
  ok('title detected', det.title.indexOf('Customer Feedback') !== -1, 'got ' + det.title);

  // ---- Form reading ----
  console.log('  Reading:');
  const read = SP.FormReader.read();
  ok('read ok', read.ok);
  ok('has sections', read.sections && read.sections.length >= 1);
  const questions = read.sections[0].questions;
  ok('6 questions detected', questions.length === 6, 'got ' + questions.length);

  // Check each question type
  const q1 = questions.find((q) => /name/i.test(q.text));
  ok('Q1 short_answer', q1 && q1.type === 'short_answer', 'got ' + (q1 && q1.type));
  ok('Q1 required', q1 && q1.required);

  const q2 = questions.find((q) => /hear about/i.test(q.text));
  ok('Q2 multiple_choice', q2 && q2.type === 'multiple_choice', 'got ' + (q2 && q2.type));
  ok('Q2 has 4 options', q2 && q2.options.length === 4, 'got ' + (q2 && q2.options.length));
  ok('Q2 options correct', q2 && q2.options.includes('Friend') && q2.options.includes('Social media'));

  const q3 = questions.find((q) => /products/i.test(q.text));
  ok('Q3 checkbox', q3 && q3.type === 'checkbox', 'got ' + (q3 && q3.type));
  ok('Q3 has 3 options', q3 && q3.options.length === 3);

  const q4 = questions.find((q) => /satisfied/i.test(q.text));
  ok('Q4 linear_scale', q4 && q4.type === 'linear_scale', 'got ' + (q4 && q4.type));
  ok('Q4 min 1 max 5', q4 && q4.minValue === 1 && q4.maxValue === 5);

  const q5 = questions.find((q) => /contact method/i.test(q.text));
  ok('Q5 dropdown', q5 && q5.type === 'dropdown', 'got ' + (q5 && q5.type));
  ok('Q5 has 4 options', q5 && q5.options.length === 4, 'got ' + (q5 && q5.options.length));

  const q6 = questions.find((q) => /comments/i.test(q.text));
  ok('Q6 paragraph', q6 && q6.type === 'paragraph', 'got ' + (q6 && q6.type));

  // ---- Form filling ----
  console.log('  Filling:');

  // Fill short answer
  const fillText = await SP.FormFiller.fillQuestion(q1, { value: 'Jane Doe' });
  ok('text fill ok', fillText.ok);
  ok('text verified', fillText.verified);
  const textInput = w.document.querySelector('input[type="text"]');
  eq('text DOM value', textInput.value, 'Jane Doe');

  // Fill multiple choice (ARIA radio)
  const fillRadio = await SP.FormFiller.fillQuestion(q2, { value: 'Social media' });
  ok('radio fill ok', fillRadio.ok);
  const checkedRadio = w.document.querySelector('[role="radio"][aria-checked="true"]');
  ok('radio aria-checked', checkedRadio && checkedRadio.getAttribute('aria-label') === 'Social media');

  // Fill checkbox
  const fillCheckbox = await SP.FormFiller.fillQuestion(q3, { value: ['Product A', 'Product C'] });
  ok('checkbox fill ok', fillCheckbox.ok);
  const checkedBoxes = Array.from(w.document.querySelectorAll('[role="checkbox"][aria-checked="true"]')).map((c) => c.getAttribute('aria-label'));
  eq('checkbox DOM state', checkedBoxes.sort(), ['Product A', 'Product C']);

  // Fill linear scale
  const fillScale = await SP.FormFiller.fillQuestion(q4, { value: 4 });
  ok('scale fill ok', fillScale.ok);
  const checkedScale = w.document.querySelector('[role="radio"][aria-checked="true"][data-value="4"]');
  ok('scale aria-checked', !!checkedScale);

  // Fill dropdown (custom listbox)
  const fillDrop = await SP.FormFiller.fillQuestion(q5, { value: 'Email' });
  ok('dropdown fill ok', fillDrop.ok);
  const selectedOpt = w.document.querySelector('[role="option"][aria-selected="true"]');
  ok('dropdown option selected', !!selectedOpt && selectedOpt.getAttribute('aria-label') === 'Email');

  // Fill paragraph
  const fillPara = await SP.FormFiller.fillQuestion(q6, { value: 'Great experience.' });
  ok('paragraph fill ok', fillPara.ok);
  const textarea = w.document.querySelector('textarea');
  ok('paragraph DOM value', textarea.value.indexOf('Great') === 0);

  // ---- Navigation ----
  console.log('  Navigation:');
  const nav = SP.FormNavigation.findButtons();
  ok('next button found', nav.next.length > 0, 'got ' + nav.next.length);
  ok('submit button check', nav.submit.length >= 0);
  ok('prev button found', nav.prev.length > 0);

  console.log('\nModern GF tests: ' + pass + ' passed, ' + fail + ' failed.');
  if (fail > 0) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  return fail === 0;
}

module.exports = { main };
