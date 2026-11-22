/* SurveyPilot AI - Gemini client with typed errors, retries, exponential backoff and batching.
   The API key is sent in the x-goog-api-key header (never in the URL) and is redacted from every error message. */
(function (root, factory) {
  var dep = (typeof require === 'function' && typeof module === 'object') ? require('./util.js') : root.SP;
  var api = factory(dep.Util);
  if (typeof module === 'object' && module.exports) module.exports = api;
  var SP = (root.SP = root.SP || {});
  Object.keys(api).forEach(function (k) { SP[k] = api[k]; });
})(typeof globalThis !== 'undefined' ? globalThis : self, function (Util) {
  'use strict';

  var BASE = 'https://generativelanguage.googleapis.com/v1beta';
  // Fallback list used when the live model list cannot be fetched. Users can also type any model id.
  var DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.0-flash'];

  function AIError(code, message, extra) {
    var e = new Error(message);
    e.name = 'AIError'; e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  function parseRetryDelay(body, headers) {
    var ra = headers && headers.get && headers.get('retry-after');
    if (ra && !isNaN(parseFloat(ra))) return parseFloat(ra) * 1000;
    try {
      var details = body && body.error && body.error.details || [];
      for (var i = 0; i < details.length; i++) {
        var d = details[i].retryDelay; // e.g. "28s"
        if (d && /^[\d.]+s$/.test(d)) return parseFloat(d) * 1000;
      }
    } catch (e) { /* malformed details: ignore and use default backoff */ }
    return null;
  }

  /** Maps an HTTP status/body to a typed AIError. */
  function classify(status, body, headers, apiKey) {
    var msg = Util.redact((body && body.error && body.error.message) || ('HTTP ' + status), [apiKey]);
    var st = body && body.error && body.error.status || '';
    var lower = (msg + ' ' + st).toLowerCase();
    if (status === 400 && /api key not valid|api_key_invalid|invalid api key/.test(lower)) return AIError('API_KEY_INVALID', 'The Gemini API key is not valid. Check it in Settings.', { status: status });
    if (status === 401 || status === 403) {
      if (/api key|permission|unauthenticated|forbidden|denied/.test(lower)) return AIError('API_KEY_INVALID', 'The Gemini API key was rejected (' + status + '). Check the key and that the Generative Language API is enabled.', { status: status });
    }
    if (status === 429) {
      var daily = /per ?day|daily|quota exceeded|exceeded your current quota|limit: 0|billing/.test(lower);
      var retryMs = parseRetryDelay(body, headers);
      if (daily && !(retryMs && retryMs <= 60000 && /per ?minute/.test(lower))) {
        return AIError('QUOTA_EXHAUSTED', 'Gemini quota is exhausted for this key/model. Switch to Local mode or try later.', { status: status, retryMs: retryMs });
      }
      return AIError('RATE_LIMITED', 'Gemini rate limit reached: ' + msg, { status: status, retryMs: retryMs });
    }
    if (status === 404) return AIError('MODEL_NOT_FOUND', 'Model not found or not available to this key. Pick another model in Settings.', { status: status });
    if (status >= 500) return AIError('SERVER', 'Gemini server error (' + status + '): ' + msg, { status: status });
    return AIError('BAD_REQUEST', 'Gemini rejected the request (' + status + '): ' + msg, { status: status });
  }

  function buildPrompt(profile, questions, language) {
    var slim = {
      age: profile.age, gender: profile.gender, occupation: profile.occupation, student: profile.isStudent,
      education: profile.education, income: profile.incomeBand, area: profile.regionLabel,
      usesBus: profile.travel.usesBus, busFrequency: profile.travel.busFrequency, usesCar: profile.travel.usesCar,
      usesBike: profile.travel.usesBike, mainTravelMode: profile.travel.mainMode,
      tripsPerWeek: profile.travel.tripsPerWeek, name: profile.name, email: profile.email, phone: profile.phone
    };
    var qs = questions.map(function (q) {
      return { key: q.key, question: q.text, type: q.type, required: !!q.required, options: q.options && q.options.length ? q.options : undefined };
    });
    return [
      'You generate SYNTHETIC survey answers for software testing. The respondent below is fictional.',
      'Answer every question as this respondent would, staying strictly consistent with the profile',
      '(e.g. someone who does not use the bus must not report bus travel; age, occupation and student status must agree).',
      'Rules:',
      '- For multiple_choice, dropdown, linear_scale and rating: answer with EXACTLY one of the listed options (copy the text).',
      '- For checkbox: answer with an array containing exact option texts.',
      '- For short_answer / paragraph: write a natural answer in language "' + (language || 'en') + '" (short_answer under 8 words).',
      '- For date use YYYY-MM-DD; for time use HH:MM (24h).',
      '- Optional questions (required=false) may be null.',
      'Return ONLY a JSON object mapping each question key to its answer.',
      '',
      'PROFILE: ' + JSON.stringify(slim),
      'QUESTIONS: ' + JSON.stringify(qs)
    ].join('\n');
  }

  function extractJson(text) {
    var t = String(text || '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(t); } catch (e) { /* try to locate an object below */ }
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) { /* fall through */ } }
    throw AIError('BAD_RESPONSE', 'Gemini returned text that is not valid JSON.');
  }

  var AI = {
    DEFAULT_MODELS: DEFAULT_MODELS,
    classify: classify,
    buildPrompt: buildPrompt,
    extractJson: extractJson,

    /** Lists models that support generateContent. Throws typed AIError. */
    listModels: function (apiKey, opts) {
      opts = opts || {};
      if (!apiKey) return Promise.reject(AIError('API_KEY_MISSING', 'No Gemini API key set.'));
      var f = opts.fetchImpl || fetch;
      return f(BASE + '/models?pageSize=100', { headers: { 'x-goog-api-key': apiKey } }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) throw classify(res.status, body, res.headers, apiKey);
          return (body.models || []).filter(function (m) {
            return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0 && /gemini/i.test(m.name);
          }).map(function (m) { return m.name.replace(/^models\//, ''); });
        });
      }, function (err) {
        throw AIError('NETWORK', 'Network error while contacting Gemini: ' + Util.redact(err.message, [apiKey]));
      });
    },

    /** One request with timeout. Resolves parsed JSON answers. */
    requestOnce: function (apiKey, model, prompt, timeoutMs, fetchImpl) {
      var f = fetchImpl || fetch;
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = null, timedOut = false;
      var p = new Promise(function (resolve, reject) {
        if (ctrl) timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, timeoutMs);
        f(BASE + '/models/' + encodeURIComponent(model) + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 1.0, responseMimeType: 'application/json' }
          }),
          signal: ctrl ? ctrl.signal : undefined
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (!res.ok) return reject(classify(res.status, body, res.headers, apiKey));
            var cand = body.candidates && body.candidates[0];
            var parts = cand && cand.content && cand.content.parts;
            var text = parts && parts.map(function (x) { return x.text || ''; }).join('');
            if (!text) {
              var why = (body.promptFeedback && body.promptFeedback.blockReason) || (cand && cand.finishReason) || 'empty';
              return reject(AIError('BAD_RESPONSE', 'Gemini returned no usable content (' + why + ').'));
            }
            try { resolve(extractJson(text)); } catch (e) { reject(e); }
          });
        }).catch(function (err) {
          if (err && err.name === 'AIError') return reject(err);
          if (timedOut || (err && err.name === 'AbortError')) return reject(AIError('TIMEOUT', 'Gemini did not answer within ' + Math.round(timeoutMs / 1000) + ' s.'));
          reject(AIError('NETWORK', 'Network error while contacting Gemini: ' + Util.redact(err && err.message, [apiKey])));
        });
      });
      return p.then(function (v) { if (timer) clearTimeout(timer); return v; }, function (e) { if (timer) clearTimeout(timer); throw e; });
    },

    /**
     * Generates answers for the questions in batches. Retries transient errors with exponential backoff.
     * Non-retryable errors (invalid key, quota exhausted) abort immediately. A failure after some batches succeeded
     * returns partial answers plus `errors`; a failure of the first batch throws.
     */
    generateAnswers: function (o) {
      var apiKey = o.apiKey, model = o.model || DEFAULT_MODELS[0];
      if (!apiKey) return Promise.reject(AIError('API_KEY_MISSING', 'No Gemini API key set. Add one in Settings or use Local mode.'));
      var maxRetries = o.maxRetries == null ? 3 : o.maxRetries;
      var timeoutMs = o.timeoutMs || 30000;
      var sleep = o.sleepImpl || Util.sleep;
      var batchSize = o.batchSize || 25;
      var batches = [];
      for (var i = 0; i < o.questions.length; i += batchSize) batches.push(o.questions.slice(i, i + batchSize));
      var answers = {}, errors = [];

      function runBatch(batch) {
        var prompt = buildPrompt(o.profile, batch, o.language);
        function attempt(n) {
          return AI.requestOnce(apiKey, model, prompt, timeoutMs, o.fetchImpl).catch(function (err) {
            var retryable = err.code === 'RATE_LIMITED' || err.code === 'SERVER' || err.code === 'TIMEOUT' || err.code === 'NETWORK' || err.code === 'BAD_RESPONSE';
            if (!retryable || n >= maxRetries) throw err;
            var base = Math.min(30000, 1000 * Math.pow(2, n));
            var wait = err.retryMs ? Math.min(60000, err.retryMs) : base + Math.floor(Math.random() * 250);
            err.attempt = n + 1;
            return sleep(wait).then(function () { return attempt(n + 1); });
          });
        }
        return attempt(0);
      }

      var chain = Promise.resolve(), firstFailure = null;
      batches.forEach(function (batch, bi) {
        chain = chain.then(function () {
          if (firstFailure) return null;
          return runBatch(batch).then(function (obj) {
            batch.forEach(function (q) { if (obj && q.key in obj) answers[q.key] = obj[q.key]; });
          }, function (err) {
            // Fatal errors apply to every later batch, so stop early.
            var fatal = err.code === 'API_KEY_INVALID' || err.code === 'QUOTA_EXHAUSTED' || err.code === 'API_KEY_MISSING' || err.code === 'MODEL_NOT_FOUND';
            if (bi === 0 && Object.keys(answers).length === 0) throw err;
            errors.push({ code: err.code, message: err.message, batch: bi });
            if (fatal) firstFailure = err;
          });
        });
      });
      return chain.then(function () {
        return { answers: answers, errors: errors, partial: errors.length > 0, model: model };
      });
    }
  };

  return { AI: AI, AIError: AIError };
});
