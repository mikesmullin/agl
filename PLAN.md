# PLAN — AGL update

Two parts: **Part 1 is done** (spring cleaning, needs review not approval).
**Part 2 is the design that needs your approval** before I write code.
**Part 3** is the Rust port, which runs after Part 2 lands.

---

## Part 1 — Spring cleaning (DONE, `main`)

### Providers: 8 modules → 3

| Kept | Why |
|------|-----|
| `generic` | The one OpenAI-compatible client. Was `openai.mjs`, formally renamed — module, provider id, log tags and error strings. |
| `copilot` | Genuinely different: device-flow auth + token exchange. |
| `meta` | Kept **for now** — see the verification below. |

Removed: `xai`, `ollama`, `lm-studio`, `runpod`, `anthropic`. Also deleted
`scripts/smoke-xai-grok45.mjs` and `src/agents/lm-studio-test.mjs`.

The first four were plain OpenAI-compatible endpoints, so an `endpoints:` entry
replaces each with no loss of function — and an existing `context_windows`
group of the same name keeps resolving, which I locked with a test:

```yaml
endpoints:
  xai: https://api.x.ai
  ollama: http://localhost:11434
  lm-studio: http://localhost:1234
```

`anthropic` was the only one with a genuinely different wire format (native
Messages API). It had **no remaining callers anywhere in `/workspace`**, so I
dropped it rather than porting it. Claude models remain reachable via
`copilot:` or any OpenAI-compatible gateway.

### Nothing silently breaks

`llama-server:default` is your live `default_model`, and `llama-server:*` is
hard-coded in `cowork`, `factory/sandbox`, and `m-js-cmp-chat`. Deleting the
*name* would have broken your daily driver for no benefit, so the deprecated
ids are kept as **aliases**, not modules:

| Alias | → | Preserved behaviour |
|-------|---|--------------------|
| `llama-server:` | `generic` | `http://127.0.0.1:1234` default, `LLAMA_SERVER_*` envs, its own `context_windows.llama-server` group, never inherits `MYCLOUD_BASE_URL` |
| `openai:` | `generic` | `https://api.openai.com` / `OPENAI_BASE_URL` default |
| `muse:` | `meta` | normalized at bind time |

`agent.provider` deliberately keeps the **surface** name (so config groups and
endpoint defaults still resolve); only module lookup goes through the alias
table. New file `test/unit/provider-registry.test.mjs` pins this contract.

### One behaviour change worth your attention

A **bare** model id (no `provider:` prefix) previously guessed `xai` for
`grok*` and `lm-studio` for everything else. Both targets are gone, so the
catch-all is now `generic`. `gpt-*`/`claude`/`luna`/`terra`/`sol`/`fable` →
`copilot`, unchanged.

### One external breakage I did not touch

`angela/test/provider-request-capture.test.mjs:24` imports
`agl-ai/providers/lm-studio`. That's outside this repo, so I left it. It needs
to become `agl-ai/providers/generic` — say the word and I'll fix it.

### `meta`: verified — it IS OpenAI-compatible, with one real quirk

You asked me to check. Reading `meta.mjs` against `generic.mjs`:

| Aspect | Same as generic? |
|--------|------------------|
| Auth header (`Authorization: Bearer`) | **identical** |
| Endpoint, request/response shape, `/v1/chat/completions`, `/v1/models` | **identical** (endpoint is just hard-coded) |
| Default model `muse-spark-1.2-contributor` | config, not code |
| **`tool_choice`** | **DIFFERENT** — forced to `"auto"` whenever tools are present; Muse rejects `required`, `none`, and the object form |
| **Streaming** | **DIFFERENT** — meta has no streaming path at all; generic does |

So `meta` is ~95% redundant. Collapsing it needs `generic` to learn
**per-endpoint quirk flags**, which is a small, clean addition:

```yaml
endpoints:
  meta:
    url: https://api.meta.ai
    default_model: muse-spark-1.2-contributor
    tool_choice: auto     # coerce every request
    stream: false         # never send stream:true
```

I **did not** collapse it yet, deliberately: it changes wire behaviour
(streaming would switch on) against a live API I can't test from here, and a
silent regression there is worse than one extra 136-line module. It's
question 3 below.

---

## Part 2 — `agent.switch()` (APPROVED + IMPLEMENTED, 97 tests green)

