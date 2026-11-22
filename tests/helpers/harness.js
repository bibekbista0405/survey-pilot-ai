/* Test harness: loads a local fixture form into jsdom and injects the real content scripts into it. */
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONTENT_SCRIPTS = ['core/util.js', 'core/survey-parser.js', 'content/form-detector.js', 'content/form-reader.js',
  'content/validation.js', 'content/form-filler.js', 'content/form-navigation.js', 'content/content-main.js'];

function loadForm(file, url) {
  const html = fs.readFileSync(path.join(ROOT, 'tests', 'forms', file), 'utf8');
  const dom = new JSDOM(html, { url: url || 'http://localhost/survey.html', runScripts: 'dangerously', pretendToBeVisual: true });
  CONTENT_SCRIPTS.forEach((s) => dom.window.eval(fs.readFileSync(path.join(ROOT, s), 'utf8')));
  return dom.window;
}

/** Sends a message to the content script exactly as the service worker would. */
function send(win, type, extra) {
  // chrome.runtime messaging structured-clones responses; round-tripping JSON mirrors that (and avoids cross-realm prototypes).
  return win.SP.content.handle(JSON.parse(JSON.stringify(Object.assign({ target: 'sp-content', type }, extra || {}))))
    .then((res) => JSON.parse(JSON.stringify(res)));
}

module.exports = { loadForm, send, ROOT, CONTENT_SCRIPTS };
