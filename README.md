# agl-rs

Rust port of [`agl-ai`](../agl) — a minimalist Pydantic-AI-style agent
library. Lives on the `rust` orphan branch of the same repository.

The branch is an orphan, so the JavaScript it was ported from is not checked
out beside it. Paths like `src/agent.mjs` in the `//!` headers refer to that
JS tree, which is read from the JS branch without switching worktrees:

```sh
git show main:src/agent.mjs
```

`PORT_STATUS.md` has what is and is not ported, plus the measured Blaze
compile-time comparison. It is kept as local notes and is not committed.

## Build

```sh
cargo test                      # 56 tests
cargo run --example triage      # live decision loop against :1237
```

## Two loops

`Agent::run()` is "the model decides, AGL executes". `Agent::switch()` is the
inverse: your code offers a short list of typed questions, the model picks,
your code transitions, and the run ends when there are no questions left.

```rust
use agl::agent::{Agent, Factory};

let agent = Agent::factory(Factory {
    model: Some("llama-server:default".into()),       // System Two
    decision_model: Some("systemone:default".into()), // System One
    ..Default::default()
})?;

let out = agent.switch(&domain, &input, handle)?;
// out.ended: Done | StepLimit | Failed | Drift | TraceExhausted
```

A domain implements three functions — `questions` returning an empty map ends
the run:

```rust
impl Domain for Triage {
    fn initial(&self, input: &Value) -> Value { … }
    fn questions(&self, state: &Value) -> Result<BTreeMap<String, Question>, SwitchError> { … }
    fn transition(&self, state: &Value, answers: &BTreeMap<String, Answer>) -> Result<Value, SwitchError> { … }
    fn view(&self, state: &Value) -> Value { … }   // what the model reads
}
```

Questions are `Question::choice`, `Question::score`, `Question::noul`, or
`pick(options, instructions)` for a list of legal moves. Answers come back as
a sum type carrying the model's probability distribution.

## Replay is a type fact, not a flag

```rust
agent.replay(&domain, &trace_jsonl)?;        // zero requests; needs no endpoint
agent.fork(&domain, &trace_jsonl, 3, h)?;    // replay 3 steps, then go live
```

Replay re-runs `questions()` and `transition()` from each recorded state and
checks the recorded questions still match. A domain edited since the trace was
written ends the run as `Drift`, naming the divergence, instead of silently
producing a different answer.

## What the numbers mean

Every `Answer` carries a `Source` — `Systemone` (measured by the decision
model) or `Trace` (replayed). These are not the same kind of evidence, and the
enum keeps them from sharing a word.

The decision server's own caveat is carried, not papered over: *the
probabilities are scaled with temperatures stored in the model file and are
not guaranteed to be calibrated for your data*. `confidence` is a 0–1 spread
measure, not a probability of being correct. A `Noul` answer is only the
probability that the answer is true; the boolean is derived by AGL at an
explicit `bool_threshold`, because the model never said "true" or "false".
