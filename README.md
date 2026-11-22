# SurveyPilot AI

A simple, fully-automated Chrome extension (Manifest V3) for authorized survey testing
with synthetic respondents.

Open the side panel on any Google Form or HTML survey → pick how many respondents →
click **Start Automation**. The extension does the rest: detects the form, generates
unique synthetic respondents, fills every section, validates answers, navigates
multi-page forms, and submits — all automatically.

> **Intended use:** authorized testing of your own survey forms, duplicate / staging
> copies of surveys, training, and QA. Do not use this tool to submit fabricated data
> to surveys you do not own or have explicit permission to test.

---

## Install

### 1. Load the extension

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `survey-pilot-ai/` folder (the one with `manifest.json`)

### 2. (Optional) Run tests

The extension itself has no runtime dependencies. Tests use Node + jsdom:

```bash
cd survey-pilot-ai
npm install
npm test
```

## How to use (3 steps)

1. **Open** a Google Form or HTML survey in a Chrome tab
2. **Click** the SurveyPilot AI toolbar icon → the side panel opens and **auto-detects** the form
3. **Pick** how many respondents (1 / 5 / 10 / 20 / 50 / Custom) → click **Start Automation**

That's it. A confirmation dialog shows the destination URL — click **Confirm & Start**
and watch the progress screen fill itself section by section and submit.

## The three screens

### Home
- Form status card: "Survey ready" or "Open a supported survey"
- Survey name, question count, section count
- Respondent count pills (1 / 5 / 10 / 20 / 50 / Custom)
- Big **Start Automation** button
- Settings icon (top-right) and History icon

### Progress (during automation)
- "Automation running" with pulsing dot
- "Respondent X of Y" counter
- Progress bar + percentage
- Current action: "Filling questions…" / "Checking answers…" / "Moving to next section…" / "Submitting…"
- Live stats: Successful / Failed / Remaining
- Elapsed time + Average completion time
- Three controls: **Pause / Resume / Stop**
- Expandable **Details** panel for the live log

### Report (when automation completes)
- "Automation completed"
- Processed / Successful / Failed counts
- Total time + Average time per respondent
- **Export CSV** and **Run Again** buttons

## Settings (gear icon)

Only four things:
- **Gemini API key** (optional — leave empty for offline mode)
- **Mode**: Automatic (AI when key is set, else local) / AI only / Local only
- **Default respondent count**
- **Theme**: Light / Dark

The extension ships in **Automatic** mode — no API key needed. It works fully offline
out of the box.

## How it works under the hood

- **Auto-detect**: when the side panel opens (or you switch tabs), the extension scans
  the active tab for a Google Form or HTML form and reads its questions, types,
  options, required flags, and sections automatically.
- **Synthetic respondents**: each respondent gets a unique, internally-consistent
  profile (age, gender, occupation, region, travel behavior, language). Consistency
  rules ensure e.g. a 19-year-old is likely a student, and a "never"-traveler picks
  "Never" on a bus-frequency question.
- **Answer generation**: in Automatic mode, uses Gemini if an API key is set, else
  falls back to local weighted-random generation. On quota errors, automatically
  switches to local mode for the rest of the run.
- **Form filling**: sets text values via native setters (so React/Vue pick up
  changes), triggers full event sequences (focus → input → change → blur, mousedown
  → mouseup → click), and **verifies the DOM state** before marking an answer filled.
- **Multi-section navigation**: snapshots a section signature, clicks Next, waits up
  to 8 seconds for the signature to change, detects the new section, continues. On
  the final page, clicks Submit.
- **Safety**: requires destination confirmation before the first run; refuses to
  operate if the active tab's URL doesn't match the confirmed destination; never
  claims success until the form's DOM signals a transition.

## Architecture

```
manifest.json
├── background/service-worker.js   Owns run state, coordinates content scripts
├── content/                        Runs in the active tab's DOM
│   ├── form-detector.js            Detects Google Forms / HTML forms
│   ├── form-reader.js              Parses questions, types, options, sections
│   ├── form-filler.js              Fills inputs, radios, checkboxes, dropdowns
│   ├── form-navigation.js          Next/Previous/Submit detection + transitions
│   └── validation.js               Verifies DOM state matches expected answers
├── sidepanel/                      Simple 3-screen UI (Home → Progress → Report)
├── popup/                          Small "Open Side Panel" launcher
├── options/                        Minimal settings page
├── core/                           Shared modules
│   ├── storage.js                  IndexedDB wrapper
│   ├── survey-parser.js            Data shape + validation
│   ├── respondent-generator.js     Weighted synthetic profile generation
│   ├── answer-generator.js         Local + AI answer generation
│   ├── statistics.js               Real run statistics
│   └── export.js                   CSV export (API keys redacted)
├── assets/                         PNG icons
└── tests/                          107 automated tests + local test forms
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Open a supported survey" | Open a Google Form or HTML form in the active tab, then reopen the side panel. |
| Start button disabled | No form detected. Open a survey first. |
| Some respondents failed | Open the Details panel on the progress screen to see what went wrong. Use History to review past runs. |
| Want AI answers | Click the gear icon, paste a Gemini API key, save. |
| Want to stop mid-run | Click Stop. The current respondent is safely handled; the rest are not processed. |
| Want to run again | On the report screen, click "Run Again". Or click History to review past runs. |

## License

MIT — see [LICENSE](LICENSE).
