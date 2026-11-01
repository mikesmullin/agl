import { describe, expect, test } from 'bun:test';
import Agent, { providers } from '../../src/agent.mjs';
import * as generic from '../../src/providers/generic.mjs';

describe('provider registry after the provider cull', () => {
  test('exposes exactly the two canonical providers', () => {
    expect(Object.keys(providers).sort()).toEqual(['copilot', 'generic']);
  });

  test('the removed providers are gone', () => {
    for (const gone of ['xai', 'ollama', 'lm-studio', 'runpod', 'anthropic', 'meta']) {
      expect(providers[gone]).toBeUndefined();
    }
  });
});

describe('deprecated provider aliases still resolve', () => {
  // `llama-server:` is the default_model in live configs and is hard-coded in
  // several sibling apps, so the NAME must keep working even though the
  // module behind it is now `generic`.
  test('llama-server binds the generic client but keeps its own id + localhost default', async () => {
    const agent = await Agent.factory({ model: 'llama-server:gemma-4-12b-qat' });
    expect(agent.client).toBe(generic);
    // The id stays visible so `context_windows.llama-server` keeps resolving.
    expect(agent.provider).toBe('llama-server');
    expect(agent.model).toBe('gemma-4-12b-qat');
    expect(agent.base_url).toBe('http://127.0.0.1:1234');
  });

  test('openai binds the generic client and keeps the hosted endpoint default', async () => {
    const prev = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    try {
      const agent = await Agent.factory({ model: 'openai:gpt-4o' });
      expect(agent.client).toBe(generic);
      expect(agent.provider).toBe('openai');
      expect(agent.base_url).toBe('https://api.openai.com');
    } finally {
      if (prev == null) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prev;
    }
  });

  // meta was COLLAPSED into generic: the id now binds the generic client plus
  // the built-in meta endpoint and its two quirks.
  test('meta binds generic with the Muse endpoint and its quirks', async () => {
    const prev = process.env.META_API_KEY;
    process.env.META_API_KEY = 'test-key';
    try {
      const agent = await Agent.factory({ model: 'meta:muse-spark-1.2-contributor' });
      expect(agent.client).toBe(generic);
      expect(agent.provider).toBe('meta');
      expect(agent.base_url).toBe('https://api.meta.ai');
      expect(agent.endpoint_quirks).toMatchObject({
        tool_choice: 'auto',
        stream: false,
      });
    } finally {
      if (prev == null) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = prev;
    }
  });

  test('muse normalizes to the canonical meta id', async () => {
    const agent = await Agent.factory({ model: 'muse:muse-spark-1.2-contributor' });
    expect(agent.client).toBe(generic);
    expect(agent.provider).toBe('meta');
  });

  test('an unknown provider names the accepted ids, aliases included', async () => {
    await expect(Agent.factory({ model: 'acme:whatever' })).rejects.toThrow(
      /Known: generic, copilot, llama-server, openai, systemone, meta, muse/,
    );
  });
});

describe('endpoint quirks reach the request', () => {
  /** Swap in a stub client and capture the request Agent builds. */
  async function capture(agent, prompt = 'hi') {
    let seen = null;
    agent.client = {
      init: async () => {},
      inference: async (req) => {
        seen = req;
        return {
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    };
    await agent.run({ prompt });
    return seen;
  }

  test('meta coerces tool_choice to auto and suppresses streaming', async () => {
    const prev = process.env.META_API_KEY;
    process.env.META_API_KEY = 'test-key';
    try {
      const agent = await Agent.factory({
        model: 'meta:muse-spark-1.2-contributor',
        tool_choice: 'required',
        stream: true,
      });
      agent.Tool('noop', 'does nothing', {}, [], () => 'x');
      const req = await capture(agent);
      // Muse rejects every tool_choice but "auto" — the old meta.mjs did this
      // in code; it is now an endpoint quirk.
      expect(req.tool_choice).toBe('auto');
      // meta.mjs had no streaming path, so no stream is started.
      expect(req.stream).toBeUndefined();
      expect(req.on_delta).toBeUndefined();
    } finally {
      if (prev == null) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = prev;
    }
  });

  test('an endpoint without quirks passes tool_choice and stream through', async () => {
    const agent = await Agent.factory({
      model: 'llama-server:default',
      tool_choice: 'required',
      stream: true,
    });
    agent.Tool('noop', 'does nothing', {}, [], () => 'x');
    expect(agent.endpoint_quirks).toBeNull();
    const req = await capture(agent);
    expect(req.tool_choice).toBe('required');
    expect(req.stream).toBe(true);
  });
});
