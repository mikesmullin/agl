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

async function _request({ method, uri, body }) {
  if (!_baseUrl) await init();
  const headers = { 'Content-Type': 'application/json' };
  // Only attach bearer if it looks like an inference auth key was intentionally set.
  // Prefer RUNPOD_INFERENCE_API_KEY so the console RUNPOD_API_KEY is not sent to the pod.
  const inferKey = await config.read('RUNPOD_INFERENCE_API_KEY');
  if (inferKey) headers.Authorization = `Bearer ${inferKey}`;

  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  debug('runpod _request.', {
    method,
    uri,
    base: _baseUrl,
    body: body
      ? { ...body, messages: body.messages ? `[${body.messages.length}]` : undefined }
      : undefined,
  });

  const response = await fetch(`${_baseUrl}${uri}`, opts);
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
