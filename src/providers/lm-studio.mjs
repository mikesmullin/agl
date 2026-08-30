import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';

const _defaultModel = 'google/gemma-4-12b-qat';

let _baseUrl = '';

// initialize provider
export async function init() {
  _baseUrl = await config.read('LM_STUDIO_BASE_URL') || 'http://127.0.0.1:1234';
}

// make an api request
async function _fetch({ method, uri, body, signal }) {
  if (!_baseUrl) await init();
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    signal,
  };
  if (method && method.toUpperCase() !== 'GET' && body !== undefined) {
    opts.body = JSON.stringify(body ?? {});
  }
  debug('lm-studio _request.', {
    method,
    uri,
    body: body !== undefined && method?.toUpperCase() !== 'GET' ? body : undefined,
  });
  try {
    return await fetch(`${_baseUrl}${uri}`, opts);
  } catch (err) {
    const url = `${_baseUrl}${uri}`;
    const cause = err?.cause ? ` (${String(err.cause).slice(0, 200)})` : '';
    throw new Error(`Unable to connect to LM Studio at ${url}: ${err?.message || err}${cause}. Is LM Studio running? Check LM_STUDIO_BASE_URL (default http://127.0.0.1:1234) and that the model is loaded.`);
  }
}

async function _request({ method, uri, body, signal }) {
  const response = await _fetch({ method, uri, body, signal });
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

// list available models (upstream HTTP; AGL catalog is ~/.config/agl/config.yaml)
export async function models() {
  try {
    const response = await _request({ method: 'GET', uri: '/api/v0/models' });
    return await response.json();
  } catch (err) {
    debug('lm-studio models via /api/v0 failed; falling back to /v1/models.', err);
    const response = await _request({ method: 'GET', uri: '/v1/models' });
    return await response.json();
  }
}

export async function chatCompletionsRequest({ model, body, signal } = {}) {
  const payload = { ...body, model: model || body?.model || _defaultModel };
  return _fetch({
    method: 'POST',
    uri: '/v1/chat/completions',
    body: payload,
    signal,
  });
}

export async function embeddingsRequest({ model, body, signal } = {}) {
  const payload = { ...body, model: model || body?.model };
  return _fetch({
    method: 'POST',
    uri: '/v1/embeddings',
    body: payload,
    signal,
  });
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
  reasoning_effort,
  signal,
}) {
  const body = { model, messages, tools, tool_choice };
  if (max_tokens) body.max_tokens = max_tokens;
  if (reasoning_effort) body.reasoning_effort = reasoning_effort;

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
