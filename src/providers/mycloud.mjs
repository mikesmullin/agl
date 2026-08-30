import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/**
 * mycloud / llama-server — OpenAI-compatible llama.cpp server.
 *
 * Env (process-wide fallback):
 *   MYCLOUD_BASE_URL / LLAMA_SERVER_BASE_URL
 *     — e.g. https://HOST:1234 (GCE) or http://127.0.0.1:1234 (local).
 *       Default when unset: http://127.0.0.1:1234
 *   MYCLOUD_MODEL / LLAMA_SERVER_MODEL — default model id (default: qwen-3.8-27b)
 *   MYCLOUD_API_KEY / LLAMA_SERVER_API_KEY
 *     — required bearer for https://; optional for http:// (local llama-server
 *       often has no --api-key)
 *   MYCLOUD_CA_FILE — PEM CA (https only; default ~/.mycloud/cert.pem)
 *
 * Per-agent / per-request overrides: base_url, api_key, ca_file.
 */

let _baseUrl = '';
let _apiKey = '';
let _caFile = '';
const _tlsCache = new Map();
const _defaultModel = 'qwen-3.8-27b';

function normalizeBase(url) {
  if (!url) return '';
  let u = String(url).trim().replace(/\/+$/, '');
  if (u.endsWith('/v1')) u = u.slice(0, -3);
  return u;
}

function skipHostname() {
  return undefined;
}

function isHttpUrl(url) {
  return String(url || '').startsWith('http://');
}

async function tlsFetchOpts(caFile) {
  const caPath =
    caFile ||
    _caFile ||
    (await config.read('MYCLOUD_CA_FILE')) ||
    join(homedir(), '.mycloud/cert.pem');
  if (_tlsCache.has(caPath)) return _tlsCache.get(caPath);
  let ca = '';
  try {
    ca = await readFile(caPath, 'utf8');
  } catch {
    const empty = {};
    _tlsCache.set(caPath, empty);
    return empty;
  }
  // Reused llama-server certs often have the previous VM IP as SAN.
  // Trust the CA, but do not require the hostname/IP to match.
  const tls = { ca, checkServerIdentity: skipHostname };
  let opts;
  if (typeof Bun !== 'undefined') {
    opts = { tls };
  } else {
    try {
      const { Agent } = await import('undici');
      opts = { dispatcher: new Agent({ connect: tls }) };
    } catch {
      opts = { tls };
    }
  }
  _tlsCache.set(caPath, opts);
  return opts;
}

export async function init(opts = {}) {
  if (opts.ca_file) _caFile = String(opts.ca_file);
  if (opts.base_url) {
    _baseUrl = normalizeBase(opts.base_url);
  } else if (!_baseUrl) {
    _baseUrl = normalizeBase(
      (await config.read('MYCLOUD_BASE_URL')) ||
        (await config.read('LLAMA_SERVER_BASE_URL')) ||
        'http://127.0.0.1:1234',
    );
  }
  if (Object.prototype.hasOwnProperty.call(opts, 'api_key')) {
    _apiKey = opts.api_key == null ? '' : String(opts.api_key);
  } else if (!_apiKey) {
    _apiKey =
      (await config.read('MYCLOUD_API_KEY')) ||
      (await config.read('LLAMA_SERVER_API_KEY')) ||
      '';
  }
  if (opts.base_url || Object.prototype.hasOwnProperty.call(opts, 'api_key')) return;
  if (!_baseUrl) {
    const err = new Error(
      'MYCLOUD_BASE_URL is missing (e.g. https://HOST:1234).',
    );
    err.code = 'MISSING_MYCLOUD_BASE_URL';
    throw err;
  }
  if (!_apiKey && !isHttpUrl(_baseUrl)) {
    const err = new Error(
      'MYCLOUD_API_KEY is missing. Export it (see ~/.bashrc) or llama-server will return 401.',
    );
    err.code = 'MISSING_MYCLOUD_API_KEY';
    throw err;
  }
}

export function defaultModel() {
  return _defaultModel;
}

