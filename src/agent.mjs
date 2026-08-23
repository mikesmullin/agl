import { debug } from './lib/debug.mjs';
import * as xai from './providers/xai.mjs';
import * as copilot from './providers/copilot.mjs';
import * as ollama from './providers/ollama.mjs';
import * as lmstudio from './providers/lm-studio.mjs';
import * as runpod from './providers/runpod.mjs';
import * as muse from './providers/muse.mjs';
import * as mycloud from './providers/mycloud.mjs';

const PROVIDERS = {
  xai,
  copilot,
  ollama,
  'lm-studio': lmstudio,
  runpod,
  muse,
  mycloud,
  'llama-server': mycloud,
};

/**
 * Parse `provider:model` (or bare model) into parts.
 * @param {string} spec
 * @returns {{ provider: string|null, model: string }}
 */
function _splitProviderModel(spec) {
  const s = String(spec || '').trim();
  let provider = null;
  let model = s;
  const idx = s.indexOf(':');
  if (idx > 0) {
    provider = s.slice(0, idx);
    model = s.slice(idx + 1);
  }
  if (!provider) {
    const m = model.toLowerCase();
    if (
      m.includes('gpt-') ||
      m.includes('claude') ||
      m.includes('luna') ||
      m.includes('terra') ||
      m.includes('sol') ||
      m.includes('fable')
    ) {
      provider = 'copilot';
    } else if (m.includes('grok')) {
      provider = 'xai';
    } else {
      provider = 'lm-studio';
    }
  }
  return { provider, model };
}

/**
 * Resolve max context window (tokens) for a `provider:model` spec (or bare model
 * id if a single provider is obvious). Delegates to each provider's
 * `contextWindowSize(model)`.
 *
 * For LM Studio this is **live** when the provider cache is warm
 * (`loaded_context_length` from `/api/v0/models`); otherwise a static table.
 * Prefer {@link resolveContextWindowAsync} so LM Studio is refreshed first.
 *
 * @param {string} spec - e.g. "copilot:gpt-5.6-luna" or "lm-studio:google/gemma-4-12b-qat"
 * @param {{ default?: number }} [opts]
 * @returns {number}
 */
export function resolveContextWindow(spec, opts = {}) {
  const fallback =
    Number.isFinite(opts.default) && opts.default > 0 ? opts.default : 32_768;
  if (!spec) return fallback;
  const { provider, model } = _splitProviderModel(spec);
  const mod = PROVIDERS[provider];
  if (mod && typeof mod.contextWindowSize === 'function') {
    const n = Number(mod.contextWindowSize(model));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

/**
 * Like {@link resolveContextWindow}, but refreshes provider-side metadata first
 * (LM Studio: GET /api/v0/models → loaded_context_length).
 *
 * @param {string} spec
 * @param {{ default?: number, force?: boolean }} [opts]
 * @returns {Promise<number>}
 */
export async function resolveContextWindowAsync(spec, opts = {}) {
  const { provider } = _splitProviderModel(spec || '');
  const mod = provider ? PROVIDERS[provider] : null;
  if (mod && typeof mod.refreshContextWindows === 'function') {
    try {
      await mod.init?.();
      await mod.refreshContextWindows({ force: opts.force !== false });
    } catch (err) {
      debug('resolveContextWindowAsync refresh failed.', err);
    }
  }
  return resolveContextWindow(spec, opts);
}

/** Provider modules (for tests / advanced callers). */
export { PROVIDERS as providers };

// ---------------------------------------------------------------------------
// Generic provider-call resilience (applies to ALL providers).
// Retries transient errors with exponential backoff + jitter, and enforces a
// per-attempt timeout. Tunable via env:
//   AGL_RETRY_ATTEMPTS (default 5)   AGL_RETRY_BASE_MS (default 1000)
//   AGL_RETRY_MAX_MS  (default 30000) AGL_TIMEOUT_MS   (default 180000, 0=off)
// ---------------------------------------------------------------------------

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _retryConfig() {
  return {
    attempts: Math.max(1, Number(process.env.AGL_RETRY_ATTEMPTS || 5)),
    baseMs: Number(process.env.AGL_RETRY_BASE_MS || 1000),
    maxMs: Number(process.env.AGL_RETRY_MAX_MS || 30000),
    timeoutMs: Number(process.env.AGL_TIMEOUT_MS ?? 180000),
  };
}

// Race a promise against a timeout. The losing promise keeps a no-op handler
// so a late rejection never surfaces as an unhandled rejection.
// `ac` (optional AbortController) is aborted when the timeout fires, so the
// underlying provider request is actually cancelled — without this, a
// timed-out attempt keeps generating on the provider while the retry sends a
// fresh one (snowballing load on local servers like LM Studio).
function _withTimeout(promise, ms, ac) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { ac?.abort(`agl: provider call timed out after ${ms}ms`); } catch { /* ignore */ }
      reject(new Error(`agl: provider call timed out after ${ms}ms`));
    }, ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// HTTP 4xx request/capability errors are deterministic except for timeout,
// conflict, early-data, and rate-limit responses. Retrying those bad requests
// only occupies a concurrency slot and repeats the same provider rejection.
export function isRetryableProviderError(err) {
  // User / harness cancel must never be retried
  if (err?.aborted === true || err?.userAbort === true) return false;
  const status = Number(err?.status);
  if (Number.isFinite(status)) {
    if (status === 400 && err?.model) {
      const message = String(err?.message || '');
      const contradictoryModelRoute = message.includes('requested model is not available')
        && message.includes('Available models:')
        && message.includes(String(err.model));
      if (contradictoryModelRoute) return true;
    }
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  const name = String(err?.name || '');
  const code = String(err?.code || '');
  const message = String(err?.message || err || '').toLowerCase();
  if (
    name === 'AbortError' &&
    /user stop|agent aborted|interrupted|aborted by user|user abort/.test(message)
  ) {
    return false;
  }
  // Idle/timeout aborts and network blips may be retried
  if (name === 'AbortError' || message.includes('timed out') || message.includes('timeout')) return true;
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)) return true;
  return err?.retryable !== false;
}

