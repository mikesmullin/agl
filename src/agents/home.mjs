import Agent from '../agent.mjs';
import { spawn } from '../lib/spawn.mjs';
import { debug, log } from '../lib/debug.mjs';
import { forceInt, forceRx, clamp } from '../lib/validate.mjs';

const _scriptStart = Date.now();

let finalOutput = { output: null, summary: '(agent produced no summary)' };

const agent = await Agent.factory({
  // model: 'ollama:gemma4:26b',
  model: 'lm-studio:google/gemma-4-e4b',
  parallel_tools: true,
  system_prompt:
    'You are a personal assistant agent.\n' +
    'You help me control my home using home automation tools.\n' +
    'I have two independently controllable lights: my desk lamp (desk_light tool) and my PC tower LED strip (pc_light_color tool). ' +
    'When I say "lights" (plural) or otherwise do not name a specific light, apply the request to BOTH lights. ' +
    'When I name a specific light (e.g. "desk light" or "pc light"), only affect that one.\n' +
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

agent.Tool('desk_light', 'control power and/or light color emitted by my govee RGB LED desk lamp. ' +
  'If the request names or implies a color (e.g. "turn it blue", "set to forest green"), you MUST provide r, g, and b together. ' +
  'Only provide power when the request is purely about turning the lamp on/off, with no color mentioned.', {
  power: { type: 'boolean', description: 'turn the lamp on or off. omit this unless the request is only about power, not color.' },
  r: { type: 'integer', description: 'red component. range 0-255. required together with g and b whenever a color is requested.' },
  g: { type: 'integer', description: 'green component. range 0-255. required together with r and b whenever a color is requested.' },
  b: { type: 'integer', description: 'blue component. range 0-255. required together with r and g whenever a color is requested.' },
  brightness: { type: 'integer', description: 'valid range is 0-35. default: (remembers last setting). The perceived brightness change is highly non-linear, biased toward finer control at lower levels.' },
}, [], async (ctx, { power, r, g, b, brightness }) => {
  let result = '';

  if (typeof power === 'boolean') {
    const t0 = Date.now();
    const power_s = power ? 'on' : 'off';
    const child = spawn('govee', [power_s]);
    debug('$ ' + child.cmd); // print full shell cmd being executed
    await child.promise; // wait for process to exit
    const ms = Date.now() - t0;
    const ok = 0 == child.code;
    console.error(
      `\x1b[2m[${new Date().toISOString().slice(11, 23)}]\x1b[0m ` +
      `${ok ? '🔌✅' : '🔌❌'} \x1b[1mdesk_light\x1b[0m power \x1b[38;2;255;200;60m$ ${child.cmd}\x1b[0m \x1b[2m(${ms}ms)\x1b[0m` +
      (child.stdout ? `\n  \x1b[2mstdout:\x1b[0m ${child.stdout.trim()}` : '') +
      (child.stderr ? `\n  \x1b[2mstderr:\x1b[0m ${child.stderr.trim()}` : '')
    );
    result += ok ? `lamp power is now ${power_s}. ` : `Failed to affect lamp power. ${child.stdout} ${child.stderr} `
  }

  if (r !== undefined || g !== undefined || b !== undefined) {
    const t0 = Date.now();
    r = clamp(forceInt(r, 0), 0, 255), g = clamp(forceInt(g, 0), 0, 255), b = clamp(forceInt(b, 0), 0, 255);
    const child = spawn('govee', ['rgb', r, g, b]);
    debug('$ ' + child.cmd); // print full shell cmd being executed
    await child.promise; // wait for process to exit
    const ms = Date.now() - t0;
    const ok = 0 == child.code;
    console.error(
      `\x1b[2m[${new Date().toISOString().slice(11, 23)}]\x1b[0m ` +
      `${ok ? '🎨✅' : '🎨❌'} \x1b[1mdesk_light\x1b[0m color \x1b[48;2;${r};${g};${b}m   \x1b[0m \x1b[38;2;${r};${g};${b}mrgb(${r},${g},${b})\x1b[0m \x1b[2m$ ${child.cmd}\x1b[0m \x1b[2m(${ms}ms)\x1b[0m` +
      (child.stdout ? `\n  \x1b[2mstdout:\x1b[0m ${child.stdout.trim()}` : '') +
      (child.stderr ? `\n  \x1b[2mstderr:\x1b[0m ${child.stderr.trim()}` : '')
    );
    result += ok ? `lamp light color is now rgb(${r},${g},${b}). ` : `Failed to affect lamp light color. ${child.stdout} ${child.stderr} `
  }

  if (brightness) {
    const t0 = Date.now();
    brightness = clamp(forceInt(brightness, 0), 0, 35); // must be an integer between 0-35, or we get 0 by default.
    const child = spawn('govee', ['brightness', brightness]);
    debug('$ ' + child.cmd); // print full shell cmd being executed
    await child.promise; // wait for process to exit
    const ms = Date.now() - t0;
    const ok = 0 == child.code;
    console.error(
      `\x1b[2m[${new Date().toISOString().slice(11, 23)}]\x1b[0m ` +
      `${ok ? '🔆✅' : '🔆❌'} \x1b[1mdesk_light\x1b[0m brightness \x1b[38;2;255;165;0m${brightness}\x1b[0m \x1b[2m$ ${child.cmd}\x1b[0m \x1b[2m(${ms}ms)\x1b[0m` +
      (child.stdout ? `\n  \x1b[2mstdout:\x1b[0m ${child.stdout.trim()}` : '') +
      (child.stderr ? `\n  \x1b[2mstderr:\x1b[0m ${child.stderr.trim()}` : '')
    );
    result += ok ? `lamp brightness=${brightness}.` : `Failed to affect lamp light brightness. ${child.stdout} ${child.stderr}`
  }

  return result || 'No lamp action requested (specify power and/or r,g,b and/or brightness).';
});

agent.Tool('pc_light_color', 'control light color emitted by my desktop PC tower chassis LED strip', {
  color: { type: 'string', description: 'hex format. ie. FF0000' },
  brightness: { type: 'integer', description: 'valid range is 0-50. default: 50' },
}, ['color'], async (ctx, { color, brightness = 50 }) => {
  const t0 = Date.now();
  color = forceRx(/^[0-9A-f]{6}$/, color, '000000'); // string must match regex pattern, or it is replaced by default value 000000 (in the return value)
  brightness = clamp(forceInt(brightness, 0), 0, 50); // must be an integer between 0-50, or we get 0 by default.
  const rr = parseInt(color.slice(0, 2), 16) || 0, gg = parseInt(color.slice(2, 4), 16) || 0, bb = parseInt(color.slice(4, 6), 16) || 0;
  const child = spawn('openrgb', ['-d', '0', '--mode', 'static', '--color', color, '--brightness', brightness]);
  debug('$ ' + child.cmd); // print full shell cmd being executed
  await child.promise; // wait for process to exit
  const ms = Date.now() - t0;
  const ok = 0 == child.code;
  console.error(
    `\x1b[2m[${new Date().toISOString().slice(11, 23)}]\x1b[0m ` +
    `${ok ? '🖥️✅' : '🖥️❌'} \x1b[1mpc_light_color\x1b[0m \x1b[48;2;${rr};${gg};${bb}m   \x1b[0m \x1b[38;2;${rr};${gg};${bb}m#${color}\x1b[0m \x1b[2m$ ${child.cmd}\x1b[0m \x1b[2m(${ms}ms)\x1b[0m` +
    (child.stdout ? `\n  \x1b[2mstdout:\x1b[0m ${child.stdout.trim()}` : '') +
    (child.stderr ? `\n  \x1b[2mstderr:\x1b[0m ${child.stderr.trim()}` : '')
  );
  return ok ? `PC light is now color=${color} brightness=${brightness}.` : `Failed to affect PC light color. ${child.stdout} ${child.stderr}`;
});

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
