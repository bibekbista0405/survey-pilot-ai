/*
 * DOM tests - load content scripts in jsdom and exercise form detection, reading,
 * filling, navigation, and validation against the local test HTML forms.
 *
 * Requires: jsdom (npm install)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let jsdom;
try { jsdom = require('jsdom'); }
catch (e) {
  console.error('jsdom not installed. Run: npm install');
  process.exit(2);
}
const { JSDOM } = jsdom;

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
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/form' });
  const w = dom.window;
  // Polyfills jsdom may be missing
  w.CSS = w.CSS || {};
  w.CSS.escape = w.CSS.escape || ((s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c));
  w.scrollTo = () => {};
  // Stub chrome APIs (content scripts use chrome.runtime)
  w.chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {} } };
  // Load core modules first, then content scripts
  const files = [
    'core/storage.js',
    'core/survey-parser.js',
    'core/respondent-generator.js',
    'core/answer-generator.js',
    'core/statistics.js',
    'core/export.js',
    'content/form-detector.js',
    'content/form-reader.js',
    'content/form-filler.js',
    'content/form-navigation.js',
    'content/validation.js'
  ];
  const wVm = w;
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    w.eval(code);
  }
  return w;
}

async function main() {
  console.log('Running DOM (content script) tests...');

  // -------- Multi-section form --------
  const multiPath = path.join(ROOT, 'tests', 'test-form-multi-section.html');
  const w = loadContentScriptsIntoDom(multiPath);
  const SP = w.SurveyPilot;

  // ---- Form detection ----
  console.log('  Form detection:');
  const det = SP.FormDetector.detect();
  ok('multi-section form detected', det.ok);
  ok('formType html_form', det.formType === 'html_form', 'got ' + det.formType);

  // ---- Form reading ----
  console.log('  Form reading:');
  const read = SP.FormReader.read();
  ok('read ok', read.ok);
  ok('read has sections', read.sections && read.sections.length > 0);
  const firstSection = read.sections[0];
  ok('first section has questions', firstSection.questions.length >= 3, 'got ' + firstSection.questions.length);
  // Required detection: name is required, age range is required
  const nameQ = firstSection.questions.find((q) => /name/i.test(q.text));
  ok('name question found', !!nameQ);
  ok('name question required', nameQ && nameQ.required, 'required=' + (nameQ && nameQ.required));
  ok('name question type short_answer', nameQ && nameQ.type === 'short_answer', 'got ' + (nameQ && nameQ.type));
  const ageQ = firstSection.questions.find((q) => /age range/i.test(q.text));
  ok('age question found', !!ageQ);
  ok('age question required', ageQ && ageQ.required);
  ok('age question type multiple_choice', ageQ && ageQ.type === 'multiple_choice', 'got ' + (ageQ && ageQ.type));
  ok('age question has 5 options', ageQ && ageQ.options.length === 5, 'got ' + (ageQ && ageQ.options.length));
  eq('age options', ageQ && ageQ.options, ['18-24', '25-34', '35-44', '45-54', '55+']);

  // Section 2 questions: bus (multiple choice), modes (checkbox), last_trip (date), commute_time (time)
  // Since fieldsets use display:none, only the active section should be visible at first
  // (the multi-section form shows only section 1 by default)
  const vis = SP.FormReader.readVisibleSection();
  ok('visible section read ok', vis.ok);
  ok('only active section visible', vis.sections.length === 1, 'got ' + vis.sections.length);

  // Activate section 2 by toggling CSS class via the form's own script... we'll just simulate
  // by removing the active class from section 1 and adding it to section 2
  const fieldsets = w.document.querySelectorAll('fieldset');
  fieldsets[0].classList.remove('active');
  fieldsets[1].classList.add('active');
  const vis2 = SP.FormReader.readVisibleSection();
  ok('section 2 now visible', vis2.ok && vis2.sections.length === 1 && /travel/i.test(vis2.sections[0].title || vis2.sections[0].questions[0].text || ''));
  const busQ = vis2.sections[0].questions.find((q) => /transit/i.test(q.text));
  ok('bus question found', !!busQ);
  ok('bus question type multiple_choice', busQ && busQ.type === 'multiple_choice');
  const modesQ = vis2.sections[0].questions.find((q) => /modes/i.test(q.text) || /transport modes/i.test(q.text));
  ok('modes question found', !!modesQ);
  ok('modes question type checkbox', modesQ && modesQ.type === 'checkbox');
  const dateQ = vis2.sections[0].questions.find((q) => q.type === 'date');
  ok('date question detected', !!dateQ);
  const timeQ = vis2.sections[0].questions.find((q) => q.type === 'time');
  ok('time question detected', !!timeQ);

  // Section 3: rating (linear scale), dropdown, paragraph
  fieldsets[1].classList.remove('active');
  fieldsets[2].classList.add('active');
  const vis3 = SP.FormReader.readVisibleSection();
  ok('section 3 visible', vis3.ok && vis3.sections.length === 1);
  const ratingQ = vis3.sections[0].questions.find((q) => q.type === 'linear_scale' || /rating/i.test(q.text));
  ok('rating question detected', !!ratingQ, 'questions: ' + vis3.sections[0].questions.map((q) => q.type).join(','));
  const dropQ = vis3.sections[0].questions.find((q) => q.type === 'dropdown');
  ok('dropdown question detected', !!dropQ);
  const paraQ = vis3.sections[0].questions.find((q) => q.type === 'paragraph');
  ok('paragraph question detected', !!paraQ);

  // ---- Form filling ----
  console.log('  Form filling:');
  // Switch back to section 1 and fill name + age
  fieldsets[0].classList.add('active');
  fieldsets[1].classList.remove('active');
  fieldsets[2].classList.remove('active');
  const vis1 = SP.FormReader.readVisibleSection();
  const nameQ2 = vis1.sections[0].questions.find((q) => /name/i.test(q.text));
  const ageQ2 = vis1.sections[0].questions.find((q) => /age range/i.test(q.text));

  // Fill text input
  const fillText = await SP.FormFiller.fillQuestion(nameQ2, { value: 'Jane Doe', text: 'Jane Doe' });
  ok('text fill ok', fillText.ok);
  ok('text fill verified', fillText.verified);
  const nameEl = w.document.getElementById('q_name');
  eq('text fill DOM state', nameEl.value, 'Jane Doe');

  // Fill radio
  const fillRadio = await SP.FormFiller.fillQuestion(ageQ2, { value: '25-34', text: '25-34' });
  ok('radio fill ok', fillRadio.ok);
  const checkedAge = w.document.querySelector('input[name="age"]:checked');
  ok('radio fill DOM state', !!checkedAge && checkedAge.value === '25-34');

  // Fill checkbox (section 2)
  fieldsets[0].classList.remove('active');
  fieldsets[1].classList.add('active');
  const vis2b = SP.FormReader.readVisibleSection();
  const modesQ2 = vis2b.sections[0].questions.find((q) => q.type === 'checkbox');
  const fillCheckbox = await SP.FormFiller.fillQuestion(modesQ2, { value: ['Walking', 'Bus'], text: 'Walking, Bus' });
  ok('checkbox fill ok', fillCheckbox.ok);
  const checkedModes = Array.from(w.document.querySelectorAll('input[name="modes"]:checked')).map((c) => c.value);
  eq('checkbox fill DOM state', checkedModes.sort(), ['Bus', 'Walking']);

  // Fill date
  const dateQ2 = vis2b.sections[0].questions.find((q) => q.type === 'date');
  const fillDate = await SP.FormFiller.fillQuestion(dateQ2, { value: '2024-08-15', text: '2024-08-15' });
  ok('date fill ok', fillDate.ok);
  const dateEl = w.document.getElementById('q_when');
  eq('date fill DOM state', dateEl.value, '2024-08-15');

  // Fill time
  const timeQ2 = vis2b.sections[0].questions.find((q) => q.type === 'time');
  const fillTime = await SP.FormFiller.fillQuestion(timeQ2, { value: '08:30', text: '08:30' });
  ok('time fill ok', fillTime.ok);
  const timeEl = w.document.getElementById('q_time');
  eq('time fill DOM state', timeEl.value, '08:30');

  // Fill dropdown (section 3)
  fieldsets[1].classList.remove('active');
  fieldsets[2].classList.add('active');
  const vis3b = SP.FormReader.readVisibleSection();
  const dropQ2 = vis3b.sections[0].questions.find((q) => q.type === 'dropdown');
  const fillDrop = await SP.FormFiller.fillQuestion(dropQ2, { value: 'Email', text: 'Email' });
  ok('dropdown fill ok', fillDrop.ok);
  const dropEl = w.document.getElementById('q_dropdown');
  eq('dropdown fill DOM state', dropEl.value, 'Email');

  // Fill paragraph
  const paraQ2 = vis3b.sections[0].questions.find((q) => q.type === 'paragraph');
  const fillPara = await SP.FormFiller.fillQuestion(paraQ2, { value: 'Great experience overall.', text: 'Great experience overall.' });
  ok('paragraph fill ok', fillPara.ok);
  const paraEl = w.document.getElementById('q_para');
  ok('paragraph fill DOM state', paraEl.value.indexOf('Great experience') === 0);

  // ---- Validation ----
  console.log('  Validation:');
  // Validate section 1 with all required filled
  fieldsets[2].classList.remove('active');
  fieldsets[0].classList.add('active');
  const vis1c = SP.FormReader.readVisibleSection();
  const answers1 = {
    [nameQ2.id]: { value: 'Jane Doe' },
    [ageQ2.id]: { value: '25-34' }
  };
  const v1 = SP.Validation.validateSection(vis1c.sections[0], answers1);
  ok('section 1 valid when all required filled', v1.ok, JSON.stringify(v1.missing));
  // Now missing the required age question
  const answers1b = { [nameQ2.id]: { value: 'Jane' } };
  const v1b = SP.Validation.validateSection(vis1c.sections[0], answers1b);
  ok('section 1 invalid when required missing', !v1b.ok);
  ok('missing list includes age question', v1b.missing.some((m) => /age/i.test(m.questionText)));

  // verifyQuestion on a filled question
  const verifyName = SP.Validation.verifyQuestion(nameQ2, { value: 'Jane Doe' });
  ok('verifyQuestion name ok', verifyName.ok);

  // ---- Navigation ----
  console.log('  Navigation:');
  // Signature should change when sections change
  const sig1 = SP.FormNavigation.sectionSignature();
  fieldsets[0].classList.remove('active');
  fieldsets[1].classList.add('active');
  const sig2 = SP.FormNavigation.sectionSignature();
  ok('section signature changes', sig1.hash !== sig2.hash, sig1.hash + ' vs ' + sig2.hash);

  // Button detection
  const btns = SP.FormNavigation.findButtons();
  ok('next button found', btns.next.length > 0, 'found ' + btns.next.length);
  // On the last section, submit should be available
  fieldsets[1].classList.remove('active');
  fieldsets[2].classList.add('active');
  const btns3 = SP.FormNavigation.findButtons();
  ok('submit button found on last section', btns3.submit.length > 0);

  // ---- Error recovery: retry on missing element ----
  console.log('  Error recovery:');
  const badQ = { id: 'nope', text: 'Nope', type: 'short_answer', required: false, elementRefs: [] };
  const fillBad = await SP.FormFiller.fillQuestion(badQ, { value: 'x' });
  ok('missing element returns not ok', !fillBad.ok);

  // ---- Diagnostic mode ----
  console.log('  Diagnostic mode:');
  const diag = SP.FormReader.diagnostic();
  ok('diagnostic ok', diag.ok);
  ok('diagnostic has sections', diag.sections && diag.sections.length > 0);
  ok('diagnostic includes elementRefs', diag.sections[0].questions[0].elementRefs != null);

  // -------- Single-section form --------
  console.log('  Single-section form:');
  const singlePath = path.join(ROOT, 'tests', 'test-form-single-section.html');
  const w2 = loadContentScriptsIntoDom(singlePath);
  const SP2 = w2.SurveyPilot;
  const det2 = SP2.FormDetector.detect();
  ok('single form detected', det2.ok);
  const read2 = SP2.FormReader.read();
  ok('single form read ok', read2.ok);
  ok('single form has questions', read2.sections[0].questions.length >= 3);

  // -------- Summary --------
  console.log('\nDOM tests: ' + pass + ' passed, ' + fail + ' failed.');
  if (fail > 0) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  return fail === 0;
}

module.exports = { main };
