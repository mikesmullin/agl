import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';

const _defaultModel = 'google/gemma-4-e4b';

let _baseUrl = '';

/**
 * Live context limits from LM Studio native `GET /api/v0/models`:
 *   loaded_context_length — n_ctx of the currently loaded instance (authoritative)
 *   max_context_length    — model card maximum (not the loaded size)
 *
 * Keyed by model id (exact + lowercased). Populated by refreshContextWindows().
 * @type {Map<string, { loaded: number|null, max: number|null, state: string|null }>}
 */
const _ctxById = new Map();
let _ctxFetchedAt = 0;
/** Re-fetch at most every 5s unless force=true (UI polls / model reloads). */
const CTX_TTL_MS = 5_000;

// initialize provider
export async function init() {
  _baseUrl = await config.read('LM_STUDIO_BASE_URL') || 'http://127.0.0.1:1234';
  // Best-effort: warm loaded_context_length cache (pie / context_window_size).
  try {
    await refreshContextWindows({ force: true });
  } catch (err) {
    debug('lm-studio init context refresh failed.', err);
  }
}

// make an api request
async function _request({ method, uri, body, signal }) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    signal,
  };
  // Only attach a body for non-GET (some servers reject GET with body).
  if (method && method.toUpperCase() !== 'GET' && body !== undefined) {
    opts.body = JSON.stringify(body ?? {});
  }
  debug('lm-studio _request.', {
    method,
    uri,
    body: body !== undefined && method?.toUpperCase() !== 'GET' ? body : undefined,
  });
  const response = await fetch(`${_baseUrl}${uri}`, opts);
  if (response.ok) {
    return response;
  }
  const errorBody = await response.text();
  const errorDetails = {
    status: response.status,
    statusText: response.statusText,
    body: errorBody,
  };
  debug('lm-studio _request error.', errorDetails);
  // Always emit provider error details so root-cause is visible without DEBUG.
  console.error(`[lm-studio] ${response.status} ${response.statusText}`);
  if (errorBody) {
    console.error(`[lm-studio] response body: ${errorBody}`);
  }
  throw new Error(`LM Studio request error: ${response.status} ${response.statusText}`);
}

/**
 * Query LM Studio native models API for loaded/max context lengths.
 * OpenAI-compat `/v1/models` does NOT include these fields.
 *
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<Map<string, { loaded: number|null, max: number|null, state: string|null }>>}
 */
export async function refreshContextWindows(opts = {}) {
  const force = Boolean(opts.force);
  const now = Date.now();
  if (!force && _ctxById.size && now - _ctxFetchedAt < CTX_TTL_MS) {
    return _ctxById;
  }
  if (!_baseUrl) {
    _baseUrl = (await config.read('LM_STUDIO_BASE_URL')) || 'http://127.0.0.1:1234';
  }
  const response = await _request({ method: 'GET', uri: '/api/v0/models' });
  const json = await response.json();
  const rows = Array.isArray(json?.data) ? json.data : [];
  _ctxById.clear();
  for (const row of rows) {
    const id = row?.id != null ? String(row.id) : '';
    if (!id) continue;
    const loadedRaw = row.loaded_context_length ?? row.loadedContextLength;
    const maxRaw = row.max_context_length ?? row.maxContextLength;
    const loaded = Number(loadedRaw);
    const max = Number(maxRaw);
    const entry = {
      loaded: Number.isFinite(loaded) && loaded > 0 ? loaded : null,
      max: Number.isFinite(max) && max > 0 ? max : null,
      state: row.state != null ? String(row.state) : null,
    };
    _ctxById.set(id, entry);
    _ctxById.set(id.toLowerCase(), entry);
    // Also index bare suffix after last slash (gemma-4-31b-qat)
    const slash = id.lastIndexOf('/');
    if (slash >= 0) {
      const bare = id.slice(slash + 1);
      if (bare && !_ctxById.has(bare)) _ctxById.set(bare, entry);
      if (bare && !_ctxById.has(bare.toLowerCase())) {
        _ctxById.set(bare.toLowerCase(), entry);
      }
    }
  }
  _ctxFetchedAt = now;
  debug('lm-studio refreshContextWindows.', {
    n: rows.length,
    sample: rows.slice(0, 3).map((r) => ({
      id: r.id,
      loaded: r.loaded_context_length,
      max: r.max_context_length,
      state: r.state,
    })),
  });
  return _ctxById;
}

