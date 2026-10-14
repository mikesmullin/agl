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

# Dynamic provider map: provider_name → OpenAI-compatible endpoint.
# `{{model}}` substitutes the model id into the URL when present;
# otherwise the model id rides the request body. Credentials via env:
# <PROVIDER>_API_KEY / <PROVIDER>_CA_FILE (uppercased, dashes → underscores),
# or object-form entries with a literal api_key / ca_file in the config.
endpoints:
  local:
    url: https://127.0.0.1:1234
    api_key: <literal-key-or-edit-me>
  mycloud: http://127.0.0.1:8788/{{model}}

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

The bare word `default` (provider omitted) resolves through `default_model` —
e.g. with `default_model: local:default`, the model string `default` routes to
the `local` endpoint with model id `default`.

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

// A dynamic provider — endpoint from the config `endpoints` map
// ({{model}} template). Per-agent overrides still win when passed:
const llama = await Agent.factory({
  model: 'local:qwen-3.8-27b',
  base_url: 'https://HOST:1234', // optional — map entry otherwise
  api_key: instanceApiKey,
  ca_file: process.env.MYCLOUD_CA_FILE, // optional; default ~/.mycloud/cert.pem
});
await llama.run({ prompt: '2+2?' });

// local-proxy (or any OpenAI-compat gateway): every provider:model is POSTed
// there as-is. `host:port` becomes https://host:port.
const viaProxy = await Agent.factory({
  model: 'xai:grok-4.6',
  proxy: 'host.containers.internal:1234',
  api_key: process.env.LOCAL_PROXY_API_KEY,
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
| *dynamic* (`endpoints` map) | `<name>:<model>` | Generic OpenAI-compatible client; endpoint from the config map, `<UPPER>_API_KEY` / `<UPPER>_CA_FILE` env (or map-object `api_key`/`ca_file`) |
| openai (generic) | `openai:<model>` | `OPENAI_API_KEY`; endpoint `OPENAI_BASE_URL` or `https://api.openai.com` — unless an `endpoints` map entry overrides it |
| xAI | `xai:<model>` | `XAI_API_KEY` env var |
| Copilot | `copilot:<model>` | Tokenman-injected Copilot session |
| Ollama | `ollama:<model>` | None (localhost) |
| LM Studio | `lm-studio:<model>` | None (localhost LM Studio; native `/api/v0` plus OpenAI `/v1`) |
| RunPod | `runpod:<model>` | `RUNPOD_BASE_URL` (OpenAI-compatible pod proxy/tunnel) |
| llama-server | `llama-server:<model>` | Local llama.cpp (default `http://127.0.0.1:1234`). Optional `LLAMA_SERVER_BASE_URL` / `LLAMA_SERVER_API_KEY`. Does not use `MYCLOUD_BASE_URL`. |
| gateway / local-proxy | any `provider:model` | `Agent.factory({ proxy: 'host:port', api_key, ca_file })`. Skips native provider clients; POSTs OpenAI chat completions to the proxy with the full model id. |
| Meta | `meta:<model>` (alias `muse:<model>`) | `META_API_KEY` or legacy `MUSE_API_KEY` |

The former `mycloud` provider was **renamed into the generic openai-compatible
client** — the `mycloud` name is now just a dynamic `endpoints` map key (in the
psicom stack it routes to the mycloud AI gateway via the `{{model}}` preset
path). The old GCE llama.cpp endpoint lives under a name like `local`:

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
