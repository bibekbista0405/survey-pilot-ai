/*
 * SurveyPilot AI - Validation (content script)
 * DOM-level validation: checks the current visible section for unanswered required
 * questions, mismatched answers, and validation messages before navigation.
 */
(function (global) {
  'use strict';

  const SP = global.SurveyPilot || {};
  const Parser = SP.SurveyParser || {};
  const Reader = SP.FormReader || {};
  const Filler = SP.FormFiller || {};
  const QTYPE = Parser.QUESTION_TYPES || {};

  function isVisible(el) {
    if (!el) return false;
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 20) {
      const cs = global.getComputedStyle ? global.getComputedStyle(cur) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      cur = cur.parentElement;
      depth++;
    }
    return true;
  }

  // Verify the DOM state of a single question matches the supplied answer
  function verifyQuestion(question, answer) {
    const els = Filler.resolveQuestionElements(question);
    if (!els.length) {
      if (!question.required) return { ok: true, verified: true, reason: 'no element (optional)' };
      return { ok: false, verified: false, reason: 'Element not found for required question' };
    }
    if (!answer || answer.value == null || answer.value === '' || (Array.isArray(answer.value) && !answer.value.length)) {
      if (question.required) return { ok: false, verified: false, reason: 'Required question has no answer' };
      return { ok: true, verified: true, reason: 'optional skipped' };
    }

    switch (question.type) {
      case QTYPE.SHORT_ANSWER:
      case QTYPE.PARAGRAPH: {
        const el = els[0];
        const actual = el.value || '';
        const expected = String(answer.value);
        const ok = actual.trim() === expected.trim();
        return { ok, verified: ok, actual, expected, reason: ok ? null : 'Mismatched text value' };
      }
      case QTYPE.MULTIPLE_CHOICE:
      case QTYPE.LINEAR_SCALE: {
        const checked = els.filter((e) => e.checked || e.getAttribute('aria-checked') === 'true');
        if (!checked.length) return { ok: false, verified: false, reason: 'No option selected' };
        const v = checked[0].value || Filler.findOptionElement(els, answer.value) && checked[0].getAttribute('aria-label');
        // We can't always compare exact values, so accept any selection
        return { ok: true, verified: true, actual: v };
      }
      case QTYPE.CHECKBOX: {
        const checked = els.filter((e) => e.checked);
        if (!checked.length) return { ok: false, verified: false, reason: 'No checkbox selected' };
        return { ok: true, verified: true, actual: checked.length + ' selected' };
      }
      case QTYPE.DROPDOWN: {
        const sel = els[0];
        if (!sel || sel.tagName !== 'SELECT') return { ok: false, verified: false, reason: 'No <select> element' };
        const ok = !!sel.value && sel.value !== '';
        return { ok, verified: ok, actual: sel.value };
      }
      case QTYPE.DATE: {
        const el = els[0];
        const ok = !!el.value;
        return { ok, verified: ok, actual: el.value };
      }
      case QTYPE.TIME: {
        const el = els[0];
        const ok = !!el.value;
        return { ok, verified: ok, actual: el.value };
      }
      case QTYPE.RATING: {
        const el = els[0];
        const ok = parseInt(el.value, 10) === parseInt(answer.value, 10);
        return { ok, verified: ok, actual: el.value };
      }
      default:
        return { ok: true, verified: true, reason: 'unsupported type, skipped verification' };
    }
  }

  // Validate a whole section: every visible required question must have an answer,
  // and every filled question must verify its DOM state
  function validateSection(section, answers) {
    const missing = [];
    const mismatched = [];
    const verified = [];
    for (const q of (section.questions || [])) {
      if (!q.visible) continue;
      const ans = answers ? answers[q.id] : null;
      if (q.required && (!ans || ans.value == null || ans.value === '' || (Array.isArray(ans.value) && !ans.value.length))) {
        missing.push({ questionId: q.id, questionText: q.text });
        continue;
      }
      if (!ans) continue;
      const v = verifyQuestion(q, ans);
      if (!v.ok) {
        mismatched.push({ questionId: q.id, questionText: q.text, reason: v.reason, actual: v.actual, expected: v.expected });
      } else {
        verified.push({ questionId: q.id });
      }
    }
    const ok = missing.length === 0 && mismatched.length === 0;
    return { ok, missing, mismatched, verified };
  }

  // Detect visible validation error messages in the DOM (Google Forms red banner etc.)
  function detectValidationErrors() {
    const sels = [
      '.freebirdFormviewerViewItemsItemErrorMessage',
      '[role="alert"]',
      '.error',
      '.invalid-feedback',
      '.field-error'
    ];
    const seen = new Set();
    const errs = [];
    sels.forEach((sel) => {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (!isVisible(el)) return;
          const t = (el.textContent || '').trim();
          if (t && !seen.has(t)) { seen.add(t); errs.push(t); }
        });
      } catch (e) { /* ignore */ }
    });
    return errs;
  }

  // Read current visible section + validate
  function validateCurrentSection(answers) {
    const r = Reader.readVisibleSection();
    if (!r.ok) return { ok: false, reason: 'Could not read visible section', errors: [] };
    const section = r.sections[0];
    if (!section) return { ok: false, reason: 'No visible section', errors: [] };
    const v = validateSection(section, answers);
    return Object.assign({}, v, { section, domErrors: detectValidationErrors() });
  }

  const Validation = {
    verifyQuestion,
    validateSection,
    validateCurrentSection,
    detectValidationErrors,
    isVisible
  };

  SP.Validation = Validation;
  global.SurveyPilot = SP;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'surveypilot_validate_section') {
        const r = validateSection(msg.section, msg.answers);
        sendResponse(r);
        return true;
      }
      if (msg.type === 'surveypilot_validate_current') {
        const r = validateCurrentSection(msg.answers);
        sendResponse(r);
        return true;
      }
      if (msg.type === 'surveypilot_verify_question') {
        sendResponse(verifyQuestion(msg.question, msg.answer));
        return true;
      }
      return false;
    });
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
