# SurveyPilot AI — Verified Features & Known Limitations

## Verified features

### Detection & parsing
- Detect Google Forms by URL pattern and DOM signals (multiple selector strategies).
- Detect standard HTML `<form>` elements (picks the form with the most visible inputs).
- Read questions with text, ID, type, options, required flag, section number, validation
  hints, and element references.
- Distinguish currently visible section questions from hidden ones (multi-page forms).
- Diagnostic mode dumps raw question descriptors with element references.
- Clearly reports unsupported forms; never claims detection succeeded when it failed.

### Question types supported
- Short answer, paragraph, multiple choice, checkbox, dropdown, linear scale, rating,
  date, time.

### Synthetic respondent generation
- Configurable count (1–500).
- Demographic filters: age ranges, regions.
- Response variation and consistency level sliders.
- Weighted distributions for age, gender, occupation, student status, region, travel
  behavior, language.
- Seeded PRNG (Mulberry32) for reproducible runs.
- Consistency rules: age ↔ student status, age ↔ occupation (Retired), travel behavior
  ↔ transit question answers.

### Answer generation
- **Local mode**: works fully offline, weighted random with topic-aware text generation
  (names, emails, cities, opinions, dates, times).
- **AI mode (Gemini)**: model selection (1.5 Flash, 1.5 Pro, 2.0 Flash), retries with
  exponential backoff, timeout handling, partial-generation gap-filling with local
  generator, automatic fallback to local mode on quota / auth errors.
- Consistency rule example verified: a `never`-traveler gets `Never` on a bus-frequency
  question.

### Respondent management
- List all generated respondents with badges and metadata.
- Search by any field (id, profile, occupation, etc.).
- Filter by mode and region.
- Multi-select with Select all / Clear.
- Drawer with full profile and inline editable answers (text, textarea, select,
  checkbox, number for linear scale).
- Regenerate profile (preserves id, regenerates answers if a survey is loaded).
- Duplicate respondent (new id, same profile and answers).
- Delete single or multiple respondents.
- All edits persist to IndexedDB immediately.

### Form filling engine
- Identifies the correct element via id → name → locator fallback chain.
- Sets text values using native setters so framework listeners (React, Vue) pick up
  changes.
- Triggers focus → input → change → blur for text; mousedown → mouseup → click for
  radios/checkboxes.
- Verifies the final DOM state: text inputs match value; radios/checkboxes are checked;
  dropdowns have the right option selected.
- Retries failed interactions once after a 200ms delay.
- Records per-question duration.

### Multi-page navigation
- Detects Next / Previous / Submit buttons via multiple selector strategies and text
  matching.
- Snapshots a section signature (visible question texts + URL) before clicking Next.
- Waits up to 8 seconds for the signature to change after click.
- Reports `navigation_timeout` with visible validation errors when blocked.
- Detects `isLastPage` + `submitAvailable` and submits when there is no Next button.
- Refuses to fill the same section repeatedly.

### Execution modes
- **Preview**: generates answers, no DOM interaction.
- **Fill**: fills the active visible section with one respondent, no auto-submit.
- **Test**: full end-to-end execution with navigation and submission.

### Execution controls
- Start, Pause, Resume, Stop, Reset, Retry (per respondent), Skip (per respondent).
- Single-flight run loop guard prevents duplicate concurrent runs.
- Run state persists in IndexedDB; if the side panel closes mid-run, the run is
  marked `paused` and the user can resume explicitly.

### Live dashboard
- 12 real statistics computed from execution records: total respondents, generated,
  completed, failed, pending, skipped, success rate, average completion time, total
  elapsed time, current respondent, current section, questions completed, questions
  remaining.
- Live progress bar (auto-refreshes every 2 seconds while visible).
- Respondent activity table with status pills (pending, generating, filling,
  validating, completed, failed, paused, skipped).
- Per-row Retry / Skip buttons while a run is in progress.

### Timing
- Per-respondent generation time, fill time, total completion time.
- Per-run elapsed time.
- Average completion time across all completed respondents.

### Storage (IndexedDB)
- 6 object stores: surveys, respondents, runs, logs, diagnostics, settings.
- Versioned schema with migration support (current version 2).
- Storage usage display (used / quota / per-store counts).
- Backup (full JSON dump) and restore (merge or replace-all modes).
- Clear individual stores or all data with confirmation.
- Data persists across Chrome restarts and extension reloads.

