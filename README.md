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
  # Providers that used to be built in are now just entries here:
  xai: https://api.x.ai

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

// Simple completion with an explicit model. `xai` is not a built-in
// provider — it resolves through the `endpoints` map above to the generic
// OpenAI-compatible client, with XAI_API_KEY as the credential.
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

AGL ships **two** provider modules. Everything else is a config entry, not
code.

| Provider | Model format | Auth |
|----------|-------------|------|
| **generic** | `generic:<model>` | The one OpenAI-compatible HTTP client. Endpoint from a per-agent `base_url`, an `endpoints` map entry, or the `MYCLOUD_BASE_URL` / `LLAMA_SERVER_BASE_URL` / `OPENAI_BASE_URL` chain (default `http://127.0.0.1:1234`). Key via `<UPPER>_API_KEY`. Also serves `POST /v1/systemone` for decision models — see [`agent.switch()`](#decision-loops--agentswitch). |
| **copilot** | `copilot:<model>` | Tokenman-injected Copilot session (device-flow + token exchange). The one genuine exception: real auth, not just a different base URL. |
| *dynamic* (`endpoints` map) | `<name>:<model>` | Routes to **generic**; endpoint from the config map, `<UPPER>_API_KEY` / `<UPPER>_CA_FILE` env (or map-object `api_key` / `ca_file`) |
| gateway / local-proxy | any `provider:model` | `Agent.factory({ proxy: 'host:port', api_key, ca_file })`. Skips provider clients; POSTs OpenAI chat completions to the proxy with the full model id. |

### Built-in endpoint names

These resolve to **generic** with an endpoint (and, where needed, behaviour
flags) already bound, so existing `default_model` values and `provider:model`
strings keep working. They are names, not modules.

| Name | Endpoint | Note |
|------|----------|------|
| `llama-server:<model>` | `$LLAMA_SERVER_BASE_URL` or `http://127.0.0.1:1234` | Keeps its own `context_windows.llama-server` group; never inherits `MYCLOUD_BASE_URL`. |
| `systemone:<model>` | `$SYSTEMONE_URL` or `http://127.0.0.1:1237` | The System One decision slot. Serves `/v1/systemone`; chat calls against it fail by design. |
| `openai:<model>` | `$OPENAI_BASE_URL` or `https://api.openai.com` | |
| `meta:<model>` / `muse:<model>` | `$META_BASE_URL` or `https://api.meta.ai` | `META_API_KEY` (legacy `MUSE_API_KEY`). Carries the two Muse quirks below. |

### Endpoint quirks

A server that *almost* speaks OpenAI is described in config instead of in a
bespoke module. The object form of an `endpoints` entry accepts:

```yaml
endpoints:
  meta:
    url: https://api.meta.ai
    tool_choice: auto     # coerce every request to this value
    stream: false         # never send stream:true
    decisions: true       # native /v1/systemone decision endpoint
```

This is how the former `meta` provider module was retired: its wire format,
auth header and routes were already identical to `generic`, and its only two
real differences — Muse rejects every `tool_choice` except `"auto"`, and it has
no streaming path — are now these two flags. A config entry overrides the
built-in set for the same name.

### Removed providers

`xai`, `ollama`, `lm-studio`, `runpod`, `anthropic` and `meta` were
**removed as modules**. All but `anthropic` were plain OpenAI-compatible
endpoints, so an `endpoints` entry replaces each one with no loss — and keeps
working with an existing `context_windows` group of the same name:

```yaml
endpoints:
  xai: https://api.x.ai
  ollama: http://localhost:11434
  lm-studio: http://localhost:1234
```

…then `XAI_API_KEY` / `OLLAMA_API_KEY` / … supply the credential, and
`xai:grok-4.6` resolves exactly as before. `anthropic` was the one provider
with a genuinely different wire format (the native Messages API); it had no
remaining callers and was dropped rather than ported. Reach Claude models
through `copilot:` or an OpenAI-compatible gateway.

A bare model id (no `provider:` prefix) now resolves to `copilot` for
`gpt-*`/`claude`/`luna`/`terra`/`sol`/`fable` ids and to **`generic`** for
everything else. Previously `grok*` guessed `xai` and the catch-all guessed
`lm-studio`.

The former `mycloud` provider was **renamed into the generic openai-compatible
client** — the `mycloud` name is now just a dynamic `endpoints` map key (in the
psicom stack it routes to the mycloud AI gateway via the `{{model}}` preset
path). The old GCE llama.cpp endpoint lives under a name like `local`:

Credentials are supplied through the process environment. With Tokenman:

```sh
op run --env-file=<(tokenman script agl-copilot) -- bun src/agents/home.mjs 'hello'
```

Tokenman owns provider refresh and any required interactive login; AGL does not
read `.env` or persist provider tokens.

## Decision loops — `agent.switch()`

A second loop shape, for **System One** (decision) models. `agent.run()` is
"the model decides, AGL executes". `agent.switch()` is the inverse: **your
code offers a short list of typed questions, the model picks, your code
transitions, and the run ends when there are no questions left.**

It is driven by a native decision endpoint (`POST /v1/systemone`,
TypeSafe-compatible), not by chat completions. One request answers every
question at a state, each answer carries a probability distribution, and
**no tokens are generated** (`output_tokens` is always 0), so a step costs
prefill only.

```js
import Agent, { pick } from 'agl-ai';

const domain = {
  name: 'triage',
  version: '0.1.0',
  limits: { steps: 8 },

  initial: ({ ticket }) => ({ ticket, read: [], team: null }),

  // `{}` ENDS the run
  questions: (s) => {
    if (s.team) return {};
    return {
      next: pick([
        ...unread(s).map((l) => ({ key: l, text: `Read ${l}` })),
        { key: 'stop', text: 'Stop: enough evidence', priority: -1 },
      ], { instructions: 'Which log should be read next?' }),
      enough: { type: 'bool', instructions: 'Enough evidence to assign a team?' },
      team: {
        type: 'choice',
        instructions: 'Which team should own this ticket?',
        criteria: { billing: 'Billing and payments', infra: 'Infrastructure' },
      },
      urgency: {
        type: 'score',
        instructions: 'How urgent is this?',
        criteria: ['can wait', 'this week', 'today', 'right now'],
      },
    };
  },

  transition: (s, a) =>
    a.next.choice === 'stop' || a.enough.value
      ? { ...s, team: a.team.choice, urgency: a.urgency.score }
      : { ...s, read: [...s.read, { log: a.next.choice, text: LOGS[a.next.choice] }] },

  view: (s) => ({ ticket: s.ticket, read: s.read }),   // what the model reads
};

const agent = await Agent.factory({
  model: 'llama-server:default',        // System Two (generative) — optional here
  decision_model: 'systemone:default',  // System One (decision)
});

const out = await agent.switch({
  domain,
  input: { ticket: 'Card declined at checkout and the customer was charged twice.' },
  trace: './runs/t1.jsonl',
});
// → { state, answers, trace, steps, ended, usage }
//   ended: 'done' | 'step limit' | 'failed' | 'drift' | 'aborted'
```

### Question and answer types

| Question | Answer |
|---|---|
| `{type:'choice', instructions, criteria:{key:desc}}` | `{choice, probabilities, probability, confidence, option?, source}` |
| `{type:'score', instructions, criteria:[lowest,…,highest]}` | `{score, legend, probabilities, confidence, source}` |
| `{type:'noul'` (alias `'bool'`)`, instructions}` | `{noul, value, bool_threshold, source}` |

`pick(options, { instructions })` turns a list of `{key, text, priority?}` into
a `choice` question; higher `priority` sorts first, so a terminal option goes
last with a negative one. The chosen option object comes back on the answer as
`option`.

### What the numbers mean

Every answer carries a `source`, because the sources are **not the same kind
of evidence**:

| `source` | Meaning |
|---|---|
| `systemone` | a distribution measured by the decision model |
| `trace` | replayed from a recorded run — no model involved |

The decision server's own caveat is carried, not papered over: *"The
probabilities are scaled with the temperatures stored in the model file. They
are not guaranteed to be calibrated for your data."* So these are **measured
probabilities under the model's own temperature, not calibrated ones**.

`confidence` is the endpoint's 0–1 spread measure (0 = all options equally
likely) — it is **not** a probability of being correct.