async function _fetch({ method, uri, body, signal, base_url, api_key, ca_file }) {
  let resolvedBase = normalizeBase(base_url) || _baseUrl;
  let resolvedKey;
  if (api_key !== undefined) {
    resolvedKey = api_key || '';
  } else {
    resolvedKey =
      _apiKey ||
      (await config.read('MYCLOUD_API_KEY')) ||
      (await config.read('LLAMA_SERVER_API_KEY')) ||
      '';
  }
  if (!resolvedBase) {
    await init({
      base_url: resolvedBase,
      ...(api_key !== undefined ? { api_key: resolvedKey } : {}),
      ca_file,
    });
    resolvedBase = normalizeBase(base_url) || _baseUrl;
    if (api_key === undefined) {
      resolvedKey =
        _apiKey ||
        (await config.read('MYCLOUD_API_KEY')) ||
        (await config.read('LLAMA_SERVER_API_KEY')) ||
        '';
    }
  }
  if (!resolvedBase) {
    const err = new Error('MYCLOUD_BASE_URL is missing (e.g. https://HOST:1234 or http://127.0.0.1:1234).');
    err.code = 'MISSING_MYCLOUD_BASE_URL';
    throw err;
  }
  if (!resolvedKey && !isHttpUrl(resolvedBase)) {
    const err = new Error(
      'MYCLOUD_API_KEY is missing. Export it (see ~/.bashrc) or llama-server will return 401.',
    );
    err.code = 'MISSING_MYCLOUD_API_KEY';
    throw err;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (resolvedKey) headers.Authorization = `Bearer ${resolvedKey}`;

  const tlsOpts = isHttpUrl(resolvedBase) ? {} : await tlsFetchOpts(ca_file);
  const opts = { method, headers, signal, ...tlsOpts };
  if (body !== undefined && method && method.toUpperCase() !== 'GET') {
    opts.body = JSON.stringify(body);
  }

  debug('mycloud _request.', {
    method,
    uri,
    base: resolvedBase,
    body: body
      ? { ...body, messages: body.messages ? `[${body.messages.length}]` : undefined }
      : undefined,
  });

  try {
    return await fetch(`${resolvedBase}${uri}`, opts);
  } catch (err) {
    const url = `${resolvedBase}${uri}`;
    const cause = err?.cause ? ` (${String(err.cause).slice(0, 200)})` : '';
    throw new Error(
      `Unable to connect to llama-server at ${url}: ${err?.message || err}${cause}. Check MYCLOUD_BASE_URL.`,
    );
  }
}

async function _request({ method, uri, body, signal, base_url, api_key, ca_file }) {
  const response = await _fetch({ method, uri, body, signal, base_url, api_key, ca_file });
  if (response.ok) return response;

  const errorBody = await response.text();
  debug('mycloud _request error.', {
    status: response.status,
    statusText: response.statusText,
    body: errorBody,
  });
  console.error(`[mycloud] ${response.status} ${response.statusText}`);
  if (errorBody) console.error(`[mycloud] response body: ${errorBody}`);
  const err = new Error(`mycloud request error: ${response.status} ${response.statusText}`);
  err.status = response.status;
  err.body = errorBody;
  throw err;
}

export async function models() {
  const timeoutMs = Number(process.env.AGL_LIST_MODELS_TIMEOUT_MS || 4000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await _request({
      method: 'GET',
      uri: '/v1/models',
      signal: ac.signal,
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function chatCompletionsRequest({
  model,
  body,
  signal,
  base_url,
  api_key,
  ca_file,
} = {}) {
  const payload = {
    ...body,
    model:
      model ||
      body?.model ||
      (await config.read('MYCLOUD_MODEL')) ||
      _defaultModel,
  };
  return _fetch({
    method: 'POST',
    uri: '/v1/chat/completions',
    body: payload,
    signal,
    base_url,
    api_key,
    ca_file,
  });
}

export async function embeddingsRequest({
  model,
  body,
  signal,
  base_url,
  api_key,
  ca_file,
} = {}) {
  const payload = { ...body, model: model || body?.model };
  return _fetch({
    method: 'POST',
    uri: '/v1/embeddings',
    body: payload,
    signal,
    base_url,
    api_key,
    ca_file,
  });
}

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
  on_delta,
  signal,
  base_url,
  api_key,
  ca_file,
} = {}) {
  const resolved =
    model ||
    (await config.read('MYCLOUD_MODEL')) ||
    _defaultModel;

  const body = {
    model: resolved,
    messages,
    stream: Boolean(stream),
  };
  if (tools?.length) body.tools = tools;
  if (tool_choice !== undefined) body.tool_choice = tool_choice;
  if (max_tokens != null) body.max_tokens = max_tokens;
  if (temperature != null) body.temperature = temperature;
  else body.temperature = 1.0;
  if (top_p != null) body.top_p = top_p;
  else body.top_p = 0.95;
  if (top_k != null) body.top_k = top_k;
  if (chat_template_kwargs && typeof chat_template_kwargs === 'object') {
    body.chat_template_kwargs = chat_template_kwargs;
  }
  if (reasoning_effort) body.reasoning_effort = reasoning_effort;

  if (!stream) {
    const response = await _request({
      method: 'POST',
      uri: '/v1/chat/completions',
      body,
      signal,
      base_url,
      api_key,
      ca_file,
    });
    return await response.json();
  }

  body.stream = true;
  body.stream_options = { include_usage: true };
  const response = await _request({
    method: 'POST',
    uri: '/v1/chat/completions',
    body,
    signal,
    base_url,
    api_key,
    ca_file,
  });

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  let finish_reason = null;
  let usage = null;
  let reasoning = '';
  let buf = '';

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
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish_reason = choice.finish_reason;
    const delta = choice.delta || {};
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
          toolCalls[i] = {
            id: tc.id || `call_${i}`,
            type: 'function',
            function: { name: '', arguments: '' },
          };
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
