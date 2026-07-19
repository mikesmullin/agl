import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';

const _tokensPath = resolve(import.meta.dir, '../../.copilot_tokens.json');
const _defaultModel = 'claude-sonnet-5';

const _config = {
  github: {
    device_code_url: 'https://github.com/login/device/code',
    access_token_url: 'https://github.com/login/oauth/access_token',
    client_id: 'Iv1.b507a08c87ecfe98',
    user_agent: 'GitHubCopilot/1.155.0',
  },
  copilot: {
    token_url: 'https://api.github.com/copilot_internal/v2/token',
    default_api_url: 'https://api.githubcopilot.com',
    editor_version: 'vscode/1.85.1',
    editor_plugin_version: 'copilot/1.155.0',
    user_agent: 'GitHubCopilot/1.155.0',
    integration_id: 'vscode-chat',
  },
};

let _tokens = null;

// --- token persistence ---

async function _loadTokens() {
  try {
    return JSON.parse(await readFile(_tokensPath, 'utf-8'));
  } catch {
    return null;
  }
}

async function _saveTokens(tokens) {
  await mkdir(dirname(_tokensPath), { recursive: true });
  await writeFile(_tokensPath, JSON.stringify(tokens, null, 2));
}

// --- github device-flow auth ---

async function _startDeviceFlow() {
  const res = await fetch(_config.github.device_code_url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': _config.github.user_agent,
    },
    body: JSON.stringify({
      client_id: _config.github.client_id,
      scope: 'read:user',
    }),
  });
  if (!res.ok) throw new Error(`Device flow failed: ${res.statusText}`);
  return await res.json();
}

async function _pollForAccessToken(deviceCode, interval) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval * 1000));
    const res = await fetch(_config.github.access_token_url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': _config.github.user_agent,
      },
      body: JSON.stringify({
        client_id: _config.github.client_id,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await res.json();
    if (data.access_token) return data.access_token;
    if (data.error === 'authorization_pending') continue;
    throw new Error(`Auth failed: ${data.error_description || data.error}`);
  }
  throw new Error('Authentication timed out');
}