A `noul` answer is only *the probability that the answer is true*. Collapsing
it to a boolean is AGL's decision, not the model's, so the threshold is
explicit (`bool_threshold`, default `0.5`) and the raw number is kept
alongside the derived `value`.

### Trace, replay, fork

```jsonl
{"v":1,"type":"meta","domain":"triage","version":"0.1.0","decision_model":"systemone:default","mode":"run","started":"…"}
{"v":1,"type":"step","step":0,"source":"systemone","state":{…},"view":{…},"questions":{…},"answers":{…}}
{"v":1,"type":"end","ended":"done","steps":4,"state":{…}}
```

```js
await agent.switch({ domain, replay: './runs/t1.jsonl' });  // zero requests, free
await agent.switch({ domain, replay: jsonlString });        // content also accepted
await agent.switch({ domain, replay: trace, fork: 3 });     // replay 3 steps, then go live
```

A replay needs **no endpoint at all** — `decision_model` is only required for
a live run or a fork.

Replay does not merely read the answers back. It **re-runs `questions()` and
`transition()` from each recorded state and checks the recorded questions still
match**. If the domain changed since the trace was written, the run ends
`'drift'` and names the divergence instead of silently producing a different
answer. The trace is *evidence*; the verdict is re-derived from it.

### Configuring the endpoint

`systemone` is built in, pointing at the documented default port and honouring
`SYSTEMONE_URL`:

```
systemone → $SYSTEMONE_URL or http://127.0.0.1:1237
```

Any other name works through the `endpoints` map. A chat-only server answers
`/v1/systemone` with `501`, which AGL reports as "this endpoint is not a
decision model" rather than as a generic failure. A provider with no
`decisions()` export (such as `copilot`) is refused at factory time.

## Running

```sh
bun src/agents/home.mjs turn on my desk light     # run an agent
DEBUG=1 bun src/agents/home.mjs set lights red    # with debug logging

bun test                                          # unit tests (test/unit/)
```

## Related

- [agl-agents](https://github.com/mikesmullin/agl-agents) example agent implementations
