# Another Generative Language (AnGeL)

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
| Copilot | `copilot:<model>` | GitHub device-flow OAuth |
| LM Studio | `lm-studio:<model>` | None (localhost) |

Creating an `.env` file in the project root with your provider API key(s) is also supported.

For GitHub Copilot, run once and follow the device-flow auth prompt — tokens are cached automatically.

## Running

```sh
bun src/agents/home.mjs turn on my desk light     # run an agent
DEBUG=1 bun src/agents/home.mjs set lights red    # with debug logging

bun test/unit/agent.mjs                           # run tests
```
