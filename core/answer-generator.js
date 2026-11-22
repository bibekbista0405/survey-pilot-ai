/*
 * SurveyPilot AI - Answer Generator
 * Produces synthetic answers for a survey's questions, given a respondent profile.
 * Two modes:
 *   - local: deterministic-ish weighted random answers with consistency rules.
 *   - ai:    uses Gemini API with retries, backoff, partial generation, and falls back
 *            to local mode on quota / auth errors.
 */
(function (global) {
  'use strict';

  const SP = global.SurveyPilot || {};
  const Parser = SP.SurveyParser || {};
  const QTYPE = Parser.QUESTION_TYPES || {};
  const Storage = SP.Storage;

  // -------- Local answer generation --------

  const NAME_POOL = ['Alex','Jordan','Sam','Taylor','Morgan','Casey','Riley','Jamie','Avery','Quinn','Drew','Reese','Skylar','Cameron','Rowan'];
  const SENTENCE_BANK = [
    'I think the experience was generally positive and straightforward.',
    'There were a few confusing parts but overall it worked well.',
    'I would prefer a clearer layout and faster navigation.',
    'The process felt smooth and the instructions were helpful.',
    'Some steps took longer than expected but the result was good.',
    'I appreciated the simplicity of the form and the clear wording.',
    'A few questions seemed repetitive and could be combined.',
    'The design felt modern and easy to follow.',
    'I had to double-check a couple of answers before continuing.',
    'It would help to save progress and return later.'
  ];
  const OPINION_BANK = [
    'Very satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very dissatisfied',
    'Strongly agree', 'Agree', 'Neither agree nor disagree', 'Disagree', 'Strongly disagree',
    'Excellent', 'Good', 'Fair', 'Poor'
  ];

  function pick(arr, rng) {
    return arr[Math.floor((rng ? rng() : Math.random()) * arr.length)];
  }

  function pickInt(min, max, rng) {
    return Math.floor((rng ? rng() : Math.random()) * (max - min + 1)) + min;
  }

  function pickBool(p, rng) {
    return (rng ? rng() : Math.random()) < p;
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor((rng ? rng() : Math.random()) * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Topic-based text generation: detect question keywords and produce relevant text
  function generateTextAnswer(question, profile, rng, opts) {
    const variation = (opts && opts.responseVariation) != null ? opts.responseVariation : 0.7;
    const q = (question.text || '').toLowerCase();
    const maxLen = question.maxLength || (question.type === QTYPE.PARAGRAPH ? 280 : 80);

    let text;
    if (/name/.test(q)) {
      text = pick(NAME_POOL, rng);
    } else if (/email/.test(q)) {
      text = ('respondent' + pickInt(100, 999, rng) + '@example.com');
    } else if (/phone/.test(q)) {
      text = '+1' + pickInt(200, 999, rng).toString() + pickInt(2000000, 9999999, rng).toString();
    } else if (/city|location|where/.test(q)) {
      text = profile.region === 'Urban' ? 'New York' : profile.region === 'Suburban' ? 'Austin' : 'Springfield';
    } else if (/age/.test(q)) {
      text = String(profile.age);
    } else if (/occupation|job|profession/.test(q)) {
      text = profile.occupation;
    } else if (/feedback|comment|opinion|suggest|improve/.test(q)) {
      text = pick(SENTENCE_BANK, rng);
      if (pickBool(variation * 0.4, rng)) {
        text += ' ' + pick(SENTENCE_BANK, rng);
      }
    } else if (/why|reason/.test(q)) {
      text = 'Because ' + pick(SENTENCE_BANK, rng).replace(/\.$/, '').toLowerCase() + '.';
    } else if (/often|frequency|frequent/.test(q)) {
      text = profile.travelBehavior;
    } else {
      text = pick(SENTENCE_BANK, rng);
    }

    if (text.length > maxLen) text = text.slice(0, maxLen);
    return text;
  }

  function generateChoiceAnswer(question, profile, rng, opts) {
    const options = question.options || [];
    if (!options.length) return null;
    const variation = (opts && opts.responseVariation) != null ? opts.responseVariation : 0.7;

    // Apply consistency: if a question's text or options relate to travel, respect profile.travelBehavior
    const q = (question.text || '').toLowerCase();
    const optLabels = options.map((o) => String(o).toLowerCase());

    if (/bus|transit|travel|commut/.test(q) && profile.travelBehavior === 'never') {
      const neverOpt = optLabels.findIndex((o) => /never|none/.test(o));
      if (neverOpt >= 0) return options[neverOpt];
    }
    if (/bus|transit|travel|commut/.test(q) && profile.travelBehavior === 'daily') {
      const dailyOpt = optLabels.findIndex((o) => /daily|every day|always/.test(o));
      if (dailyOpt >= 0 && pickBool(opts.consistencyLevel || 0.9, rng)) return options[dailyOpt];
    }

    // Weighted random with variation: with prob (1 - variation), pick the first option (common default),
    // otherwise uniform random
    if (pickBool(1 - variation * 0.6, rng)) {
      return options[pickInt(0, Math.min(2, options.length - 1), rng)];
    }
    return options[pickInt(0, options.length - 1, rng)];
  }

  function generateCheckboxAnswer(question, profile, rng, opts) {
    const options = question.options || [];
    if (!options.length) return [];
    const min = question.minChoices || 1;
    const max = question.maxChoices || Math.min(options.length, 5);
    const target = pickInt(Math.min(min, options.length), Math.min(max, options.length), rng);
    const shuffled = shuffle(options, rng);
    return shuffled.slice(0, target);
  }

  function generateLinearScaleAnswer(question, profile, rng) {
    const min = question.minValue != null ? question.minValue : 1;
    const max = question.maxValue != null ? question.maxValue : 5;
    // Bias towards middle-high
    const v = pickInt(min, max, rng);
    return v;
  }

  function generateRatingAnswer(question, profile, rng) {
    const max = question.maxValue || 5;
    const v = pickInt(1, max, rng);
    return v;
  }

  function generateDateAnswer(question, rng) {
    const now = new Date();
    const offset = pickInt(-180, 30, rng); // past 6 months mostly
    const d = new Date(now.getTime() + offset * 24 * 3600 * 1000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function generateTimeAnswer(question, rng) {
    const h = pickInt(7, 21, rng);
    const m = pick([0, 15, 30, 45], rng);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function localAnswerFor(question, profile, rng, opts) {
    switch (question.type) {
      case QTYPE.SHORT_ANSWER: return generateTextAnswer(question, profile, rng, opts);
      case QTYPE.PARAGRAPH: return generateTextAnswer(question, profile, rng, opts);
      case QTYPE.MULTIPLE_CHOICE: return generateChoiceAnswer(question, profile, rng, opts);
      case QTYPE.DROPDOWN: return generateChoiceAnswer(question, profile, rng, opts);
      case QTYPE.CHECKBOX: return generateCheckboxAnswer(question, profile, rng, opts);
      case QTYPE.LINEAR_SCALE: return generateLinearScaleAnswer(question, profile, rng);
      case QTYPE.RATING: return generateRatingAnswer(question, profile, rng);
      case QTYPE.DATE: return generateDateAnswer(question, rng);
      case QTYPE.TIME: return generateTimeAnswer(question, rng);
      default: return null;
    }
  }

  // Generate a complete answer set for one respondent against one survey
  async function generateAnswersLocal(survey, respondent, opts) {
    opts = opts || {};
    const rng = SP.RespondentGenerator.makeRng(opts.seed);
    const questions = (survey.sections || []).flatMap((s, i) => (s.questions || []).map((q) => ({ ...q, sectionIndex: i })));
    const answers = {};
    const t0 = Date.now();
    for (const q of questions) {
      const value = localAnswerFor(q, respondent.profile, rng, opts);
      const check = Parser.validateAnswerShape(q, { value });
      // If the local generator produced something invalid for the shape, retry once
      let finalValue = value;
      if (!check.ok && q.type !== QTYPE.UNKNOWN) {
        finalValue = localAnswerFor(q, respondent.profile, rng, opts);
      }
      answers[q.id] = {
        questionId: q.id,
        value: finalValue,
        text: humanReadable(finalValue, q),
        sectionIndex: q.sectionIndex
      };
    }
    return { answers, generationTime: Date.now() - t0 };
  }

  // Generate answers for a SPECIFIC list of questions (e.g. a newly-visible section)
  // and MERGE them into the respondent's existing answers. Does not overwrite existing answers.
  // This is the key function for multi-section forms where later sections' questions
  // weren't known when answers were initially generated.
  async function generateAnswersForQuestions(questions, respondent, opts) {
    opts = opts || {};
    const rng = SP.RespondentGenerator.makeRng(opts.seed);
    respondent.answers = respondent.answers || {};
    const t0 = Date.now();
    let generated = 0;
    for (const q of questions) {
      // Skip if answer already exists and is non-empty
      const existing = respondent.answers[q.id];
      if (existing && existing.value != null && existing.value !== '' &&
          !(Array.isArray(existing.value) && existing.value.length === 0)) {
        continue;
      }
      let value;
      if (opts.mode === 'ai' && opts.apiKey) {
        // Use AI for this single question
        try {
          const singleSurvey = { title: 'Section questions', sections: [{ id: 's', title: 'Current section', questions: [q] }] };
          const aiResult = await generateAnswersAI(singleSurvey, respondent, opts);
          if (aiResult.answers && aiResult.answers[q.id]) {
            value = aiResult.answers[q.id].value;
          }
        } catch (e) {
          value = null;
        }
      }
      if (value == null) {
        value = localAnswerFor(q, respondent.profile, rng, opts);
        const check = Parser.validateAnswerShape(q, { value });
        if (!check.ok && q.type !== QTYPE.UNKNOWN) {
          value = localAnswerFor(q, respondent.profile, rng, opts);
        }
      }
      respondent.answers[q.id] = {
        questionId: q.id,
        value: value,
        text: humanReadable(value, q),
        sectionIndex: q.sectionIndex != null ? q.sectionIndex : 0,
        generatedAt: Date.now()
      };
      generated++;
    }
    return { generated, generationTime: Date.now() - t0 };
  }

  function humanReadable(value, question) {
    if (value == null) return '';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  }

  // -------- AI (Gemini) answer generation --------

  const GEMINI_MODELS = [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (stable, recommended)' },
    { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite (fastest, cheapest)' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (preview, newer)' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (preview, highest quality)' }
  ];

  const DEFAULT_MODEL = 'gemini-2.0-flash';
  // Fallback models to try if the primary model fails (e.g. model deprecated or unavailable)
  const FALLBACK_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];
  const DEFAULT_TIMEOUT_MS = 30000;
  const MAX_RETRIES = 3;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function classifyError(err, httpStatus) {
    if (httpStatus === 429) return 'rate_limit';
    if (httpStatus === 400 && /API key not valid/i.test(String(err && err.message || ''))) return 'invalid_key';
    if (httpStatus === 400) return 'bad_request';
    if (httpStatus === 401 || httpStatus === 403) return 'auth';
    if (httpStatus >= 500) return 'server';
    if (err && err.name === 'AbortError') return 'timeout';
    return 'network';
  }

  async function callGemini({ apiKey, model, prompt, timeoutMs }) {
    // Try the requested model first, then fall back to alternatives if it fails
    const models = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];
    let lastErr = null;
    for (const m of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const body = {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 4096 }
        };
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS) : null;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl ? ctrl.signal : undefined
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
        if (!res.ok) {
          const msg = (json.error && json.error.message) || text || ('HTTP ' + res.status);
          const err = new Error(msg);
          err.httpStatus = res.status;
          err.payload = json;
          err.model = m;
          throw err;
        }
        const out = json.candidates && json.candidates[0] && json.candidates[0].content &&
                    json.candidates[0].content.parts && json.candidates[0].content.parts[0];
        if (!out || !out.text) {
          const err = new Error('Gemini returned no usable content');
          err.payload = json;
          err.model = m;
          throw err;
        }
        return out.text;
      } catch (err) {
        lastErr = err;
        // If it's a model-not-found or deprecation error, try the next model
        if (err.httpStatus === 404 || err.httpStatus === 400 && /model|not found|deprecated|not supported/i.test(err.message)) {
          continue;
        }
        // For other errors (rate limit, auth, network), don't try other models
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr || new Error('All models failed');
  }

  function buildPromptForSurvey(survey, respondent) {
    const profile = respondent.profile;
    const questions = (survey.sections || []).flatMap((s) => s.questions || []);
    const qList = questions.map((q, i) => {
      const meta = {
        id: q.id,
        index: i + 1,
        text: q.text,
        type: q.type,
        required: q.required,
        options: q.options || undefined,
        min: q.minValue != null ? q.minValue : undefined,
        max: q.maxValue != null ? q.maxValue : undefined
      };
      return meta;
    });
    const prompt =
`You are simulating a single survey respondent with the following profile. Generate honest, realistic answers for every question, consistent with the profile. Do NOT include any PII or real personal data. Respond strictly as JSON.

Profile:
- age: ${profile.age}
- gender: ${profile.gender}
- occupation: ${profile.occupation}
- studentStatus: ${profile.studentStatus}
- region: ${profile.region}
- travelBehavior: ${profile.travelBehavior}
- language: ${profile.language}

Survey title: ${survey.title}
Questions (JSON):
${JSON.stringify(qList, null, 2)}

Respond with ONLY a JSON object of shape: { "answers": [ { "questionId": "<id>", "value": <string|number|array> } ] }.
For "checkbox" questions, value MUST be an array of strings from the options array.
For "multiple_choice" / "dropdown" / "linear_scale" / "rating", value MUST be a single string or number from the options/range.
For "short_answer" / "paragraph", value is a string.
For "date", use YYYY-MM-DD. For "time", use HH:MM.
If a question is not required and the profile would naturally skip it, you may use null.`;
    return prompt;
  }

  function parseGeminiAnswers(text, survey) {
    let json;
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end < 0) throw new Error('No JSON found in response');
      json = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      throw new Error('Gemini response was not valid JSON: ' + e.message);
    }
    const list = (json.answers || []).filter(Boolean);
    const out = {};
    for (const a of list) {
      if (!a.questionId) continue;
      out[a.questionId] = {
        questionId: a.questionId,
        value: a.value,
        text: humanReadable(a.value, null)
      };
    }
    return out;
  }

  // Try AI; on quota/auth/network errors, fall back to local generation.
  // Records the actual mode used and any errors encountered.
  async function generateAnswersAI(survey, respondent, opts) {
    opts = opts || {};
    const apiKey = opts.apiKey;
    const model = opts.model || DEFAULT_MODEL;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const maxRetries = opts.maxRetries != null ? opts.maxRetries : MAX_RETRIES;
    const errors = [];

    if (!apiKey) {
      errors.push({ kind: 'invalid_key', message: 'No API key configured' });
      const local = await generateAnswersLocal(survey, respondent, opts);
      return Object.assign({}, local, { mode: 'local', fallbackReason: 'no_api_key', errors });
    }

    const prompt = buildPromptForSurvey(survey, respondent);
    let attempt = 0;
    let lastErr = null;
    while (attempt <= maxRetries) {
      attempt++;
      try {
        const t0 = Date.now();
        const text = await callGemini({ apiKey, model, prompt, timeoutMs });
        const parsed = parseGeminiAnswers(text, survey);
        // Fill gaps with local generator
        const questions = (survey.sections || []).flatMap((s) => s.questions || []);
        const rng = SP.RespondentGenerator.makeRng(opts.seed);
        const merged = {};
        let missingCount = 0;
        for (const q of questions) {
          if (parsed[q.id] && parsed[q.id].value != null) {
            merged[q.id] = Object.assign({}, parsed[q.id], { sectionIndex: q.sectionIndex });
            const check = Parser.validateAnswerShape(q, parsed[q.id]);
            if (!check.ok) {
              // Re-try locally
              const v = localAnswerFor(q, respondent.profile, rng, opts);
              merged[q.id] = { questionId: q.id, value: v, text: humanReadable(v, q), sectionIndex: q.sectionIndex };
              errors.push({ kind: 'shape_mismatch', questionId: q.id, message: check.reason });
            } else {
              merged[q.id].text = humanReadable(parsed[q.id].value, q);
            }
          } else {
            missingCount++;
            const v = localAnswerFor(q, respondent.profile, rng, opts);
            merged[q.id] = { questionId: q.id, value: v, text: humanReadable(v, q), sectionIndex: q.sectionIndex };
            errors.push({ kind: 'missing_answer', questionId: q.id, message: 'Gemini omitted this question; filled locally' });
          }
        }
        return { answers: merged, generationTime: Date.now() - t0, mode: 'ai', missingCount, errors };
      } catch (err) {
        lastErr = err;
        const kind = classifyError(err, err.httpStatus);
        errors.push({ kind, message: err.message, attempt });
        // No point retrying auth/quota errors
        if (kind === 'invalid_key' || kind === 'auth') break;
        if (kind === 'rate_limit') {
          // Exponential backoff
          const wait = Math.min(8000, 500 * Math.pow(2, attempt - 1));
          await sleep(wait);
          continue;
        }
        if (kind === 'timeout' || kind === 'network' || kind === 'server') {
          const wait = Math.min(4000, 500 * Math.pow(2, attempt - 1));
          await sleep(wait);
          continue;
        }
        break;
      }
    }

    // Fallback
    const local = await generateAnswersLocal(survey, respondent, opts);
    return Object.assign({}, local, { mode: 'local', fallbackReason: lastErr ? classifyError(lastErr, lastErr.httpStatus) : 'unknown', errors });
  }

  // -------- Public dispatcher --------

  async function generateAnswers(survey, respondent, opts) {
    opts = opts || {};
    if (opts.mode === 'ai') {
      const r = await generateAnswersAI(survey, respondent, opts);
      respondent.generationMode = r.mode;
      respondent.fallbackReason = r.fallbackReason || null;
      respondent.errors = r.errors || [];
      respondent.generationTime = r.generationTime;
      respondent.answers = r.answers;
      return r;
    }
    const r = await generateAnswersLocal(survey, respondent, opts);
    respondent.generationMode = 'local';
    respondent.generationTime = r.generationTime;
    respondent.answers = r.answers;
    return r;
  }

  // Edit a single answer (used by respondent manager)
  function setAnswer(respondent, question, value) {
    respondent.answers[question.id] = {
      questionId: question.id,
      value,
      text: humanReadable(value, question),
      sectionIndex: question.sectionIndex,
      editedAt: Date.now()
    };
    return respondent.answers[question.id];
  }

  const AnswerGenerator = {
    GEMINI_MODELS,
    DEFAULT_MODEL,
    FALLBACK_MODELS,
    generateAnswers,
    generateAnswersLocal,
    generateAnswersForQuestions,
    generateAnswersAI,
    localAnswerFor,
    setAnswer,
    humanReadable,
    classifyError,
    callGemini,
    buildPromptForSurvey
  };

  global.SurveyPilot = global.SurveyPilot || {};
  global.SurveyPilot.AnswerGenerator = AnswerGenerator;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
