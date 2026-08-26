import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';

/**
 * RunPod provider — OpenAI-compatible inference against a pod you run
 * (vLLM, llama-server, etc. exposed via RunPod HTTP proxy or SSH tunnel).
 *
 * Env:
 *   RUNPOD_BASE_URL  — e.g. https://{podId}-8910.proxy.runpod.net
 *                      (with or without trailing /v1)
 *   RUNPOD_API_KEY   — optional Authorization bearer for the inference server
 *                      (usually unset for private tunnels; not the RunPod console key)
 *   RUNPOD_MODEL     — default model id (default: MiniMax-M3)
 */

let _baseUrl = '';
let _apiKey = '';
const _defaultModel = 'MiniMax-M3';

function normalizeBase(url) {
  if (!url) return '';
  let u = String(url).trim().replace(/\/+$/, '');
  // Accept either root or /v1; we always call /v1/...
  if (u.endsWith('/v1')) u = u.slice(0, -3);
  return u;
}

export async function init() {
  _baseUrl = normalizeBase(
    (await config.read('RUNPOD_BASE_URL')) ||
      (await config.read('RUNPOD_PROXY_URL')) ||
      '',
  );
  _apiKey = (await config.read('RUNPOD_INFERENCE_API_KEY')) || (await config.read('RUNPOD_API_KEY')) || '';

  if (!_baseUrl) {
    const err = new Error(
      'RUNPOD_BASE_URL is missing (e.g. https://<podId>-8910.proxy.runpod.net).',
    );
    err.code = 'MISSING_RUNPOD_BASE_URL';
    throw err;
  }
}

export function defaultModel() {
  return _defaultModel;
}

async function _fetch({ method, uri, body, signal }) {
  if (!_baseUrl) await init();
  const headers = { 'Content-Type': 'application/json' };
  const inferKey = await config.read('RUNPOD_INFERENCE_API_KEY');
  if (inferKey) headers.Authorization = `Bearer ${inferKey}`;
  const opts = { method, headers, signal };
  if (body !== undefined && method && method.toUpperCase() !== 'GET') {
    opts.body = JSON.stringify(body);
  }

  debug('runpod _request.', {
    method,
    uri,
    base: _baseUrl,
    body: body
      ? { ...body, messages: body.messages ? `[${body.messages.length}]` : undefined }
      : undefined,
  });

  return fetch(`${_baseUrl}${uri}`, opts);
}

async function _request({ method, uri, body, signal }) {
  const response = await _fetch({ method, uri, body, signal });
  if (response.ok) return response;

  const errorBody = await response.text();
  const errorDetails = {
    status: response.status,
    statusText: response.statusText,
    body: errorBody,
  };
  debug('runpod _request error.', errorDetails);
  console.error(`[runpod] ${response.status} ${response.statusText}`);
  if (errorBody) console.error(`[runpod] response body: ${errorBody}`);
  const err = new Error(`RunPod request error: ${response.status} ${response.statusText}`);
  err.status = response.status;
  err.body = errorBody;
  throw err;
}

export async function models() {
  const response = await _request({ method: 'GET', uri: '/v1/models' });
  return await response.json();
}

export async function chatCompletionsRequest({ model, body, signal } = {}) {
  if (!_baseUrl) await init();
  const payload = {
    ...body,
    model:
      model ||
      body?.model ||
      (await config.read('RUNPOD_MODEL')) ||
      _defaultModel,
  };
  return _fetch({
    method: 'POST',
    uri: '/v1/chat/completions',
    body: payload,
    signal,
  });
}

/**
 * Chat completion (OpenAI-compatible / vLLM).
 * Non-streaming by default — preferred while debugging Gemma 4 tool/reasoning loops.
 *
 * @param {{
 *   model?: string,
 *   messages: object[],
 *   tools?: object[],
 *   tool_choice?: any,
 *   max_tokens?: number,
 *   temperature?: number,
 *   top_p?: number,
 *   top_k?: number,
 *   stream?: boolean,
 *   chat_template_kwargs?: object,
 *   reasoning_effort?: string,
 * }} opts
 */
export async function inference({
  model,
  messages,
  tools,
  tool_choice,
  max_tokens,
  temperature,
  top_p,
  top_k,
  stream = false,
  chat_template_kwargs,
  reasoning_effort,
} = {}) {
  const resolved =
    model ||
    (await config.read('RUNPOD_MODEL')) ||
    _defaultModel;

  const body = {
    model: resolved,
    messages,
    stream: Boolean(stream),
  };
  if (tools?.length) body.tools = tools;
  if (tool_choice !== undefined) body.tool_choice = tool_choice;
  if (max_tokens != null) body.max_tokens = max_tokens;
  // Gemma 4 / many open models: temp=1.0, top_p=0.95 (model generation_config often agrees)
  if (temperature != null) body.temperature = temperature;
  else body.temperature = 1.0;
  if (top_p != null) body.top_p = top_p;
  else body.top_p = 0.95;
  if (top_k != null) body.top_k = top_k;
  // vLLM: enable Gemma thinking channel when server uses gemma4 chat template + reasoning parser
  if (chat_template_kwargs && typeof chat_template_kwargs === 'object') {
    body.chat_template_kwargs = chat_template_kwargs;
  }
  if (reasoning_effort) body.reasoning_effort = reasoning_effort;

  const response = await _request({
    method: 'POST',
    uri: '/v1/chat/completions',
    body,
  });
  return await response.json();
}

/**
 * Lightweight smoke: one short completion (non-streaming).
 * Accepts content or reasoning/reasoning_content so thinking-only replies still pass.
 */
export async function smokeInference({ model } = {}) {
  const data = await inference({
    model,
    messages: [
      { role: 'system', content: 'Reply with exactly one short sentence.' },
      { role: 'user', content: 'Say hello in five words or fewer.' },
    ],
    max_tokens: 64,
    stream: false,
  });
  const msg = data?.choices?.[0]?.message || {};
  const content = msg.content ?? '';
  const reasoning = msg.reasoning_content ?? msg.reasoning ?? '';
  const previewLen = String(content || reasoning || '').length;
  return {
    ok: previewLen > 0,
    model: data?.model || model || _defaultModel,
    previewLen,
    id: data?.id || null,
    hasContent: Boolean(content && String(content).length),
    hasReasoning: Boolean(reasoning && String(reasoning).length),
  };
}

/**
 * Max context window (tokens) for a RunPod-hosted model id.
 * @param {string} model
 * @returns {number}
 */
export function contextWindowSize(model) {
  const m = String(model || '').toLowerCase();
  // Gemma 4 MoE 26B-A4B — 256K
  if (
    m.includes('gemma4') ||
    m.includes('gemma-4') ||
    m.includes('26b-a4b') ||
    m.includes('26b_a4b')
  ) {
    return 262_144;
  }
  if (m.includes('minimax') || m.includes('m3')) return 196_608;
  return 32_768;
}
