import { debug } from '../lib/debug.mjs';
import * as config from '../lib/config.mjs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';

const _tokensPath = resolve(import.meta.dir, '../../.copilot_tokens.json');
const _defaultModel = 'claude-sonnet-4.6';

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

async function _getSession() {
  let tokens = await _loadTokens();

  // valid copilot token
  if (tokens?.copilot_token && tokens.expires_at * 1000 > Date.now()) {
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

async function _request({ method, uri, body }) {
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
    },
  };
  if (body) opts.body = JSON.stringify(body);
  debug('copilot _request.', { method, uri, body });
  const res = await fetch(url, opts);
  if (res.status === 401) {
    console.warn('Copilot token expired, refreshing...');
    _tokens = await _getSession();
    return _request({ method, uri, body });
  }

  if (res.ok) {
    return res;
  }
  else {
    const errorDetails = {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers),
      body: await res.text()
    };
    debug('Copilot _request response.', errorDetails);
    throw new Error(`Copilot Request error: ${res.status} ${res.statusText}`);
  }
}

export async function models() {
  const res = await _request({ method: 'GET', uri: '/models' });
  return await res.json();
}

export async function inference({ model = _defaultModel, messages, tools, tool_choice }) {
  // openai-compatible
  const res = await _request({
    method: 'POST', uri: '/chat/completions', body: {
      model,
      messages,
      tools,
      // tool_choice,
    },
  });
  return await res.json();
}
