import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';

const _defaultModel = 'google/gemma-4-e4b';

let _baseUrl = '';

// initialize provider
export async function init() {
  _baseUrl = await config.read('LM_STUDIO_BASE_URL') || 'http://localhost:1234';
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
export async function inference({ model = _defaultModel, messages, tools, tool_choice, max_tokens }) {
  const body = { model, messages };
  if (tools !== undefined) body.tools = tools;
  if (tool_choice !== undefined) body.tool_choice = tool_choice;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;
  const response = await _request({
    method: 'POST',
    uri: '/v1/chat/completions',
    body,
  });
  return await response.json();
}
