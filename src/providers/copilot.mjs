import { debug } from '../lib/debug.mjs';
import { setting } from '../lib/config.mjs';
import { openaiErrorFromResponse } from '../lib/openai-gateway.mjs';
import { access, readFile, writeFile } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { join } from 'path';

const _defaultModel = 'claude-sonnet-5';
const _tokensFileDefault = join(import.meta.dir, '../../.copilot_tokens.json');

const _config = {
  copilot: {
    default_api_url: 'https://api.githubcopilot.com',
    editor_version: 'vscode/1.85.1',
    editor_plugin_version: 'copilot/1.155.0',
    user_agent: 'GitHubCopilot/1.155.0',
    integration_id: 'vscode-chat',
  },
};

let _tokens = null;

function tokensFilePath() {
  return process.env.AGL_COPILOT_TOKENS_FILE || _tokensFileDefault;
}

async function tokensFileExists(path = tokensFilePath()) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function environmentSession() {
  const githubToken = process.env.AGL_COPILOT_GITHUB_TOKEN;
  const copilotToken = process.env.AGL_COPILOT_TOKEN;
  const expiresAt = Number(process.env.AGL_COPILOT_EXPIRES_AT);
  if (!githubToken || !copilotToken || !expiresAt) {
    throw new Error('AGL_COPILOT_GITHUB_TOKEN, AGL_COPILOT_TOKEN, and AGL_COPILOT_EXPIRES_AT are required; run `tokenman refresh agl-copilot` and launch through `op run`, or create .copilot_tokens.json.');
  }
  if (expiresAt * 1000 <= Date.now()) {
    throw new Error('AGL Copilot token is expired; run `tokenman refresh agl-copilot` and relaunch.');
  }
  return {
    github_token: githubToken,
    copilot_token: copilotToken,
    expires_at: expiresAt,
    api_url: await setting('copilot_api_url', _config.copilot.default_api_url),
  };
}

