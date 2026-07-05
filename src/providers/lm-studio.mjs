import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';

const _defaultModel = 'google/gemma-4-e4b';

let _baseUrl = '';

// initialize provider
export async function init() {
  _baseUrl = await config.read('LM_STUDIO_BASE_URL') || 'http://127.0.0.1:1234';
}

// make an api request
async function _request({ method, uri, body = {} }) {
  const _body = JSON.stringify(body);
  debug('lm-studio _request.', { method, uri, body });
  const response = await fetch(`${_baseUrl}${uri}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: _body,
  });
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

// list available models
export async function models() {
  const response = await _request({ method: 'GET', uri: '/v1/models' });
  return await response.json();
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
export async function inference({ model = _defaultModel, messages, tools, tool_choice, stream, on_delta, max_tokens }) {
  const body = { model, messages, tools, tool_choice };
  if (max_tokens) body.max_tokens = max_tokens;

  if (!stream) {
    const response = await _request({
      method: 'POST',
      uri: '/v1/chat/completions',
      body,
    });
    return await response.json();
  }

  body.stream = true;
  const response = await _request({
    method: 'POST',
    uri: '/v1/chat/completions',
    body,
  });

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  let finish_reason = null;
  let usage = null;
  let buf = '';

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
    if (delta.content) {
      message.content += delta.content;
      if (on_delta) {
        try { on_delta(delta.content); } catch (err) { debug('on_delta error.', err); }
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

  while (true) {
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

  const assembled = toolCalls.filter(Boolean);
  if (assembled.length) message.tool_calls = assembled;
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
