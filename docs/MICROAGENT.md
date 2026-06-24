# Microagents

> **Agent (superset) vs. microagent (subset).** An *agent* is any AGL agent — any
> `Agent.factory` workflow, including conversational, multi-tool, multi-turn agents
> (e.g. a chat assistant). A *microagent* is the **focused subset** of agents defined
> below. The rules in this document apply to **microagents**, not to agents in general.
> Conversational/multi-decision agents are legitimate; they simply are not microagents
> and are not held to this contract.

A microagent is a small, **focused** decision unit that mixes naturally with deterministic
script code. Its simplicity is about **focus, not size**: it brings the model's full
attention to bear on answering exactly one question.

## General Shape

- A function wraps one microagent workflow.
- Inside that function:
  - Call `Agent.factory(...)` once.
  - Register zero or more tools with `microagent.Tool(...)`.
  - Call `microagent.run(...)` once.
  - Return one result.
- In this codebase, prefer assigning the wrapper directly onto `_G` when the module exists only to register shared behavior.

## Core Definition

- A microagent exists to answer **one question** — to make exactly one subjective decision.
- That answer is delivered as **exactly one final tool call** (the output tool). Multiple
  output parameters are fine: they are parts of one answer, not multiple decisions.
- The output should be structured and strongly typed via tool-call schema, so deterministic
  code can consume it reliably.
- If you find yourself needing two *independent* decisions, split that into multiple microagents.
- If a branch can be handled with a cheap deterministic rule, regex, lookup, or parser, do that instead of creating a microagent.

## Prompt And Schema Responsibilities

- **Focus, not size.** A microagent's system prompt may be arbitrarily large — it can load
  whole migration guides, rulebooks, linter findings, or other files from disk. Length is
  not a defect. What matters is that *all* of that context is aimed at answering the single
  question. There is **no** minimal-prompt requirement.
- System prompts should focus on decision intent, constraints, and the quality bar — but
  may include as much domain knowledge as the one decision genuinely needs.
- Pushing detailed field semantics into the output schema descriptions is good practice, but
  it is fine for the prompt to also carry the domain rules required to make the decision.
- Prefer schema names that match the domain language used by the caller, such as `headline`, `description`, `applies_if`, `formatting_instructions`, and `action_taken`.

## Duplication (a discipline, not a hard rule)

These keep a prompt lean when leanness helps, but are **not** requirements — a focused
microagent may legitimately restate context in the prompt when that sharpens the decision:

- Prefer to let output tool parameter types/descriptions carry return-shape semantics.
- Prefer to let `microagent.Tool(...)` definitions carry tool behavior.
- Prefer to assemble final display strings in deterministic code rather than the prompt.

## Input Style

- User prompts should pass runtime values in explicit XML-style tags.
- Keep tag payloads deterministic and clean: preprocessed text, selected context, IDs, and similar inputs.
- Prefer tag names that describe meaning, not implementation history, such as `email-content`, `user-instruction`, `rule-logic`, and `execution-outcome`.
- Only pass context the model actually needs for the decision. Remove stale or derived inputs that deterministic code already knows.

## Architectural Role

- Deterministic code handles I/O, shell commands, parsing, retries, validation, and side effects.
- Microagents handle subjective interpretation: classification, recommendation, intent mapping, and relevance checks.
- Deterministic code executes the chosen action and persists state.
- Deterministic code should also normalize final presentation for humans, such as building the final summary string or selecting which fields to persist.
- Tool-backed microagents should expose domain actions with small, literal names that mirror the real operations being executed.

## Practical Quality Checks

The three load-bearing invariants of a microagent:

- **Single decision** — one question, one `Agent.factory`, one `run`, one final output tool
  call. (Multiple output parameters are fine.)
- **Typed output** — a clear, strongly-typed output schema the caller can consume directly.
- **Deterministic boundary** — I/O, parsing, formatting, persistence, and retries live in the
  calling deterministic code, not inside the model.

Supporting good practices (not pass/fail):

- Return the model result in a shape the caller can use directly, with any final string formatting handled outside the model.
- Remove incidental logging, adapter code, and legacy wrapper exports when they do not improve correctness.
- Prefer simplification that reduces moving parts across the boundary: fewer aliases, fewer compatibility shapes, fewer invented abstractions.

## Qualities Seen In Retrospect

- The better microagents became narrower: they classify, extract, recommend, or summarize one thing and stop there.
- The better prompts became more *focused* — every line, however long the prompt, serving the single decision; the schema descriptions carried the precision.
- The better interfaces became more explicit: XML-tagged inputs in, typed fields out.
- The better implementations left operational work in deterministic code and kept the model on judgment tasks.
- The better refactors removed unnecessary microagents entirely when plain code was both cheaper and more reliable.
