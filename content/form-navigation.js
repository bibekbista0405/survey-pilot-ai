/*
 * SurveyPilot AI - Form Navigation (content script)
 * Detects and operates Next / Previous / Submit buttons on multi-page forms.
 * Waits for section transitions and reports when navigation fails.
 */
(function (global) {
  'use strict';

  const SP = global.SurveyPilot || {};

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

  function textOf(el) {
    return (el && el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  // Multiple selector strategies for navigation buttons
  function findButtons() {
    const candidates = [];

    // Google Forms: Next button has specific role / class / aria-label.
    // Modern Google Forms uses [role="button"] with aria-label or text content.
    const gfNext = Array.from(document.querySelectorAll(
      '.freebirdFormviewerViewNavigationRightActionButton, ' +
      '[role="button"][jsname*="Next"], ' +
      'div[role="button"][aria-label*="Next" i], ' +
      'div[role="button"][aria-label*="Continue" i], ' +
      '.appsMaterialWizButtonPaperbuttonLabel, ' +
      '[jsname*="ocHEne"], ' +  // Next button jsname
      '[jsname*="M6aTFc"]'     // another common Next jsname
    )).filter(isVisible).filter((el) => {
      // Filter to buttons whose text or aria-label contains "Next" / "Continue"
      const lbl = (el.getAttribute('aria-label') || '') + ' ' + textOf(el);
      return /next|continue|forward/i.test(lbl) || el.getAttribute('jsname') && /ocHEne|M6aTFc/.test(el.getAttribute('jsname'));
    });

    const gfPrev = Array.from(document.querySelectorAll(
      '.freebirdFormviewerViewNavigationLeftActionButton, ' +
      'div[role="button"][aria-label*="Back" i], ' +
      'div[role="button"][aria-label*="Previous" i], ' +
      '[jsname*="AeHA0e"]'
    )).filter(isVisible);

    const gfSubmit = Array.from(document.querySelectorAll(
      'div[role="button"][aria-label*="Submit" i], ' +
      '.freebirdFormviewerViewNavigationSubmitButton, ' +
      'button[type="submit"], input[type="submit"], ' +
      '[jsname*="M2UYVd"]'  // Submit button jsname
    )).filter(isVisible).filter((el) => {
      const lbl = (el.getAttribute('aria-label') || '') + ' ' + textOf(el);
      return /submit|send|finish|complete|done/i.test(lbl) || el.getAttribute('jsname') === 'M2UYVd';
    });

    // Broader fallback: any [role="button"] with "Submit" or "Next" text
    if (!gfNext.length || !gfSubmit.length) {
      const allRoleButtons = Array.from(document.querySelectorAll('[role="button"], button')).filter(isVisible);
      for (const b of allRoleButtons) {
        const t = textOf(b).toLowerCase();
        if (!gfNext.length && /next|continue/.test(t) && !/back|previous/.test(t)) gfNext.push(b);
        if (!gfSubmit.length && /submit/.test(t)) gfSubmit.push(b);
      }
    }

    // HTML forms
    const htmlButtons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).filter(isVisible);

    // Classify HTML buttons by text
    const htmlNext = htmlButtons.filter((b) => /next|continue|forward|>/i.test(textOf(b) || b.value || ''));
    const htmlPrev = htmlButtons.filter((b) => /back|previous|prev|</i.test(textOf(b) || b.value || ''));
    const htmlSubmit = htmlButtons.filter((b) => /submit|send|finish|complete|done/i.test(textOf(b) || b.value || ''));

    return {
      next: gfNext.length ? gfNext : htmlNext,
      prev: gfPrev.length ? gfPrev : htmlPrev,
      submit: gfSubmit.length ? gfSubmit : htmlSubmit
    };
  }

  function pickPrimary(list) {
    if (!list || !list.length) return null;
    // Prefer the last visible one (Google Forms puts Next button last in the action row)
    return list[list.length - 1];
  }

  function clickEl(el) {
    if (!el) return false;
    // Scroll into view first so the element is clickable
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {
      try { el.scrollIntoView(); } catch (e2) {}
    }
    // Focus the element (Google Forms may require focus before accepting clicks)
    try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
    // Use native el.click() ONLY — produces a TRUSTED click event.
    // Synthetic dispatchEvent events have isTrusted=false and Google Forms ignores them.
    try { if (typeof el.click === 'function') el.click(); } catch (e) { return false; }
    return true;
  }

  // Snapshot a signature of the current visible section so we can detect transitions
  function sectionSignature() {
    const sig = {
      url: location.href,
      // First ~5 visible question texts, joined
      questions: [],
      scrollY: window.scrollY,
      title: document.title
    };
    const qs = document.querySelectorAll('.freebirdFormviewerViewItemsItemItemTitle, [role="heading"][aria-level="3"], .question-text, h2, h3, legend, .field > label');
    const seen = new Set();
    Array.from(qs).filter(isVisible).slice(0, 8).forEach((el) => {
      const t = textOf(el);
      if (t && !seen.has(t)) { seen.add(t); sig.questions.push(t); }
    });
    sig.hash = sig.questions.join('||') + '|' + sig.url;
    return sig;
  }

  function waitForChange(prevSig, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timeout = timeoutMs || 8000;
      function check() {
        const cur = sectionSignature();
        if (cur.hash !== prevSig.hash) { resolve({ changed: true, sig: cur }); return; }
        if (Date.now() - t0 > timeout) { resolve({ changed: false, sig: cur, timeout: true }); return; }
        setTimeout(check, 150);
      }
      setTimeout(check, 100);
    });
  }

  function waitForErrors(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timeout = timeoutMs || 1500;
      function check() {
        // Google Forms validation errors
        const errs = Array.from(document.querySelectorAll(
          '.freebirdFormviewerViewItemsItemErrorMessage, ' +
          '.freebirdMaterialHeaderbannerHasError, ' +
          '[role="alert"], ' +
          '.error, .invalid-feedback'
        )).filter(isVisible).map(textOf).filter(Boolean);
        if (errs.length) { resolve({ errors: errs }); return; }
        if (Date.now() - t0 > timeout) { resolve({ errors: [] }); return; }
        setTimeout(check, 100);
      }
      setTimeout(check, 50);
    });
  }

  // Attempt to go to the next section
  async function goNext(opts) {
    opts = opts || {};
    const before = sectionSignature();
    const btns = findButtons();
    // Prefer Submit if there is no Next button (last page)
    const primary = pickPrimary(btns.next) || pickPrimary(btns.submit);
    if (!primary) {
      // Maybe last page: look for submit
      const submit = pickPrimary(btns.submit);
      if (submit) return { ok: false, reason: 'no_next_button', isLastPage: true, submitAvailable: true };
      return { ok: false, reason: 'no_navigation_button' };
    }
    const clicked = clickEl(primary);
    if (!clicked) return { ok: false, reason: 'click_failed' };
    // Wait for the section to change (Google Forms transitions are async)
    const change = await waitForChange(before, opts.timeoutMs || 10000);
    if (!change.changed) {
      // The click didn't cause a transition. Try clicking child elements of the button.
      const children = primary.querySelectorAll('div, span, [jsname]');
      for (const child of children) {
        clickEl(child);
        const change2 = await waitForChange(before, 2000);
        if (change2.changed) {
          const errs = await waitForErrors(600);
          return { ok: true, sig: change2.sig, errors: errs.errors };
        }
      }
      // Check for validation errors blocking navigation
      const errs = await waitForErrors(opts.errorTimeoutMs || 1500);
      return { ok: false, reason: 'navigation_timeout', errors: errs.errors, sig: change.sig };
    }
    // After change, check for new validation errors
    const errs = await waitForErrors(600);
    return { ok: true, sig: change.sig, errors: errs.errors };
  }

  async function goSubmit(opts) {
    opts = opts || {};
    const before = sectionSignature();
    const btns = findButtons();
    const primary = pickPrimary(btns.submit);
    if (!primary) return { ok: false, reason: 'no_submit_button' };
    const clicked = clickEl(primary);
    if (!clicked) return { ok: false, reason: 'click_failed' };
    // Wait for either URL change or a confirmation message
    const change = await waitForChange(before, opts.timeoutMs || 10000);
    return { ok: change.changed, sig: change.sig, reason: change.changed ? null : 'navigation_timeout' };
  }

  function hasSubmitButton() {
    const btns = findButtons();
    return !!pickPrimary(btns.submit);
  }

  function hasNextButton() {
    const btns = findButtons();
    return !!pickPrimary(btns.next);
  }

  // Find the "Submit another response" / "Fill out a new form" link on the Google Forms
  // confirmation page. Only matches SPECIFIC text patterns to avoid false positives.
  function findResubmitLink() {
    const links = Array.from(document.querySelectorAll('a, [role="link"]'));
    // Only match specific confirmation-page link text — NOT generic "viewform" hrefs
    const patterns = [
      /submit another response/i,
      /fill out a new form/i,
      /submit another form/i,
      /send another response/i,
      /submit another/i
    ];
    for (const link of links) {
      if (!isVisible(link)) continue;
      const text = textOf(link);
      if (patterns.some((p) => p.test(text))) return link;
      const ariaLabel = link.getAttribute('aria-label') || '';
      if (patterns.some((p) => p.test(ariaLabel))) return link;
    }
    return null;
  }

  function clickResubmitLink() {
    const link = findResubmitLink();
    if (!link) return { ok: false, reason: 'No resubmit link found' };
    try { link.scrollIntoView({ block: 'center' }); } catch (e) {}
    // Use native click only (trusted event)
    try { if (typeof link.click === 'function') link.click(); } catch (e) {}
    return { ok: true, href: link.getAttribute('href') || '' };
  }

  // Check if the current page is the Google Forms confirmation page.
  // STRICT detection: only true if there's confirmation text AND no form/question elements.
  function isConfirmationPage() {
    const bodyText = (document.body && document.body.textContent || '').toLowerCase();
    // Only match specific confirmation phrases — NOT generic "your response"
    const hasConfirmationText = /response has been recorded|response was recorded|your submission has been|form was submitted/i.test(bodyText);
    // Check for ANY form/question elements — if any exist, this is NOT a confirmation page
    const hasForm = !!document.querySelector(
      'form, [role="listitem"][data-params], .freebirdFormviewerViewItemsItemItem, ' +
      '[role="radio"], [role="checkbox"], [role="listbox"], ' +
      'input[type="text"], input[type="radio"], input[type="checkbox"], textarea, select'
    );
    const hasResubmitLink = !!findResubmitLink();
    // Confirmation page = has confirmation text AND no form elements
    // OR has a resubmit link with specific text AND no form elements
    return (hasConfirmationText && !hasForm) || (hasResubmitLink && !hasForm);
  }

  function currentSignature() {
    return sectionSignature();
  }

  const FormNavigation = {
    findButtons,
    pickPrimary,
    clickEl,
    sectionSignature,
    waitForChange,
    waitForErrors,
    goNext,
    goSubmit,
    hasSubmitButton,
    hasNextButton,
    findResubmitLink,
    clickResubmitLink,
    isConfirmationPage,
    currentSignature,
    isVisible
  };

  SP.FormNavigation = FormNavigation;
  global.SurveyPilot = SP;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'surveypilot_nav_next') {
        goNext(msg.opts || {}).then((r) => sendResponse(r));
        return true;
      }
      if (msg.type === 'surveypilot_nav_submit') {
        goSubmit(msg.opts || {}).then((r) => sendResponse(r));
        return true;
      }
      if (msg.type === 'surveypilot_nav_buttons') {
        const b = findButtons();
        sendResponse({
          next: b.next.map(textOf),
          prev: b.prev.map(textOf),
          submit: b.submit.map(textOf),
          hasNext: !!pickPrimary(b.next),
          hasSubmit: !!pickPrimary(b.submit)
        });
        return true;
      }
      if (msg.type === 'surveypilot_nav_signature') {
        sendResponse(sectionSignature());
        return true;
      }
      if (msg.type === 'surveypilot_nav_resubmit') {
        sendResponse(clickResubmitLink());
        return true;
      }
      if (msg.type === 'surveypilot_nav_is_confirmation') {
        sendResponse({ isConfirmation: isConfirmationPage(), hasResubmitLink: !!findResubmitLink() });
        return true;
      }
      return false;
    });
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
