# Microagents

A microagent is a small, single-purpose decision unit that mixes naturally with deterministic script code.

## General Shape

- A function wraps one microagent workflow.
- Inside that function:
  - Call `Agent.factory(...)` once.
  - Register zero or more tools with `microagent.Tool(...)`.
  - Call `microagent.run(...)` once.
  - Return one result.
- In this codebase, prefer assigning the wrapper directly onto `_G` when the module exists only to register shared behavior.

## Core Definition

- A microagent exists to make exactly one subjective decision.
- Its output should be structured and strongly typed via tool-call schema, so deterministic code can consume it reliably.
- If you find yourself needing multiple decisions, split that into multiple microagents.
- If a branch can be handled with a cheap deterministic rule, regex, lookup, or parser, do that instead of creating a microagent.

## Prompt And Schema Responsibilities

- System prompts should stay short, usually a few sentences.
- System prompts should focus on decision intent, constraints, and quality bar.
- Push detailed field semantics into the output schema descriptions instead of bloating the prompt.
- Prefer schema names that match the domain language used by the caller, such as `headline`, `description`, `applies_if`, `formatting_instructions`, and `action_taken`.

## Avoid Duplication In Prompts

- Do not describe return type or output field descriptions in the system prompt.
  That belongs in output tool parameter types and descriptions.
- Do not explain tool behavior, tool count, or available tool categories in the system prompt.
  That belongs in `microagent.Tool(...)` definitions, including parameter types and descriptions.
- Do not embed output templates in the prompt when deterministic code can assemble the final display string.

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

- One microagent equals one decision.
- One run call per wrapper function.
- Clear typed output schema.
- Minimal system prompt.
- No duplicated docs between prompt text and tool or schema definitions.
- Return the model result in a shape the caller can use directly, with any final string formatting handled outside the model.
- Remove incidental logging, adapter code, and legacy wrapper exports when they do not improve correctness.
- Prefer simplification that reduces moving parts across the boundary: fewer aliases, fewer compatibility shapes, fewer invented abstractions.

## Qualities Seen In Retrospect

- The better microagents became narrower: they classify, extract, recommend, or summarize one thing and stop there.
- The better prompts became shorter and more literal, while the schema descriptions carried the precision.
- The better interfaces became more explicit: XML-tagged inputs in, typed fields out.
- The better implementations left operational work in deterministic code and kept the model on judgment tasks.
- The better refactors removed unnecessary microagents entirely when plain code was both cheaper and more reliable.
