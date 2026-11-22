/*
 * SurveyPilot AI - Automated Tests
 *
 * Two test runners:
 *   - tests/core.test.js         : pure-JS tests of core modules (no DOM).
 *   - tests/dom.test.js          : tests of content scripts using jsdom.
 *
 * Run with:  npm test   (or:  node tests/run-all.js)
 *
 * The tests cover question detection (via jsdom), question parsing, required-question
 * detection, answer matching, synthetic profile generation, conditional answer
 * consistency, radio/checkbox/dropdown/text interaction (via jsdom), validation,
 * section navigation, error recovery, storage persistence (in-memory shim),
 * export functionality, and statistics calculations.
 */