Per your clarification: **a method on the agent instance**, with the System One
model declared at `Agent.factory()` time.

### What reading `~/.config/inference` changed

My first draft was wrong in an important way, and the correction makes this
much simpler. I had planned to synthesise probabilities out of
`logprobs`/`top_logprobs` on a chat endpoint. That is unnecessary: your `:1237`
slot is **H2O-Lightning-4B** (`h2o-lightning-4b`, Q8_0, 4.2 B params, 8192
ctx, `+mmproj`), and its `/v1/models` advertises
`"output_modalities": ["decisions"]`. Your own README is explicit that
"a decision endpoint cannot chat".

It serves a **native typed-decision API**: `POST /v1/systemone`
(TypeSafe-compatible). I read the spec in the fork's
`tools/server/README.md` and ran it against your live slot:

```
POST http://127.0.0.1:1237/v1/systemone
{ "state": "Customer message: I was charged twice …",
  "questions": {
    "route":   {"type":"choice","instructions":"Which team?","criteria":{"billing":null,"shipping":null,"technical":null}},
    "angry":   {"type":"noul","instructions":"Is the customer angry?"},
    "urgency": {"type":"score","instructions":"How urgent?","criteria":["can wait","this week","today","right now"]}}}
→ 200 in 68 ms
{ "route":   {"choice":"billing","probabilities":{"billing":0.9690,"shipping":0.0185,"technical":0.0126},"confidence":0.9534},
  "angry":   {"noul":0.6474},
  "urgency": {"score":1.3459,"probabilities":{"0":0.0237,"1":0.7052,"2":0.1727,"3":0.0984},"confidence":0.6067},
  "usage":   {"input_tokens":297,"output_tokens":0} }
```

**This endpoint *is* the switch shape already.** The correspondence is 1:1,
not approximate:

| Switch concept | `/v1/systemone` |
|---|---|
| `view(state)` → what the model reads | `state` (string, object or array — I verified an object works) |
| `questions(state)` → `{id: question}` | `questions` — identical shape, identical `instructions`/`criteria` fields |
| question types `bool` / `choice` / `score` | `noul` / `choice` / `score` |
| "answers come with probabilities" | `probabilities` (sum to 1) + `confidence` |
| one cheap step | **one request answers every question at that state**; `output_tokens: 0` — pure prefill |

So AGL doesn't need to *emulate* a decision model. `agent.switch()` is the
**loop** (`initial → questions → transition → repeat`), trace and replay
around a native call. That is a much smaller, more honest change than my first
draft.

### Shape

`Agent.factory()` gains **`decision_model`** — the System One model. It's
separate from `model` (System Two) so one agent can do both, which is the
Tier-1/Tier-3 split in `tmp/TURTLE_FORK3.md`:

```js
const agent = await Agent.factory({
  model: 'llama-server:default',        // System Two (generative) — optional
  decision_model: 'systemone:default',  // System One (:1237)
});

const out = await agent.switch({
  domain,
  input: { ticket: 'card declined at checkout' },
  trace: './runs/t1.jsonl',
});
// → { state, answers, trace, steps, ended: 'done'|'step limit'|'failed'|'drift' }
```

`systemone` is just an `endpoints:` entry — **no new provider**:

```yaml
endpoints:
  systemone: http://127.0.0.1:1237
```

The domain is plain data + three functions, exactly Switch's contract:

```js
const domain = {
  name: 'triage',
  version: '0.1.0',
  limits: { steps: 20 },

  initial: ({ ticket }) => ({ ticket, read: [], team: null }),

  // {} ends the run
  questions: (s) => {
    if (s.team) return {};
    return {
      next: pick([
        ...unread(s).map((l) => ({ key: l, text: `Read ${l}` })),
        { key: 'stop', text: 'Stop: enough evidence', priority: -1 },
      ], { instructions: 'Which action next?' }),
      enough: { type: 'noul', instructions: 'Enough evidence to assign a team?' },
    };
  },

  transition: (s, a) => ({ ...s, team: a.next.choice === 'stop' ? route(s) : null }),
  view: (s) => ({ ticket: s.ticket, read: s.read }),   // becomes `state`
};
```

### Implementation