async function getCopilotToken(githubToken) {
  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubToken}`,
      'User-Agent': _config.copilot.user_agent,
      'Editor-Version': _config.copilot.editor_version,
      'Editor-Plugin-Version': _config.copilot.editor_plugin_version,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to get Copilot token: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

/**
 * File-backed session for long-lived daemons (aigw / dad-proxy).
 * Prefer this whenever `.copilot_tokens.json` exists — skip tokenman env.
 * Refreshes via github_token; does not start an interactive device flow.
 */
async function fileSession() {
  const path = tokensFilePath();
  let tokens;
  try {
    tokens = JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    throw new Error(
      `Copilot tokens file missing (${path}). Set AGL_COPILOT_* via tokenman, or create .copilot_tokens.json.`,
    );
  }
  const stillGood =
    tokens?.copilot_token &&
    Number(tokens.expires_at) * 1000 > Date.now() + 60_000;
  if (stillGood) {
    tokens.api_url =
      tokens.api_url || (await setting('copilot_api_url', _config.copilot.default_api_url));
    return tokens;
  }
  if (!tokens?.github_token) {
    throw new Error('Copilot token expired and no github_token in file to refresh.');
  }
  const data = await getCopilotToken(tokens.github_token);
  tokens.copilot_token = data.token;
  tokens.expires_at = data.expires_at;
  tokens.api_url = data.endpoints?.api || _config.copilot.default_api_url;
  try {
    await writeFile(path, JSON.stringify(tokens, null, 2));
  } catch (err) {
    debug('copilot token file write failed.', err);
  }
  return tokens;
}

// --- public interface ---

export async function init() {
  // Prefer on-disk tokens when present (no tokenman / op run required).
  if (await tokensFileExists()) {
    _tokens = await fileSession();
    return;
  }
  _tokens = await environmentSession();
}

async function _fetch({ method, uri, body, extraHeaders, signal }) {
  if (!_tokens) await init();
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
  return fetch(url, opts);
}

async function _request({ method, uri, body, extraHeaders, signal }) {
  // NOTE: retry/backoff and per-call timeout are handled generically in the
  // agent provider-invocation loop (applies to all providers), not here.
  let res = await _fetch({ method, uri, body, extraHeaders, signal });
  if (res.status === 401 && (await tokensFileExists())) {
    try {
      _tokens = await fileSession();
      res = await _fetch({ method, uri, body, extraHeaders, signal });
    } catch {
      throw new Error('Copilot authentication was rejected; refresh .copilot_tokens.json or run `tokenman refresh agl-copilot`.');
    }
  }
  if (res.status === 401) {
    throw new Error('Copilot authentication was rejected; run `tokenman refresh agl-copilot` and relaunch.');
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

// New OpenAI-family Copilot models are exposed only
// through the Responses API. Keep the provider's public return shape
// OpenAI-chat-compatible so Agent's existing tool loop remains unchanged.
const _responsesModels = new Set(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);

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
function _buildResponsesBody({
  model,
  messages,
  tools,
  tool_choice,
  reasoning_effort,
  max_tokens,
  stream = false,
}) {
  const body = {
    model,
    input: responsesInput(messages || []),
    store: false,
  };
  if (stream) body.stream = true;
  const convertedTools = _responsesTools(tools);
  if (convertedTools.length) body.tools = convertedTools;
  const convertedToolChoice = responsesToolChoice(tool_choice);
  if (convertedToolChoice) body.tool_choice = convertedToolChoice;
  if (reasoning_effort) body.reasoning = { effort: reasoning_effort };
  if (max_tokens) body.max_output_tokens = max_tokens;
  return body;
}

function _responsesExtraHeaders(messages) {
  const hasImages = (messages || []).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part?.type === 'image_url'),
  );
  return hasImages ? { 'Copilot-Vision-Request': 'true' } : {};
}

/** POST /responses with 401 file-token retry; returns raw fetch Response (ok or not). */
async function _responsesFetch({ body, extraHeaders, signal }) {
  let res = await _fetch({
    method: 'POST',
    uri: '/responses',
    body,
    extraHeaders,
    signal,
  });
  if (res.status === 401 && (await tokensFileExists())) {
    try {
      _tokens = await fileSession();
      res = await _fetch({
        method: 'POST',
        uri: '/responses',
        body,
        extraHeaders,
        signal,
      });
    } catch {
      /* keep original 401 */
    }
  }
  return res;
}

async function _responsesInference({ model, messages, tools, tool_choice, reasoning_effort, max_tokens }) {
  const body = _buildResponsesBody({
    model,
    messages,
    tools,
    tool_choice,
    reasoning_effort,
    max_tokens,
    stream: false,
  });
  const res = await _request({
    method: 'POST',
    uri: '/responses',
    body,
    extraHeaders: _responsesExtraHeaders(messages),
  });
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

/**
 * Translate Copilot/OpenAI Responses SSE → OpenAI chat.completion.chunk SSE
 * so VS Code / aigw clients using apiType=chat-completions can stream Luna/Terra/Sol.
 */
function streamResponsesToOpenAI(res, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let id = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  /** @type {Map<string, number>} */
  const toolIndexByItem = new Map();
  let nextToolIndex = 0;
  let sawToolCall = false;
  let finishReason = 'stop';
  let usage;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const chunk = (delta, finish = null, extra = {}) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra,
      });

      send(chunk({ role: 'assistant', content: '' }));

      let buf = '';
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, sep).trimEnd();
            buf = buf.slice(sep + 1);
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let evt;
            try {
              evt = JSON.parse(raw);
            } catch {
              continue;
            }
            const type = evt.type || '';

            if (type === 'response.created' || type === 'response.in_progress') {
              // Keep a stable chatcmpl-* id for all chunks (OpenAI chat clients
              // expect one id for the whole stream). Capture upstream model only.
              if (evt.response?.model) model = evt.response.model;
              continue;
            }

            if (type === 'response.output_text.delta' && evt.delta) {
              send(chunk({ content: String(evt.delta) }));
              continue;
            }

            // Reasoning / thinking deltas (when present)
            if (
              (type === 'response.reasoning_summary_text.delta' ||
                type === 'response.reasoning_text.delta') &&
              evt.delta
            ) {
              send(
                chunk({
                  reasoning_content: String(evt.delta),
                  reasoning_text: String(evt.delta),
                }),
              );
              continue;
            }

            if (type === 'response.output_item.added' && evt.item?.type === 'function_call') {
              sawToolCall = true;
              const itemKey = String(evt.item.id || evt.output_index || nextToolIndex);
              const idx = nextToolIndex++;
              toolIndexByItem.set(itemKey, idx);
              if (evt.item.id) toolIndexByItem.set(String(evt.item.id), idx);
              send(
                chunk({
                  tool_calls: [
                    {
                      index: idx,
                      id: evt.item.call_id || evt.item.id,
                      type: 'function',
                      function: {
                        name: evt.item.name || '',
                        arguments: evt.item.arguments || '',
                      },
                    },
                  ],
                }),
              );
              continue;
            }

            if (type === 'response.function_call_arguments.delta' && evt.delta) {
              sawToolCall = true;
              const itemKey = String(evt.item_id || evt.output_index || '');
              const idx =
                toolIndexByItem.has(itemKey)
                  ? toolIndexByItem.get(itemKey)
                  : (evt.output_index ?? Math.max(0, nextToolIndex - 1));
              send(
                chunk({
                  tool_calls: [
                    {
                      index: idx,
                      function: { arguments: String(evt.delta) },
                    },
                  ],
                }),
              );
              continue;
            }

            if (type === 'response.completed' || type === 'response.incomplete') {
              // Keep a stable chatcmpl-* id for all chunks; only capture model/usage.
              if (evt.response?.model) model = evt.response.model;
              if (evt.response?.usage) {
                usage = {
                  prompt_tokens: evt.response.usage.input_tokens,
                  completion_tokens: evt.response.usage.output_tokens,
                  total_tokens: evt.response.usage.total_tokens,
                };
              }
              if (type === 'response.incomplete') finishReason = 'length';
              else if (sawToolCall) finishReason = 'tool_calls';
              else finishReason = 'stop';
              continue;
            }

            if (type === 'response.failed' || type === 'error' || type === 'response.error') {
              const msg =
                evt.message ||
                evt.error?.message ||
                evt.response?.error?.message ||
                'Responses stream failed';
              send({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                error: { message: String(msg), type: 'server_error' },
              });
              finishReason = 'stop';
            }
          }
        }
      } catch (err) {
        controller.error(err);
        return;
      }

      if (sawToolCall && finishReason === 'stop') finishReason = 'tool_calls';
      send(
        chunk(
          {},
          finishReason,
          usage ? { usage } : {},
        ),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function chatCompletionsRequest({ model, body, signal } = {}) {
  if (!_tokens) await init();
  const requestBody = { ...(body || {}), model };
  if (_responsesModels.has(model)) {
    const messages = requestBody.messages || [];
    const responsesBody = _buildResponsesBody({
      model,
      messages,
      tools: requestBody.tools,
      tool_choice: requestBody.tool_choice,
      reasoning_effort: requestBody.reasoning_effort,
      max_tokens: requestBody.max_tokens,
      stream: Boolean(requestBody.stream),
    });
    const extraHeaders = _responsesExtraHeaders(messages);

    if (requestBody.stream) {
      const res = await _responsesFetch({
        body: responsesBody,
        extraHeaders,
        signal,
      });
      if (!res.ok) return openaiErrorFromResponse(res, 'copilot');
      return streamResponsesToOpenAI(res, model);
    }

    const result = await _responsesInference({
      model,
      messages,
      tools: requestBody.tools,
      tool_choice: requestBody.tool_choice,
      reasoning_effort: requestBody.reasoning_effort,
      max_tokens: requestBody.max_tokens,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return _request({
    method: 'POST',
    uri: '/chat/completions',
    body: requestBody,
    signal,
  });
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
    if (evt.usage) {
      // Normalize Responses-style input/output_tokens → OpenAI chat usage
      const u = evt.usage;
      const pt = Number(
        u.prompt_tokens ?? u.promptTokens ?? u.input_tokens ?? u.inputTokens,
      );
      const ct = Number(
        u.completion_tokens ??
          u.completionTokens ??
          u.output_tokens ??
          u.outputTokens ??
          0,
      );
      const tt = Number(
        u.total_tokens ??
          u.totalTokens ??
          (Number.isFinite(pt) ? pt : 0) + (Number.isFinite(ct) ? ct : 0),
      );
      usage = {
        ...u,
        prompt_tokens: Number.isFinite(pt) ? pt : 0,
        completion_tokens: Number.isFinite(ct) ? ct : 0,
        total_tokens: Number.isFinite(tt) ? tt : 0,
      };
    }
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

export async function inference({
  model = _defaultModel,
  messages,
  tools,
  tool_choice,
  reasoning_effort,
  context_window,
  max_tokens,
  stream,
  signal: parentSignal,
}) {
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
    // OpenAI-compat: include final-chunk usage so pie uses provider counts
    // (not chars/4). Harmless if the gateway ignores unknown fields.
    requestBody.stream_options = { include_usage: true };
    const idleMs = Number(process.env.AGL_STREAM_IDLE_MS || 120000);
    const controller = new AbortController();
    let idleTimer = setTimeout(() => controller.abort(), idleMs);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleMs);
    };
    const onParentAbort = () => {
      try {
        controller.abort(
          typeof parentSignal?.reason === 'string'
            ? parentSignal.reason
            : 'user stop',
        );
      } catch {
        /* ignore */
      }
    };
    if (parentSignal) {
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    try {
      const res = await _request({
        method: 'POST', uri: '/chat/completions', body: requestBody, extraHeaders,
        signal: controller.signal,
      });
      return await _consumeStream(res, resetIdle);
    } catch (err) {
      if (parentSignal?.aborted || controller.signal.aborted) {
        const e = new Error(
          typeof parentSignal?.reason === 'string'
            ? parentSignal.reason
            : err?.message || 'user stop',
        );
        e.name = 'AbortError';
        e.aborted = true;
        e.userAbort = Boolean(parentSignal?.aborted);
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(idleTimer);
      if (parentSignal) {
        try {
          parentSignal.removeEventListener('abort', onParentAbort);
        } catch {
          /* ignore */
        }
      }
    }
  }

  const res = await _request({
    method: 'POST',
    uri: '/chat/completions',
    body: requestBody,
    extraHeaders,
    signal: parentSignal,
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


