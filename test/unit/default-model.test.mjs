import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Agent, {
  resolveDefaultModel,
  userConfigPath,
  chatCompletions,
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

describe('resolveDefaultModel', () => {
  test('reads default_model from the user config file every call', async () => {
    const { dir } = writeConfig('default_model: llama-server:gemma-4-12b-qat\n');
    expect(await resolveDefaultModel()).toBe('llama-server:gemma-4-12b-qat');
    writeFileSync(join(dir, 'config.yaml'), 'default_model: llama-server:qwen3.8-27b-nvfp4-mtp-q8attn\n');
    expect(await resolveDefaultModel()).toBe(
      'llama-server:qwen3.8-27b-nvfp4-mtp-q8attn',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test('falls back to Agent.default.model when the file is missing', async () => {
    process.env.AGL_CONFIG_PATH = join(tmpdir(), 'agl-no-such-config.yaml');
    expect(await resolveDefaultModel()).toBe(Agent.default.model);
  });

  test('userConfigPath honors AGL_CONFIG_PATH', () => {
    process.env.AGL_CONFIG_PATH = '/tmp/agl-test.yaml';
    expect(userConfigPath()).toBe('/tmp/agl-test.yaml');
  });
});

describe('Agent.factory empty model', () => {
  test('omitted model binds the config default and stays live', async () => {
    const { dir } = writeConfig('default_model: llama-server:gemma-4-12b-qat\n');
    const agent = await Agent.factory({});
    expect(agent._liveDefault).toBe(true);
    expect(agent.provider).toBe('llama-server');
    expect(agent.model).toBe('gemma-4-12b-qat');
    expect(agent._boundSpec).toBe('llama-server:gemma-4-12b-qat');

    writeFileSync(
      join(dir, 'config.yaml'),
      'default_model: llama-server:qwen3.8-27b-nvfp4-mtp-q8attn\n',
    );
    await agent._bindDefaultModel();
    expect(agent.model).toBe('qwen3.8-27b-nvfp4-mtp-q8attn');
    expect(agent._boundSpec).toBe('llama-server:qwen3.8-27b-nvfp4-mtp-q8attn');
    rmSync(dir, { recursive: true, force: true });
  });

  test('null / empty string model is live-default, not a baked spec', async () => {
    writeConfig('default_model: llama-server:gemma-4-12b-qat\n');
    for (const model of [null, undefined, '', '  ']) {
      const agent = await Agent.factory({ model });
      expect(agent._liveDefault).toBe(true);
    }
  });

  test('explicit model is not live-default', async () => {
    writeConfig('default_model: llama-server:gemma-4-12b-qat\n');
    const agent = await Agent.factory({ model: 'xai:grok-4.6' });
    expect(agent._liveDefault).toBe(false);
    expect(agent.provider).toBe('xai');
    expect(agent.model).toBe('grok-4.6');
  });
});

describe('chatCompletions empty model', () => {
  test('missing model is filled from the user config before provider lookup', async () => {
    writeConfig('default_model: acme:secret-model\n');
    const res = await chatCompletions({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error?.message || '')).toMatch(/Unknown provider "acme"/);
  });
});