/** Build an Error that withProviderRetry will not retry. */
export function abortError(reason = 'aborted') {
  const e = new Error(reason || 'aborted');
  e.name = 'AbortError';
  e.aborted = true;
  e.userAbort = true;
  return e;
}

// Run an async provider call with timeout + retry/backoff on transient errors.
// opts.timeoutMs overrides the default; pass 0 to disable the wall-clock
// timeout (e.g. for streaming calls that govern themselves via an idle timer).
//
// fn is called with an attempt context `{ signal }` — an AbortSignal scoped to
// THIS attempt that fires on (a) opts.signal abort (user stop) or (b) the
// per-attempt timeout. Callers that thread it into their provider request get
// true early-abort: the HTTP request is torn down instead of left running.
// Callers that ignore the argument keep the old race-only behavior.
export async function withProviderRetry(fn, opts = {}) {
  const cfg = _retryConfig();
  // opts.attempts (total tries) overrides env; factory `retries: 0` → attempts: 1
  const attempts = Math.max(
    1,
    Number.isFinite(opts.attempts) ? Math.floor(opts.attempts) : cfg.attempts,
  );
  const { baseMs, maxMs } = cfg;
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
  const signal = opts.signal;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      throw abortError(
        typeof signal.reason === 'string' ? signal.reason : 'user stop',
      );
    }
    const attemptAc = new AbortController();
    const onOuterAbort = () => {
      try {
        attemptAc.abort(
          typeof signal?.reason === 'string' ? signal.reason : 'user stop',
        );
      } catch { /* ignore */ }
    };
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
    try {
      return await _withTimeout(
        Promise.resolve().then(() => fn({ signal: attemptAc.signal })),
        timeoutMs,
        attemptAc,
      );
    } catch (err) {
      lastErr = err;
      // User-cancelled stream: never retry
      if (signal?.aborted || err?.aborted || err?.userAbort) {
        throw abortError(
          typeof signal?.reason === 'string'
            ? signal.reason
            : err?.message || 'user stop',
        );
      }
      if (attempt >= attempts || !isRetryableProviderError(err)) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const wait = backoff + Math.floor(Math.random() * 250);
      console.warn(
        `agl: provider call failed (${err?.name || 'Error'}: ${err?.message || err}); ` +
        `retry ${attempt}/${attempts - 1} in ${wait}ms`,
      );
      debug('agl provider retry.', { attempt, wait, error: String(err?.message || err) });
      await _sleep(wait);
    } finally {
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Global concurrency gate for Agent.run().
// Every call to run() must acquire a slot before issuing provider inference and
// release it when finished (success OR error). The number of slots is read live
// from Agent.default.concurrency on each acquire, so callers can tune it at
// runtime (e.g. Agent.default.concurrency = 6). Default is 1 to avoid
// overwhelming the remote AI provider API. Anything beyond the limit waits
// asynchronously for the next free slot, FIFO. This naturally throttles retries
// too: each retry re-enters run() and must re-acquire a slot through the queue.
// ---------------------------------------------------------------------------
let _runActive = 0;
const _runWaiters = [];

function _concurrencyLimit() {
  const n = Number(Agent.default.concurrency);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function _drainWaiters() {
  while (_runWaiters.length && _runActive < _concurrencyLimit()) {
    _runActive++;
    const next = _runWaiters.shift();
    next();
  }
}

function _acquireRunSlot() {
  if (_runActive < _concurrencyLimit()) {
    _runActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _runWaiters.push(resolve));
}

function _releaseRunSlot() {
  _runActive = Math.max(0, _runActive - 1);
  // A slot just freed — wake the next waiter(s) up to the current limit.
  _drainWaiters();
}

/** Stable id for context_window items (UI / jsonl event_id). */
function _newCtxId() {
  return `cw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Strip harness-only fields; produce OpenAI / LM Studio chat.completions message.
 *
 * Canonical schema (see tmp/scrratchpad4.md + OpenAI chat completions):
 *   system|user:  { role, content }
 *   assistant:    { role, content, tool_calls? }  — no name/args/id/visible
 *                 content null when tool_calls present (empty string also ok)
 *   tool:         { role, tool_call_id, content } — no name/ok/denied/…
 *
 * Never retransmit reasoning_content (pollutes context + hurts KV reuse).
 * Never forward UI stamps angela adds (name, args, explanation, id, visible,
 * _persisted) — those caused Gemma "amnesia loops" after the context_window
 * refactor (assistant+tool rows looked like malformed function messages).
 *
 * @param {object} m
 */
function _toProviderMessage(m) {
  if (!m || typeof m !== 'object') {
    return { role: 'user', content: '' };
  }
  const role = m.role;

  if (role === 'system' || role === 'user') {
    return { role, content: m.content != null ? m.content : '' };
  }

  if (role === 'assistant') {
    const row = { role: 'assistant' };
    const hasTc = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    if (hasTc) {
      const text = m.content != null ? String(m.content) : '';
      // Prefer null when tool-only (LM Studio / OpenAI preferred shape)
      row.content = text.trim() ? text : null;
      row.tool_calls = m.tool_calls.map((tc) => {
        const fn = tc?.function || {};
        const args = fn.arguments;
        return {
          id: tc?.id || '',
          type: tc?.type || 'function',
          function: {
            name: fn.name || '',
            arguments:
              typeof args === 'string'
                ? args
                : JSON.stringify(args ?? {}),
          },
        };
      });
    } else {
      row.content = m.content != null ? m.content : '';
    }
    // intentionally omit: name, reasoning_content, reasoning, id, visible, args
    return row;
  }

  if (role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.tool_call_id || '',
      content: m.content != null ? m.content : '',
    };
  }

  // Unknown roles (e.g. reasoning) should be filtered before this is called.
  return { role: role || 'user', content: m.content != null ? m.content : '' };
}

export default class Agent {
  static default = {
    model: 'lm-studio:google/gemma-4-12b-qat',
    /** @deprecated use context_window_size — kept for factory back-compat (number) */
    context_window: null,
    context_window_size: null,
    MAX_CTX_LEN: null,
    WIDE_MODEL: null,
    /** OpenAI-style effort (low|medium|high|xhigh|…). Blank/omitted → omit from request. */
    reasoning_effort: null,
    // Default "provider:model" spec for Agent.embed() when none is passed.
    embed_model: null,
    // Max simultaneous in-flight Agent.run() calls (provider inference loops).
    // Default 1 (serial). Set higher (e.g. 6) to parallelize.
    concurrency: 1,
    /**
     * Max provider inference rounds per Agent.run() when an output_tool is set.
     * Each model call (including after tool results / after nudges) counts as one turn.
     * Override per agent via Agent.factory({ max_turns }).
     */
    max_turns: 5,
  };

  // tool registry
  tools = {};
  // register a tool call
  Tool(name, description, properties, required, fn) {
    if (Object.keys(this.tools).length >= 128) throw new Error('Tool limit exceeded: maximum 128 tools allowed');
    fn._name = name;
    fn._description = description || '';
    fn._properties = properties || {};
    fn._required = required || [];
    this.tools[name] = fn;
  }

  _renderTools() {
    const tools = [];
    for (const name in this.tools) {
      const tool = this.tools[name];
      tools.push({
        type: 'function',
        function: {
          name: tool._name,
          description: tool._description,
          parameters: {
            type: 'object',
            properties: tool._properties,
            required: tool._required,
          }
        }
      });
    }
    return tools;
  }

  /** OpenAI-style signature text for the registered output tool (for nudges). */
  _outputToolSignature() {
    const name = this.output_tool_name;
    if (!name || !this.tools[name]) {
      return `${name || 'final_result'}(…unknown schema…)`;
    }
    const fn = this.tools[name];
    const props = fn._properties || {};
    const required = new Set(fn._required || []);
    const params = Object.keys(props).map((k) => {
      const p = props[k] || {};
      const t = p.type || 'any';
      const req = required.has(k) ? '' : '?';
      return `${k}${req}: ${t}`;
    });
    const desc = (fn._description || '').trim();
    const sig = `${name}({ ${params.join(', ')} })`;
    return desc ? `${sig}\n  // ${desc}` : sig;
  }

  /**
   * Assess a failed assistant turn that did not call the output tool.
   * @returns {{ expected: string[], observed: string[], summary: string }}
   */
  _assessMissingOutputTool(assistantMsg) {
    const name = this.output_tool_name || 'final_result';
    const content =
      assistantMsg?.content != null ? String(assistantMsg.content) : '';
    const finish = assistantMsg?.finish_reason; // usually on choice, not message
    const hasContent = content.trim().length > 0;
    const hasTc =
      Array.isArray(assistantMsg?.tool_calls) &&
      assistantMsg.tool_calls.length > 0;
    const expected = [
      `Exactly one tool call to \`${name}\` (the registered output tool)`,
      'No freeform-only answer — the user ignores assistant prose as the final answer',
      `Arguments matching the output tool schema: ${this._outputToolSignature()}`,
    ];
    const observed = [];
    if (!hasTc) {
      observed.push('No tool_calls on the assistant message (empty / missing)');
    } else {
      const names = assistantMsg.tool_calls
        .map((c) => c?.function?.name || '(unnamed)')
        .join(', ');
      observed.push(`tool_calls present but not treated as output completion: ${names}`);
    }
    if (hasContent) {
      const preview = content.replace(/\s+/g, ' ').trim().slice(0, 280);
      observed.push(
        `Freeform assistant content was returned (${content.trim().length} chars): "${preview}${content.trim().length > 280 ? '…' : ''}"`,
      );
    } else {
      observed.push('Assistant content empty or null (and no usable output tool call)');
    }
    if (finish) observed.push(`finish_reason=${finish}`);
    const summary = hasContent
      ? 'Model produced prose (or empty tool payload) instead of invoking the required output tool.'
      : 'Model stopped without invoking the required output tool.';
    return { expected, observed, summary };
  }

  /**
   * Build a user-role nudge after the model failed to call the output tool.
   * @param {{
   *   failedAttempts: number,
   *   remainingTurns: number,
   *   maxTurns: number,
   *   assistantMsg: object|null,
   *   finishReason?: string|null,
   *   judgeFeedback?: string|null,
   * }} opts
   */
  _buildOutputToolNudge(opts = {}) {
    const name = this.output_tool_name || 'final_result';
    const failedAttempts = Number(opts.failedAttempts) || 1;
    const remainingTurns = Math.max(0, Number(opts.remainingTurns) || 0);
    const maxTurns = Number(opts.maxTurns) || this.max_turns || 5;
    const assistantMsg = opts.assistantMsg || null;
    if (assistantMsg && opts.finishReason && !assistantMsg.finish_reason) {
      assistantMsg.finish_reason = opts.finishReason;
    }
    const sig = this._outputToolSignature();
    const assessment = this._assessMissingOutputTool(assistantMsg);

    const lines = [];
    lines.push('═══ PROTOCOL VIOLATION — OUTPUT TOOL REQUIRED ═══');
    lines.push('');
    lines.push('FACTS (non-negotiable):');
    lines.push(
      '1. The user will NOT accept any outcome other than a tool call to the output tool.',
    );
    lines.push(
      '2. The user will NOT read (and will discard) any assistant freeform text as the final answer — prose alone is a failed turn.',
    );
    lines.push(
      `3. To succeed and satisfy the user you MUST call the output tool named \`${name}\`. That is the only successful terminal action.`,
    );
    lines.push('');
    lines.push('REQUIRED TOOL — name and signature:');
    lines.push(`  name: ${name}`);
    lines.push(`  signature: ${sig}`);
    lines.push('');

    if (failedAttempts <= 1) {
      lines.push(
        'Your previous response did not call this tool. Call it now with a complete argument object.',
      );
    } else {
      lines.push('ASSESSMENT OF YOUR LAST FAILED RESPONSE:');
      lines.push(`  Summary: ${assessment.summary}`);
      lines.push('  Expected:');
      for (const e of assessment.expected) lines.push(`    ✓ ${e}`);
      lines.push('  Observed:');
      for (const o of assessment.observed) lines.push(`    ✗ ${o}`);
      lines.push('');
      lines.push(
        `Failed attempts so far: ${failedAttempts}. Turns remaining (including your next reply): ${remainingTurns} of max ${maxTurns}.`,
      );
      lines.push(
        'Do NOT repeat the same mistake (freeform answer, wrong tool name, or empty tool_calls).',
      );
      lines.push(
        'Think carefully before your next action. Prefer high-reasoning: plan the exact tool call, then emit only that tool call.',
      );
      lines.push(
        'WARNING: If you exhaust remaining turns without a successful call to the output tool, this run will be ABORTED and scored as a FAILURE.',
      );
    }

    if (opts.judgeFeedback && String(opts.judgeFeedback).trim()) {
      lines.push('');
      lines.push('═══ LAST-CHANCE JUDGE FEEDBACK (one turn remaining) ═══');
      lines.push(String(opts.judgeFeedback).trim());
      lines.push('');
      lines.push(
        `This is your FINAL opportunity. Call \`${name}\` now with correct arguments. Freeform text will fail the run.`,
      );
    }

    lines.push('');
    lines.push(
      `NEXT ACTION: Invoke tool \`${name}\` exactly once with all required parameters filled.`,
    );
    return lines.join('\n');
  }

  /**
   * LLM-as-judge microagent for last-chance recovery feedback.
   * Freeform (no output_tool) so it cannot recurse into the same nudge loop.
   * @returns {Promise<string>}
   */
  async _judgeMissingOutputTool({
    assistantMsg,
    failedAttempts,
    maxTurns,
    remainingTurns,
    finishReason,
  }) {
    const name = this.output_tool_name || 'final_result';
    const sig = this._outputToolSignature();
    const assessment = this._assessMissingOutputTool({
      ...(assistantMsg || {}),
      finish_reason: finishReason || assistantMsg?.finish_reason,
    });
    const lastContent =
      assistantMsg?.content != null ? String(assistantMsg.content) : '';
    const lastTc = Array.isArray(assistantMsg?.tool_calls)
      ? JSON.stringify(assistantMsg.tool_calls).slice(0, 2000)
      : '(none)';

    const modelSpec = `${this.provider}:${this.model}`;
    let feedback = '';
    try {
      const judge = await Agent.factory({
        model: modelSpec,
        // No output_tool — single freeform completion; max_turns unused for freeform stop
        max_turns: 1,
        retain_history: false,
        retries: 0,
        system_prompt: `You are a strict protocol judge for a tool-calling agent.
Your job is NOT to answer the original user task. You only diagnose why the agent failed
to call its required output tool, and coach the next (final) attempt.

Write concise, high-signal coaching for the failing agent:
- Describe the failure clearly
- Describe the desired behavior
- Give one concrete example of a correct tool invocation (name + JSON arguments shape)
Do not call tools yourself. Plain text only.`,
      });
      const result = await judge.run({
        prompt: `<task>
Diagnose the agent's failed turn and write recovery coaching for its LAST remaining attempt.
</task>

<required-output-tool>
name: ${name}
signature:
${sig}
</required-output-tool>

<budget>
failed_attempts: ${failedAttempts}
max_turns: ${maxTurns}
remaining_turns: ${remainingTurns}
</budget>

<assessment>
summary: ${assessment.summary}
expected:
${assessment.expected.map((e) => `- ${e}`).join('\n')}
observed:
${assessment.observed.map((o) => `- ${o}`).join('\n')}
</assessment>

<last-assistant-content>
${lastContent.slice(0, 4000) || '(empty)'}
</last-assistant-content>

<last-assistant-tool-calls>
${lastTc}
</last-assistant-tool-calls>

Respond with:
1) Failure description
2) Desired behavior
3) Example tool call for \`${name}\` (illustrative JSON args)
`,
      });
      feedback =
        Agent.lastAssistantResponse(result) ||
        (typeof result === 'string' ? result : '') ||
        '';
    } catch (err) {
      debug('Agent output-tool judge failed.', err);
      feedback = [
        'Judge unavailable; static recovery brief:',
        assessment.summary,
        `You must call \`${name}\` with schema: ${sig}`,
        'Do not answer in prose. Emit only the required tool call.',
      ].join('\n');
    }
    return String(feedback || '').trim();
  }

  static async factory({
    model,
    system_prompt,
    output_tool,
    tool_choice,
    context_window, // legacy: number (max tokens) OR array (seed messages)
    context_window_size,
    parallel_tools,
    // OpenAI-style effort string (low|medium|high|xhigh|…). Blank/omitted → omit.
    reasoning_effort,
    max_tokens,
    temperature,
    chat_template_kwargs,
    stream,
    on_delta,
    retain_history,
    // Max provider inference rounds per run (default Agent.default.max_turns = 5).
    // Applies especially when output_tool is set: prevents infinite nudge loops.
    max_turns,
    // Number of *re*-tries after the first failure (0 = try once, never retry).
    // Honored centrally by withProviderRetry for every provider. Prefer this
    // over AGL_RETRY_ATTEMPTS when a caller (e.g. brain viz) needs cancel to
    // stick and must not re-fire a stuck inference loop.
    retries,
    // Per-attempt wall-clock timeout (ms). Overrides AGL_TIMEOUT_MS for this agent.
    timeout_ms,
    // Per-agent provider endpoint / credential overrides (mycloud / llama-server).
    // Needed when talking to a just-provisioned instance whose IP/key are not
    // the process-wide MYCLOUD_BASE_URL / MYCLOUD_API_KEY.
    base_url,
    api_key,
    ca_file,
  } = {}) {
    const inst = new Agent();
    const resolvedModel = model || Agent.default.model;
    if (retries != null && Number.isFinite(Number(retries))) {
      // retries=0 → 1 attempt; retries=2 → 3 attempts
      inst.retry_attempts = Math.max(1, Math.floor(Number(retries)) + 1);
    } else {
      inst.retry_attempts = null; // fall through to env / default
    }

    {
      const mt =
        max_turns != null
          ? Number(max_turns)
          : Number(Agent.default.max_turns ?? 5);
      inst.max_turns =
        Number.isFinite(mt) && mt >= 1 ? Math.floor(mt) : 5;
    }

    // Token budget (was historically named context_window as a number).
    let size =
      context_window_size ??
      Agent.default.context_window_size ??
      null;
    if (size == null && typeof context_window === 'number') {
      size = context_window;
    } else if (
      size == null &&
      context_window != null &&
      typeof context_window === 'object' &&
      !Array.isArray(context_window)
    ) {
      // ignore
    } else if (size == null) {
      size = Agent.default.context_window; // legacy default number
    }
    inst.context_window_size =
      size != null && Number.isFinite(Number(size)) ? Number(size) : null;

    // Conversation context (array) — single source of truth for multi-turn.
    // Mutate freely between run() calls (e.g. set visible:false for compaction).
    if (Array.isArray(context_window)) {
      inst.context_window = context_window.map((m) => ({
        visible: true,
        id: m.id || _newCtxId(),
        ...m,
      }));
    } else {
      inst.context_window = [];
    }

    inst.parallel_tools = parallel_tools ?? false;
    {
      const trimmed =
        reasoning_effort == null ? '' : String(reasoning_effort).trim();
      const fromDefault =
        Agent.default.reasoning_effort == null
          ? ''
          : String(Agent.default.reasoning_effort).trim();
      inst.reasoning_effort = trimmed || fromDefault || null;
    }
    inst.max_tokens = max_tokens ?? null;
    inst.temperature = temperature ?? null;
    inst.chat_template_kwargs = chat_template_kwargs ?? null;
    inst.timeout_ms = timeout_ms ?? null;
    inst.base_url = base_url ?? null;
    inst.api_key = api_key ?? null;
    inst.ca_file = ca_file ?? null;
    inst.stream = stream ?? false;
    inst.on_delta = on_delta ?? null;
    // When true, run() appends user/assistant/tool turns onto context_window
    // automatically. When false, each run() is one-shot (does not retain).
    inst.retain_history = retain_history ?? false;
    /** Last provider-reported usage (authoritative token counts; not chars/4). */
    inst.last_prompt_tokens = null;
    inst.last_completion_tokens = null;
    inst.last_total_tokens = null;
    if (!resolvedModel) {
      throw new Error('Agent.factory requires model or Agent.default.model');
    }
    {
      const idx = resolvedModel.indexOf(':');
      if (idx <= 0 || idx >= resolvedModel.length - 1) {
        throw new Error(`Invalid model format: ${resolvedModel}. Expected "provider:model".`);
      }
      inst.provider = resolvedModel.slice(0, idx);
      inst.model = resolvedModel.slice(idx + 1);
    }
    inst.client = PROVIDERS[inst.provider];
    if (!inst.client) {
      throw new Error(`Unknown AI provider: ${inst.provider}. Known: ${Object.keys(PROVIDERS).join(', ')}`);
    }
    inst.system_prompt = system_prompt;
    inst.tool_choice = tool_choice;
    await inst.client.init({
      base_url: inst.base_url,
      api_key: inst.api_key,
      ca_file: inst.ca_file,
    });

    const wideModelSpec = Agent.default.WIDE_MODEL;
    if (wideModelSpec) {
      const widx = wideModelSpec.indexOf(':');
      const wideProvider = widx > 0 && widx < wideModelSpec.length - 1 ? wideModelSpec.slice(0, widx) : null;
      inst._wideModel = wideProvider ? wideModelSpec.slice(widx + 1) : wideModelSpec;
      inst._wideClient = wideProvider ? PROVIDERS[wideProvider] : inst.client;
      if (inst._wideClient && inst._wideClient !== inst.client) {
        await inst._wideClient.init({
          base_url: inst.base_url,
          api_key: inst.api_key,
          ca_file: inst.ca_file,
        });
      }
    }

    if (output_tool) {
      inst.last_output = null;
      inst.output_tool_name = output_tool?.name || 'final_result';
      // Wrap output-tool fn so run() always gets last_output. Custom fns may be
      // either (ctx, args) [AGL/Tool convention] or (args) [sheets stage contract];
      // their return value becomes last_output (undefined → fall back to args).
      const userOutFn = output_tool?.fn;
      const outFn = async (ctx, args) => {
        let result;
        if (userOutFn) {
          result =
            userOutFn.length <= 1
              ? await userOutFn(args)
              : await userOutFn(ctx, args);
          inst.last_output = result !== undefined ? result : args;
        } else {
          inst.last_output = Object.prototype.hasOwnProperty.call(args, 'output')
            ? args.output
            : args;
          result = inst.last_output;
        }
        return result;
      };
      inst.Tool(
        inst.output_tool_name,
        // NOTE: must never be empty — the Copilot endpoint rejects requests
        // (400 Bad Request) when a tool has an empty description and the
        // messages contain image content.
        output_tool?.description || 'Report the final result.',
        output_tool?.parameters || { output: { type: output_tool?.type } },
        output_tool?.required || ['output'],
        outFn);
      if (!inst.tool_choice) {
        inst.tool_choice = 'required';
      }
    }

    return inst;
  }

  // Public entry point — enforces the global concurrency gate. Acquires a slot
  // before running the provider inference loop and always releases it, even on
  // error, so a thrown run() never leaks a slot.
  //
  // AbortController is created *before* the slot wait so abort() during queue
  // wait still kills the run the moment it starts (and never lets a pre-run
  // abort be silently cleared — that was the cancel race that left LM Studio
  // decoding for minutes after the user hit Stop).
  async run(args) {
    // Fresh controller for this run. If abort() already flipped `this.aborted`
    // for a *previous* run we clear it here; if abort() races us after this
    // assignment, the new controller is what it will abort.
    this.aborted = false;
    this._abortReason = null;
    this._runAbort = new AbortController();
    const runSignal = this._runAbort.signal;

    await _acquireRunSlot();
    try {
      if (this.aborted || runSignal.aborted) {
        throw abortError(this._abortReason || 'user stop');
      }
      return await this._runGated(args, runSignal);
    } finally {
      _releaseRunSlot();
    }
  }

  /**
   * Cancel the in-flight run: flag + abort the active provider AbortSignal so
   * streaming fetch/readers stop immediately (not only between tool loops).
   * Safe to call before run(), during slot wait, or mid-stream.
   */
  abort(reason = 'aborted') {
    this.aborted = true;
    this._abortReason = reason || 'aborted';
    const ac = this._runAbort;
    if (ac && !ac.signal.aborted) {
      try {
        ac.abort(reason || 'aborted');
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Clear the conversation context array (system prompt is separate).
   * Alias kept for older callers that used history.
   */
  clearHistory() {
    this.context_window = [];
  }

  /** @deprecated use context_window */
  get history() {
    return this.context_window;
  }
  set history(v) {
    this.context_window = Array.isArray(v) ? v : [];
  }

  /**
   * Messages sent to the provider this call: system + visible context_window
   * items (skips role=reasoning; skips visible===false).
   *
   * Consecutive single-tool assistant rows (1 UI item each) are merged into one
   * OpenAI assistant message with combined tool_calls so the provider sees a
   * valid multi-tool turn.
   *
   * TODO(provider-cache): Always retransmit the full filtered list today.
   * Pending opportunity: integrate per-provider incremental / prompt-cache APIs
   * so we only retransmit when context_window visibility or contents change
   * (dirty flag), improving cache hit rates on remote providers.
   */
  messagesForProvider() {
    const out = [];
    if (this.system_prompt != null && this.system_prompt !== '') {
      out.push({ role: 'system', content: this.system_prompt });
    }
    if (!Array.isArray(this.context_window)) return out;
    for (const m of this.context_window) {
      if (!m || typeof m !== 'object') continue;
      if (m.visible === false) continue;
      if (m.role === 'system') continue; // only system_prompt
      if (m.role === 'reasoning') continue; // UI-only unless caller promotes it
      const row = _toProviderMessage(m);
      // Merge consecutive tool-call assistants into one provider message
      // (UI stores 1 context_window item per tool_call; API wants one multi-tc turn)
      if (
        row.role === 'assistant' &&
        Array.isArray(row.tool_calls) &&
        row.tool_calls.length &&
        (row.content == null || !String(row.content).trim())
      ) {
        const prev = out[out.length - 1];
        if (
          prev &&
          prev.role === 'assistant' &&
          Array.isArray(prev.tool_calls) &&
          prev.tool_calls.length &&
          (prev.content == null || !String(prev.content).trim())
        ) {
          prev.tool_calls = prev.tool_calls.concat(row.tool_calls);
          continue;
        }
      }
      out.push(row);
    }
    return out;
  }

  /**
   * Append one item to context_window (retain path / tools / user).
   * @param {object} item
   */
  pushContext(item) {
    if (!Array.isArray(this.context_window)) this.context_window = [];
    const row = {
      visible: true,
      id: item?.id || _newCtxId(),
      ...item,
    };
    if (row.visible === undefined) row.visible = true;
    this.context_window.push(row);
    return row;
  }

  /**
   * Set visible on an item by id (manual compaction / eye toggle).
   * @returns {boolean} found
   */
  setContextVisible(id, visible) {
    if (!Array.isArray(this.context_window) || id == null) return false;
    let n = 0;
    for (const m of this.context_window) {
      if (m.id === id || (Array.isArray(m.ids) && m.ids.includes(id))) {
        m.visible = Boolean(visible);
        n++;
      }
    }
    return n > 0;
  }

  async _runGated({
    prompt,
    skip_user_append = false,
    user_id = null,
    ...ctx
  } = {}, runSignal = null) {
    // Prefer the controller created in run() (covers pre-slot abort). Fall
    // back only if a caller invoked _runGated directly.
    if (!runSignal) {
      this.aborted = false;
      this._abortReason = null;
      this._runAbort = new AbortController();
      runSignal = this._runAbort.signal;
    }

    if (this.aborted || runSignal.aborted) {
      throw abortError(this._abortReason || 'user stop');
    }

    if (!Array.isArray(this.context_window)) this.context_window = [];

    // One-shot: don't pollute retained context — use ephemeral list.
    // Retain: append user to context_window unless caller already did (angela).
    const retain = Boolean(this.retain_history);
    if (retain && !skip_user_append) {
      this.pushContext({
        role: 'user',
        content: prompt,
        ...(user_id ? { id: user_id } : {}),
      });
    }

    const hasTools = Object.keys(this.tools).length > 0;

    // Ephemeral transcript for !retain (still supports multi-step tools in one run)
    let oneshot = null;
    if (!retain) {
      oneshot = [
        ...(this.system_prompt
          ? [{ role: 'system', content: this.system_prompt }]
          : []),
        { role: 'user', content: prompt },
      ];
    }

    const providerMessages = () =>
      retain ? this.messagesForProvider() : oneshot;

    const maxTurns = Math.max(1, Number(this.max_turns) || 5);
    let done = false;
    let turnsUsed = 0;
    /** Times the model ended a turn without calling the required output tool. */
    let outputToolFailures = 0;

    while (true) {
      if (this.aborted) {
        throw new Error(this._abortReason || 'agent aborted');
      }
      if (done) {
        return this.last_output;
      }

      // Cap provider rounds (inference calls) to stop infinite nudge loops.
      if (turnsUsed >= maxTurns) {
        const name = this.output_tool_name || 'final_result';
        throw new Error(
          `agent exceeded max_turns=${maxTurns} without a successful ` +
            `output tool call (\`${name}\`); aborting as failure ` +
            `(output_tool_failures=${outputToolFailures})`,
        );
      }
      turnsUsed += 1;

      const messages = providerMessages();

      let activeModel = this.model;
      let activeClient = this.client;
      if (Agent.default.MAX_CTX_LEN && this._wideModel) {
        let chars = 0;
        for (const m of messages) {
          chars += String(m.content || '').length;
          if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
        }
        if (chars > Agent.default.MAX_CTX_LEN) {
          activeModel = this._wideModel;
          activeClient = this._wideClient;
        }
      }

      const req = { model: activeModel, messages };
      if (hasTools) req.tools = this._renderTools();
      if (this.tool_choice) req.tool_choice = this.tool_choice;
      if (this.reasoning_effort) req.reasoning_effort = this.reasoning_effort;
      // Provider long-context hint (number), not the message array
      if (this.context_window_size) {
        req.context_window = this.context_window_size;
      }
      if (this.max_tokens) req.max_tokens = this.max_tokens;
      if (this.temperature != null) req.temperature = this.temperature;
      if (this.chat_template_kwargs) req.chat_template_kwargs = this.chat_template_kwargs;
      if (this.base_url) req.base_url = this.base_url;
      if (this.api_key) req.api_key = this.api_key;
      if (this.ca_file) req.ca_file = this.ca_file;
      if (this.stream) req.stream = this.stream;
      if (this.stream && this.on_delta) req.on_delta = this.on_delta;
      // Client-side abort of the HTTP stream (Stop / new prompt interrupt)
      req.signal = runSignal;

      // Do NOT preflight with chars/4 heuristics — token counts come from the
      // provider response `usage` object after each completion (see below).

      // Streaming calls self-govern via the provider's idle timeout, so disable
      // the agent-level wall-clock timeout (a long-but-progressing generation
      // must not be killed mid-stream). User abort still cancels via req.signal.
      let result;
      try {
        result = await withProviderRetry(
          // attempt.signal aborts on user stop AND per-attempt timeout, so a
          // timed-out attempt's HTTP request is torn down (frees the provider
          // slot) instead of generating on in the background while we retry
          (attempt) => activeClient.inference({
            ...req,
            signal: attempt?.signal ?? runSignal,
          }),
          {
            ...(this.stream ? { timeoutMs: 0 } : {}),
            ...(this.timeout_ms != null ? { timeoutMs: this.timeout_ms } : {}),
            signal: runSignal,
            ...(this.retry_attempts != null ? { attempts: this.retry_attempts } : {}),
          },
        );
      } catch (err) {
        if (this.aborted || runSignal.aborted || err?.aborted || err?.userAbort) {
          throw abortError(this._abortReason || err?.message || 'user stop');
        }
        throw err;
      }
      if (this.aborted || runSignal.aborted) {
        throw abortError(this._abortReason || 'user stop');
      }
      debug('Agent.run result.', result);

      // Authoritative context size from provider (OpenAI-style usage.prompt_tokens)
      const usage = result?.usage || result?.Usage;
      if (usage && typeof usage === 'object') {
        const pt = Number(
          usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens,
        );
        const ct = Number(
          usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens,
        );
        const tt = Number(usage.total_tokens ?? usage.totalTokens);
        if (Number.isFinite(pt) && pt >= 0) this.last_prompt_tokens = pt;
        if (Number.isFinite(ct) && ct >= 0) this.last_completion_tokens = ct;
        if (Number.isFinite(tt) && tt >= 0) this.last_total_tokens = tt;
        else if (
          Number.isFinite(this.last_prompt_tokens) &&
          Number.isFinite(this.last_completion_tokens)
        ) {
          this.last_total_tokens =
            this.last_prompt_tokens + this.last_completion_tokens;
        }
      }

      // Collect choices that include tool calls. Some gateways (LM Studio /
      // Gemma) set finish_reason to "length" or "stop" while still returning
      // message.tool_calls — treat any non-empty tool_calls as a tool turn.
      const toolCallChoices = (result.choices || []).filter((choice) => {
        const calls = choice?.message?.tool_calls;
        return Array.isArray(calls) && calls.length > 0;
      });

      if (toolCallChoices.length === 0) {
        if (this.output_tool_name && !done) {
          // Model stopped without calling the output tool — bounded nudge loop.
          outputToolFailures += 1;
          const choice0 = result.choices?.[0];
          const assistantMsg = choice0?.message || null;
          const finishReason = choice0?.finish_reason ?? null;
          if (assistantMsg) {
            if (retain) {
              this.pushContext({
                role: 'assistant',
                content: assistantMsg.content ?? '',
                ...(assistantMsg.tool_calls
                  ? { tool_calls: assistantMsg.tool_calls }
                  : {}),
              });
            } else {
              oneshot.push(assistantMsg);
            }
          }

          const remainingTurns = maxTurns - turnsUsed;
          if (remainingTurns <= 0) {
            throw new Error(
              `agent failed to call output tool \`${this.output_tool_name}\` ` +
                `within max_turns=${maxTurns} ` +
                `(output_tool_failures=${outputToolFailures})`,
            );
          }

          let judgeFeedback = null;
          // One turn remaining → LLM-as-judge coaches the final recovery attempt.
          if (remainingTurns === 1) {
            debug('Agent invoking output-tool judge (last turn).', {
              outputToolFailures,
              maxTurns,
            });
            judgeFeedback = await this._judgeMissingOutputTool({
              assistantMsg,
              failedAttempts: outputToolFailures,
              maxTurns,
              remainingTurns,
              finishReason,
            });
          }

          const nudge = {
            role: 'user',
            content: this._buildOutputToolNudge({
              failedAttempts: outputToolFailures,
              remainingTurns,
              maxTurns,
              assistantMsg,
              finishReason,
              judgeFeedback,
            }),
          };
          if (retain) this.pushContext(nudge);
          else oneshot.push(nudge);
          debug('Agent nudging model to call output tool.', {
            tool: this.output_tool_name,
            outputToolFailures,
            remainingTurns,
            hasJudge: Boolean(judgeFeedback),
          });
          continue;
        }
        // Freeform completion: retain assistant (reasoning already pushed above).
        if (retain) {
          const assistantMsg = result.choices?.[0]?.message;
          if (assistantMsg) {
            this.pushContext({
              role: 'assistant',
              content: assistantMsg.content ?? '',
              ...(assistantMsg.tool_calls
                ? { tool_calls: assistantMsg.tool_calls }
                : {}),
            });
          }
        }
        return result;
      }

      // One context_window item per tool_call (1 UI row = 1 item = 1 jsonl event)
      const allCalls = toolCallChoices.flatMap(
        (choice) => choice.message.tool_calls || [],
      );
      for (const call of allCalls) {
        if (retain) {
          this.pushContext({
            role: 'assistant',
            content: '',
            tool_calls: [call],
          });
        } else {
          oneshot.push({
            role: 'assistant',
            content: '',
            tool_calls: [call],
          });
        }
      }

      const runOneTool = async (call) => {
        const name = call?.function?.name || '';
        const rawArgs = call?.function?.arguments ?? '{}';
        let args;
        try {
          args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs;
        } catch (e) {
          // Truncated tool JSON (finish_reason length) — surface as tool error
          return {
            call,
            args: {},
            content: JSON.stringify({
              error: `invalid tool arguments (possibly truncated): ${e.message}`,
              raw: String(rawArgs).slice(0, 400),
            }),
          };
        }
        debug('Agent tool call.', { name, args });
        const fn = this.tools[name];
        if (!fn) {
          return {
            call,
            args,
            content: JSON.stringify({
              error: `unknown tool: ${name}`,
              hint: this.output_tool_name
                ? `Registered tools: ${Object.keys(this.tools).join(', ')}. ` +
                  `To finish you must call \`${this.output_tool_name}\`.`
                : `Registered tools: ${Object.keys(this.tools).join(', ')}.`,
            }),
          };
        }
        try {
          const result = await fn(ctx, args);
          return {
            call,
            args,
            content:
              typeof result === 'string' ? result : JSON.stringify(result),
          };
        } catch (e) {
          return {
            call,
            args,
            content: JSON.stringify({ error: e?.message || String(e) }),
          };
        }
      };

      if (this.parallel_tools) {
        const settled = await Promise.all(allCalls.map(runOneTool));
        for (const { call, args, content } of settled) {
          debug('Agent tool response.', {
            name: call?.function?.name,
            args,
            content,
          });
          if (
            this.output_tool_name &&
            this.output_tool_name == call?.function?.name
          ) {
            done = true;
          }
          const toolMsg = {
            role: 'tool',
            tool_call_id: call.id,
            content,
          };
          if (retain) this.pushContext(toolMsg);
          else oneshot.push(toolMsg);
        }
      } else {
        for (const call of allCalls) {
          const { args, content } = await runOneTool(call);
          debug('Agent tool response.', {
            name: call?.function?.name,
            args,
            content,
          });
          if (
            this.output_tool_name &&
            this.output_tool_name == call?.function?.name
          ) {
            done = true;
          }
          const toolMsg = {
            role: 'tool',
            tool_call_id: call.id,
            content,
          };
          if (retain) this.pushContext(toolMsg);
          else oneshot.push(toolMsg);
        }
      }
      // loop back to send tool results to the AI
    }
  }

  // Compute embeddings for text via a provider, resolved from a "provider:model"
  // spec (e.g. "copilot:text-embedding-3-small", "lm-studio:text-embedding-nomic-embed-text-v1.5").
  // `input` may be a string or an array of strings. Returns the OpenAI-compat
  // shape { model, data:[{ index, embedding }], usage }. Wrapped in the same
  // retry/backoff resilience as inference.
  static async embed({ model, input } = {}) {
    const resolved = model || Agent.default.embed_model;
    if (!resolved) {
      throw new Error('Agent.embed requires model or Agent.default.embed_model');
    }
    const idx = resolved.indexOf(':');
    if (idx <= 0 || idx >= resolved.length - 1) {
      throw new Error(`Invalid model format: ${resolved}. Expected "provider:model".`);
    }
    const provider = resolved.slice(0, idx);
    const modelId = resolved.slice(idx + 1);
    const client = PROVIDERS[provider];
    if (!client) throw new Error(`Unknown provider: ${provider}`);
    if (typeof client.embeddings !== 'function') {
      throw new Error(`Provider ${provider} does not support embeddings`);
    }
    await client.init();
    return await withProviderRetry(() => client.embeddings({ model: modelId, input }));
  }

  // Extract the last assistant response content from a result object
  static lastAssistantResponse(result) {    const choices = result?.choices || [];
    for (let i = choices.length - 1; i >= 0; i--) {
      const msg = choices[i]?.message;
      if (msg?.role === 'assistant' && msg?.content) {
        return msg.content;
      }
    }
    return null;
  }
}