### Export
- Respondents CSV (one row per respondent, one column per question).
- Respondents JSON (structured with survey metadata).
- Runs CSV (per-run summary).
- Logs CSV (timestamp, action, question, result, error details).
- Full backup JSON.
- **API keys are redacted in every export and log entry.**

### Settings
- Gemini API key (password field with show/hide toggle, test button).
- Model selection.
- Generation mode (local / ai).
- Default respondent count, batch size, retry limit, delay between runs.
- Theme (light / dark) with toggle in header.
- Language selection.
- Data retention days.
- Diagnostic logging toggle.

### Logging
- Every action logged with timestamp, runId, respondentId, action, question, result,
  and error details.
- Filter by action type and free-text search.
- Copy logs to clipboard.
- Export to CSV.
- Clear with confirmation.

### Error handling
- Unsupported form, no questions detected, missing answers, required unanswered,
  invalid answer shape, element not found, navigation timeout, page timeout, Gemini
  quota exhausted, invalid API key, storage errors, tab closed mid-run, tab navigated
  to wrong URL, form changed unexpectedly — all surface actionable messages via toast
  notifications and the Logs tab.

### Safety
- Destination URL must be explicitly confirmed before any test run starts.
- The run loop refuses to operate if the active tab's URL does not match the confirmed
  destination.
- Submissions are only marked successful after the form's own DOM signals a transition.
- All synthetic data is clearly synthetic; no real PII is collected.

### Performance
- Content scripts use cached selector results within a single read.
- Run loop uses a single-flight guard.
- Side panel auto-refreshes the dashboard at most every 2 seconds.
- No background polling when the side panel is closed.

## Known limitations

1. **Google Forms UI churn**: Google periodically changes the class names and DOM
   structure of Google Forms. The reader uses multiple selector strategies and falls
   back to heuristics, but a future Google Forms redesign could break detection. The
   diagnostic mode is the fastest way to identify such breakage.

2. **Linear scale vs. multiple choice**: A horizontal row of radios with sequential
   numeric values is detected as a linear scale; if the form uses text labels for what
   looks like a scale, it will be detected as multiple choice. Both still fill
   correctly.

3. **CAPTCHA-protected forms**: If the destination form requires a CAPTCHA, the
   submission will fail at the CAPTCHA step. The extension captures diagnostics but
   cannot solve CAPTCHAs.

4. **iframe-embedded forms**: The content script does not run in cross-origin iframes
   by default. Forms embedded via cross-origin iframes will not be detected. Open the
   form URL directly in a top-level tab.

5. **File upload questions**: Not supported. A respondent with a file-upload answer
   will skip that question.

6. **Custom question widgets**: Forms using fully custom JavaScript widgets (e.g. star
   rating drawn on canvas) are not supported unless they fall back to a hidden input
   with a standard type.

7. **Concurrency**: The current execution model is single-threaded (one respondent at a
   time per tab). Concurrent runs across multiple tabs are not coordinated.

8. **Gemini model availability**: The model list is hardcoded to known-good models at
   time of writing. Newer Gemini models can be added by editing the
   `GEMINI_MODELS` array in `core/answer-generator.js`.

9. **Screenshots in diagnostics**: The Chrome extension API does not expose
   `chrome.tabs.captureVisibleTab` to content scripts or the side panel without
   additional permissions. Diagnostics therefore record URL, title, navigation
   signature, visible buttons, and error context, but not a pixel screenshot.

10. **Submission confirmation**: The extension considers a submission successful when
    the page's signature changes after clicking Submit. Some forms show a confirmation
    on the same URL (via DOM-only state change); these are detected when the visible
    question set changes. Forms that do not change visible state at all after submit
    may be reported as `navigation_timeout` even though the submission succeeded.

## Features not yet verified in a live browser

The following are implemented in code and covered by automated tests where feasible,
but have not been verified end-to-end in a live Chrome session against a real Google
Form (because that would require submitting fabricated data to a third-party form,
which the extension explicitly prohibits):

- End-to-end test run against a live Google Form (multi-section).
- Gemini 2.0 Flash model (the model is listed but the API may still be in preview).
- Capture of `chrome.tabs.captureVisibleTab` screenshots (the diagnostics module is
  wired but pixel screenshots are not captured — see limitation #9).

To verify these yourself, load the extension, configure your own Google Form, and run
a Test execution.
