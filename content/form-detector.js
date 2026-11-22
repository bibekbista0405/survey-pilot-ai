/*
 * SurveyPilot AI - Form Detector (content script)
 * Detects whether the active page contains a supported survey form.
 * Supported: Google Forms, standard HTML <form>s with at least one input.
 *
 * Attaches to window.SurveyPilot.FormDetector and listens for runtime messages
 * of type "detectForm" from the service worker / side panel.
 */
(function (global) {
  'use strict';

  const SP = global.SurveyPilot || {};
  const Parser = SP.SurveyParser || {};

  function detectGoogleForms() {
    // Robustness: use several signals rather than a single selector.
    const url = global.location ? global.location.href : '';
    const isFormsUrl = /forms\.gle\/|docs\.google\.com\/forms\//.test(url);
    const hasFreebird = !!(document.querySelector('.freebirdFormviewerViewFormContainer, .freebirdFormviewerViewHeaderHeader, .FormSelector') || document.body && /freebird/.test(document.body.className));
    // Modern Google Forms: has [role="listitem"][data-params] containers and a [role="main"] wrapper
    const hasModernFormItems = !!document.querySelector('[role="listitem"][data-params], [data-params]');
    const hasRoleForm = !!document.querySelector('form');
    const hasRoleMain = !!document.querySelector('[role="main"]');
    // Navigation buttons (Next/Submit) — present on intro pages and question pages
    const hasNavButton = !!document.querySelector('[role="button"][aria-label*="Next" i], [role="button"][aria-label*="Submit" i], [role="button"][aria-label*="Continue" i], button[type="submit"]');
    // STRICT confirmation page detection: only match SPECIFIC text, NOT generic href patterns.
    // "Submit another response" only appears on the confirmation page AFTER submission.
    const allLinks = Array.from(document.querySelectorAll('a, [role="link"]'));
    const hasResubmitLink = allLinks.some((link) => {
      const text = (link.textContent || '').trim();
      return /submit another response|fill out a new form|submit another form|send another response/i.test(text);
    });
    // Confirmation text: only specific phrases that Google Forms shows after submission
    const bodyText = (document.body && document.body.textContent || '').toLowerCase();
    const hasConfirmationText = /response has been recorded|response was recorded|your submission has been|form was submitted/i.test(bodyText);

    // Trust the URL pattern: if we're on a Google Forms URL, treat it as a Google Form
    // as long as there's ANY Google Forms signal (form items, nav buttons, main role, etc.)
    if (isFormsUrl && (hasFreebird || hasModernFormItems || hasRoleForm || hasRoleMain || hasNavButton || hasConfirmationText || hasResubmitLink)) {
      let title = '';
      const titleEl = document.querySelector('.freebirdFormviewerViewHeaderTitle, .M7eMe, [role="heading"][aria-level="1"], h1, [role="heading"]');
      if (titleEl) title = (titleEl.textContent || '').trim();
      // Determine the page type — STRICT rules to avoid false positives
      let pageType = 'questions';
      // Confirmation page: ONLY if there's specific confirmation text AND no form elements
      // OR a specific "Submit another response" link AND no form elements
      const hasAnyFormElement = hasModernFormItems || hasFreebird || hasRoleForm ||
        !!document.querySelector('[role="radio"], [role="checkbox"], [role="listbox"], input[type="text"], textarea, select');
      if (hasConfirmationText && !hasAnyFormElement) {
        pageType = 'confirmation';
      } else if (hasResubmitLink && !hasAnyFormElement) {
        pageType = 'confirmation';
      } else if (!hasModernFormItems && !hasFreebird && !hasRoleForm && !hasAnyFormElement && hasNavButton) {
        pageType = 'intro';
      }
      return {
        formType: 'google_forms',
        title: title || document.title || 'Google Form',
        url,
        confidence: 'high',
        pageType
      };
    }
    // Legacy fallback: freebird classes without URL match
    if (hasFreebird) {
      let title = '';
      const titleEl = document.querySelector('.freebirdFormviewerViewHeaderTitle, [role="heading"][aria-level="1"], h1');
      if (titleEl) title = (titleEl.textContent || '').trim();
      return {
        formType: 'google_forms',
        title: title || document.title || 'Google Form',
        url,
        confidence: 'high',
        pageType: (hasConfirmationText && !hasModernFormItems) ? 'confirmation' : 'questions'
      };
    }
    return null;
  }

  function detectHtmlForm() {
    const forms = Array.from(document.querySelectorAll('form'));
    if (!forms.length) return null;
    // Pick the form with the most visible inputs
    let best = null;
    let bestScore = 0;
    for (const f of forms) {
      const inputs = Array.from(f.querySelectorAll('input, textarea, select')).filter((el) => isElementVisible(el));
      const score = inputs.length;
      if (score > bestScore) { best = f; bestScore = score; }
    }
    if (!best || bestScore < 1) return null;

    let title = '';
    const titleEl = best.querySelector('h1, h2, legend, [data-form-title]') || document.querySelector('h1');
    if (titleEl) title = (titleEl.textContent || '').trim();

    return {
      formType: 'html_form',
      title: title || document.title || 'HTML Form',
      url: global.location.href,
      confidence: 'high',
      formElement: best
    };
  }

  function isElementVisible(el) {
    if (!el) return false;
    // Walk up checking display / visibility via getComputedStyle.
    // We do NOT use rect dimensions because real Google Forms sections can have
    // legitimately 0-height ancestors during transitions, and headless test
    // environments (jsdom) report 0x0 for everything.
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 20) {
      const cs = global.getComputedStyle ? global.getComputedStyle(cur) : null;
      if (cs) {
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      // Hidden inputs are never visible
      if (cur.tagName === 'INPUT' && cur.type === 'hidden') return false;
      // aria-hidden="true" on an ancestor means hidden
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      cur = cur.parentElement;
      depth++;
    }
    return true;
  }

  // Public API
  function detect() {
    try {
      const g = detectGoogleForms();
      if (g) return Object.assign({ ok: true }, g);
      const h = detectHtmlForm();
      if (h) {
        const { formElement, ...rest } = h;
        return Object.assign({ ok: true }, rest);
      }
      return { ok: false, formType: 'unknown', title: document.title || '', url: global.location.href, reason: 'No supported form detected on this page' };
    } catch (e) {
      return { ok: false, formType: 'unknown', title: '', url: global.location.href, reason: 'Detection error: ' + (e && e.message) };
    }
  }

  const FormDetector = {
    detect,
    detectGoogleForms,
    detectHtmlForm,
    isElementVisible
  };

  SP.FormDetector = FormDetector;
  global.SurveyPilot = SP;

  // Listen for messages from the service worker / side panel
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'surveypilot_ping') {
        sendResponse({ pong: true, formType: detectFormType ? detectFormType() : 'unknown' });
        return true;
      }
      if (msg.type === 'surveypilot_detect') {
        const r = detect();
        sendResponse(r);
        return true;
      }
      return false;
    });
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
