let _key = '';
let _baseUrl = '';
const _defaultModel = 'muse-spark-1.2-contributor';

export const KNOWN_MODELS = [
  'muse-1.2',
  'muse-1.2-contributor',
  'muse-spark-1.2',
  'muse-spark',
];

function _debug(...args) {
  if (process.env.DEBUG) console.debug('[muse]', ...args);
}

async function _readEnv(name) {
  return process.env[name] || null;
}

export async function init() {
  _key = await _readEnv('MUSE_API_KEY');
  // Hard-coded Meta Muse endpoint per project requirement
  _baseUrl = 'https://api.meta.ai/v1';

  _baseUrl = String(_baseUrl).trim().replace(/\/+$/, '');
  if (_baseUrl.endsWith('/v1')) _baseUrl = _baseUrl.slice(0, -3);

  if (!_key) {
    const err = new Error('MUSE_API_KEY is missing. Copy .env.example to .env and set MUSE_API_KEY, or export MUSE_API_KEY in your shell.');
    err.code = 'MISSING_MUSE_API_KEY';
    throw err;
  }
}

export function defaultModel() {
  return _defaultModel;
}

async function _request({ method, uri, body, signal }) {
  if (!_key) await init();
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${_key}`,
    },
  };
  if (signal) opts.signal = signal;
  if (body !== undefined) opts.body = JSON.stringify(body);
  _debug('_request', { method, uri, body: body ? { ...body, messages: body.messages ? `[${body.messages.length}]` : undefined } : undefined });
  const response = await fetch(`${_baseUrl}${uri}`, opts);
  if (response.ok) return response;
  const errorBody = await response.text();
  const errorDetails = {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers),
    body: errorBody,
  };
  _debug('request error', errorDetails);
  console.error(`[muse] ${response.status} ${response.statusText}`);
  if (errorBody) console.error(`[muse] response body: ${errorBody.slice(0, 2000)}`);
  const err = new Error(`Muse request error: ${response.status} ${response.statusText}`);
  err.status = response.status;
  err.body = errorBody;
  try {
    const parsed = JSON.parse(errorBody);
    const e = parsed?.error ?? parsed;
    if (e?.message) err.message += ` — ${String(e.message).slice(0, 500)}`;
  } catch {}
  throw err;
}

export async function models() {
  const response = await _request({ method: 'GET', uri: '/v1/models' });
  return await response.json();
}

export async function inference({
  model = _defaultModel,
  messages,
  tools,
  tool_choice,
  max_tokens,
  reasoning_effort,
  signal,
} = {}) {
  const body = { model: model || _defaultModel, messages };
  if (tools?.length) body.tools = tools;
  // Muse only supports "auto" — when output_tool is defined (tools present),
  // Agent sets tool_choice="required" but Muse rejects it, so map to "auto"
  if (tools?.length) {
    body.tool_choice = "auto";
  } else if (tool_choice !== undefined) {
    let tc = tool_choice;
    if (tc === "required" || tc === "none") tc = "auto";
    else if (typeof tc === "object" && tc !== null && (tc.type === "function" || tc.function)) tc = "auto";
    body.tool_choice = tc;
  }
  if (max_tokens != null) body.max_tokens = max_tokens;
  if (reasoning_effort) body.reasoning_effort = reasoning_effort;
  const response = await _request({ method: 'POST', uri: '/v1/chat/completions', body, signal });
  return await response.json();
}

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

export function contextWindowSize(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('muse-1.2') || m.includes('muse-1')) return 131_072;
  if (m.includes('muse')) return 131_072;
  return 32_768;
}
