/*
 * SurveyPilot AI - Form Reader (content script)
 * Reads questions from the detected form. Distinguishes visible (current section)
 * questions from hidden ones. Supports Google Forms and standard HTML forms.
 *
 * Robust detection: multiple selector strategies + fallback heuristics.
 */
(function (global) {
  'use strict';

  const SP = global.SurveyPilot || {};
  const Parser = SP.SurveyParser || {};
  const QTYPE = Parser.QUESTION_TYPES || {};
  const Detector = SP.FormDetector || {};

  function isVisible(el) {
    return Detector.isElementVisible ? Detector.isElementVisible(el) : (el && el.offsetParent !== null);
  }

  function textOf(el) {
    if (!el) return '';
    return (el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  // Try a list of selectors; return first matching element that is visible
  function firstVisible(selectors, root) {
    root = root || document;
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el && isVisible(el)) return el;
      } catch (e) { /* invalid selector */ }
    }
    return null;
  }

  function allVisible(selectors, root) {
    root = root || document;
    const out = [];
    const seen = new Set();
    for (const sel of selectors) {
      try {
        root.querySelectorAll(sel).forEach((el) => {
          if (el && isVisible(el) && !seen.has(el)) { seen.add(el); out.push(el); }
        });
      } catch (e) { /* ignore */ }
    }
    return out;
  }

  // ---------- Google Forms reader (modern + legacy selectors) ----------

  function readGoogleForms() {
    // Modern Google Forms (2024+) uses [role="listitem"] with [data-params] for each question.
    // Legacy Forms used .freebirdFormviewerViewItemsItemItem. We try both + several fallbacks.
    const containerSelectors = [
      '[role="listitem"][data-params]',
      '.freebirdFormviewerViewItemsItemItem',
      '[role="listitem"]',
      '[data-params]',
      '[jsname*="ItemContainer"]',
      '.geMS5',
      '.Qr7O4e',
      '.rPtrBb'
    ];
    let containers = allVisible(containerSelectors, document);
    if (!containers.length) return null;

    // CRITICAL: deduplicate containers — keep only the OUTERMOST (those not contained
    // by any other matched container). Without this, a question's outer [role="listitem"]
    // AND an inner .Qr7O4e div both match, producing duplicate questions with different IDs.
    containers = containers.filter((c) => {
      return !containers.some((other) => other !== c && other.contains(c));
    });

    const sections = [];
    let currentSection = { id: Parser.makeId('sec'), title: 'Section 1', questions: [] };
    sections.push(currentSection);
    let sectionIdx = 0;

    containers.forEach((container, idx) => {
      // Section break detection (Google Forms "Section after page")
      const isSectionHeader = container.querySelector(
        '.freebirdFormviewerViewSectionheaderHeader, ' +
        '[role="heading"][aria-level="2"], ' +
        '.Tnv2Ac, ' +
        '.r6Ht2e'
      );
      if (isSectionHeader && currentSection.questions.length > 0) {
        sectionIdx++;
        currentSection = { id: Parser.makeId('sec'), title: textOf(isSectionHeader) || ('Section ' + (sectionIdx + 1)), questions: [] };
        sections.push(currentSection);
      } else if (isSectionHeader && currentSection.questions.length === 0) {
        currentSection.title = textOf(isSectionHeader) || currentSection.title;
      }

      const q = readGoogleFormsQuestion(container, idx, sectionIdx, currentSection.title);
      if (q) {
        // Avoid exact-duplicate questions in the same section (same ID or same text+type)
        const dup = currentSection.questions.find((existing) => existing.id === q.id || (existing.text === q.text && existing.type === q.type));
        if (!dup) currentSection.questions.push(q);
      }
    });

    return sections;
  }

  function readGoogleFormsQuestion(container, idx, sectionIdx, sectionTitle) {
    // Question text — modern Google Forms uses .M7eMe, legacy uses .freebirdFormviewerViewItemsItemItemTitle.
    // ARIA role="heading" is the most stable fallback.
    const textEl = firstVisible([
      '.M7eMe',
      '.freebirdFormviewerViewItemsItemItemTitle',
      '[role="heading"][aria-level="3"]',
      '[role="heading"]',
      '.quantumWizTextpaperTextLabel',
      'div[dir="auto"]'
    ], container);
    let text = textOf(textEl);
    if (!text) {
      // Last resort: any text node that looks like a question
      const allText = textOf(container);
      if (allText && allText.length > 3 && allText.length < 500) text = allText.split('\n')[0];
    }
    if (!text) return null;

    // Required indicator — modern uses .H2GQcc, legacy uses .freebirdFormviewerViewItemsItemRequiredAsterisk
    const reqEl = container.querySelector(
      '.H2GQcc, .vSQV4c, ' +
      '.freebirdFormviewerViewItemsItemRequiredAsterisk, ' +
      '[aria-label="Required"], ' +
      '.v1xUbe'
    );
    const required = !!(reqEl);

    // Type detection: use both ARIA roles (stable) and input types (legacy).
    // Modern Google Forms uses [role="radio"], [role="checkbox"], [role="option"] for custom widgets.
    const radios = Array.from(container.querySelectorAll('[role="radio"], input[type="radio"]')).filter(isVisible);
    const checkboxes = Array.from(container.querySelectorAll('[role="checkbox"], input[type="checkbox"]')).filter(isVisible);
    const listboxes = Array.from(container.querySelectorAll('[role="listbox"], select')).filter(isVisible);
    const textInputs = Array.from(container.querySelectorAll(
      'input[type="text"], input:not([type]), input[type="email"], input[type="url"], input[type="tel"], input[type="number"]'
    )).filter(isVisible);
    const textareas = Array.from(container.querySelectorAll('textarea')).filter(isVisible);
    const dateInputs = Array.from(container.querySelectorAll('input[type="date"]')).filter(isVisible);
    const timeInputs = Array.from(container.querySelectorAll('input[type="time"]')).filter(isVisible);
    const rangeInputs = Array.from(container.querySelectorAll('input[type="range"]')).filter(isVisible);

    // Linear scale: radios with sequential numeric values. Must NOT match just because
    // there's a [role="radiogroup"] (every modern GF multiple choice has that).
    // Only treat as linear scale if ALL radio values are numeric integers.
    const linearScaleMatch = radios.length >= 2 && radios.every((r) => {
      const v = r.value || r.getAttribute('data-value') || '';
      return v !== '' && v !== '__OTHER_OPTION__' && /^\d+$/.test(v);
    });

    let type = QTYPE.UNKNOWN;
    let options = [];
    let minValue = null, maxValue = null;
    let minChoices = null, maxChoices = null;
    let inputRefs = [];

    if (radios.length && !checkboxes.length && linearScaleMatch) {
      type = QTYPE.LINEAR_SCALE;
      const values = radios.map((r) => r.value || r.getAttribute('data-value') || '').filter((v) => v !== '' && v !== '__OTHER_OPTION__').map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
      if (values.length) { minValue = Math.min.apply(null, values); maxValue = Math.max.apply(null, values); }
      inputRefs = radios.map(describeElement);
    } else if (radios.length && !checkboxes.length) {
      type = QTYPE.MULTIPLE_CHOICE;
      options = radios.map((r) => radioLabel(r)).filter((v) => v != null && v !== '');
      inputRefs = radios.map(describeElement);
    } else if (checkboxes.length) {
      type = QTYPE.CHECKBOX;
      options = checkboxes.map((c) => checkboxLabel(c)).filter((v) => v != null && v !== '');
      inputRefs = checkboxes.map(describeElement);
      const other = container.querySelector('[data-other-input]');
      if (other) maxChoices = options.length;
    } else if (listboxes.length) {
      type = QTYPE.DROPDOWN;
      const sel = listboxes[0];
      if (sel.tagName === 'SELECT') {
        options = Array.from(sel.options).map((o) => o.textContent.trim()).filter((t) => t && t !== '');
      } else {
        // Custom listbox widget: options may be inside the listbox OR in a popup
        // elsewhere in the question container. Search the whole container.
        options = Array.from(container.querySelectorAll('[role="option"]'))
          .map((o) => o.getAttribute('aria-label') || textOf(o))
          .filter((t) => t && t !== '' && t !== 'Choose');
      }
      inputRefs = [describeElement(sel)];
    } else if (dateInputs.length) {
      type = QTYPE.DATE;
      inputRefs = [describeElement(dateInputs[0])];
    } else if (timeInputs.length) {
      type = QTYPE.TIME;
      inputRefs = [describeElement(timeInputs[0])];
    } else if (rangeInputs.length) {
      type = QTYPE.RATING;
      minValue = parseInt(rangeInputs[0].min || '1', 10);
      maxValue = parseInt(rangeInputs[0].max || '5', 10);
      inputRefs = [describeElement(rangeInputs[0])];
    } else if (textareas.length) {
      type = QTYPE.PARAGRAPH;
      inputRefs = [describeElement(textareas[0])];
    } else if (textInputs.length) {
      type = QTYPE.SHORT_ANSWER;
      inputRefs = [describeElement(textInputs[0])];
    }

    // Validation hints from data-attributes / aria
    const maxLength = container.getAttribute('data-max-length') || (textInputs[0] && textInputs[0].maxLength >= 0 ? textInputs[0].maxLength : null);
    const pattern = (textInputs[0] && textInputs[0].pattern) || null;

    // Question ID: prefer data-params (contains the real Google Forms question ID).
    // If not available, use a STABLE hash of question text + section title — NOT the index.
    // Using the index causes cross-section contamination: Section A's q_1 (Gender) and
    // Section C's q_1 (PDB1) would share the same ID, so Section A's answer gets applied to Section C.
    const dataParams = container.getAttribute('data-params');
    let qid;
    if (dataParams) {
      // data-params looks like [[123, "question_id"], ...] — extract the string ID
      const match = dataParams.match(/"([a-f0-9]{10,})"/);
      qid = match ? 'gfq_' + match[1] : ('gfq_' + Parser.hashString(dataParams));
    } else {
      // Stable ID from question text + section title so the same question always gets the same ID
      qid = 'q_' + Parser.hashString(text + '|' + (sectionTitle || ''));
    }
    return {
      id: qid,
      text,
      type,
      required,
      options,
      minValue, maxValue,
      minChoices, maxChoices,
      maxLength: maxLength || null,
      pattern: pattern || null,
      sectionIndex: sectionIdx,
      visible: isVisible(container),
      elementRefs: inputRefs,
      containerRef: describeElement(container)
    };
  }

  function radioLabel(radio) {
    // Modern Google Forms: <div role="radio" aria-label="Option text">...
    if (radio.getAttribute('aria-label')) return radio.getAttribute('aria-label');
    // data-value attribute sometimes holds the label
    if (radio.getAttribute('data-value')) return radio.getAttribute('data-value');
    // Walk up to the label container
    const parent = radio.closest('[role="radio"], [data-value], .docssharedWizToggleLabeledContainer, .nWQGrd, label');
    if (parent) {
      const t = parent.getAttribute('aria-label') || textOf(parent.querySelector('.nWQGrd, .DWffhd, [dir="auto"]')) || textOf(parent);
      if (t) return t;
    }
    if (radio.labels && radio.labels.length) return textOf(radio.labels[0]);
    return radio.value || textOf(radio);
  }

  function checkboxLabel(cb) {
    if (cb.getAttribute('aria-label')) return cb.getAttribute('aria-label');
    if (cb.getAttribute('data-value')) return cb.getAttribute('data-value');
    const parent = cb.closest('[role="checkbox"], [data-value], .docssharedWizToggleLabeledContainer, .nWQGrd, label');
    if (parent) {
      const t = parent.getAttribute('aria-label') || textOf(parent.querySelector('.nWQGrd, .DWffhd, [dir="auto"]')) || textOf(parent);
      if (t) return t;
    }
    if (cb.labels && cb.labels.length) return textOf(cb.labels[0]);
    return cb.value || textOf(cb);
  }

  // ---------- HTML form reader ----------

  function readHtmlForm() {
    const forms = Array.from(document.querySelectorAll('form'));
    if (!forms.length) return null;
    let best = null; let bestScore = 0;
    for (const f of forms) {
      const inputs = Array.from(f.querySelectorAll('input, textarea, select')).filter(isVisible);
      if (inputs.length > bestScore) { best = f; bestScore = inputs.length; }
    }
    if (!best) return null;

    // Group questions by <fieldset> if present, otherwise single section
    const fieldsets = Array.from(best.querySelectorAll('fieldset')).filter((fs) => isVisible(fs));
    const sections = [];
    if (fieldsets.length) {
      fieldsets.forEach((fs, i) => {
        const title = textOf(fs.querySelector('legend')) || ('Section ' + (i + 1));
        const questions = readHtmlQuestions(fs, i);
        sections.push({ id: Parser.makeId('sec'), title, questions });
      });
    } else {
      const questions = readHtmlQuestions(best, 0);
      const title = textOf(best.querySelector('h1, h2, legend')) || 'Section 1';
      sections.push({ id: Parser.makeId('sec'), title, questions });
    }
    return sections.filter((s) => s.questions.length > 0);
  }

  function readHtmlQuestions(root, sectionIdx) {
    const out = [];

    // Strategy 1: prefer container-style wrappers (.field, .form-group, .question, .form-question).
    // These wrap a whole question: its label/text + its inputs. We only fall back to <label>
    // wrappers if no containers exist (in which case each <label> wraps one question).
    function findLeafWrappers(selectors) {
      const wrappers = [];
      for (const sel of selectors) {
        try {
          root.querySelectorAll(sel).forEach((el) => {
            if (isVisible(el) && !wrappers.some((w) => w === el)) wrappers.push(el);
          });
        } catch (e) { /* ignore */ }
      }
      // Keep only wrappers that contain at least one visible input
      const withInputs = wrappers.filter((w) => {
        return Array.from(w.querySelectorAll('input, textarea, select')).some((el) => isVisible(el) && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button');
      });
      // Filter to leaves (don't contain another wrapper-with-inputs)
      const leaves = withInputs.filter((w) => {
        return !withInputs.some((other) => other !== w && w.contains(other));
      });
      // Sort by DOM order
      leaves.sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & 4) return -1;
        if (pos & 2) return 1;
        return 0;
      });
      return leaves;
    }

    // Try containers first
    let wrappers = findLeafWrappers(['.form-group', '.field', '.question', '.form-question']);
    // If none, fall back to <label> wrappers
    if (!wrappers.length) {
      wrappers = findLeafWrappers(['label']);
    }
    // If still none, fall back to <fieldset> (whole section as one question — last resort)
    if (!wrappers.length) {
      wrappers = findLeafWrappers(['fieldset', 'div']);
    }

    const handled = new Set();
    wrappers.forEach((w, idx) => {
      const inputs = Array.from(w.querySelectorAll('input, textarea, select')).filter((el) => isVisible(el) && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button');
      if (!inputs.length) return;
      if (inputs.some((i) => handled.has(i))) return;
      inputs.forEach((i) => handled.add(i));
      const text = readHtmlQuestionText(w);
      if (!text) return;
      const q = buildHtmlQuestion(text, inputs, idx, sectionIdx);
      if (q) out.push(q);
    });

    // Strategy 2: fall back to grouping by radio/checkbox name (groups of same-name inputs become one question)
    if (!out.length) {
      const allInputs = Array.from(root.querySelectorAll('input, textarea, select')).filter((el) => isVisible(el) && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button' && !handled.has(el));
      const byName = new Map();
      const standalone = [];
      for (const el of allInputs) {
        if ((el.type === 'radio' || el.type === 'checkbox') && el.name) {
          if (!byName.has(el.name)) byName.set(el.name, []);
          byName.get(el.name).push(el);
          handled.add(el);
        } else {
          standalone.push(el);
        }
      }
      let idx = 0;
      for (const [name, inputs] of byName) {
        const text = readHtmlQuestionText(inputs[0].closest('label, .field, .form-group, fieldset') || inputs[0]);
        if (!text) continue;
        const q = buildHtmlQuestion(text, inputs, idx++, sectionIdx);
        if (q) out.push(q);
      }
      for (const el of standalone) {
        const text = readHtmlQuestionText(el.closest('label, .field, .form-group, fieldset') || el);
        if (!text) continue;
        handled.add(el);
        const q = buildHtmlQuestion(text, [el], idx++, sectionIdx);
        if (q) out.push(q);
      }
    }

    // Strategy 3: as a last resort, any straggler inputs not yet handled
    const stray = Array.from(root.querySelectorAll('input, textarea, select')).filter((el) => isVisible(el) && !handled.has(el) && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button');
    stray.forEach((el, idx) => {
      const text = readHtmlQuestionText(el.closest('label, .field, .form-group, fieldset') || el);
      if (!text) return;
      const q = buildHtmlQuestion(text, [el], idx + 1000, sectionIdx);
      if (q) out.push(q);
    });

    return out;
  }

  function readHtmlQuestionText(cand) {
    if (!cand) return '';
    // Prefer a nested heading or legend (anywhere inside)
    const heading = cand.querySelector('h1, h2, h3, h4, legend, .question-text, .label-text, .field-label');
    if (heading) return textOf(heading);

    // Look at DIRECT children that are <label> or text containers, and prefer
    // one that does NOT itself wrap an input (option labels typically wrap the radio/checkbox).
    // Note: a question label can have a `for` attribute pointing to a sibling input,
    // so we do NOT skip labels just because they have `for`.
    if (cand.children && cand.children.length) {
      for (const child of Array.from(cand.children)) {
        if (child.tagName !== 'LABEL' && !child.classList.contains('question-text') && !child.classList.contains('field-label')) continue;
        if (child.querySelector('input, textarea, select')) continue; // wraps an input → option label
        const t = textOf(child);
        if (t) return t;
      }
    }

    // If the candidate IS a label, use its text (minus the option text if it wraps an input)
    if (cand.tagName === 'LABEL') {
      const t = textOf(cand);
      // If the label wraps an input, strip the input's value/options
      const inp = cand.querySelector('input, textarea, select');
      if (inp) {
        // Use only text nodes directly inside the label, not inside child labels
        let direct = '';
        for (const node of cand.childNodes) {
          if (node.nodeType === 3) direct += node.textContent;
        }
        return (direct.trim() || t.split(/\n/)[0]).trim();
      }
      return t.split(/\n/)[0].trim();
    }

    // Or aria-label on the input itself
    const inp = cand.querySelector('input, textarea, select');
    if (inp && inp.getAttribute('aria-label')) return inp.getAttribute('aria-label');

    // Or a sibling/child <label for=>
    const inp2 = cand.querySelector('input, textarea, select');
    if (inp2 && inp2.id) {
      // Only use <label for> if it does NOT appear inside the candidate (otherwise it's an option label)
      const lbl = document.querySelector('label[for="' + CSS.escape(inp2.id) + '"]');
      if (lbl && !cand.contains(lbl)) return textOf(lbl);
    }

    // Last resort: a label that's a sibling (just above the inputs)
    const prev = cand.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return textOf(prev);

    return '';
  }

  function buildHtmlQuestion(text, inputs, idx, sectionIdx) {
    const radios = inputs.filter((i) => i.type === 'radio');
    const checkboxes = inputs.filter((i) => i.type === 'checkbox');
    const selects = inputs.filter((i) => i.tagName === 'SELECT');
    const textInputs = inputs.filter((i) => i.type === 'text' || i.type === '' || i.type === 'email' || i.type === 'tel' || i.type === 'url' || i.type === 'number');
    const textareas = inputs.filter((i) => i.tagName === 'TEXTAREA');
    const dateInputs = inputs.filter((i) => i.type === 'date');
    const timeInputs = inputs.filter((i) => i.type === 'time');
    const rangeInputs = inputs.filter((i) => i.type === 'range');
    const numberInputs = inputs.filter((i) => i.type === 'number');

    let type = QTYPE.UNKNOWN;
    let options = [];
    let minValue = null, maxValue = null;
    let inputRefs = [];

    if (radios.length >= 3 && isLinearScaleGroup(radios)) {
      type = QTYPE.LINEAR_SCALE;
      const vals = radios.map((r) => parseInt(r.value, 10)).filter((v) => !isNaN(v));
      if (vals.length) { minValue = Math.min.apply(null, vals); maxValue = Math.max.apply(null, vals); }
      inputRefs = radios.map(describeElement);
    } else if (radios.length) {
      type = QTYPE.MULTIPLE_CHOICE;
      options = radios.map(radioLabel);
      inputRefs = radios.map(describeElement);
    } else if (checkboxes.length) {
      type = QTYPE.CHECKBOX;
      options = checkboxes.map(checkboxLabel);
      inputRefs = checkboxes.map(describeElement);
    } else if (selects.length) {
      type = QTYPE.DROPDOWN;
      const sel = selects[0];
      options = Array.from(sel.options).map((o) => o.textContent.trim()).filter((t) => t && t !== '');
      inputRefs = [describeElement(sel)];
    } else if (dateInputs.length) {
      type = QTYPE.DATE;
      inputRefs = [describeElement(dateInputs[0])];
    } else if (timeInputs.length) {
      type = QTYPE.TIME;
      inputRefs = [describeElement(timeInputs[0])];
    } else if (rangeInputs.length) {
      type = QTYPE.RATING;
      minValue = parseInt(rangeInputs[0].min || '1', 10);
      maxValue = parseInt(rangeInputs[0].max || '5', 10);
      inputRefs = [describeElement(rangeInputs[0])];
    } else if (textareas.length) {
      type = QTYPE.PARAGRAPH;
      inputRefs = [describeElement(textareas[0])];
    } else if (textInputs.length || numberInputs.length) {
      type = QTYPE.SHORT_ANSWER;
      const el = (textInputs[0] || numberInputs[0]);
      inputRefs = [describeElement(el)];
    }

    const required = inputs.some((i) => i.required || i.getAttribute('aria-required') === 'true');
    const qid = (inputs[0].name || inputs[0].id || ('q_' + idx));

    return {
      id: 'htmlq_' + Parser.hashString(text + '|' + qid),
      text,
      type,
      required,
      options,
      minValue, maxValue,
      minChoices: null,
      maxChoices: null,
      maxLength: (textInputs[0] && textInputs[0].maxLength >= 0) ? textInputs[0].maxLength : null,
      pattern: (textInputs[0] && textInputs[0].pattern) || null,
      sectionIndex: sectionIdx,
      visible: true,
      elementRefs: inputRefs,
      containerRef: null
    };
  }

  function isLinearScaleGroup(radios) {
    // Heuristic: numeric values 1..N with sequential radio buttons
    const vals = radios.map((r) => parseInt(r.value, 10)).filter((v) => !isNaN(v));
    if (vals.length < 3) return false;
    const sorted = vals.slice().sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) return false;
    }
    return true;
  }

  // ---------- Element descriptor (for cross-context use) ----------
  function describeElement(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      name: el.name || null,
      id: el.id || null,
      value: el.value || null,
      role: el.getAttribute('role') || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      classes: el.className ? String(el.className).split(/\s+/).slice(0, 5) : [],
      // XPath-ish locator built from stable attributes
      locator: buildLocator(el),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
    };
  }

  function buildLocator(el) {
    if (!el) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.getAttribute('role')) return `[role="${el.getAttribute('role')}"]${el.getAttribute('aria-label') ? `[aria-label="${el.getAttribute('aria-label')}"]` : ''}`;
    // Path
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) part += '.' + cls.join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function resolveLocator(locator) {
    if (!locator) return null;
    try { return document.querySelector(locator); } catch (e) { return null; }
  }

  // ---------- Public read API ----------

  function read() {
    let sections = null;
    const formType = detectFormType();
    if (formType === 'google_forms') sections = readGoogleForms();
    else if (formType === 'html_form') sections = readHtmlForm();
    if (!sections) return { ok: false, reason: 'No readable form found', formType, sections: [] };

    // VERIFICATION: count the actual question containers on the page and compare
    // with what we found. If there are more containers than questions, some were missed.
    const allContainers = document.querySelectorAll('[role="listitem"][data-params], [role="listitem"], .freebirdFormviewerViewItemsItemItem');
    const visibleContainers = Array.from(allContainers).filter(isVisible);
    const totalQuestionsFound = sections.reduce((n, s) => n + (s.questions || []).length, 0);

    // If we found fewer questions than visible containers, try a broader read
    if (visibleContainers.length > totalQuestionsFound && totalQuestionsFound === 0) {
      // The standard selectors didn't find any questions, but there ARE visible containers.
      // Try reading each visible container directly as a question.
      const fallbackSections = [{ id: Parser.makeId('sec'), title: 'Section 1', questions: [] }];
      visibleContainers.forEach((container, idx) => {
        const q = readGoogleFormsQuestion(container, idx, 0, 'Section 1');
        if (q) {
          const dup = fallbackSections[0].questions.find((existing) => existing.id === q.id || (existing.text === q.text && existing.type === q.type));
          if (!dup) fallbackSections[0].questions.push(q);
        }
      });
      if (fallbackSections[0].questions.length > 0) {
        sections = fallbackSections;
      }
    }

    // Mark visibility per question
    sections.forEach((s) => {
      s.questions.forEach((q) => { q.visible = true; });
    });
    return { ok: true, formType, sections };
  }

  function detectFormType() {
    if (document.querySelector('.freebirdFormviewerViewFormContainer, .freebirdFormviewerViewHeaderHeader')) return 'google_forms';
    if (/forms\.gle\/|docs\.google\.com\/forms\//.test(location.href)) return 'google_forms';
    if (document.querySelector('form')) return 'html_form';
    return 'unknown';
  }

  // Diagnostic mode: return raw question descriptors with element refs for debugging
  function diagnostic() {
    const r = read();
    if (!r.ok) return r;
    return {
      ok: true,
      formType: r.formType,
      sections: r.sections.map((s) => ({
        id: s.id, title: s.title,
        questions: s.questions.map((q) => ({ ...q, elementRefs: q.elementRefs }))
      }))
    };
  }

  // Extract all visible text from the form page for AI analysis
  function extractFormText() {
    const formContainer = document.querySelector(
      '[role="main"], form, .freebirdFormviewerViewFormContainer, .FormSelector'
    ) || document.body;
    // Get text from visible elements only, preserving structure
    const walker = document.createTreeWalker(
      formContainer,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: function(node) {
          if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
          // Skip script/style elements
          if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    const texts = [];
    let node;
    while (node = walker.nextNode()) {
      // Only get direct text nodes (not from children)
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = (child.textContent || '').trim();
          if (t) texts.push(t);
        }
      }
      // Also check aria-labels on inputs
      if (node.getAttribute && node.getAttribute('aria-label')) {
        texts.push(node.getAttribute('aria-label'));
      }
      // Check role attributes
      if (node.getAttribute && node.getAttribute('role')) {
        const role = node.getAttribute('role');
        if (role === 'radio' || role === 'checkbox' || role === 'option') {
          texts.push('[' + role + ': ' + (node.getAttribute('aria-label') || node.textContent || '').trim() + ']');
        }
      }
    }
    return texts.join('\n').slice(0, 12000);
  }

  // Bottom-up reader: create questions directly from form input elements.
  // This is a last-resort reader used when the container-based reader fails.
  // It finds all visible radios, checkboxes, text inputs, etc. and groups them into questions.
  function readFromInputs() {
    const questions = [];

    // Find all visible radio groups (grouped by [role="radiogroup"] or name attribute)
    const radioGroups = new Map();
    const allRadios = Array.from(document.querySelectorAll('[role="radio"], input[type="radio"]')).filter(isVisible);
    for (const radio of allRadios) {
      // Group by the closest radiogroup container, or by name
      let groupKey = null;
      const radiogroup = radio.closest('[role="radiogroup"], .freebirdFormviewerViewItemsScaleRoot, fieldset');
      if (radiogroup) {
        groupKey = radiogroup;
      } else if (radio.name) {
        groupKey = 'name:' + radio.name;
      } else {
        // Use the question container (closest listitem or data-params)
        const container = radio.closest('[role="listitem"], [data-params], .freebirdFormviewerViewItemsItemItem, .Qr7O4e, .geMS5');
        groupKey = container || radio.parentElement;
      }
      if (!radioGroups.has(groupKey)) radioGroups.set(groupKey, []);
      radioGroups.get(groupKey).push(radio);
    }
    for (const [, radios] of radioGroups) {
      if (radios.length < 1) continue;
      const container = radios[0].closest('[role="listitem"], [data-params], .freebirdFormviewerViewItemsItemItem, .Qr7O4e, .geMS5, fieldset, [role="radiogroup"]');
      const text = findQuestionText(container || radios[0]);
      const options = radios.map((r) => r.getAttribute('aria-label') || r.getAttribute('data-value') || r.value || textOf(r)).filter((v) => v && v !== '');
      // Check if it's a linear scale (all numeric values)
      const isLinearScale = options.length >= 2 && options.every((o) => /^\d+$/.test(o));
      const q = {
        id: 'inp_' + Parser.hashString(text || options.join('|')),
        text: text || ('Question ' + (questions.length + 1)),
        type: isLinearScale ? 'linear_scale' : 'multiple_choice',
        required: checkRequired(container || radios[0]),
        options: options,
        minValue: isLinearScale ? parseInt(options[0], 10) : null,
        maxValue: isLinearScale ? parseInt(options[options.length - 1], 10) : null,
        sectionIndex: 0,
        visible: true,
        elementRefs: radios.map(describeElement),
        containerRef: container ? describeElement(container) : null
      };
      // Avoid duplicates
      if (!questions.find((existing) => existing.text === q.text)) questions.push(q);
    }

    // Find all visible checkbox groups
    const checkboxGroups = new Map();
    const allCheckboxes = Array.from(document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')).filter(isVisible);
    for (const cb of allCheckboxes) {
      let groupKey = null;
      const group = cb.closest('[role="group"], fieldset');
      if (group) {
        groupKey = group;
      } else if (cb.name) {
        groupKey = 'name:' + cb.name;
      } else {
        const container = cb.closest('[role="listitem"], [data-params], .Qr7O4e, .geMS5');
        groupKey = container || cb.parentElement;
      }
      if (!checkboxGroups.has(groupKey)) checkboxGroups.set(groupKey, []);
      checkboxGroups.get(groupKey).push(cb);
    }
    for (const [, checkboxes] of checkboxGroups) {
      if (checkboxes.length < 1) continue;
      const container = checkboxes[0].closest('[role="listitem"], [data-params], .Qr7O4e, .geMS5, fieldset, [role="group"]');
      const text = findQuestionText(container || checkboxes[0]);
      const options = checkboxes.map((c) => c.getAttribute('aria-label') || c.getAttribute('data-value') || c.value || textOf(c)).filter((v) => v && v !== '');
      const q = {
        id: 'inp_' + Parser.hashString(text || options.join('|')),
        text: text || ('Question ' + (questions.length + 1)),
        type: 'checkbox',
        required: checkRequired(container || checkboxes[0]),
        options: options,
        minValue: null, maxValue: null,
        sectionIndex: 0,
        visible: true,
        elementRefs: checkboxes.map(describeElement),
        containerRef: container ? describeElement(container) : null
      };
      if (!questions.find((existing) => existing.text === q.text)) questions.push(q);
    }

    // Find visible text inputs and textareas
    const textInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), input[type="email"], input[type="url"], input[type="tel"], input[type="number"]')).filter(isVisible);
    const textareas = Array.from(document.querySelectorAll('textarea')).filter(isVisible);
    for (const el of [...textInputs, ...textareas]) {
      const container = el.closest('[role="listitem"], [data-params], .Qr7O4e, .geMS5, .field, .form-group');
      const text = findQuestionText(container || el);
      if (!text) continue; // skip inputs without a question label
      const q = {
        id: 'inp_' + Parser.hashString(text),
        text: text,
        type: el.tagName === 'TEXTAREA' ? 'paragraph' : 'short_answer',
        required: checkRequired(container || el) || el.required,
        options: [],
        minValue: null, maxValue: null,
        sectionIndex: 0,
        visible: true,
        elementRefs: [describeElement(el)],
        containerRef: container ? describeElement(container) : null
      };
      if (!questions.find((existing) => existing.text === q.text)) questions.push(q);
    }

    // Find visible dropdowns/listboxes
    const dropdowns = Array.from(document.querySelectorAll('[role="listbox"], select')).filter(isVisible);
    for (const sel of dropdowns) {
      const container = sel.closest('[role="listitem"], [data-params], .Qr7O4e, .geMS5');
      const text = findQuestionText(container || sel);
      let options = [];
      if (sel.tagName === 'SELECT') {
        options = Array.from(sel.options).map((o) => o.textContent.trim()).filter((t) => t && t !== '');
      } else {
        options = Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.getAttribute('aria-label') || textOf(o)).filter((t) => t && t !== '');
      }
      const q = {
        id: 'inp_' + Parser.hashString(text || 'dropdown'),
        text: text || ('Question ' + (questions.length + 1)),
        type: 'dropdown',
        required: checkRequired(container || sel),
        options: options,
        minValue: null, maxValue: null,
        sectionIndex: 0,
        visible: true,
        elementRefs: [describeElement(sel)],
        containerRef: container ? describeElement(container) : null
      };
      if (!questions.find((existing) => existing.text === q.text)) questions.push(q);
    }

    return questions;
  }

  // Find the question text for a given element by looking at nearby headings/labels
  function findQuestionText(el) {
    if (!el) return '';
    // Walk up to find a container with a heading
    let cur = el;
    for (let depth = 0; depth < 5 && cur; depth++) {
      const heading = cur.querySelector('.M7eMe, [role="heading"], .freebirdFormviewerViewItemsItemItemTitle, .question-text, h1, h2, h3, h4, legend, label');
      if (heading) {
        const t = textOf(heading);
        if (t) return t;
      }
      cur = cur.parentElement;
    }
    // Look for a preceding heading
    let prev = el.previousElementSibling;
    for (let i = 0; i < 5 && prev; i++) {
      const t = textOf(prev);
      if (t && t.length > 3 && t.length < 500) return t;
      prev = prev.previousElementSibling;
    }
    // Check aria-label on the element itself
    if (el.getAttribute && el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    return '';
  }

  // Check if a question is required by looking for required indicators
  function checkRequired(el) {
    if (!el) return false;
    if (el.querySelector && el.querySelector('.H2GQcc, .vSQV4c, .freebirdFormviewerViewItemsItemRequiredAsterisk, [aria-label="Required"], .v1xUbe, .req, [required]')) return true;
    if (el.required) return true;
    if (el.getAttribute && el.getAttribute('aria-required') === 'true') return true;
    return false;
  }

  // Check if there are visible form input elements on the page (radios, checkboxes, text inputs)
  function hasVisibleInputs() {
    return !!document.querySelector(
      '[role="radio"], [role="checkbox"], [role="listbox"], ' +
      'input[type="text"], input:not([type]), input[type="email"], input[type="url"], ' +
      'input[type="radio"], input[type="checkbox"], textarea, select'
    );
  }
  function readVisibleSection() {
    const r = read();
    if (!r.ok) return r;
    // Google Forms: only one section is visible at a time; pick the one with visible questions
    const visibleSections = r.sections.filter((s) => s.questions.some((q) => q.visible));
    if (visibleSections.length === 0) {
      // No visible sections found by the standard reader. But there might be visible
      // question containers that the reader missed. Return the full read result so the
      // caller can decide what to do.
      return { ok: true, formType: r.formType, sections: r.sections, allSections: r.sections };
    }
    return { ok: true, formType: r.formType, sections: visibleSections, allSections: r.sections };
  }

  const FormReader = {
    read,
    readVisibleSection,
    diagnostic,
    detectFormType,
    describeElement,
    resolveLocator,
    extractFormText,
    readFromInputs,
    hasVisibleInputs
  };

  SP.FormReader = FormReader;
  global.SurveyPilot = SP;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'surveypilot_read') {
        const r = read();
        sendResponse(r);
        return true;
      }
      if (msg.type === 'surveypilot_read_visible') {
        const r = readVisibleSection();
        sendResponse(r);
        return true;
      }
      if (msg.type === 'surveypilot_diagnostic') {
        const r = diagnostic();
        sendResponse(r);
        return true;
      }
      if (msg.type === 'surveypilot_extract_form_text') {
        const text = extractFormText();
        sendResponse({ ok: true, text });
        return true;
      }
      if (msg.type === 'surveypilot_read_from_inputs') {
        const questions = readFromInputs();
        sendResponse({ ok: true, questions });
        return true;
      }
      if (msg.type === 'surveypilot_has_visible_inputs') {
        sendResponse({ hasInputs: hasVisibleInputs() });
        return true;
      }
      return false;
    });
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
