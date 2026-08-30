import { describe, expect, test } from 'bun:test';
import Agent, { normalizeProxy, providers, resolveContextWindow } from '../../src/agent.mjs';

describe('resolveContextWindow', () => {
  test('grok-4.6 is 500k; other grok-4 stays 128k', () => {
    expect(resolveContextWindow('xai:grok-4.6')).toBe(500_000);
    expect(resolveContextWindow('grok-4.6')).toBe(500_000);
    expect(resolveContextWindow('xai:grok-4.5')).toBe(131_072);
    expect(resolveContextWindow('xai:grok-4-0709')).toBe(131_072);
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
