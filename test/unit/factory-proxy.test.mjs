import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Agent, {
  normalizeProxy,
  providers,
  resolveContextWindow,
  resolveContextWindowAsync,
} from '../../src/agent.mjs';

const prevPath = process.env.AGL_CONFIG_PATH;

function writeConfig(text) {
  const dir = mkdtempSync(join(tmpdir(), 'agl-cfg-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, text);
  process.env.AGL_CONFIG_PATH = path;
  return { dir, path };
}

afterEach(() => {
  if (prevPath === undefined) delete process.env.AGL_CONFIG_PATH;
  else process.env.AGL_CONFIG_PATH = prevPath;
});

const WINDOWS_YAML = `default_model: llama-server:gemma-4-12b-qat
context_windows:
  llama-server:
    default: 1048576
    gemma-4-12b-qat: 1048576
  xai:
    default: 131072
    grok-4.6: 500000
    grok-4.5: 131072
    grok-4-0709: 131072
`;

describe('resolveContextWindow', () => {
  test('reads provider → model sizes from the user config', () => {
    writeConfig(WINDOWS_YAML);
    expect(resolveContextWindow('xai:grok-4.6')).toBe(500_000);
    expect(resolveContextWindow('grok-4.6')).toBe(500_000);
    expect(resolveContextWindow('xai:grok-4.5')).toBe(131_072);
    expect(resolveContextWindow('xai:grok-4-0709')).toBe(131_072);
  });

  test('llama-server lookup does not contact MYCLOUD_BASE_URL', async () => {
    writeConfig(WINDOWS_YAML);
    const prev = process.env.MYCLOUD_BASE_URL;
    process.env.MYCLOUD_BASE_URL = 'https://192.0.2.1:1234';
    try {
      const t0 = Date.now();
      const n = await resolveContextWindowAsync('llama-server:gemma-4-12b-qat');
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(n).toBe(1_048_576);
    } finally {
      if (prev == null) delete process.env.MYCLOUD_BASE_URL;
      else process.env.MYCLOUD_BASE_URL = prev;
    }
  });
});

describe('normalizeProxy', () => {
  test('host:port becomes https://host:port', () => {
    expect(normalizeProxy('host.containers.internal:1234')).toBe(
      'https://host.containers.internal:1234',
    );
  });

  test('keeps an explicit URL and strips trailing /v1', () => {
    expect(normalizeProxy('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234');
    expect(normalizeProxy('https://uber.home:1234')).toBe('https://uber.home:1234');
  });

  test('empty is unset', () => {
    expect(normalizeProxy('')).toBe('');
    expect(normalizeProxy(null)).toBe('');
    expect(normalizeProxy(undefined)).toBe('');
  });
});

describe('Agent.factory({ proxy })', () => {
  test('routes any provider:model through the llama-server OpenAI client', async () => {
    const agent = await Agent.factory({
      model: 'xai:grok-4.6',
      proxy: 'host.containers.internal:1234',
      api_key: 'test-key',
    });
    expect(agent.proxy).toBe('https://host.containers.internal:1234');
    expect(agent.base_url).toBe('https://host.containers.internal:1234');
    expect(agent.provider).toBe('xai');
    expect(agent.model).toBe('xai:grok-4.6');
    expect(agent.client).toBe(providers['llama-server']);
    expect(agent.client).not.toBe(providers.xai);
  });

  test('does not require AGL to know the provider', async () => {
    const agent = await Agent.factory({
      model: 'acme:secret-model',
      proxy: '127.0.0.1:1234',
      api_key: 'k',
    });
    expect(agent.model).toBe('acme:secret-model');
    expect(agent.client).toBe(providers['llama-server']);
  });

  test('base_url wins as the fetch URL when both are set', async () => {
    const agent = await Agent.factory({
      model: 'openai:gpt-4o',
      proxy: 'host.containers.internal:1234',
      base_url: 'https://dad.example:1234',
      api_key: 'k',
    });
    expect(agent.proxy).toBe('https://host.containers.internal:1234');
    expect(agent.base_url).toBe('https://dad.example:1234');
    expect(agent.model).toBe('openai:gpt-4o');
    expect(agent.client).toBe(providers['llama-server']);
  });

  test('without proxy, unknown provider still throws', async () => {
    await expect(Agent.factory({ model: 'acme:secret-model' })).rejects.toThrow(
      /Unknown AI provider/,
    );
  });
});
