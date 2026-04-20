import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';

let _baseUrl = '';
const _defaultModel = 'gemma4:26b';

// initialize provider
export async function init() {
  _baseUrl = await config.read('OLLAMA_BASE_URL') || 'http://localhost:11434';
}

// make an api request
async function _request({ method, uri, body }) {
  debug('ollama _request.', { method, uri, body });
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const response = await fetch(`${_baseUrl}${uri}`, opts);
  if (response.ok) {
    return response;
  }
  const errorDetails = {
    status: response.status,
    statusText: response.statusText,
    body: await response.text(),
  };
  debug('ollama _request error.', errorDetails);
  throw new Error(`Ollama request error: ${response.status} ${response.statusText}`);
}

// list available models
export async function models() {
  const response = await _request({ method: 'GET', uri: '/api/tags' });
  return await response.json();
}

// request a completion (openai-compatible)
export async function inference({ model = _defaultModel, messages, tools }) {
  // ollama expects tool_call arguments as objects, not JSON strings
  const _messages = messages.map(m => {
    if (!m.tool_calls) return m;
    const cleaned = { ...m };
    delete cleaned.thinking;
    cleaned.tool_calls = m.tool_calls.map(tc => ({
      ...tc,
      function: {
        ...tc.function,
        arguments: typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      },
    }));
    return cleaned;
  });

  const body = { model, messages: _messages, stream: false };
  if (tools?.length) body.tools = tools;
  const response = await _request({ method: 'POST', uri: '/api/chat', body });
  const data = await response.json();

  // normalize to openai-compatible shape
  const msg = data.message;
  const hasToolCalls = msg?.tool_calls?.length > 0;

  // ollama returns arguments as objects; openai expects JSON strings
  if (hasToolCalls) {
    for (const call of msg.tool_calls) {
      if (typeof call.function.arguments !== 'string') {
        call.function.arguments = JSON.stringify(call.function.arguments);
      }
    }
  }

  return {
    model: data.model,
    choices: [{
      message: msg,
      finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: data.prompt_eval_count || 0,
      completion_tokens: data.eval_count || 0,
      total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
    },
  };
}
