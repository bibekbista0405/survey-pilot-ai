# SurveyPilot AI

A Chrome (Manifest V3) extension for **testing your own survey forms** with clearly synthetic respondents. It reads a Google Form or a standard HTML form, generates consistent synthetic respondents (offline locally, or with Gemini), fills the form with read-back verification, and records real per-respondent results in a live dashboard with CSV/JSON export.

> Use it only on surveys you own or are explicitly authorised to test. Test runs that submit data require you to confirm the destination first. All generated identities (names, emails, phones) are synthetic.

## Install

1. Unzip the folder.
2. (Optional, only to run the tests) `npm install` then `npm test` and `npm run check`.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `survey-pilot-ai` folder (the one containing `manifest.json`). Chrome 116+ is required for the Side Panel API.
4. Pin the extension. Clicking the toolbar icon opens the popup; **Open side panel** there opens the main UI.

## Configure (optional, for AI mode)

Open the extension's **Settings** (gear icon). Paste a Gemini API key from Google AI Studio, pick a model (default `gemini-2.5-flash`; the list can be fetched from your key), and use **Test connection**. The key is stored only in `chrome.storage.local`, is never written to logs, exports or backups, and is only sent to `generativelanguage.googleapis.com`. Without a key the extension works in **Local** mode. If AI fails (quota, rate limit, bad key, timeout) it falls back to local generation when *auto fallback* is on, and the run record says which source produced the answers.

## Quick start (Auto tab)

1. Open your survey form in a normal tab, then open the side panel.
2. On the **Auto** tab choose how many responses, tick the "this is my own form" box, press **▶ Start Auto**.
3. It reads the form, generates synthetic respondents, picks answers, fills each section, clicks Next, submits, clicks "Submit another response" (or reloads the form), and repeats. Watch the live dashboard; use Pause / Stop / Skip any time.

## Workflow (manual control)

1. **Survey tab → Scan this form.** Reads the open tab. Shows detected status (supported / partial / unsupported with a reason), question types, required fields and sections. **Diagnostics** shows exactly what was and was not understood and highlights fields on the page.
2. **Respondents tab.** Configure count, age/occupation/gender mix, consistency rules and seed, then generate. AI or Local. Edit, delete or export respondents.
3. **Run tab.**
   - **Preview**: shows the answers that would be entered, no changes to the page.
   - **Fill**: fills the current form for one respondent and verifies every field by reading the DOM back. It **never clicks Submit**.
   - **Test run**: for each respondent fills all sections, navigates, and submits. You must type/confirm the destination before it starts; if the tab is not on that destination the run refuses to continue.
   - Controls: start, pause, resume, stop, skip current, retry failed, reset (deletes run records only).
4. **Dashboard** (Run tab). Totals, per-status counts, durations, and rates are computed only from stored run records. A respondent is **Completed** only when the form itself showed a confirmation; if Submit was clicked but nothing confirmed it, the record is not counted as success.
5. **Export.** CSV (respondents, run records, logs) and JSON backup (no API key, no screenshots). Cells starting with `=`, `+`, `-`, `@` are neutralised against spreadsheet formula injection. Restore from backup supports merge or replace.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "Unsupported" or 0 questions on a Google Form | Wait for the page to finish loading and rescan; make sure you are signed in and the form is open (not the `/formResponse` page). Run **Diagnostics** and export the report. |
| Run stops with `NAV_TIMEOUT` | The Next button was clicked but the section did not change. Usually a required answer was rejected; check the diagnostics snapshot saved on the record. Raise *navigation timeout* in Settings if the site is slow. |
| `VALIDATION_ERROR` | The form rejected an answer (e.g. a format rule). The message text from the page is stored with the record. |
| AI errors | `API_KEY_INVALID` fix the key; `QUOTA_EXHAUSTED`/`RATE_LIMITED` wait or use Local; `MODEL_NOT_FOUND` choose another model. |
| "Background service did not answer" | Reload the extension from `chrome://extensions`. An interrupted run is restored as **paused**. |
| Content script missing on an old tab | The extension injects it on demand; if the page blocks it (e.g. `chrome://`, Web Store) it cannot work there. |

## Project layout

`core/` shared logic (parser, generators, AI client, storage, stats, export) · `content/` page scripts (detect, read, fill, validate, navigate) · `background/` service worker and run engine · `sidepanel/`, `popup/`, `options/` UI · `tests/` automated tests and fixture forms.

## Tests

`npm test` runs 95 tests (core, storage with fake-indexeddb, content scripts in jsdom against local fixture forms, and run-engine integration). `npm run check` validates the manifest, file references and JS syntax. `node tests/ui-smoke.js` (needs Playwright) loads the three UI pages in Chromium with a mocked `chrome.*` API. See `TESTING.md` for what is and is not verified.
