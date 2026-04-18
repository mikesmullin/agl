import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';

let _key = '';
const _baseUrl = 'https://api.x.ai';
const _defaultModel = 'grok-4-1-fast-reasoning';

// initialize provider
export async function init() {
  _key = await config.read('XAI_API_KEY')

  if (!_key) {
    console.error('XAI_API_KEY is missing.');
    process.exit(1);
  }
}

// make an api request
async function _request({ method, uri, body = {} }) {
  const _body = JSON.stringify(body);
  debug('xai _request.', { method, uri, body });
  const response = await fetch(`${_baseUrl}${uri}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${_key}`
    },
    body: _body,
  });
  if (response.ok) {
    return response;
  }
  else {
    const errorDetails = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      body: await response.text()
    };
    debug('xAI _request response.', errorDetails);
    throw new Error(`XAI Request error: ${response.status} ${response.statusText}`);
  }
}

// list available models
export async function models() {
  const response = await _request({ method: 'GET', uri: '/v1/models' });
  return await response.json();
}

// request a completion
export async function inference({ model = _defaultModel, messages, tools, tool_choice }) {
  // openai-compatible
  const response = await _request({
    method: 'POST', uri: '/v1/chat/completions', body: {
      model,
      messages,
      tools,
      tool_choice,
    }
  });
  return await response.json();
}