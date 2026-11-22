/*
 * SurveyPilot AI - Form Filler (content script)
 * Fills form elements with the supplied answer values. Verifies the final DOM
 * state before reporting success. Retries failed interactions safely.
 */
(function (global) {
  'use strict';

  const SP = global.SurveyPilot || {};
  const Parser = SP.SurveyParser || {};
  const QTYPE = Parser.QUESTION_TYPES || {};
  const Reader = SP.FormReader || {};

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

  function resolveQuestionElements(question) {
    const refs = question.elementRefs || [];
    const els = [];
    for (const ref of refs) {
      if (!ref) continue;
      let el = null;
      if (ref.id) el = document.getElementById(ref.id);
      if (!el && ref.name) {
        const list = document.getElementsByName(ref.name);
        if (list && list.length === 1) el = list[0];
        else if (list && list.length > 1) {
          els.push.apply(els, Array.from(list));
          continue;
        }
      }
      if (!el && ref.locator) el = Reader.resolveLocator ? Reader.resolveLocator(ref.locator) : document.querySelector(ref.locator);
      if (el) els.push(el);
    }
    let result = els.filter(Boolean);
    // FALLBACK: if stored refs didn't resolve (common after section navigation),
    // re-query the DOM fresh by finding the question container and its inputs.
    if (!result.length || result.length === 0) {
      result = findElementsForQuestionInDOM(question);
    }
    return result;
  }

  // Re-query the live DOM to find the input elements for a question.
  // This is the robust fallback when stored elementRefs are stale.
  function findElementsForQuestionInDOM(question) {
    // Find the question container by matching its text
    const qText = (question.text || '').trim();
    if (!qText) return [];
    // Try to find the container that holds this question's text
    const containers = document.querySelectorAll('[role="listitem"][data-params], [role="listitem"], .freebirdFormviewerViewItemsItemItem, [data-params]');
    let bestContainer = null;
    for (const c of containers) {
      if (!isVisible(c)) continue;
      const cText = (c.textContent || '').trim();
      // Match if the container's text starts with the question text (allowing for extra option text)
      if (cText.indexOf(qText) !== -1 || qText.indexOf(cText.slice(0, Math.min(60, qText.length))) !== -1) {
        bestContainer = c;
        break;
      }
    }
    const searchRoot = bestContainer || document;
    // Find input elements based on question type
    if (question.type === 'multiple_choice' || question.type === 'linear_scale' || question.type === 'rating') {
      return Array.from(searchRoot.querySelectorAll('[role="radio"], input[type="radio"]')).filter(isVisible);
    }
    if (question.type === 'checkbox') {
      return Array.from(searchRoot.querySelectorAll('[role="checkbox"], input[type="checkbox"]')).filter(isVisible);
    }
    if (question.type === 'dropdown') {
      return Array.from(searchRoot.querySelectorAll('[role="listbox"], select')).filter(isVisible);
    }
    if (question.type === 'paragraph') {
      return Array.from(searchRoot.querySelectorAll('textarea')).filter(isVisible);
    }
    if (question.type === 'short_answer') {
      return Array.from(searchRoot.querySelectorAll('input[type="text"], input:not([type]), input[type="email"], input[type="url"], input[type="tel"], input[type="number"]')).filter(isVisible);
    }
    if (question.type === 'date') return Array.from(searchRoot.querySelectorAll('input[type="date"]')).filter(isVisible);
    if (question.type === 'time') return Array.from(searchRoot.querySelectorAll('input[type="time"]')).filter(isVisible);
    return [];
  }

  function findOptionElement(elements, targetValue) {
    if (targetValue == null) return null;
    const target = String(targetValue).toLowerCase();
    // 1. Match by value attribute
    let match = elements.find((el) => el.value && String(el.value) === String(targetValue));
    if (match) return match;
    // 2. Match by aria-label
    match = elements.find((el) => {
      const lbl = el.getAttribute('aria-label') || radioLabel(el) || checkboxLabel(el);
      return lbl && String(lbl).toLowerCase() === target;
    });
    if (match) return match;
    // 3. Match by associated label text
    match = elements.find((el) => {
      const lbl = (el.labels && el.labels.length) ? (el.labels[0].textContent || '').trim() : '';
      return lbl && String(lbl).toLowerCase() === target;
    });
    if (match) return match;
    // 4. Partial match
    match = elements.find((el) => {
      const lbl = el.getAttribute('aria-label') || radioLabel(el) || checkboxLabel(el) || (el.labels && el.labels[0] && el.labels[0].textContent || '');
      return lbl && String(lbl).toLowerCase().indexOf(target) !== -1;
    });
    return match || null;
  }

  function radioLabel(radio) {
    if (radio.getAttribute('aria-label')) return radio.getAttribute('aria-label');
    const parent = radio.closest('[role="radio"], [data-value], label, .docssharedWizToggleLabeledContainer');
    if (parent) return parent.getAttribute('aria-label') || (parent.textContent || '').trim();
    if (radio.labels && radio.labels.length) return (radio.labels[0].textContent || '').trim();
    return radio.value;
  }
  function checkboxLabel(cb) {
    if (cb.getAttribute('aria-label')) return cb.getAttribute('aria-label');
    const parent = cb.closest('[role="checkbox"], [data-value], label, .docssharedWizToggleLabeledContainer');
    if (parent) return parent.getAttribute('aria-label') || (parent.textContent || '').trim();
    if (cb.labels && cb.labels.length) return (cb.labels[0].textContent || '').trim();
    return cb.value;
  }

  function triggerEvents(el) {
    // Replicate a real user interaction sequence
    try { el.dispatchEvent(new Event('focus', { bubbles: false })); } catch (e) {}
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new Event('blur', { bubbles: false })); } catch (e) {}
  }

  function triggerClick(el) {
    if (!el) return;
    // Hover (some frameworks require hover before click)
    try { el.dispatchEvent(new global.MouseEvent('mouseover', { bubbles: true, cancelable: true })); } catch (e) {}
    // Focus
    try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
    // Native click ONLY — do NOT also dispatch a synthetic click event.
    // Calling both el.click() and dispatchEvent(click) causes a DOUBLE toggle
    // on checkboxes (toggle on → toggle off = unchanged), which is why they weren't checking.
    try { if (typeof el.click === 'function') el.click(); } catch (e) {}
  }

  function scrollIntoView(el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {
      try { el.scrollIntoView(); } catch (e2) {}
    }
  }

  function setTextValue(el, value) {
    if (!el) return false;
    // Use native setter so React/framework listeners pick up the change
    const proto = (el.tagName === 'TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) {
      setter.call(el, String(value));
    } else {
      el.value = String(value);
    }
    triggerEvents(el);
    return el.value === String(value);
  }

  function fillText(question, answer) {
    const els = resolveQuestionElements(question);
    const el = els[0];
    if (!el) return { ok: false, reason: 'Element not found for text question' };
    const value = (answer && answer.value != null) ? answer.value : '';
    const ok = setTextValue(el, value);
    if (!ok) {
      // Retry: focus then type
      try { el.focus(); } catch (e) {}
      ok && (ok = setTextValue(el, value));
    }
    return { ok, verified: ok, finalValue: el.value };
  }

  async function fillRadio(question, answer) {
    const els = resolveQuestionElements(question);
    if (!els.length) return { ok: false, reason: 'No radio elements found' };
    const target = (answer && answer.value != null) ? answer.value : null;
    if (target == null) return { ok: false, reason: 'No answer value provided' };

    // 1. Try exact match by value, aria-label, or label text
    const match = findOptionElement(els, target);
    if (match) return await clickAndVerify(match);

    // 2. Try numeric value match (for linear scales: answer=2 → radio with value/aria-label "2")
    const num = parseInt(target, 10);
    if (!isNaN(num)) {
      const m2 = els.find((el) => {
        const v = el.value || el.getAttribute('data-value') || el.getAttribute('aria-label') || '';
        return parseInt(v, 10) === num;
      });
      if (m2) return await clickAndVerify(m2);
      // 3. Position-based match: answer is a 1-indexed position
      if (num >= 1 && num <= els.length) {
        return await clickAndVerify(els[num - 1]);
      }
    }

    // 4. Text-to-position mapping for Likert scales
    const targetLower = String(target).toLowerCase();
    const labelMap = ['strongly disagree', 'disagree', 'neutral', 'agree', 'strongly agree',
                      'very dissatisfied', 'dissatisfied', 'satisfied', 'very satisfied',
                      'never', 'rarely', 'sometimes', 'often', 'always',
                      'poor', 'fair', 'good', 'very good', 'excellent'];
    const targetIdx = labelMap.findIndex((l) => targetLower.indexOf(l) !== -1 || l.indexOf(targetLower) !== -1);
    if (targetIdx >= 0 && targetIdx < els.length) {
      return await clickAndVerify(els[targetIdx]);
    }

    // 5. Last resort: if there are options stored on the question, try matching those to element labels
    if (question.options && question.options.length) {
      const targetOpt = question.options.find((o) => String(o).toLowerCase() === targetLower);
      if (targetOpt) {
        const m3 = findOptionElement(els, targetOpt);
        if (m3) return await clickAndVerify(m3);
      }
    }

    return { ok: false, reason: 'No matching radio option for value: ' + target };
  }

  async function clickAndVerify(el) {
    if (!el) return { ok: false, reason: 'No element' };

    // Scroll into view so the element is clickable
    scrollIntoView(el);
    await new Promise((r) => setTimeout(r, 50));

    const isRoleWidget = el.getAttribute && (el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox');

    if (isRoleWidget) {
      // Strategy 1: focus + native click on the widget itself
      try { el.focus(); } catch (e) {}
      await new Promise((r) => setTimeout(r, 50));
      triggerClick(el);
      await new Promise((r) => setTimeout(r, 150));
      if (el.getAttribute('aria-checked') === 'true') {
        return { ok: true, verified: true, finalValue: el.getAttribute('data-value') || el.getAttribute('aria-label') || '' };
      }

      // Strategy 2: click child elements (the inner content that Google Forms might be listening on)
      const children = el.querySelectorAll('div, span, label, [jsname]');
      for (const child of children) {
        scrollIntoView(child);
        try { child.focus(); } catch (e) {}
        triggerClick(child);
        await new Promise((r) => setTimeout(r, 100));
        if (el.getAttribute('aria-checked') === 'true') break;
      }
      if (el.getAttribute('aria-checked') === 'true') {
        return { ok: true, verified: true, finalValue: el.getAttribute('data-value') || el.getAttribute('aria-label') || '' };
      }

      // Strategy 3: click the parent container
      const parent = el.parentElement;
      if (parent) {
        scrollIntoView(parent);
        triggerClick(parent);
        await new Promise((r) => setTimeout(r, 150));
      }

      const ok = el.getAttribute('aria-checked') === 'true';
      return { ok, verified: ok, finalValue: el.getAttribute('data-value') || el.getAttribute('aria-label') || '' };
    }

    // Native input element
    try { el.focus(); } catch (e) {}
    triggerClick(el);
    await new Promise((r) => setTimeout(r, 100));
    if (!el.checked) {
      // Try clicking the parent label container
      const parent = el.closest('label, [role="radio"], [role="checkbox"], .docssharedWizToggleLabeledContainer, .nWQGrd');
      if (parent && parent !== el) {
        scrollIntoView(parent);
        triggerClick(parent);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return { ok: !!el.checked || el.getAttribute('aria-checked') === 'true', verified: !!el.checked, finalValue: el.value };
  }

  async function fillCheckbox(question, answer) {
    const els = resolveQuestionElements(question);
    if (!els.length) return { ok: false, reason: 'No checkbox elements found' };
    const targets = Array.isArray(answer.value) ? answer.value : (answer.value != null ? [answer.value] : []);
    if (!targets.length) return { ok: false, reason: 'No selections provided' };
    const results = [];
    // Uncheck all first — just click once to toggle off, DON'T use clickAndVerify
    // (clickAndVerify would try children and might re-check the box)
    for (const el of els) {
      if (el.checked) { el.checked = false; triggerEvents(el); }
      if (el.getAttribute && el.getAttribute('aria-checked') === 'true') {
        scrollIntoView(el);
        try { if (typeof el.click === 'function') el.click(); } catch (e) {}
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    for (const t of targets) {
      const m = findOptionElement(els, t);
      if (!m) {
        // Try position-based match
        const num = parseInt(t, 10);
        if (!isNaN(num) && num >= 1 && num <= els.length) {
          const r = await clickAndVerify(els[num - 1]);
          results.push({ ok: r.ok, value: t });
          continue;
        }
        results.push({ ok: false, value: t, reason: 'No matching checkbox for value: ' + t });
        continue;
      }
      const r = await clickAndVerify(m);
      results.push({ ok: r.ok, value: t });
    }
    const ok = results.every((r) => r.ok);
    const checkedValues = els.filter((e) => e.checked || (e.getAttribute && e.getAttribute('aria-checked') === 'true')).map((e) => e.value || e.getAttribute('data-value') || e.getAttribute('aria-label') || '');
    return { ok, verified: ok, finalValue: checkedValues, details: results };
  }

  function fillDropdown(question, answer) {
    const els = resolveQuestionElements(question);
    const el = els[0];
    if (!el) return { ok: false, reason: 'No dropdown element found' };
    const target = String(answer && answer.value != null ? answer.value : '');

    // Native <select> element
    if (el.tagName === 'SELECT') {
      let opt = Array.from(el.options).find((o) => o.value === target || o.textContent.trim() === target);
      if (!opt) {
        opt = Array.from(el.options).find((o) => o.textContent.trim().toLowerCase().indexOf(target.toLowerCase()) !== -1);
      }
      if (!opt) return { ok: false, reason: 'No matching dropdown option for: ' + target };
      el.value = opt.value;
      triggerEvents(el);
      if (el.value !== opt.value) {
        el.selectedIndex = opt.index;
        triggerEvents(el);
      }
      const verified = el.value === opt.value || el.selectedIndex === opt.index;
      return { ok: verified, verified, finalValue: opt.textContent.trim() };
    }

    // Modern Google Forms: custom [role="listbox"] widget.
    // Need to: 1) click the dropdown to open it, 2) find the matching [role="option"], 3) click it.
    if (el.getAttribute && el.getAttribute('role') === 'listbox') {
      // Click to open the dropdown
      triggerClick(el);
      if (!el.getAttribute('aria-expanded')) {
        try { el.click(); } catch (e) {}
      }
      // Wait briefly for the options to render, then find and click the target
      return new Promise((resolve) => {
        setTimeout(() => {
          // Options may be in a popup outside the listbox, so search the whole document
          const options = Array.from(document.querySelectorAll('[role="option"]')).filter((o) => isVisible(o));
          const targetLower = target.toLowerCase();
          let opt = options.find((o) => (o.getAttribute('aria-label') || textOf(o) || '').toLowerCase() === targetLower);
          if (!opt) {
            opt = options.find((o) => (o.getAttribute('aria-label') || textOf(o) || '').toLowerCase().indexOf(targetLower) !== -1);
          }
          if (!opt) {
            resolve({ ok: false, reason: 'No matching dropdown option for: ' + target });
            return;
          }
          triggerClick(opt);
          if (opt.getAttribute('aria-selected') !== 'true') {
            try { opt.click(); } catch (e) {}
          }
          const ok = opt.getAttribute('aria-selected') === 'true';
          resolve({ ok, verified: ok, finalValue: opt.getAttribute('aria-label') || textOf(opt) });
        }, 300);
      });
    }

    return { ok: false, reason: 'Unrecognized dropdown element' };
  }

  function fillDate(question, answer) {
    const els = resolveQuestionElements(question);
    const el = els[0];
    if (!el) return { ok: false, reason: 'No date element found' };
    const value = String(answer && answer.value != null ? answer.value : '');
    const ok = setTextValue(el, value);
    return { ok, verified: ok, finalValue: el.value };
  }

  function fillTime(question, answer) {
    const els = resolveQuestionElements(question);
    const el = els[0];
    if (!el) return { ok: false, reason: 'No time element found' };
    const value = String(answer && answer.value != null ? answer.value : '');
    const ok = setTextValue(el, value);
    return { ok, verified: ok, finalValue: el.value };
  }

  function fillRating(question, answer) {
    // Rating implemented via <input type=range>; set value then trigger
    const els = resolveQuestionElements(question);
    const el = els[0];
    if (!el) return { ok: false, reason: 'No rating element found' };
    const value = parseInt(answer && answer.value, 10);
    if (isNaN(value)) return { ok: false, reason: 'Invalid rating value' };
    el.value = String(value);
    triggerEvents(el);
    const verified = parseInt(el.value, 10) === value;
    return { ok: verified, verified, finalValue: el.value };
  }

  // Fill a single question, retrying once on failure
  async function fillQuestion(question, answer) {
    const t0 = Date.now();
    let result;
    switch (question.type) {
      case QTYPE.SHORT_ANSWER:
      case QTYPE.PARAGRAPH: result = fillText(question, answer); break;
      case QTYPE.MULTIPLE_CHOICE:
      case QTYPE.LINEAR_SCALE: result = await fillRadio(question, answer); break;
      case QTYPE.CHECKBOX: result = await fillCheckbox(question, answer); break;
      case QTYPE.DROPDOWN: result = await fillDropdown(question, answer); break;
      case QTYPE.DATE: result = fillDate(question, answer); break;
      case QTYPE.TIME: result = fillTime(question, answer); break;
      case QTYPE.RATING: result = await fillRadio(question, answer); break;
      default: result = { ok: false, reason: 'Unsupported question type: ' + question.type };
    }
    if (!result.ok) {
      // Retry once after a short delay
      await new Promise((r) => setTimeout(r, 300));
      switch (question.type) {
        case QTYPE.SHORT_ANSWER:
        case QTYPE.PARAGRAPH: result = fillText(question, answer); break;
        case QTYPE.MULTIPLE_CHOICE:
        case QTYPE.LINEAR_SCALE: result = await fillRadio(question, answer); break;
        case QTYPE.CHECKBOX: result = await fillCheckbox(question, answer); break;
        case QTYPE.DROPDOWN: result = await fillDropdown(question, answer); break;
        case QTYPE.DATE: result = fillDate(question, answer); break;
        case QTYPE.TIME: result = fillTime(question, answer); break;
        case QTYPE.RATING: result = await fillRadio(question, answer); break;
      }
      result.retried = true;
    }
    result.durationMs = Date.now() - t0;
    result.questionId = question.id;
    result.questionText = question.text;
    return result;
  }

  // Fill all visible questions in a section with the respondent's answers.
  // Does NOT skip any question silently — every question gets a result entry.
  async function fillSection(section, respondentAnswers) {
    const results = [];
    for (const q of section.questions) {
      if (!q.visible) continue;
      const ans = respondentAnswers[q.id];
      if (!ans || ans.value == null || ans.value === '' || (Array.isArray(ans.value) && !ans.value.length)) {
        // No answer for this question. If it's optional, generate a default answer.
        if (!q.required) {
          // For optional questions, try to generate a default answer rather than skipping
          const defaultValue = generateDefaultAnswer(q);
          if (defaultValue != null) {
            const r = await fillQuestion(q, { value: defaultValue, text: String(defaultValue) });
            results.push(r);
            continue;
          }
          // Truly can't answer — record it as skipped (optional)
          results.push({ questionId: q.id, questionText: q.text, ok: true, reason: 'optional_skipped', durationMs: 0 });
          continue;
        }
        // Required question with no answer — try to generate a default
        const defaultValue = generateDefaultAnswer(q);
        if (defaultValue != null) {
          const r = await fillQuestion(q, { value: defaultValue, text: String(defaultValue) });
          results.push(r);
          continue;
        }
        results.push({ questionId: q.id, questionText: q.text, ok: false, reason: 'Required question has no answer and no default could be generated', durationMs: 0 });
        continue;
      }
      const r = await fillQuestion(q, ans);
      results.push(r);
    }
    const ok = results.every((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    return { ok, sectionId: section.id, sectionTitle: section.title, results, failed };
  }

  // Generate a default answer for a question when no answer is available.
  // This prevents questions from being skipped.
  function generateDefaultAnswer(question) {
    if (!question) return null;
    switch (question.type) {
      case 'multiple_choice':
      case 'dropdown':
        // Pick the first option
        return (question.options && question.options.length) ? question.options[0] : null;
      case 'checkbox':
        // Pick the first option
        return (question.options && question.options.length) ? [question.options[0]] : null;
      case 'linear_scale':
      case 'rating':
        // Pick the middle value
        const min = question.minValue || 1;
        const max = question.maxValue || 5;
        return Math.round((min + max) / 2);
      case 'short_answer':
      case 'paragraph':
        // Generate a text answer based on the question
        return generateTextForQuestion(question);
      case 'date':
        return new Date().toISOString().slice(0, 10);
      case 'time':
        return '12:00';
      default:
        return null;
    }
  }

  function generateTextForQuestion(question) {
    const q = (question.text || '').toLowerCase();
    if (/name/.test(q)) return 'Respondent';
    if (/email/.test(q)) return 'respondent@example.com';
    if (/age/.test(q)) return '30';
    if (/phone/.test(q)) return '1234567890';
    if (/city|location|where/.test(q)) return 'N/A';
    if (/comment|feedback|opinion|suggest/.test(q)) return 'No additional comments.';
    return 'N/A';
  }

  const FormFiller = {
    fillQuestion,
    fillSection,
    fillText,
    fillRadio,
    fillCheckbox,
    fillDropdown,
    fillDate,
    fillTime,
    fillRating,
    setTextValue,
    triggerEvents,
    triggerClick,
    findOptionElement,
    resolveQuestionElements
  };

  SP.FormFiller = FormFiller;
  global.SurveyPilot = SP;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'surveypilot_fill_question') {
        fillQuestion(msg.question, msg.answer).then((r) => sendResponse(r));
        return true;
      }
      if (msg.type === 'surveypilot_fill_section') {
        fillSection(msg.section, msg.answers).then((r) => sendResponse(r));
        return true;
      }
      return false;
    });
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
