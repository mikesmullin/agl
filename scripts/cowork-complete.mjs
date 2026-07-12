#!/usr/bin/env bun
/**
 * One-shot completion for gl1 cowork (stdout = assistant text only).
 * Usage:
 *   bun scripts/cowork-complete.mjs <provider:model> <system> <user>
 * Example:
 *   bun scripts/cowork-complete.mjs copilot:claude-sonnet-5 "Be brief." "Hello"
 *
 * Exit 0 on success. Errors → stderr (no secrets) + non-zero exit.
 */
import Agent from '../src/agent.mjs';

const model = process.argv[2] || 'copilot:claude-sonnet-5';
const system = process.argv[3] || 'You are a helpful assistant.';
const user = process.argv[4] || '';

if (!user) {
  console.error('usage: cowork-complete.mjs <provider:model> <system> <user>');
  process.exit(2);
}

try {
  const agent = await Agent.factory({
    model,
    system_prompt: system,
    max_tokens: 512,
  });
  const result = await agent.run({ prompt: user });
  // freeform: full OpenAI-shaped response
  const content =
    result?.choices?.[0]?.message?.content ??
    (typeof result === 'string' ? result : null) ??
    (result?.last_output != null ? String(result.last_output) : null);
  if (!content) {
    console.error('no content in response');
    process.exit(1);
  }
  process.stdout.write(String(content));
  process.exit(0);
} catch (e) {
  console.error(e?.message || String(e));
  process.exit(1);
}
