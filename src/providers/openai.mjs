import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';
import { openaiFetch } from '../lib/openai-gateway.mjs';

let _key = '';
const _baseUrl = 'https://api.openai.com';
const _defaultModel = 'gpt-4.1-mini';

export const KNOWN_MODELS = ['gpt-4.1', 'gpt-4.1-mini', 'o4-mini'];

export async function init() {
  _key = await config.read('OPENAI_API_KEY');
  if (!_key) {
    const err = new Error('OPENAI_API_KEY is missing.');
    err.code = 'MISSING_OPENAI_API_KEY';
    throw err;
  }
}

export function defaultModel() {
  return _defaultModel;
}

async function _fetch({ method, uri, body, signal }) {
  if (!_key) await init();
  debug('openai _request.', {
    method,
    uri,
    body: body
      ? { ...body, messages: body.messages ? `[${body.messages.length}]` : undefined }
      : undefined,
  });
  return openaiFetch({
    baseUrl: _baseUrl,
    path: uri,
    method,
    headers: { Authorization: `Bearer ${_key}` },
    body,
    signal,
  });
}

async function _request({ method, uri, body, signal }) {
  const response = await _fetch({ method, uri, body, signal });
  if (response.ok) return response;
  const errorDetails = {
    status: response.status,
    statusText: response.statusText,
    body: await response.text(),
  };
  debug('openai _request response.', errorDetails);
  const err = new Error(`OpenAI Request error: ${response.status} ${response.statusText}`);
  err.status = response.status;
  err.body = errorDetails.body;
  throw err;
}

export async function models() {
  const response = await _request({ method: 'GET', uri: '/v1/models' });
  return await response.json();
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

export async function inference({
  model = _defaultModel,
  messages,
  tools,
  tool_choice,
  max_tokens,
  reasoning_effort,
} = {}) {
  const body = { model: model || _defaultModel, messages };
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

export function contextWindowSize(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('gpt-4.1')) return 1_047_576;
  if (m.includes('o4')) return 200_000;
  return 128_000;
}
