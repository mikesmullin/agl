import { debug, log } from '../../src/lib/debug.mjs';
import Agent from '../../src/agent.mjs';

const test0 = async () => {
  const agent = await Agent.factory({
    model: 'xai:grok-4-1-fast-reasoning',
    system_prompt: 'You are a helpful assistant that can answer questions and help with tasks.',
  });

  const result = await agent.run({ prompt: 'What is 2+2?' });
  log('result', result);
};

const test1 = async () => {
  const agent = await Agent.factory({
    model: 'xai:grok-4-1-fast-reasoning',
    system_prompt:
      'Use the `roulette_wheel` function to see if the ' +
      'customer has won based on the number they provide.',
    output_tool: { type: 'boolean' },
  });

  agent.Tool('roulette_wheel', 'check if the square is a winner', {
    v1: { type: 'integer' },
  }, ['v1'], async (ctx, { v1 }) => {
    return ctx.magic_num == v1 ? 'winner' : 'loser';
  });

  const magic_num = 18;
  const result1 = await agent.run({ prompt: 'Put my money on square eighteen', magic_num });
  log('', { result1 });

  const result2 = await agent.run({ prompt: 'I bet five is the winner', magic_num });
  log('', { result2 });
};

(async () => {
  // await test0();
  await test1();
  // process.exit(0);
})();
