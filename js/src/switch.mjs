/**
 * switch — a finite-choice decision loop over a System One model.
 *
 * The shape comes from osolmaz/switch: your code presents a short list of
 * typed questions, the model picks, your code transitions, and the run ends
 * when there are no questions left. It is AGL's agent loop inverted — instead
 * of "the model decides and AGL executes", it is "your code decides what the
 * model may decide, and the model picks one".
 *
 * It is driven by a NATIVE decision endpoint (`POST /v1/systemone`), not by
 * chat completions: one request answers every question at a state, the answers
 * carry probability distributions, and no tokens are generated.
 *
 * A domain is plain data plus three functions:
 *
 *   initial(input)        -> the starting state (plain JSON)
 *   questions(state)      -> { id: question }   — `{}` ENDS the run
 *   transition(state, a)  -> the next state
 *   view(state)           -> what the model reads (optional; defaults to state)
 */

/** Question types the decision endpoint accepts, and the aliases we map on. */
const WIRE_TYPES = new Set(['choice', 'score', 'noul']);
const TYPE_ALIASES = { bool: 'noul', boolean: 'noul' };

/** Default cap on loop steps when the domain does not set `limits.steps`. */
const DEFAULT_STEP_LIMIT = 20;

/**
 * Turn a list of legal options into a `choice` question — the counterpart of
 * Switch's `pick`/`picking` helper.
 *
 * Each option is `{ key, text, priority? }`. `key` is what the model answers
 * with and what `transition` receives; `text` is the description the model
 * reads. Higher `priority` sorts first (default 0), so a terminal option can
 * be pushed last with a negative one.
 *
 * @param {Array<{key: string, text?: string, priority?: number}>} options
 * @param {{instructions?: string}} [opts]
 */
export function pick(options, { instructions } = {}) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('pick: needs a non-empty array of options');
  }
  const sorted = [...options].sort(
    (a, b) => (b?.priority ?? 0) - (a?.priority ?? 0),
  );
  const criteria = {};
  const byKey = {};
  for (const o of sorted) {
    const key = String(o?.key ?? '');
    if (!key) throw new Error('pick: every option needs a non-empty `key`');
    if (Object.prototype.hasOwnProperty.call(criteria, key)) {
      throw new Error(`pick: duplicate option key "${key}"`);
    }
    criteria[key] = o.text ?? null;
    byKey[key] = o;
  }
  return {
    type: 'choice',
    ...(instructions ? { instructions } : {}),
    criteria,
    // Stripped before the request; used to hand `transition` the full option.
    _options: byKey,
  };
}

/** Strip our private `_*` fields so only the wire shape is sent. */
function toWireQuestions(questions) {
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    if (!q || typeof q !== 'object') {
      throw new Error(`switch: question "${id}" must be an object`);
    }
    const type = TYPE_ALIASES[q.type] ?? q.type ?? 'choice';
    if (!WIRE_TYPES.has(type)) {
      throw new Error(
        `switch: question "${id}" has unsupported type "${q.type}" ` +
          `(expected choice, score, or noul/bool)`,
      );
    }
    const wire = { type };
    if (q.instructions !== undefined) wire.instructions = q.instructions;
    if (q.criteria !== undefined) wire.criteria = q.criteria;
    out[id] = wire;
  }
  return out;
}

/**
 * Normalize the endpoint's answers into AGL's shape.
 *
 * Every answer records `source`, because the three sources are NOT the same
 * kind of evidence and must not share a word:
 *   'systemone' — a distribution measured by the decision model
 *   'trace'     — replayed from a recorded run, no model involved
 *
 * The server's own caveat applies to 'systemone' and is deliberately not
 * papered over: "The probabilities are scaled with the temperatures stored in
 * the model file. They are not guaranteed to be calibrated for your data."
 * So these are measured probabilities under the model's temperature, not
 * calibrated ones.
 */
