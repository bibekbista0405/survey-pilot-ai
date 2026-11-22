/*
 * SurveyPilot AI - Survey Parser (data shape + helpers, no DOM)
 * Defines question types, normalizes parsed question data, computes compatibility,
 * and provides helpers used by content scripts and the UI.
 */
(function (global) {
  'use strict';

  const QUESTION_TYPES = {
    SHORT_ANSWER: 'short_answer',
    PARAGRAPH: 'paragraph',
    MULTIPLE_CHOICE: 'multiple_choice',
    CHECKBOX: 'checkbox',
    DROPDOWN: 'dropdown',
    LINEAR_SCALE: 'linear_scale',
    RATING: 'rating',
    DATE: 'date',
    TIME: 'time',
    UNKNOWN: 'unknown'
  };

  const FORM_TYPES = {
    GOOGLE_FORMS: 'google_forms',
    HTML_FORM: 'html_form',
    UNKNOWN: 'unknown'
  };

  const COMPATIBILITY = {
    SUPPORTED: 'supported',
    PARTIAL: 'partial',
    UNSUPPORTED: 'unsupported'
  };

  function makeId(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // Stable hash for a string (used to fingerprint forms)
  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(16);
  }

  // Build a Survey object from raw detection results
  function buildSurvey({ url, title, formType, sections, detectedAt }) {
    const allQuestions = sections.flatMap((s, i) => (s.questions || []).map((q) => ({ ...q, sectionIndex: i })));
    const required = allQuestions.filter((q) => q.required).length;
    const typeCounts = {};
    allQuestions.forEach((q) => { typeCounts[q.type] = (typeCounts[q.type] || 0) + 1; });
    const compatibility = computeCompatibility(formType, allQuestions);
    const fingerprint = hashString(url + '|' + title + '|' + allQuestions.map((q) => q.id).join(','));
    return {
      id: 'survey_' + fingerprint,
      url,
      title: title || '(untitled form)',
      formType,
      sections,
      questionCount: allQuestions.length,
      sectionCount: sections.length,
      requiredCount: required,
      typeCounts,
      compatibility,
      detectedAt: detectedAt || Date.now(),
      fingerprint
    };
  }

  function computeCompatibility(formType, questions) {
    if (!formType || formType === FORM_TYPES.UNKNOWN) return COMPATIBILITY.UNSUPPORTED;
    if (!questions || questions.length === 0) return COMPATIBILITY.UNSUPPORTED;
    const unknownRatio = questions.filter((q) => q.type === QUESTION_TYPES.UNKNOWN).length / questions.length;
    if (unknownRatio > 0.5) return COMPATIBILITY.PARTIAL;
    return COMPATIBILITY.SUPPORTED;
  }

  function describeQuestionType(type) {
    const map = {
      short_answer: 'Short answer',
      paragraph: 'Paragraph',
      multiple_choice: 'Multiple choice',
      checkbox: 'Checkbox',
      dropdown: 'Dropdown',
      linear_scale: 'Linear scale',
      rating: 'Rating',
      date: 'Date',
      time: 'Time',
      unknown: 'Unknown'
    };
    return map[type] || type;
  }

  // Validate that an answer matches a question's shape (not value correctness)
  function validateAnswerShape(question, answer) {
    if (!question) return { ok: false, reason: 'No question provided' };
    const value = answer && answer.value != null ? answer.value : answer;
    const isEmpty = value == null || value === '' || (Array.isArray(value) && value.length === 0);
    if (isEmpty) {
      if (question.required) return { ok: false, reason: 'Required question is unanswered' };
      return { ok: true };
    }
    switch (question.type) {
      case QUESTION_TYPES.MULTIPLE_CHOICE:
      case QUESTION_TYPES.LINEAR_SCALE:
      case QUESTION_TYPES.RATING: {
        if (Array.isArray(value)) return { ok: false, reason: 'Expected single value' };
        if (question.options && question.options.length && !question.options.includes(String(value))) {
          return { ok: false, reason: 'Value not among options' };
        }
        return { ok: true };
      }
      case QUESTION_TYPES.CHECKBOX: {
        const vals = Array.isArray(value) ? value : [value];
        if (question.options && question.options.length) {
          const invalid = vals.filter((v) => !question.options.includes(String(v)));
          if (invalid.length) return { ok: false, reason: 'Some selections not among options: ' + invalid.join(', ') };
        }
        if (question.minChoices && vals.length < question.minChoices) {
          return { ok: false, reason: 'Requires at least ' + question.minChoices + ' selections' };
        }
        if (question.maxChoices && vals.length > question.maxChoices) {
          return { ok: false, reason: 'Allows at most ' + question.maxChoices + ' selections' };
        }
        return { ok: true };
      }
      case QUESTION_TYPES.DROPDOWN: {
        if (question.options && question.options.length && !question.options.includes(String(value))) {
          return { ok: false, reason: 'Value not among dropdown options' };
        }
        return { ok: true };
      }
      case QUESTION_TYPES.SHORT_ANSWER:
      case QUESTION_TYPES.PARAGRAPH: {
        const text = String(value || '');
        if (question.maxLength && text.length > question.maxLength) {
          return { ok: false, reason: 'Exceeds max length ' + question.maxLength };
        }
        if (question.minLength && text.length < question.minLength) {
          return { ok: false, reason: 'Below min length ' + question.minLength };
        }
        if (question.pattern) {
          try {
            const re = new RegExp(question.pattern);
            if (!re.test(text)) return { ok: false, reason: 'Does not match pattern' };
          } catch (e) { /* ignore bad pattern */ }
        }
        return { ok: true };
      }
      case QUESTION_TYPES.DATE: {
        if (isNaN(Date.parse(String(value)))) return { ok: false, reason: 'Invalid date' };
        return { ok: true };
      }
      case QUESTION_TYPES.TIME: {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(value));
        if (!m) return { ok: false, reason: 'Invalid time (expected HH:MM)' };
        const h = parseInt(m[1], 10);
        if (h > 23) return { ok: false, reason: 'Hour out of range' };
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }

  const SurveyParser = {
    QUESTION_TYPES,
    FORM_TYPES,
    COMPATIBILITY,
    makeId,
    hashString,
    buildSurvey,
    computeCompatibility,
    describeQuestionType,
    validateAnswerShape
  };

  global.SurveyPilot = global.SurveyPilot || {};
  global.SurveyPilot.SurveyParser = SurveyParser;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
