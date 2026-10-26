import { expect, test } from 'bun:test';
import Agent from '../../src/agent.mjs';

test('tool registry defaults to 256, permits replacement, and supports custom limits', () => {
  const agent = new Agent();
  const add = name => agent.Tool(name, '', {}, [], () => {});
  for (let i = 0; i < 256; i++) add(`tool_${i}`);
  expect(() => add('overflow')).toThrow('maximum 256');
  expect(() => add('tool_0')).not.toThrow();
  expect(agent._renderTools()).toHaveLength(256);
  agent.max_tools = 257;
  add('extra');
  expect(() => add('overflow')).toThrow('maximum 257');
  for (const invalid of [0, -1, 1.5, NaN, Infinity, '256']) {
    agent.max_tools = invalid;
    expect(() => add('overflow')).toThrow('positive integer');
  }
});
