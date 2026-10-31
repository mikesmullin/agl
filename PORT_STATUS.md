# agl-rs — port status and Blaze measurements

Rust port of `agl-ai`, on the `rust` orphan branch of the same repo.
The JS source it was ported from is kept under `js/` as the reference.

```
/workspace/agl        main branch   (JavaScript, Bun)
/workspace/agl-rs     rust branch   (this; orphan, separate worktree)
```

`cargo test` — **56 passing, 0 failing.**
`cargo run --example triage` — verified end to end against the live
System One slot at `127.0.0.1:1237`.

## What is ported

| Module | From | Notes |
|---|---|---|
| `src/config.rs` | `lib/config.mjs` | Same narrow YAML subset (comments, nested maps, quoted/plain scalars, ints). Re-read from disk on every lookup, so an edit takes effect with no restart. |
| `src/handlebars.rs` | `lib/mini-handlebars.mjs` | `{{path}}`, `{{#if}}`/`{{#unless}}`/`{{#each}}`/`{{#with}}`, `{{else}}`/`{{else if}}`, `@index`/`@key`/`@first`/`@last`, `this`, `./`, `../`, `{{~ ~}}`, `\{{escape}}`. |
| `src/provider.rs` | `providers/generic.mjs` | Chat completions, `/v1/models`, `/v1/embeddings`, and the native `/v1/systemone` decision endpoint. Custom-CA handling with relaxed hostname checks, matching the JS rationale. |
| `src/agent.rs` | `agent.mjs` | Model-spec parsing, provider registry + aliases, endpoint quirks, context-window resolution, tool registry, the generative run loop, and `switch()`/`replay()`/`fork()`. |
| `src/switch.rs` | `switch.mjs` | The whole decision loop: domain contract, `pick`, trace, replay, drift detection, fork. |

### Where the port is better than a transcription

`switch.rs` is the module that actually gains from Rust, and the gain is not
speed:

- `QuestionKind` is an enum, so a malformed question type cannot be
  constructed — in JS it is a string validated at request time.
- `Answer` is a sum type (`Choice`/`Score`/`Noul`) instead of one struct with
  optional fields, so a choice answer cannot be read as if it carried a score,
  and `match` on it is exhaustive.
- `Source` (`Systemone` / `Trace`) is an enum, so the "these are not the same
  kind of evidence" rule is enforced by the compiler rather than by a
  convention about a string field.
- `Mode` (`Run` / `Replay` / `Fork`) makes "a replay needs no endpoint" a type
  fact: the replay variant carries no decider at all.

## What is NOT ported

- **`copilot`** — the one genuine exception in the JS tree: GitHub device-flow
  auth plus token exchange, not just a different base URL. Porting OAuth
  device flow is a separate job from porting the inference path. `generic`
  (and therefore every `endpoints` entry, plus the `llama-server`, `openai`,
  `systemone`, `meta` and `muse` names) is ported.
- **Streaming** (`stream: true` + `on_delta`). The non-streaming path is
  complete; the SSE assembler is not ported.
- **The OpenAI-compatible gateway passthrough** (`lib/openai-gateway.mjs`,
  `chatCompletions`/`listModels` handlers). The `proxy` option on the agent
  *is* ported.
- The output-tool **nudge loop** and the LLM-as-judge fallback. The run loop
  is bounded by `max_turns`, but the protocol-violation nudging is not ported.

## Blaze — measured, not assumed

`tmp/FAST_RUST.md` asked whether the compile-time win is real. It is, and it
is smaller than the headline.

Installed `blaze 0.20261027.0` (stable channel) via `curl -fsSL https://ix.dev/blaze | sh`
after reading the script: HTTPS-only, TLS 1.2+, SHA256-verified against the
release's `SHA256SUMS`, installs into `~/.cargo/bin`.

Protocol (`bench/compile-bench.sh`): one cold build per tool reported
separately, then 10 rounds that each edit **one function body** (a real change
to codegen, not a whitespace poke) and rebuild. Median and spread, not a single
run. Machine: Linux x86-64, 64 cores, 62 GB RAM.

### Incremental build, one function edited

| | cargo | blaze | speedup |
|---|---|---|---|
| run 1 | 236 ms (229–343) | **61 ms** (57–88) | **3.87×** |
| run 2 | 214 ms (206–229) | **59 ms** (57–82) | **3.63×** |

### Type-check only (`check`)

| | cargo | blaze | speedup |
|---|---|---|---|
| run 2 | 140 ms (136–3041) | **29 ms** (29–37) | **4.83×** |

(The 3041 ms `cargo check` outlier is the first check after the build loop;
the median is the honest figure.)

### Cold build

| | cargo | blaze |
|---|---|---|
| first ever (daemon cold) | 5.6–6.2 s | **21.8 s** |
| daemon already warm | 5.6 s | 5.1 s |

Blaze is ~3.5× **slower** on the very first build, which is expected and
documented — it has no first-build shortcut and must build its in-memory
representation of the workspace. Once its daemon is warm, a cold build is
comparable.

### Answering the question honestly

**Yes, the improvement is measurable: ~3.6–3.9× on incremental builds and
~4.8× on `check`.** But it is *not* the 11× that Blaze publishes for Linux
x86-64, and the gap is explainable rather than suspicious:

- `agl-rs` is **small**. The published benchmarks are ripgrep (cargo 508 ms),
  nushell (1.25 s), helix (2.15 s) and bun (9.11 s) — baselines 2× to 40×
  slower than our 214 ms. At 214 ms a large fraction is fixed cargo and
  linker overhead that no compiler can remove, so there is simply less to win.
  I predicted this before measuring, and the measurement agreed.
- The 92× headline and the 24× figure are a best case and an aarch64 number
  respectively; 11× is their own Linux x86-64 average.

### The important caveat: `blaze test` cannot run this crate

`blaze build` and `blaze check` work and are genuinely compiling — a
deliberate type error (`pub fn __bench_probe() -> u64 { "not a u64" }`) is
caught as `error[E0308]`, so the speedup is not a no-op being timed.

But `blaze test` and `cargo run --example triage` through Blaze both **refuse
to build**, naming what they cannot lower:

```
error: `triage` reaches functions blaze could not compile, so it is not built:
  <reqwest::async_impl::client::ClientBuilder>::build: unsupported:
    … writable static `__RUST_STD_INTERNAL_VAL` without a rustc symbol
  <tokio::runtime::blocking::pool::BlockingPool>::new: unsupported: …
  <rustls::client::handy::cache::ClientSessionMemoryCache>::new: unsupported: …
```

This is Blaze behaving **correctly by its own design**: its codegen returns an
explicit "unsupported" and fails with a named reason rather than guessing and
miscompiling. But the practical consequence for this crate is real: the async
HTTP stack (tokio + reqwest + rustls) is out of reach, so Blaze accelerates
the *edit → type-error* loop while `cargo test` remains the only way to
actually run the tests.

**Net recommendation:** worth keeping for the inner edit loop (`blaze check` at
29 ms vs 140 ms is a noticeably tighter cycle), but it cannot replace cargo
here, and their own advice — keep `cargo check`/CI as the final word — is the
right call. For a crate without the async HTTP stack the picture would likely
be better; for a *larger* crate the speedup should also be larger.