| Change | File | Note |
|---|---|---|
| `decisions({ state, questions, files })` → `POST /v1/systemone` | `src/providers/generic.mjs` | **additive export.** Reuses the existing `_fetch`/`_request`, so it inherits base_url/api_key/TLS/error-detail handling for free |
| `decision_model` option + `_bindDecisionModel()` | `src/agent.mjs` | mirrors the existing `_wideModel` binding pattern |
| `switch()` method + `pick()` helper | `src/switch.mjs`, re-exported as a method | the loop, trace, replay, fork |

`_runGated` and the output-tool/nudge/judge machinery are **not touched** —
`switch()` is a sibling entry point, so the ~10 sibling consumers of
`agent.mjs` keep their exact behaviour.

### Two small correctness details I verified

1. **Never send an empty question set.** `{"questions":{}}` returns
   `400 "questions" must be a non-empty object`. The loop must detect `{}`
   locally and end the run — which is also what the Switch contract says.
2. **`noul` has no discrete value**, only "the probability that the answer is
   true" (I got `0.6474`). Collapsing that to a boolean is a decision *AGL*
   makes, not the model, so `bool_threshold` is explicit (default `0.5`) and
   the answer keeps the raw `noul` number alongside any derived `value`.

### Honesty: `source` and `confidence`

Every answer records where its numbers came from:

| `source` | Meaning |
|---|---|
| `systemone` | native `probabilities` + `confidence` from the decision model |
| `logprobs` | renormalised `top_logprobs` from a chat endpoint — the fallback (verified working on `:1234`: `A=0.9892 / B=0.0049` → `0.9951` over `{A,B}`) |
| `tool-call` | forced `tool_choice` on an endpoint with neither. **`probability: null`** — never a fabricated number |
| `trace` | replayed verbatim |

And the caveat carried verbatim from the server docs, because it's exactly the
decision-word discipline from your ontology work:

> "The probabilities are scaled with the temperatures stored in the model
> file. **They are not guaranteed to be calibrated for your data.**"

So AGL reports a *measured distribution under the model's own temperature*,
not a calibrated probability. It must not use the stronger word. This is the
concrete fix for the `code-review` diagnosis in `tmp/TURTLE_FORK3.md` — that
`confidence` there is a model-said number.

### Trace, replay, fork

```jsonl
{"v":1,"type":"meta","domain":"triage","version":"0.1.0","decision_model":"systemone:default","started":"…"}
{"v":1,"type":"step","step":0,"state":{…},"questions":{…},"answers":{…},"usage":{"input_tokens":297,"output_tokens":0}}
{"v":1,"type":"end","ended":"done","steps":3,"state":{…}}
```

```js
await agent.switch({ domain, trace, replay: true });   // zero requests, deterministic
await agent.switch({ domain, trace, fork: 3 });        // replay 3 steps, then continue live
```

Replay **re-runs `questions()` and `transition()`** from each recorded state
and checks the recorded questions still match. If the domain changed since the
trace was written, the run ends `'drift'` and names the divergence instead of
silently producing a different answer. That's the `derivations.tsv`
re-derivation pattern: the trace is *evidence*, and the verdict is re-derived
from it rather than trusted. Plain Switch replay does not do this.

### Budget note

Your `:1237` slot runs `-c 8192`, and h2o-lightning truncates a state over
32 000 tokens (keeping the first and last 16 000). So `view(state)` is
budgeted against the resolved context window and the loop fails loudly rather
than letting the server silently truncate the middle of the evidence.