function normalizeAnswers(raw, questions, { source, boolThreshold }) {
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = raw?.[id];
    if (a == null) throw new Error(`switch: endpoint returned no answer for question "${id}"`);
    const type = TYPE_ALIASES[q.type] ?? q.type ?? 'choice';
    if (type === 'choice') {
      const choice = a.choice;
      out[id] = {
        type: 'choice',
        choice,
        probabilities: a.probabilities ?? null,
        // `confidence` is the endpoint's own 0..1 spread measure, not a
        // probability of correctness.
        confidence: a.confidence ?? null,
        probability: a.probabilities?.[choice] ?? null,
        ...(q._options?.[choice] !== undefined ? { option: q._options[choice] } : {}),
        source,
      };
    } else if (type === 'score') {
      out[id] = {
        type: 'score',
        score: a.score ?? null,
        legend: a.legend ?? null,
        probabilities: a.probabilities ?? null,
        confidence: a.confidence ?? null,
        source,
      };
    } else {
      // noul: the endpoint returns ONLY the probability that the answer is
      // true. Collapsing that to a boolean is OUR decision, not the model's,
      // so the threshold is explicit and the raw number is kept.
      const p = a.noul ?? null;
      out[id] = {
        type: 'noul',
        noul: p,
        value: p == null ? null : p >= boolThreshold,
        bool_threshold: boolThreshold,
        source,
      };
    }
  }
  return out;
}

/** Stable key order, so a recorded question set compares byte-for-byte. */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

function validateDomain(domain) {
  if (!domain || typeof domain !== 'object') throw new Error('switch: `domain` is required');
  for (const fn of ['questions', 'transition']) {
    if (typeof domain[fn] !== 'function') {
      throw new Error(`switch: domain.${fn} must be a function`);
    }
  }
  if (domain.initial !== undefined && typeof domain.initial !== 'function') {
    throw new Error('switch: domain.initial must be a function when present');
  }
  if (domain.view !== undefined && typeof domain.view !== 'function') {
    throw new Error('switch: domain.view must be a function when present');
  }
}

/** Parse a trace: either a JSONL string or an array of already-parsed rows. */
export function parseTrace(trace) {
  if (Array.isArray(trace)) return trace;
  const rows = [];
  for (const line of String(trace ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t));
  }
  return rows;
}

/**
 * Run (or replay) a decision loop.
 *
 * Called as `agent.switch(...)`; `decide` and `describe` are supplied by the
 * Agent so this module stays free of provider concerns.
 *
 * @param {object} o
 * @param {object} o.domain
 * @param {unknown} [o.input]            passed to domain.initial
 * @param {object}  [o.state]            start from an explicit state instead
 * @param {Array|string} [o.replay]      a trace to replay (no model calls)
 * @param {number}  [o.fork]             replay this many steps, then go live
 * @param {function} o.decide            async ({state, questions, signal}) -> raw answers
 * @param {string}  [o.describe]         decision model spec, recorded in the trace
 * @param {number}  [o.bool_threshold]   noul -> boolean cut (default 0.5)
 * @param {AbortSignal} [o.signal]
 */
