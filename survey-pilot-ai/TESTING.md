# Testing report

Executed in a Linux container with Node (not on a real Chrome profile).

## Executed and passing
- `npm test`: 95/95 pass (core 31, storage 11, content 38, engine 15).
- `npm run check`: manifest valid, all referenced files exist, every JS file parses, no TODO markers.
- `node tests/ui-smoke.js`: side panel, popup and options pages load in Chromium with a mocked `chrome` API without script errors and render text.

## Verified by those tests
Local respondent generation and consistency rules; answer generation with AI->local fallback (mocked HTTP, key never leaked); IndexedDB open/migrate/CRUD/backup/restore; form detection and reading on local HTML fixtures (single and multi-page, ARIA widgets, hidden fields, required markers); filling with DOM read-back and retry; Next-click timeout and validation error detection; confirmation detection; run engine: full run, destination guard, mismatch, concurrent-run refusal, navigation away, stuck Next with diagnostics, retry, pause/resume (paused time excluded), skip, stop, reset, restore after service-worker restart, Fill mode never submits; statistics computed only from records; CSV injection neutralisation.

## NOT verified (needs your manual check in Chrome)
- Real Google Forms DOM. `tests/forms/google-like.html` is a hand-written approximation, not Google's markup, which changes over time.
- Real Gemini API calls (only mocked responses were tested). Model names and response shape may need adjustment.
- Side Panel opening, tab events, service-worker suspension/wake-up, on-demand script injection, and screenshot capture in a real Chrome.
- Interactive UI behaviour beyond initial render (button flows, dashboard updates during a real run). UI pages were only load-tested with a mock backend.
- Real submissions and confirmation pages on live sites; CAPTCHAs, login walls and file-upload questions are unsupported.

## Known limitations
- Unsupported field types are flagged, not filled (file upload, grid/matrix variants not recognised by the reader, CAPTCHA).
- Layout-based visibility checks are skipped in jsdom; real browsers use layout.
- Custom widgets are handled heuristically and may fail on unusual designs; use Diagnostics to see why.

## Added in v1.0.1
- Popup now calls `chrome.sidePanel.open()` directly in the click handler (required user gesture). Not verified in real Chrome.
- API key field accepts pasted keys with quotes/whitespace/`key=` prefixes; only requires one unbroken string of 20+ characters.
- Between respondents the engine clicks "Submit another response" after a confirmed submission, and falls back to loading the destination if the form does not come back (jsdom-tested only; real Google behaviour unverified).

## Added in v1.1.0 (Auto tab)
- New **Auto** tab: one button scans, generates, and runs.
- `node tests/e2e-chromium.js` and `node tests/e2e-auto-ui.js` (need Playwright) load the real unpacked extension in Chromium, serve the 3-section fixture locally, run the real service worker, and check the server received every submission. Both passed (3/3 and 2/2 submissions, no panel errors). This is the first real-Chrome evidence, but only against the local fixture; the Chrome Side Panel itself (opened as a normal tab here) and real Google Forms remain unverified.

## Added in v1.2.0
- Intro/welcome pages with no questions (only a Next button) are detected as supported and the runner clicks Next (jsdom + real Chromium via `FIXTURE=intro.html node tests/e2e-auto-ui.js`: 2/2 submitted).
- Every question is answered by default, optional ones included (tests: 98/98 pass). Blank answers only happen if skipping is explicitly enabled in code.
- Still unverified: the real Google Forms DOM. The intro-page detection relies on finding Google's Next control (a `role=button` element labelled "Next"); if your form still shows "Unsupported", run Diagnostics and send me the output.