Per your config comments, scoring is **serial by design** on the single
`-np 1` slot ("Scoring concurrently across slots measured no faster … so the
adapter stays serial"), so `switch()` issues one request per step and does not
try to parallelise questions.

### Scope

New `src/switch.mjs` (~250 lines), `decisions()` in `generic.mjs` (~40),
`decision_model` binding (~40), tests, one worked example, README section.
Smaller than my first draft because the native endpoint does the hard part.

### Not proposed

No case-folder/CLI harness (question 3). No fine-tuning pipeline, though the
trace is deliberately a usable training record — which is the "run enough
cases with a good model, then fine-tune an open decision model" path in
`tmp/SWITCH.md`.

## Part 3 — Rust port (DONE, `rust` branch, 56 tests green)

`/workspace/agl-rs` is a worktree on a new **`rust` orphan branch** of this
repo. The JS source is kept there under `js/` as the port reference. Full
detail in `agl-rs/PORT_STATUS.md`.

**4,507 lines of Rust. `cargo test`: 56 passing. Clippy clean.**
`cargo run --example triage` verified end to end against the live `:1237`
slot — 4 steps, 1,980 input tokens, **0 output tokens**, replay deterministic
with 0 requests, drift caught at step 0.

Ported: `config` (same YAML subset), `handlebars` (the `{{...}}` subset),
`provider/generic` (chat completions, models, embeddings, `/v1/systemone`),
`agent` (spec parsing, registry + aliases, quirks, context windows, tools, run
loop, `switch`/`replay`/`fork`), and `switch` (the whole decision loop).

**Not ported, and said plainly:** `copilot` (device-flow OAuth — a separate
job from the inference path), streaming/SSE, the gateway passthrough handlers,
and the output-tool nudge/judge loop.

Where the port earns its keep is `switch.rs`, and not through speed:
`QuestionKind`, `Answer`, `Source` and `Mode` are enums/sum types, so a
malformed question cannot be built, `match` on an answer is exhaustive, the
"measured vs replayed" distinction is compiler-enforced rather than a string
convention, and "a replay needs no endpoint" becomes a type fact.

### Blaze — measured

Installed `blaze 0.20261027.0` after reading the installer (HTTPS-only,
TLS 1.2+, SHA256-verified against the release `SHA256SUMS`). Protocol:
cold build reported separately, then 10 rounds each editing **one function
body**; median and spread, not one run. Linux x86-64, 64 cores.

| | cargo | blaze | speedup |
|---|---|---|---|
| incremental build (run 1) | 236 ms | **61 ms** | **3.87×** |
| incremental build (run 2) | 214 ms | **59 ms** | **3.63×** |
| `check` (type-check only) | 140 ms | **29 ms** | **4.83×** |
| cold build, daemon cold | 6.2 s | 21.8 s | 0.28× |
| cold build, daemon warm | 5.6 s | 5.1 s | 1.10× |

**Yes, the improvement is measurable: ~3.6–3.9× on incremental builds, ~4.8×
on `check`.** It is *not* Blaze's published 11× for Linux x86-64, and the gap
is explainable: `agl-rs` is small. Their benchmarks are ripgrep (508 ms),
nushell (1.25 s), helix (2.15 s), bun (9.11 s) — baselines 2–40× slower than
our 214 ms, where fixed cargo/linker overhead dominates and there is less to
win. I predicted that before measuring and the measurement agreed.

Validity checked rather than assumed: a deliberate type error is caught by
`blaze build` as `error[E0308]`, so the 61 ms is real compilation, not a
no-op being timed.

**The caveat that matters:** `blaze test` **cannot build this crate.** It
refuses to lower the async HTTP stack and names why —
`reqwest::ClientBuilder::build`, `tokio::BlockingPool::new`,
`rustls::ClientSessionMemoryCache::new`, all
`unsupported: writable static __RUST_STD_INTERNAL_VAL without a rustc symbol`.
That is Blaze working as designed (explicit "unsupported" instead of a silent
miscompile), but the consequence is concrete: it speeds up the
edit→type-error loop while `cargo test` stays the only way to run the tests.
Worth keeping for the inner loop; it cannot replace cargo here.

## Decisions taken (approved)

1. **`agent.switch()`** as a method, with `decision_model` declared at `Agent.factory()` time. ✅ implemented
2. **systemone-only for v1** — no chat/logprobs fallback. `switch()` refuses a non-decision endpoint instead of degrading. ✅ implemented
3. **No case-folder/CLI harness.** ✅ skipped
4. **`meta` collapsed** into `generic` + per-endpoint quirk flags. ✅ implemented (`tool_choice: auto`, `stream: false`), pinned by a test that asserts both reach the wire

## Still open

- `angela/test/provider-request-capture.test.mjs:24` imports
  `agl-ai/providers/lm-studio`, which no longer exists. It is outside this
  repo, so I left it; it needs to become `agl-ai/providers/generic`.
- Nothing is committed on `main` — the provider cull and `switch()` are staged
  in the working tree for review. The `rust` branch is committed, since an
  orphan branch does not exist until it has a commit.
- `meta`'s collapse is untested against the live `api.meta.ai` (unreachable
  from here). The quirks are verified at the request-building layer only.
