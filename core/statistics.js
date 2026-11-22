/* SurveyPilot AI - statistics computed only from real execution records. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  var SP = (root.SP = root.SP || {});
  Object.keys(api).forEach(function (k) { SP[k] = api[k]; });
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  function mean(arr) {
    var v = arr.filter(function (x) { return typeof x === 'number' && isFinite(x); });
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
  }

  var Stats = {
    mean: mean,

    /**
     * run: run object (status, startedAt, endedAt, pausedMs, pauseStartedAt, respondentIds)
     * records: latest execution record per respondent in this run
     * respondents: all stored respondents
     * now: current timestamp (injected so the function stays pure)
     */
    compute: function (input) {
      var run = input.run || null, records = input.records || [], respondents = input.respondents || [];
      var now = input.now == null ? Date.now() : input.now;
      var byStatus = { Pending: 0, Generating: 0, Filling: 0, Validating: 0, Completed: 0, Failed: 0, Paused: 0, Skipped: 0 };
      var latest = {};
      records.forEach(function (r) { latest[r.respondentId] = r; });   // records are expected in chronological order
      var targets = run ? (run.respondentIds || []) : [];
      targets.forEach(function (id) {
        var r = latest[id];
        var st = r ? r.status : 'Pending';
        byStatus[st] = (byStatus[st] || 0) + 1;
      });
      var completedRecs = targets.map(function (id) { return latest[id]; }).filter(function (r) { return r && r.status === 'Completed'; });
      var finished = byStatus.Completed + byStatus.Failed;
      var elapsed = null;
      if (run && run.startedAt) {
        var end = run.endedAt || now;
        var paused = (run.pausedMs || 0) + (run.pauseStartedAt && !run.endedAt ? now - run.pauseStartedAt : 0);
        elapsed = Math.max(0, end - run.startedAt - paused);
      }
      var cur = run && run.currentRespondentId ? latest[run.currentRespondentId] : null;
      var total = cur ? (cur.questionsTotal || 0) : 0, done = cur ? (cur.questionsFilled || 0) : 0;
      var inFlight = byStatus.Generating + byStatus.Filling + byStatus.Validating;
      return {
        totalRespondents: respondents.length,
        generatedRespondents: respondents.length,
        targetRespondents: targets.length,
        completedRuns: byStatus.Completed,
        failedRuns: byStatus.Failed,
        skippedRuns: byStatus.Skipped,
        pendingRuns: byStatus.Pending + byStatus.Paused,
        inFlightRuns: inFlight,
        byStatus: byStatus,
        successRate: finished ? byStatus.Completed / finished : null,
        avgCompletionMs: mean(completedRecs.map(function (r) { return r.durationMs; })),
        elapsedMs: elapsed,
        currentRespondentId: cur ? cur.respondentId : null,
        currentSection: cur ? (cur.currentSection == null ? null : cur.currentSection) : null,
        questionsCompleted: done,
        questionsRemaining: cur ? Math.max(0, total - done) : null,
        progress: targets.length ? (byStatus.Completed + byStatus.Failed + byStatus.Skipped) / targets.length : 0
      };
    },

    /** Averages of the timing fields stored on records (generation, read, per-question, per-section). */
    timings: function (records) {
      var done = (records || []).filter(function (r) { return r.status === 'Completed' || r.status === 'Failed'; });
      var q = [], s = [];
      done.forEach(function (r) {
        (r.questionTimings || []).forEach(function (t) { q.push(t.ms); });
        (r.sectionTimings || []).forEach(function (t) { s.push(t.ms); });
      });
      return {
        avgGenerationMs: mean(done.map(function (r) { return r.generationMs; })),
        avgReadMs: mean(done.map(function (r) { return r.readMs; })),
        avgQuestionFillMs: mean(q),
        avgSectionMs: mean(s),
        avgRespondentMs: mean(done.map(function (r) { return r.durationMs; })),
        samples: { respondents: done.length, questions: q.length, sections: s.length }
      };
    },

    /** Keeps only the latest record per respondent (records chronological). */
    latestPerRespondent: function (records) {
      var map = {};
      (records || []).forEach(function (r) { map[r.respondentId] = r; });
      return Object.keys(map).map(function (k) { return map[k]; });
    }
  };

  return { Stats: Stats };
});