export async function runSwitch({
  domain,
  input,
  state: startState,
  replay = null,
  fork = null,
  decide,
  describe = null,
  bool_threshold = 0.5,
  signal = null,
} = {}) {
  validateDomain(domain);

  const replayRows = replay ? parseTrace(replay) : null;
  const replaySteps = replayRows
    ? replayRows.filter((r) => r?.type === 'step')
    : null;
  // `replay` with no fork point replays everything; `fork: n` replays n steps.
  const replayUpTo = replayRows
    ? fork == null
      ? replaySteps.length
      : Math.max(0, Math.min(Number(fork), replaySteps.length))
    : 0;
  const live = !replayRows || replayUpTo < replaySteps.length || fork != null;

  if (!replayRows && typeof decide !== 'function') {
    throw new Error('switch: a `decide` function is required for a live run');
  }

  const stepLimit = Math.max(1, Number(domain.limits?.steps) || DEFAULT_STEP_LIMIT);

  let state;
  if (startState !== undefined) state = startState;
  else if (replayRows && replaySteps.length) state = replaySteps[0].state;
  else if (typeof domain.initial === 'function') state = domain.initial(input);
  else state = input ?? {};

  const trace = [
    {
      v: 1,
      type: 'meta',
      domain: domain.name ?? null,
      version: domain.version ?? null,
      decision_model: describe,
      mode: replayRows ? (fork == null ? 'replay' : `fork:${replayUpTo}`) : 'run',
      started: new Date().toISOString(),
    },
  ];

  let steps = 0;
  let ended = 'done';
  let lastAnswers = null;
  const usage = { input_tokens: 0, output_tokens: 0, requests: 0 };

  while (true) {
    if (signal?.aborted) {
      ended = 'aborted';
      break;
    }
    if (steps >= stepLimit) {
      ended = 'step limit';
      break;
    }

    const questions = domain.questions(state);
    // The contract: no questions means the run is over. The endpoint itself
    // rejects an empty set, so this must be caught here.
    if (!questions || Object.keys(questions).length === 0) break;

    const wire = toWireQuestions(questions);
    const view = typeof domain.view === 'function' ? domain.view(state) : state;

    let answers;
    let source;
    const recorded = replaySteps?.[steps];
    const useRecorded = recorded && steps < replayUpTo;

    if (useRecorded) {
      // Re-derive rather than trust: if the domain has changed since the trace
      // was written, the recorded answers no longer belong to these questions,
      // so say so instead of silently producing a different result.
      if (stableStringify(recorded.questions) !== stableStringify(wire)) {
        trace.push({
          v: 1,
          type: 'drift',
          step: steps,
          expected: recorded.questions,
          actual: wire,
        });
        ended = 'drift';
        break;
      }
      answers = normalizeAnswers(recorded.answers, questions, {
        source: 'trace',
        boolThreshold: bool_threshold,
      });
      source = 'trace';
    } else {
      if (!live || typeof decide !== 'function') {
        ended = 'trace exhausted';
        break;
      }
      const raw = await decide({ state: view, questions: wire, signal });
      answers = normalizeAnswers(raw?.answers, questions, {
        source: 'systemone',
        boolThreshold: bool_threshold,
      });
      source = 'systemone';
      const u = raw?.usage || {};
      usage.input_tokens += Number(u.input_tokens) || 0;
      usage.output_tokens += Number(u.output_tokens) || 0;
      usage.requests += 1;
    }

    trace.push({
      v: 1,
      type: 'step',
      step: steps,
      source,
      state,
      view,
      questions: wire,
      answers: rawForTrace(answers),
    });

    lastAnswers = answers;
    steps += 1;

    let next;
    try {
      next = domain.transition(state, answers);
    } catch (err) {
      trace.push({ v: 1, type: 'error', step: steps - 1, message: String(err?.message || err) });
      ended = 'failed';
      break;
    }
    if (next === undefined) {
      ended = 'failed';
      trace.push({
        v: 1,
        type: 'error',
        step: steps - 1,
        message: 'domain.transition returned undefined',
      });
      break;
    }
    state = next;
  }

  trace.push({ v: 1, type: 'end', ended, steps, state });
  return { state, answers: lastAnswers, trace, steps, ended, usage };
}

/**
 * Record answers in the endpoint's own vocabulary, so a trace stays replayable
 * even if AGL's normalization changes. `source`/`value` are derived, not data.
 */
function rawForTrace(answers) {
  const out = {};
  for (const [id, a] of Object.entries(answers)) {
    if (a.type === 'choice') {
      out[id] = {
        type: 'choice',
        choice: a.choice,
        ...(a.probabilities ? { probabilities: a.probabilities } : {}),
        ...(a.confidence != null ? { confidence: a.confidence } : {}),
      };
    } else if (a.type === 'score') {
      out[id] = {
        type: 'score',
        score: a.score,
        ...(a.legend ? { legend: a.legend } : {}),
        ...(a.probabilities ? { probabilities: a.probabilities } : {}),
        ...(a.confidence != null ? { confidence: a.confidence } : {}),
      };
    } else {
      out[id] = { type: 'noul', noul: a.noul };
    }
  }
  return out;
}

/** Serialize a trace to JSONL. */
export function formatTrace(trace) {
  return trace.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
