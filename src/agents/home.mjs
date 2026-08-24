import Agent from '../agent.mjs';
import {
  alarm__create, alarm__list, alarm__update, alarm__delete,
  alarm__show, alarm__snooze,
  timer__create, timer__dismiss, timer__show,
} from '/workspace/agl-common/lib/tool/adb.coffee';
import { desk_light, pc_light_color } from '/workspace/agl-common/lib/tool/home.coffee';

const _scriptStart = Date.now();

let finalOutput = { output: null, summary: '(agent produced no summary)' };

const agent = await Agent.factory({
  // model: 'ollama:gemma4:26b',
  model: process.env.FAV_LOCAL_LLM,
  parallel_tools: true,
  system_prompt:
    'You are a personal assistant agent.\n' +
    'You help me control my home using home automation tools.\n' +
    'I have two independently controllable lights: my desk lamp (desk_light tool) and my PC tower lights (pc_light_color tool). ' +
    'The PC tower lights include the chassis LED strip and the GPU RGB; pc_light_color always sets both together. ' +
    'When I say "lights" (plural) or otherwise do not name a specific light, apply the request to BOTH lights. ' +
    'When I name a specific light (e.g. "desk light" or "pc light"), only affect that one.\n' +
    'You can manage alarms and timers on my Google Pixel Clock app: ' +
    'alarm__create, alarm__list, alarm__update, alarm__delete, alarm__show, alarm__snooze, ' +
    'timer__create, timer__dismiss, timer__show. ' +
    'Convert spoken times to 24-hour hour (0-23) and minute (0-59); e.g. "8am" is hour=8 minute=0, "8:30pm" is hour=20 minute=30. ' +
    'Timer length is seconds (5 minutes → 300). Prefer matching existing alarms by label when deleting or updating. ' +
    'alarm__list only reports the next scheduled alarm (Clock has no list intent). alarm__snooze only affects a currently ringing alarm.\n' +
    'Call each necessary tool at most once.',
  output_tool: {
    description: 'Report whether you were successful, along with a concise summary.',
    parameters: {
      output: { type: 'boolean', description: 'were you successful?' },
      summary: { type: 'string', description: 'a short summary of what you tried, what you expected to happen, and what you observed.' },
    },
    required: ['output', 'summary'],
    fn: (ctx, args) => {
      finalOutput = args;
      return 'Acknowledged.';
    },
  },
});

agent.Tool(desk_light);
agent.Tool(pc_light_color);
agent.Tool(alarm__create);
agent.Tool(alarm__list);
agent.Tool(alarm__update);
agent.Tool(alarm__delete);
agent.Tool(alarm__show);
agent.Tool(alarm__snooze);
agent.Tool(timer__create);
agent.Tool(timer__dismiss);
agent.Tool(timer__show);

const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
  console.error('Usage: bun src/agents/home.mjs <prompt>\n');
  console.error('Example prompts:');
  console.error('  turn on my desk light');
  console.error('  change my desk light color to red');
  console.error('  change my desk light color to dark blue');
  console.error('  set pc light color to deep forest green');
  console.error('  set lights to purple');
  console.error('  turn off my desk light');
  console.error('  set an alarm for 8am');
  console.error('  set an alarm for 7:30 pm labeled gym');
  console.error('  when is my next alarm');
  console.error('  change the gym alarm to 7am');
  console.error('  delete the gym alarm');
  console.error('  snooze my alarm');
  console.error('  show my alarms');
  console.error('  start a 5 minute timer');
  console.error('  show timers');
  process.exit(1);
}

await agent.run({ prompt });

const totalMs = Date.now() - _scriptStart;
const ok = finalOutput.output === true;
console.log(
  `\x1b[2m[${new Date().toISOString().slice(11, 23)}]\x1b[0m ` +
  `${ok ? '✅' : '❌'} \x1b[1mresult:\x1b[0m ${ok ? '\x1b[38;2;80;220;100mtrue\x1b[0m' : '\x1b[38;2;230;70;70mfalse\x1b[0m'} \x1b[2m(${totalMs}ms total)\x1b[0m\n` +
  `📝 \x1b[1mSummary:\x1b[0m ${finalOutput.summary}`
);
