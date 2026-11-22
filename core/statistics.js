/*
 * SurveyPilot AI - Statistics
 * Computes real run statistics from execution records. Never fabricates numbers.
 */
(function (global) {
  'use strict';

  function emptyStats() {
    return {
      totalRespondents: 0,
      generatedRespondents: 0,
      completedRuns: 0,
      failedRuns: 0,
      pendingRuns: 0,
      skippedRuns: 0,
      successRate: 0,
      averageCompletionMs: 0,
      totalElapsedMs: 0,
      currentRespondentId: null,
      currentSection: null,
      questionsCompleted: 0,
      questionsRemaining: 0
    };
  }

  // Compute statistics from a list of run records (each run has executionItems
  // describing per-respondent outcomes).
  function computeFromRuns(runs) {
    const stats = emptyStats();
    if (!runs || !runs.length) return stats;

    let totalRespondents = 0;
    let completed = 0;
    let failed = 0;
    let pending = 0;
    let skipped = 0;
    let generated = 0;
    let completionMsSum = 0;
    let completionMsCount = 0;
    let totalElapsedMs = 0;
    let qCompleted = 0;
    let qRemaining = 0;
    let currentRespondentId = null;
    let currentSection = null;

    for (const run of runs) {
      const items = run.executionItems || [];
      totalRespondents += items.length;
      for (const item of items) {
        switch (item.status) {
          case 'completed': completed++; generated++; if (item.durationMs) { completionMsSum += item.durationMs; completionMsCount++; } qCompleted += item.questionsCompleted || 0; break;
          case 'failed': failed++; generated++; qCompleted += item.questionsCompleted || 0; break;
          case 'skipped': skipped++; break;
          case 'pending': pending++; qRemaining += (item.questionsRemaining || 0); break;
          case 'generating':
          case 'filling':
          case 'validating':
            generated++;
            currentRespondentId = item.respondentId;
            currentSection = item.currentSection || null;
            qCompleted += item.questionsCompleted || 0;
            qRemaining += (item.questionsRemaining || 0);
            break;
        }
        if (item.totalQuestions) {
          // totalRespondents-derived totals already accounted for above
        }
      }
      if (run.startedAt) {
        const end = run.endedAt || run.lastActivityAt || Date.now();
        totalElapsedMs += (end - run.startedAt);
      }
    }

    const successRate = (completed + failed + skipped) > 0 ? completed / (completed + failed + skipped) : 0;
    stats.totalRespondents = totalRespondents;
    stats.generatedRespondents = generated;
    stats.completedRuns = completed;
    stats.failedRuns = failed;
    stats.pendingRuns = pending;
    stats.skippedRuns = skipped;
    stats.successRate = successRate;
    stats.averageCompletionMs = completionMsCount ? Math.round(completionMsSum / completionMsCount) : 0;
    stats.totalElapsedMs = totalElapsedMs;
    stats.currentRespondentId = currentRespondentId;
    stats.currentSection = currentSection;
    stats.questionsCompleted = qCompleted;
    stats.questionsRemaining = qRemaining;
    return stats;
  }

  // Compute statistics for a single run
  function computeForRun(run) {
    if (!run) return emptyStats();
    return computeFromRuns([run]);
  }

  function formatDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + 'ms';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    const m = Math.floor(s / 60);
    const rs = Math.round(s - m * 60);
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    const rm = m - h * 60;
    return `${h}h ${rm}m`;
  }

  function formatPercent(p) {
    if (p == null || isNaN(p)) return '—';
    return (p * 100).toFixed(1) + '%';
  }

  const Statistics = {
    emptyStats,
    computeFromRuns,
    computeForRun,
    formatDuration,
    formatPercent
  };

  global.SurveyPilot = global.SurveyPilot || {};
  global.SurveyPilot.Statistics = Statistics;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
