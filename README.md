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

Omit `model` (or pass `null` / `''`) to use the user default from
`~/.config/agl/config.yaml`:

```yaml
default_model: llama-server:gemma-4-12b-qat

context_windows:
  llama-server:
    default: 1048576
    gemma-4-12b-qat: 1048576
  xai:
    default: 131072
    grok-4.6: 500000
```

That file is re-read on every inference when the caller omitted a model, and
on every `resolveContextWindow` / `listModels` call, so a disk edit switches
every AGL-dependent app without a restart and without probing providers.
Override the path with `AGL_CONFIG_PATH`. If the file is missing, AGL falls
back to `llama-server:gemma-4-12b-qat` and a 32_768 token window.

```js
import Agent from 'agl-ai';

// Uses ~/.config/agl/config.yaml default_model
const agent = await Agent.factory({
  system_prompt: 'You are a helpful assistant.',
});

// Simple completion with an explicit model
const grok = await Agent.factory({
  model: 'xai:grok-4-1-fast-reasoning',
  system_prompt: 'You are a helpful assistant. The date is {{date}}.',
  locals: { date: new Date().toLocaleString() }, // optional Handlebars-like substitution
  reasoning_effort: 'high', // optional; omitted/blank → provider default
});
const result = await agent.run({ prompt: 'What is 2+2?' });

// mycloud / llama-server — pass this instance's URL + API key (do not rely on
// process-wide MYCLOUD_BASE_URL, which may still point at a previous VM)
const llama = await Agent.factory({
  model: 'mycloud:qwen-3.8-27b',
  base_url: 'https://HOST:1234',
  api_key: instanceApiKey,
  ca_file: process.env.MYCLOUD_CA_FILE, // optional; default ~/.mycloud/cert.pem
});
await llama.run({ prompt: '2+2?' });

// dad-proxy (or any OpenAI-compat gateway): every provider:model is POSTed
// there as-is. `host:port` becomes https://host:port.
const viaProxy = await Agent.factory({
  model: 'xai:grok-4.6',
  proxy: 'host.containers.internal:1234',
  api_key: process.env.DAD_PROXY_API_KEY,
  ca_file: '/opt/certs/ca.pem',
});
await viaProxy.run({ prompt: '2+2?' });

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

// Or pass a named function that carries its own schema:
//   fn.description / fn.parameters / fn.required  (name = fn.name)
//   agent.Tool(desk_light)

const magic_num = 18;
const result1 = await agent.run({ prompt: 'Put my money on square eighteen', magic_num });
log('', { result1 }); // => true

const result2 = await agent.run({ prompt: 'I bet five is the winner', magic_num });
log('', { result2 }); // => false
```

`locals` is optional. When it is a plain object, `system_prompt` is compiled as a
Handlebars-like template (`{{name}}`, `{{#if}}` / `{{#unless}}` / `{{#each}}` /
`{{#with}}`, whitespace `~`, `\{{escape}}`) against those values, once at
factory time. Omit `locals` and the prompt is unchanged — including any
literal `{{...}}`. Implementation: [src/lib/mini-handlebars.mjs](src/lib/mini-handlebars.mjs)
(no extra dependency).

## AI Providers

These are supported.

| Provider | Model format | Auth |
|----------|-------------|------|
| xAI | `xai:<model>` | `XAI_API_KEY` env var |
| Copilot | `copilot:<model>` | Tokenman-injected Copilot session |
| Ollama | `ollama:<model>` | None (localhost) |
| LM Studio | `lm-studio:<model>` | None (localhost LM Studio; native `/api/v0` plus OpenAI `/v1`) |
| RunPod | `runpod:<model>` | `RUNPOD_BASE_URL` (OpenAI-compatible pod proxy/tunnel) |
| llama-server | `llama-server:<model>` | Local llama.cpp (default `http://127.0.0.1:1234`). Optional `LLAMA_SERVER_BASE_URL` / `LLAMA_SERVER_API_KEY`. Does not use `MYCLOUD_BASE_URL`. |
| mycloud | `mycloud:<model>` | `MYCLOUD_BASE_URL` + `MYCLOUD_API_KEY` (HTTPS llama.cpp, e.g. GCE `:1234`). Optional `MYCLOUD_CA_FILE` for a self-signed cert (default `~/.mycloud/cert.pem`). Override per agent with `Agent.factory({ base_url, api_key, ca_file })`. |
| gateway / dad-proxy | any `provider:model` | `Agent.factory({ proxy: 'host:port', api_key, ca_file })`. Skips native provider clients; POSTs OpenAI chat completions to the proxy with the full model id. |
| Meta | `meta:<model>` (alias `muse:<model>`) | `META_API_KEY` or legacy `MUSE_API_KEY` |

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

bun test                                          # unit tests (test/unit/)
```

## Related

- [agl-agents](https://github.com/mikesmullin/agl-agents) example agent implementations
