import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';
import { openaiFetch } from '../lib/openai-gateway.mjs';

let _key = '';
const _baseUrl = 'https://api.x.ai';
/** Default model: Grok 4.5 (chat completions API model id). */
const _defaultModel = 'grok-4.5';

// initialize provider
export async function init() {
  _key = await config.read('XAI_API_KEY');

  if (!_key) {
    // Prefer soft failure so importers can fall back; CLI scripts may still exit.
    const err = new Error('XAI_API_KEY is missing.');
    err.code = 'MISSING_XAI_API_KEY';
    throw err;
  }
}

export function defaultModel() {
  return _defaultModel;
}

async function _fetch({ method, uri, body, signal }) {
  if (!_key) {
    await init();
  }
  debug('xai _request.', { method, uri, body: body ? { ...body, messages: body.messages ? `[${body.messages.length}]` : undefined } : undefined });
  return openaiFetch({
    baseUrl: _baseUrl,
    path: uri,
    method,
    headers: { Authorization: `Bearer ${_key}` },
    body,
    signal,
  });
}

// make an api request
async function _request({ method, uri, body, signal }) {
  const response = await _fetch({ method, uri, body, signal });
  if (response.ok) {
    return response;
  }
  const errorDetails = {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
  debug('xAI _request response.', errorDetails);
  const err = new Error(`XAI Request error: ${response.status} ${response.statusText}`);
  err.status = response.status;
  err.body = errorDetails.body;
  throw err;
}

// list available models
export async function models() {
  const response = await _request({ method: 'GET', uri: '/v1/models' });
  return await response.json();
}

/**
 * Raw OpenAI chat.completions passthrough (gateway). Returns fetch Response.
 */
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

/**
 * Chat completion (OpenAI-compatible).
 * @param {{ model?: string, messages: object[], tools?: object[], tool_choice?: any, max_tokens?: number, reasoning_effort?: string }} opts
 */
export async function inference({
  model = _defaultModel,
  messages,
  tools,
  tool_choice,
  max_tokens,
  reasoning_effort,
} = {}) {
  const body = {
    model: model || _defaultModel,
    messages,
  };
  if (tools?.length) body.tools = tools;
  if (tool_choice !== undefined) body.tool_choice = tool_choice;
  if (max_tokens != null) body.max_tokens = max_tokens;
  if (reasoning_effort) body.reasoning_effort = reasoning_effort;

  const response = await _request({
    method: 'POST',
    uri: '/v1/chat/completions',
    body,
  });
  return await response.json();
}

/**
 * Lightweight smoke: one short completion with grok-4.5 (or `model`).
 * Returns { ok, model, previewLen, id? } without dumping content.
 */
export async function smokeInference({ model = _defaultModel } = {}) {
  const data = await inference({
    model,
    messages: [
      { role: 'system', content: 'Reply with exactly one short sentence.' },
      { role: 'user', content: 'Say hello in five words or fewer.' },
    ],
    max_tokens: 32,
  });
  const content = data?.choices?.[0]?.message?.content ?? '';
  return {
    ok: Boolean(content && content.length > 0),
    model: data?.model || model,
    previewLen: content.length,
    id: data?.id || null,
  };
}


