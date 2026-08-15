# Another Generative Language (AnGeL) 👼

A minimalist [Pydantic AI](https://ai.pydantic.dev/) clone in Bun JavaScript.

Lightweight AI agent framework with tool calling -- zero dependencies.

## Requirements

- [Bun](https://bun.sh/) runtime

## Install

```sh
npm install agl-ai
```

## Usage

- See [src/agents/home.mjs](src/agents/home.mjs) for a practical example.

Below is a simplistic example from the unit tests:

```js
import Agent from 'agl-ai';

// Simple completion
const agent = await Agent.factory({
  model: 'xai:grok-4-1-fast-reasoning',
  system_prompt: 'You are a helpful assistant.',
});
const result = await agent.run({ prompt: 'What is 2+2?' });

// Tool calling
const agent = await Agent.factory({
  model: 'xai:grok-4-1-fast-reasoning',
  system_prompt: 'Use the roulette_wheel function to check if the customer won.',
  output_tool: { type: 'boolean' },
  parallel_tools: true, // execute multiple tool calls concurrently (default: false)
  max_turns: 5, // cap provider rounds when output_tool is required (default 5; stops nudge loops)
});

agent.Tool('roulette_wheel', 'check if the square is a winner', {
  v1: { type: 'integer' },
}, ['v1'], async (ctx, { v1 }) => {
  return ctx.magic_num == v1 ? 'winner' : 'loser';
});

const magic_num = 18;
const result1 = await agent.run({ prompt: 'Put my money on square eighteen', magic_num });
log('', { result1 }); // => true

const result2 = await agent.run({ prompt: 'I bet five is the winner', magic_num });
log('', { result2 }); // => false
```

## AI Providers

These are supported.

| Provider | Model format | Auth |
|----------|-------------|------|
| xAI | `xai:<model>` | `XAI_API_KEY` env var |
| Copilot | `copilot:<model>` | Tokenman-injected Copilot session |
| Ollama | `ollama:<model>` | None (localhost) |
| LM Studio | `lm-studio:<model>` | None (localhost) |
| RunPod | `runpod:<model>` | `RUNPOD_BASE_URL` (OpenAI-compatible pod proxy/tunnel) |
| Muse | `muse:<model>` | `MUSE_API_KEY` env var |

Credentials are supplied through the process environment. With Tokenman:

```sh
op run --env-file=<(tokenman script agl-xai) -- bun src/agents/home.mjs 'hello'
op run --env-file=<(tokenman script agl-copilot) -- bun src/agents/home.mjs 'hello'
```

Tokenman owns provider refresh and any required interactive login; AGL does not
read `.env` or persist provider tokens.

## Running

```sh
bun src/agents/home.mjs turn on my desk light     # run an agent
DEBUG=1 bun src/agents/home.mjs set lights red    # with debug logging

bun test/unit/agent.mjs                           # run tests
```

## Related

- [agl-agents](https://github.com/mikesmullin/agl-agents) example agent implementations