function _lookupCtx(model) {
  if (!model || !_ctxById.size) return null;
  const raw = String(model).trim();
  if (_ctxById.has(raw)) return _ctxById.get(raw);
  const lower = raw.toLowerCase();
  if (_ctxById.has(lower)) return _ctxById.get(lower);
  const slash = raw.lastIndexOf('/');
  if (slash >= 0) {
    const bare = raw.slice(slash + 1);
    if (_ctxById.has(bare)) return _ctxById.get(bare);
    if (_ctxById.has(bare.toLowerCase())) return _ctxById.get(bare.toLowerCase());
  }
  // Fuzzy: any cached id that ends with model or contains it
  for (const [k, v] of _ctxById) {
    if (k.includes(lower) || lower.includes(k)) return v;
  }
  return null;
}

// list available models
export async function models() {
  // Prefer native v0 (includes loaded_context_length); fall back to OpenAI-compat.
  try {
    await refreshContextWindows({ force: true });
    const response = await _request({ method: 'GET', uri: '/api/v0/models' });
    const json = await response.json();
    return {
      object: 'list',
      data: (json?.data || []).map((r) => ({
        id: r.id,
        object: 'model',
        owned_by: r.publisher || 'organization_owner',
        state: r.state,
        max_context_length: r.max_context_length,
        loaded_context_length: r.loaded_context_length,
      })),
    };
  } catch (err) {
    debug('lm-studio models via /api/v0 failed; falling back to /v1/models.', err);
    const response = await _request({ method: 'GET', uri: '/v1/models' });
    return await response.json();
  }
}

// request a completion (openai-compatible)
//
// stream: when truthy, requests SSE streaming and re-assembles the chunks
// into the normal non-streaming response shape (same approach as the
// copilot provider), so callers see one result either way. on_delta, if
// given, is called with each content token as it arrives — this is what
// lets a caller (e.g. Ada's brain) start acting on the first sentence
// before the full reply exists. Tool-call deltas are assembled too, so
// streaming works with tools enabled.
export async function inference({
  model = _defaultModel,
  messages,
  tools,
  tool_choice,
  stream,
  on_delta,
  max_tokens,
  signal,
}) {
  const body = { model, messages, tools, tool_choice };
  if (max_tokens) body.max_tokens = max_tokens;

  if (!stream) {
    const response = await _request({
      method: 'POST',
      uri: '/v1/chat/completions',
      body,
      signal,
    });
    return await response.json();
  }

  body.stream = true;
  // Ask for usage on the final SSE chunk (OpenAI stream_options).
  body.stream_options = { include_usage: true };
  const response = await _request({
    method: 'POST',
    uri: '/v1/chat/completions',
    body,
    signal,
  });

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  let finish_reason = null;
  let usage = null;
  let reasoning = '';
  let buf = '';

  // If the agent aborts mid-stream, cancel the body reader promptly.
  const onAbort = () => {
    try {
      reader.cancel('aborted');
    } catch {
      /* ignore */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish_reason = choice.finish_reason;
    const delta = choice.delta || {};
    // Gemma 4 / LM Studio thinking channel (also reasoning, reasoning_text)
    const rdelta =
      delta.reasoning_content ??
      delta.reasoning ??
      delta.reasoning_text ??
      delta.thinking;
    if (typeof rdelta === 'string' && rdelta) {
      reasoning += rdelta;
      if (on_delta) {
        try {
          on_delta(rdelta, { channel: 'reasoning' });
        } catch (err) {
          debug('on_delta reasoning error.', err);
        }
      }
    }
    if (delta.content) {
      message.content += delta.content;
      if (on_delta) {
        try {
          on_delta(delta.content, { channel: 'content' });
        } catch (err) {
          debug('on_delta error.', err);
        }
      }
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        if (!toolCalls[i]) {
          toolCalls[i] = { id: tc.id || `call_${i}`, type: 'function', function: { name: '', arguments: '' } };
        }
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        const e = new Error(
          typeof signal.reason === 'string' ? signal.reason : 'user stop',
        );
        e.name = 'AbortError';
        e.aborted = true;
        e.userAbort = true;
        throw e;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx).trim());
        buf = buf.slice(idx + 1);
      }
    }
    if (buf.trim()) handleLine(buf.trim());
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      const e = new Error(
        typeof signal?.reason === 'string'
          ? signal.reason
          : err?.message || 'user stop',
      );
      e.name = 'AbortError';
      e.aborted = true;
      e.userAbort = true;
      throw e;
    }
    throw err;
  } finally {
    if (signal) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        /* ignore */
      }
    }
  }

  const assembled = toolCalls.filter(Boolean);
  if (assembled.length) message.tool_calls = assembled;
  if (reasoning) message.reasoning_content = reasoning;
  return {
    choices: [{
      message,
      finish_reason: finish_reason || (assembled.length ? 'tool_calls' : 'stop'),
    }],
    usage,
  };
}

