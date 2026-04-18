import Agent from '../agent.mjs';
import { spawn } from '../lib/spawn.mjs';
import { debug, log } from '../lib/debug.mjs';
import { forceInt, forceRx, clamp } from '../lib/validate.mjs';

(async () => {
  const agent = await Agent.factory({
    model: 'xai:grok-4-1-fast-reasoning',
    system_prompt:
      'You are a personal assistant agent.\n' +
      'You help me control home using home automation tools.',
    output_tool: { type: 'boolean', description: 'were you successful?' },
  });

  agent.Tool('desk_light_toggle', 'control power to my govee RGB LED desk lamp', {
    power: { type: 'boolean' },
  }, ['power'], async (ctx, { power }) => {
    const power_s = power ? 'on' : 'off';
    const child = spawn('govee', [power_s]);
    debug('$ ' + child.cmd); // print full shell cmd being executed
    await child.promise; // wait for process to exit
    return 0 == child.code ? `lamp power is now ${power_s}.` : `Failed to affect lamp power. ${child.stdout} ${child.stderr}`
  });

  agent.Tool('desk_light_color', 'control light color emitted by my govee RGB LED desk lamp', {
    r: { type: 'integer', description: 'red component. range 0-255' },
    g: { type: 'integer', description: 'blue component. range 0-255' },
    b: { type: 'integer', description: 'green component. range 0-255' },
    brightness: { type: 'integer', description: 'valid range is 0-35. default: (remembers last setting). The perceived brightness change is highly non-linear, biased toward finer control at lower levels.' },
  }, ['r', 'g', 'b'], async (ctx, { r, g, b, brightness }) => {
    let result = '';
    {
      r = clamp(forceInt(r, 0), 0, 255), g = clamp(forceInt(g, 0), 0, 255), b = clamp(forceInt(b, 0), 0, 255);
      const child = spawn('govee', ['rgb', r, g, b]);
      debug('$ ' + child.cmd); // print full shell cmd being executed
      await child.promise; // wait for process to exit
      result += 0 == child.code ? `lamp light color is now rgb(${r},${g},${b}).` : `Failed to affect lamp light color. ${child.stdout} ${child.stderr}`
    }

    if (brightness) {
      brightness = clamp(forceInt(brightness, 0), 0, 35); // must be an integer between 0-35, or we get 0 by default.
      const child = spawn('govee', ['brightness', brightness]);
      debug('$ ' + child.cmd); // print full shell cmd being executed
      await child.promise; // wait for process to exit
      result += 0 == child.code ? `lamp brightness=${brightness}.` : `Failed to affect lamp light brightness. ${child.stdout} ${child.stderr}`
    }

    return result;
  });

  agent.Tool('pc_light_color', 'control light color emitted by my desktop PC tower chassis LED strip', {
    color: { type: 'string', description: 'hex format. ie. FF0000' },
    brightness: { type: 'integer', description: 'valid range is 0-50. default: 50' },
  }, ['color'], async (ctx, { color, brightness = 50 }) => {
    color = forceRx(/^[0-9A-f]{6}$/, color, '000000'); // string must match regex pattern, or it is replaced by default value 000000 (in the return value)
    brightness = clamp(forceInt(brightness, 0), 0, 50); // must be an integer between 0-50, or we get 0 by default.
    const child = spawn('openrgb', ['-d', '0', '--mode', 'static', '--color', color, '--brightness', brightness]);
    debug('$ ' + child.cmd); // print full shell cmd being executed
    await child.promise; // wait for process to exit
    return 0 == child.code ? `PC light is now color=${color} brightness=${brightness}.` : `Failed to affect PC light color. ${child.stdout} ${child.stderr}`
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

  const result = await agent.run({ prompt });
  console.log({ result });
})();