async function _getCopilotToken(githubToken) {
  const res = await fetch(_config.copilot.token_url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${githubToken}`,
      'User-Agent': _config.copilot.user_agent,
      'Editor-Version': _config.copilot.editor_version,
      'Editor-Plugin-Version': _config.copilot.editor_plugin_version,
    },
  });
  if (!res.ok) throw new Error(`Failed to get Copilot token: ${res.statusText}`);
  return await res.json();
}

async function _authenticate() {
  const flow = await _startDeviceFlow();
  console.log(`\nVisit: ${flow.verification_uri}`);
  console.log(`Enter code: ${flow.user_code}\n`);
  const githubToken = await _pollForAccessToken(flow.device_code, flow.interval);
  console.log('GitHub authenticated.');

  const copilotData = await _getCopilotToken(githubToken);
  console.log('Copilot token obtained.');

  const tokens = {
    github_token: githubToken,
    copilot_token: copilotData.token,
    expires_at: copilotData.expires_at,
    api_url: copilotData.endpoints?.api || _config.copilot.default_api_url,
  };
  await _saveTokens(tokens);
  return tokens;
}

// --- session: load / refresh / auth ---

// Deduplicate concurrent session refreshes. When many Agent.factory()/init()
// calls run in parallel (e.g. a parallelized batch), they would otherwise each
// see the same expired token and each hit the refresh endpoint. Instead, the
// first caller starts the refresh and stores its promise here; everyone else
// awaits the same promise and reuses the freshly-minted token.
let _sessionPromise = null;

async function _getSession({ force = false } = {}) {
  // A valid cached token needs no coordination — return it immediately.
  if (!force && _tokens?.copilot_token && _tokens.expires_at * 1000 > Date.now()) {
    return _tokens;
  }
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = _refreshSession({ force }).finally(() => {
    _sessionPromise = null;
  });
  return _sessionPromise;
}

async function _refreshSession({ force = false } = {}) {
  let tokens = await _loadTokens();

  // valid copilot token (another process may have just refreshed it on disk)
  if (!force && tokens?.copilot_token && tokens.expires_at * 1000 > Date.now()) {
    return tokens;
  }

  // refresh with existing github token
  if (tokens?.github_token) {
    console.debug('Refreshing Copilot token...');
    try {
      const data = await _getCopilotToken(tokens.github_token);
      tokens.copilot_token = data.token;
      tokens.expires_at = data.expires_at;
      tokens.api_url = data.endpoints?.api || _config.copilot.default_api_url;
      await _saveTokens(tokens);
      return tokens;
    } catch {
      console.warn('Cached GitHub token invalid, re-authenticating.');
    }
  }

  // fresh device-flow auth
  return await _authenticate();
}

// --- public interface ---

export async function init() {
  _tokens = await _getSession();
}

async function _request({ method, uri, body, extraHeaders, signal }) {
  if (!_tokens) throw new Error('copilot: call init() first');
  const url = `${_tokens.api_url}${uri}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${_tokens.copilot_token}`,
      'Editor-Version': _config.copilot.editor_version,
      'Editor-Plugin-Version': _config.copilot.editor_plugin_version,
      'User-Agent': _config.copilot.user_agent,
      'Copilot-Integration-Id': _config.copilot.integration_id,
      'OpenAI-Intent': 'conversation-panel',
      ...(extraHeaders || {}),
    },
  };
  if (signal) opts.signal = signal;
  if (body) opts.body = JSON.stringify(body);
  debug('copilot _request.', { method, uri, body });

  // NOTE: retry/backoff and per-call timeout are handled generically in the
  // agent provider-invocation loop (applies to all providers), not here.
  const res = await fetch(url, opts);
  if (res.status === 401) {
    console.warn('Copilot token expired, refreshing...');
    _tokens = await _getSession({ force: true });
    return _request({ method, uri, body, extraHeaders });
  }

  if (res.ok) {
    return res;
  }

  // Read the body once and surface the provider's own error detail in the
  // thrown message so callers get actionable info WITHOUT needing DEBUG=1.
  // The Copilot/OpenAI-compat error shape is: { error: { message, code, type, param } }.
  const bodyText = await res.text();
  const errorDetails = {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers),
    body: bodyText,
  };
  debug('Copilot _request response.', errorDetails);

  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    const e = parsed?.error ?? parsed;
    if (e && typeof e === 'object') {
      const parts = [];
      if (e.message) parts.push(e.message);
      const meta = [e.code, e.type, e.param].filter(Boolean).join(', ');
      if (meta) parts.push(`(${meta})`);
      detail = parts.join(' ');
    } else if (typeof e === 'string') {
      detail = e;
    }
  } catch {
    // Non-JSON body (e.g. plain text like "unauthorized: token expired")
    detail = bodyText.trim();
  }
  detail = (detail || '').replace(/\s+/g, ' ').slice(0, 500);

  const error = new Error(
    `Copilot Request error: ${res.status} ${res.statusText}` +
    (detail ? ` — ${detail}` : ''),
  );
  error.status = res.status;
  error.statusText = res.statusText;
  error.model = body?.model;
  try {
    const parsed = JSON.parse(bodyText);
    const providerError = parsed?.error ?? parsed;
    error.code = providerError?.code;
    error.type = providerError?.type;
    error.param = providerError?.param;
  } catch {}
  throw error;
}

export async function models() {
  const res = await _request({ method: 'GET', uri: '/models' });
  return await res.json();
}

// New OpenAI-family Copilot models (currently GPT-5.6 Luna) are exposed only
// through the Responses API. Keep the provider's public return shape
// OpenAI-chat-compatible so Agent's existing tool loop remains unchanged.
const _responsesModels = new Set(['gpt-5.6-luna']);

export function responsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: String(message.content) }] });
      for (const call of message.tool_calls) input.push({
        type: 'function_call', call_id: call.id, name: call.function?.name,
        arguments: call.function?.arguments || '{}',
      });
      continue;
    }
    const raw = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }];
    const content = raw.map((part) => {
      if (part?.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url };
      // Copilot's Responses endpoint follows the OpenAI role distinction:
      // user/system input uses input_text, while replayed assistant history
      // must use output_text (the Luna tool loop includes both forms).
      return {
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: String(part?.text ?? part?.content ?? ''),
      };
    });
    input.push({ role: message.role, content });
  }
  return input;
}

function _responsesTools(tools) {
  return (tools || []).map((tool) => ({
    type: 'function', name: tool.function?.name, description: tool.function?.description,
    parameters: tool.function?.parameters || { type: 'object', properties: {} },
  }));
}

export function responsesToolChoice(toolChoice) {
  if (toolChoice == null || ['auto', 'none', 'required'].includes(toolChoice)) return toolChoice;
  if (toolChoice?.type === 'function') {
    return { type: 'function', name: toolChoice.name || toolChoice.function?.name };
  }
  return undefined;
}

async function _responsesInference({ model, messages, tools, tool_choice, reasoning_effort, max_tokens }) {
  const body = { model, input: responsesInput(messages), store: false };
  const convertedTools = _responsesTools(tools);
  if (convertedTools.length) body.tools = convertedTools;
  const convertedToolChoice = responsesToolChoice(tool_choice);
  if (convertedToolChoice) body.tool_choice = convertedToolChoice;
  if (reasoning_effort) body.reasoning = { effort: reasoning_effort };
  if (max_tokens) body.max_output_tokens = max_tokens;
  const hasImages = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part?.type === 'image_url'));
  const extraHeaders = hasImages ? { 'Copilot-Vision-Request': 'true' } : {};
  const res = await _request({ method: 'POST', uri: '/responses', body, extraHeaders });
  const result = await res.json();
  const toolCalls = [];
  const texts = [];
  for (const item of result.output || []) {
    if (item.type === 'function_call') toolCalls.push({
      id: item.call_id || item.id, type: 'function',
      function: { name: item.name, arguments: item.arguments || '{}' },
    });
    if (item.type === 'message') {
      for (const part of item.content || []) if (part.type === 'output_text' && part.text) texts.push(part.text);
    }
  }
  return {
    id: result.id, model: result.model || model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: texts.join('') || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? 'tool_calls' : (result.status === 'completed' ? 'stop' : result.status),
    }],
    usage: result.usage ? {
      prompt_tokens: result.usage.input_tokens,
      completion_tokens: result.usage.output_tokens,
      total_tokens: result.usage.total_tokens,
    } : undefined,
    _responses: result,
  };
}

// Consume an SSE stream (OpenAI-compat deltas) and assemble a single
// non-streaming-shaped result: { choices:[{ message:{role,content}, finish_reason }], usage }.
// `onChunk` (optional) is called after each network read to reset an idle timer.
async function _consumeStream(res, onChunk) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let role = 'assistant';
  let finishReason = null;
  let usage = null;
  let id = null;
  let model = null;

  // Optional live progress telemetry to stderr (AGL_STREAM_PROGRESS=1).
  // Prints visible chars + reasoning chars + est tok/s every
  // AGL_STREAM_PROGRESS_MS (default 2000) so long "thinking" phases are visible.
  const progress = process.env.AGL_STREAM_PROGRESS === '1';
  const progressMs = Number(process.env.AGL_STREAM_PROGRESS_MS || 2000);
  const startedAt = Date.now();
  let firstTokenAt = null;
  let firstContentAt = null;
  let lastReport = startedAt;
  const reportProgress = (final = false) => {
    if (!progress) return;
    const now = Date.now();
    if (!final && now - lastReport < progressMs) return;
    lastReport = now;
    const secs = (now - startedAt) / 1000;
    const estTok = Math.ceil(content.length / 4);
    const estThink = Math.ceil(reasoning.length / 4);
    const ttft = firstTokenAt ? `${((firstTokenAt - startedAt) / 1000).toFixed(1)}s` : '—';
    const ttc = firstContentAt ? `${((firstContentAt - startedAt) / 1000).toFixed(1)}s` : '—';
    const phase = content.length === 0 && reasoning.length > 0 ? 'THINKING' : 'writing';
    process.stderr.write(
      `[stream] ${final ? 'done ' : ''}t=${secs.toFixed(1)}s ${phase}  content=${content.length}c(~${estTok}t)  reasoning=${reasoning.length}c(~${estThink}t)  ttft=${ttft} ttc=${ttc}\n`
    );
  };

  const handleEvent = (jsonStr) => {
    if (jsonStr === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(jsonStr); } catch { return; }
    if (evt.id) id = evt.id;
    if (evt.model) model = evt.model;
    if (evt.usage) usage = evt.usage;
    const choice = evt.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (delta.role) role = delta.role;
    // Capture reasoning/thinking deltas (Anthropic-via-Copilot extended thinking).
    const rt = delta.reasoning_text ?? delta.reasoning ?? delta.thinking;
    if (typeof rt === 'string' && rt) {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      reasoning += rt;
    }
    const before = content.length;
    if (typeof delta.content === 'string') content += delta.content;
    // Some gateways stream Anthropic-style content arrays.
    else if (Array.isArray(delta.content)) {
      for (const b of delta.content) if (b?.type === 'text' && b.text) content += b.text;
    }
    if (content.length > before) {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      if (firstContentAt === null) firstContentAt = Date.now();
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (onChunk) onChunk();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || !line.startsWith('data:')) continue;
      handleEvent(line.slice(5).trim());
    }
    reportProgress();
  }
  // flush any trailing buffered line
  const tail = buffer.trim();
  if (tail.startsWith('data:')) handleEvent(tail.slice(5).trim());
  reportProgress(true);

  debug('copilot stream assembled.', { id, model, finishReason, contentLen: content.length, usage });

  return {
    id,
    model,
    choices: [
      { index: 0, message: { role, content }, finish_reason: finishReason || 'stop' },
    ],
    usage: usage || undefined,
  };
}

export async function inference({ model = _defaultModel, messages, tools, tool_choice, reasoning_effort, context_window, max_tokens, stream }) {
  // Normalize messages: convert any Anthropic-native tool_result user messages
  // back to OpenAI tool messages (handles round-trips with claude-* models that
  // return Anthropic-native format through the Copilot enterprise endpoint)
  const normalizedMessages = messages.map(msg => {
    // Convert Anthropic assistant messages that have tool_use in content array
    // to OpenAI-compat format (tool_calls)
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
      const textBlocks    = msg.content.filter(b => b.type === 'text');
      if (toolUseBlocks.length > 0) {
        return {
          role: 'assistant',
          content: textBlocks.map(b => b.text).join('') || null,
          tool_calls: toolUseBlocks.map(b => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
        };
      }
    }
    return msg;
  });

  if (_responsesModels.has(model)) {
    return await _responsesInference({ model, messages: normalizedMessages, tools, tool_choice, reasoning_effort, max_tokens });
  }

  const requestBody = {
    model,
    messages: normalizedMessages,
    tools,
    // tool_choice,
  };
  // Optional Anthropic-via-Copilot reasoning control (low|medium|high|xhigh|max).
  if (reasoning_effort) requestBody.reasoning_effort = reasoning_effort;
  if (max_tokens) requestBody.max_tokens = max_tokens;

  // Opt-in extended/1M context for models that gate it behind a beta header.
  const extraHeaders = {};
  if (context_window && context_window > 200000) {
    extraHeaders['anthropic-beta'] = 'context-1m-2025-08-07';
  }

  // Vision: Copilot requires this header when any message carries image content
  // (OpenAI-style content arrays with { type: 'image_url' } parts).
  const hasImages = normalizedMessages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url'),
  );
  if (hasImages) extraHeaders['Copilot-Vision-Request'] = 'true';

  // Streaming path: raises the effective output cap (non-streaming responses are
  // capped at ~16k tokens and return empty choices when exceeded). Used for long
  // text generations that have no tools. Returns the same OpenAI-compat shape.
  //
  // Streams use an IDLE timeout (abort only if no chunk arrives for a while), not
  // a wall-clock cap — a long-but-progressing generation must not be killed.
  if (stream && (!tools || tools.length === 0)) {
    requestBody.stream = true;
    const idleMs = Number(process.env.AGL_STREAM_IDLE_MS || 120000);
    const controller = new AbortController();
    let idleTimer = setTimeout(() => controller.abort(), idleMs);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleMs);
    };
    try {
      const res = await _request({
        method: 'POST', uri: '/chat/completions', body: requestBody, extraHeaders,
        signal: controller.signal,
      });
      return await _consumeStream(res, resetIdle);
    } finally {
      clearTimeout(idleTimer);
    }
  }

  const res = await _request({
    method: 'POST', uri: '/chat/completions', body: requestBody, extraHeaders,
  });
  const result = await res.json();

  // Normalize Anthropic-native response to OpenAI-compat format so agl-ai's
  // agent loop can handle tool_calls correctly regardless of model provider.
  // Anthropic returns: { stop_reason: 'tool_use', content: [{ type:'tool_use', ... }] }
  // OpenAI returns:    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [...] } }] }
  if (result.choices) {
    for (const choice of result.choices) {
      const msg = choice.message;
      if (msg && Array.isArray(msg.content)) {
        const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
        if (toolUseBlocks.length > 0) {
          // Rewrite to OpenAI-compat shape in place
          const textBlocks = msg.content.filter(b => b.type === 'text');
          msg._anthropic_content = msg.content; // preserve for debugging
          msg.content = textBlocks.map(b => b.text).join('') || null;
          msg.tool_calls = toolUseBlocks.map(b => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
          choice.finish_reason = 'tool_calls';
        }
      }
      // Normalize Anthropic stop_reason → finish_reason
      if (!choice.finish_reason && choice.stop_reason) {
        choice.finish_reason = choice.stop_reason === 'tool_use' ? 'tool_calls'
          : choice.stop_reason === 'end_turn' ? 'stop'
          : choice.stop_reason;
      }
      // Final: if message has tool_calls set, finish_reason MUST be 'tool_calls'
      // (some gateway versions return finish_reason:'stop' even with tool_calls present)
      if (msg && msg.tool_calls && msg.tool_calls.length > 0) {
        choice.finish_reason = 'tool_calls';
      }
    }
  }

  return result;
}

// request embeddings (openai-compatible).
// NOTE: the Copilot endpoint REQUIRES `input` to be an ARRAY — a bare string
// returns 400 Bad Request. We normalize a single string to a one-element array.
// Returns the OpenAI-compat shape: { object, data:[{ index, embedding }], model, usage }.
export async function embeddings({ model, input }) {
  if (!model) throw new Error('copilot.embeddings: model is required');
  const arr = Array.isArray(input) ? input : [input];
  const res = await _request({
    method: 'POST', uri: '/embeddings', body: { model, input: arr },
  });
  return await res.json();
}