// request embeddings (openai-compatible). LM Studio serves an embedding model
// (e.g. `text-embedding-nomic-embed-text-v1.5`) at /v1/embeddings. Load an
// embedding model in LM Studio and pass its id as `model`.
// Returns the OpenAI-compat shape: { object, data:[{ index, embedding }], model, usage }.
export async function embeddings({ model, input }) {
  if (!model) throw new Error('lm-studio.embeddings: model is required');
  const arr = Array.isArray(input) ? input : [input];
  const response = await _request({
    method: 'POST',
    uri: '/v1/embeddings',
    body: { model, input: arr },
  });
  return await response.json();
}

/**
 * Hard-coded fallbacks when `/api/v0/models` is unreachable or the model is
 * not listed yet. Prefer refreshContextWindows() + loaded_context_length.
 *
 * @param {string} model
 * @returns {number}
 */
function _staticContextWindowSize(model) {
  const m = String(model || '').toLowerCase();
  // Historical guesses only — actual n_ctx is whatever LM Studio loaded.
  if (
    m.includes('gemma-4-12b-qat') ||
    m.includes('gemma-4-12b') ||
    m.includes('google/gemma-4-12b')
  ) {
    return 120_000;
  }
  if (m.includes('gemma-4') || m.includes('gemma4') || m.includes('e4b')) {
    return 32_768;
  }
  if (m.includes('qwen3.6') || m.includes('fablevibes')) return 32_768;
  if (m.includes('qwen3.5') || m.includes('qwen3') || m.includes('qwen/')) {
    return 32_768;
  }
  if (m.includes('llama') && m.includes('70b')) return 32_768;
  return 32_768;
}

/**
 * Max context window (tokens) for an LM Studio model id.
 *
 * Prefer live data from `GET /api/v0/models`:
 *   1. loaded_context_length when the model is loaded (true n_ctx — e.g. 8192)
 *   2. max_context_length when not loaded (model card max)
 *   3. static table fallback
 *
 * Call `await refreshContextWindows()` (or `init()`) before this if you need
 * a fresh value — this function is sync for Agent.resolveContextWindow callers.
 *
 * @param {string} model
 * @returns {number}
 */
export function contextWindowSize(model) {
  const hit = _lookupCtx(model);
  if (hit?.loaded != null) {
    // Authoritative: n_ctx of the currently loaded instance (e.g. 8192).
    // Do NOT use max_context_length here — that is the GGUF card max (often
    // 128k–262k), not the size the user loaded, and it wildly mis-sizes the pie.
    return hit.loaded;
  }
  return _staticContextWindowSize(model);
}
