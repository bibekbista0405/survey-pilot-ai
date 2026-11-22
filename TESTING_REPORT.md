# SurveyPilot AI — Testing Report

## Test execution

Tests run via `node tests/run-all.js` after `npm install`.

```
Running core module tests...
  Survey parser:
  Respondent generator:
  Answer generator (local):
  Statistics:
  Export:
  Storage:

Core tests: 52 passed, 0 failed.

Running DOM (content script) tests...
  Form detection:
  Form reading:
  Form filling:
  Validation:
  Navigation:
  Error recovery:
  Diagnostic mode:
  Single-section form:

DOM tests: 55 passed, 0 failed.

=================
OVERALL: PASS
=================
```

**Total: 107 tests passed, 0 failed.**

## Coverage

### Core module tests (`tests/core.test.js`, 52 assertions)

- **Survey parser** — question type constants, compatibility computation, survey
  fingerprinting, `validateAnswerShape` for short_answer, multiple_choice, checkbox
  (with min/max bounds), dropdown, date, time (including rejection of invalid time
  `25:99`).
- **Respondent generator** — count, ids, profiles, generation mode tag, seed
  reproducibility (same seed → same ages), seed variation (different seeds → different
  profiles), consistency rules (respondents under 22 are mostly students; respondents
  65+ are rarely students).
- **Answer generator (local)** — answer count covers all questions, all answers have
  values, travel-behavior consistency (a `never`-traveler picks `Never` on a bus
  question; a `daily`-traveler tends toward `Daily`), date format `YYYY-MM-DD`.
- **Statistics** — `computeFromRuns` correctness for completed / failed / skipped /
  pending / generating / filling / validating statuses, average completion time,
  questionsCompleted/questionsRemaining aggregation, formatDuration formatting.
- **Export** — `toCsv` header correctness, comma escaping, `jsonDump` redacts
  `apiKey` field, `respondentsToCsv` produces a header row.
- **Storage** — `setSetting`/`getSetting` round-trip, `put`/`get`/`getAll`/`del`
  on respondents store, with an in-memory IndexedDB shim that honors the `keyPath`
  of each store.

### DOM / content-script tests (`tests/dom.test.js`, 55 assertions)

Loaded against `tests/test-form-multi-section.html` (3-section HTML form with text,
email, radio, checkbox, date, time, linear scale, dropdown, paragraph) and
`tests/test-form-single-section.html`.

- **Form detection** — multi-section form detected as `html_form`; single-section
  form detected.
- **Form reading** — sections parsed, questions per section detected, required flags
  (`name` and `age` required), question types (`short_answer`, `multiple_choice`,
  `checkbox`, `date`, `time`, `linear_scale`/`rating`, `dropdown`, `paragraph`),
  options arrays (`['18-24','25-34','35-44','45-54','55+']`).
- **Visible vs hidden section detection** — only the currently active section is
  returned by `readVisibleSection`; switching the active class changes which section
  is visible.
- **Form filling** — `fillQuestion` on text input (DOM state verified), radio
  (`input[name="age"]:checked` matches), checkbox (`['Bus','Walking']` after sort),
  date, time, dropdown, paragraph. Each fill verifies the DOM state and reports
  `verified: true`.
- **Validation** — `validateSection` accepts a section with all required filled,
  rejects when required is missing, `missing` list contains the right question text;
  `verifyQuestion` confirms DOM state on a filled question.
- **Navigation** — `sectionSignature` changes when sections are toggled; next/submit
  buttons are detected on the right sections.
- **Error recovery** — `fillQuestion` on a question with no `elementRefs` returns
  `{ ok: false }` rather than throwing.
- **Diagnostic mode** — `diagnostic()` returns sections with `elementRefs` populated.
- **Single-section form** — detected and read; at least 3 questions parsed.

## Manual verification (browser)

The following were verified by loading the unpacked extension in Chrome and using
the local test forms in `tests/test-form-multi-section.html` and
`tests/test-form-single-section.html`:

- Side panel opens via toolbar click.
- Detect → Read form produces correct question count and types on the test forms.
- Generate 10 local respondents → all have unique profiles.
- Generate answers for current survey → all required questions have answers.
- Fill mode fills the active section without submitting.
- Test mode runs end-to-end on the multi-section form, navigates through all 3
  sections, submits, and the dashboard reports success.
- Pause / Resume / Stop affect the live run.
- Respondent drawer edits persist after closing.
- CSV and JSON exports download correctly.
- Clear-all wipes IndexedDB.
- Theme toggle persists between sessions.

## Quota-failure fallback

Verified by configuring an invalid Gemini API key, setting mode to AI, and generating
answers. The extension returns answers in `local` mode with `fallbackReason:
'invalid_key'` and an entry in `respondent.errors`. No crash, no silent success.

## Reload test

After clicking Reload on the extension card in `chrome://extensions`:
- IndexedDB data (respondents, runs, logs) persists.
- Settings (API key, theme, defaults) persist.
- An in-progress run is marked as `paused` on reload so the user can resume
  explicitly (no silent auto-resume).

## Console errors

No console errors are produced by the extension's own scripts during normal operation
on the test forms. The only expected warnings are Chrome's standard messages about
`chrome.runtime.sendMessage` recipients being unavailable when no side panel is open
(these are caught and ignored).
