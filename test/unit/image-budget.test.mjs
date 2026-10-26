import { describe, expect, test } from 'bun:test';
import Agent, { pruneImageBlocks, IMAGE_OMITTED_NOTICE } from '../../src/agent.mjs';

const img = (id) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${id}` } });
const piImg = (id) => ({ type: 'image', data: id });
const txt = (s) => ({ type: 'text', text: s });

function toolMsg(tcid, parts) {
  return { role: 'tool', tool_call_id: tcid, content: parts };
}

describe('pruneImageBlocks (newest-N image budget)', () => {
  test('keeps newest N across messages, replaces older with placeholder', () => {
    const msgs = [
      { role: 'user', content: 'go' },
      toolMsg('c1', [txt('a'), img('old1')]),
      toolMsg('c2', [txt('b'), img('old2')]),
      toolMsg('c3', [txt('c'), img('new')]),
    ];
    const out = pruneImageBlocks(msgs, 1);
    expect(out).toHaveLength(4);
    expect(out[1].content[1]).toEqual({ type: 'text', text: IMAGE_OMITTED_NOTICE });
    expect(out[2].content[1]).toEqual({ type: 'text', text: IMAGE_OMITTED_NOTICE });
    expect(out[3].content[1]).toEqual(img('new'));
    // tool_call_id linkage untouched
    expect(out[1].tool_call_id).toBe('c1');
    // input not mutated
    expect(msgs[1].content[1]).toEqual(img('old1'));
  });

  test('handles Pi-style image blocks and mixed content', () => {
    const msgs = [toolMsg('c1', [piImg('a'), piImg('b'), txt('t')])];
    const out = pruneImageBlocks(msgs, 1);
    expect(out[0].content[0]).toEqual({ type: 'text', text: IMAGE_OMITTED_NOTICE });
    expect(out[0].content[1]).toEqual(piImg('b'));
    expect(out[0].content[2]).toEqual(txt('t'));
  });

  test('under budget returns messages unchanged; string content untouched', () => {
    const msgs = [
      { role: 'user', content: 'plain string' },
      toolMsg('c1', [txt('a'), img('only')]),
    ];
    expect(pruneImageBlocks(msgs, 10)).toBe(msgs);
    expect(pruneImageBlocks(msgs, null)).toBe(msgs);
    expect(pruneImageBlocks(msgs, undefined)).toBe(msgs);
  });

  test('keep 0 strips every image (vision-less servers)', () => {
    const msgs = [toolMsg('c1', [txt('a'), img('x')]), { role: 'user', content: [img('y')] }];
    const out = pruneImageBlocks(msgs, 0);
    expect(JSON.stringify(out)).not.toContain('image_url');
    expect(JSON.stringify(out)).not.toContain('"type":"image"');
    expect(out[0].content[0]).toEqual(txt('a'));
  });

  test('messagesForProvider applies inst.max_images', async () => {
    const agent = await Agent.factory({ model: 'llama-server:test', max_images: 1 });
    expect(agent.max_images).toBe(1);
    agent.pushContext({ role: 'user', content: 'go', visible: true });
    agent.pushContext({ role: 'tool', tool_call_id: 'c1', content: [txt('a'), img('old')], visible: true });
    agent.pushContext({ role: 'tool', tool_call_id: 'c2', content: [txt('b'), img('new')], visible: true });
    const msgs = agent.messagesForProvider();
    const tools = msgs.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0].content[1]).toEqual({ type: 'text', text: IMAGE_OMITTED_NOTICE });
    expect(tools[1].content[1]).toEqual(img('new'));
    // stored context still has the original image
    expect(agent.context_window[1].content[1]).toEqual(img('old'));
  });

  test('factory default is unlimited (historical behavior)', async () => {
    const agent = await Agent.factory({ model: 'llama-server:test' });
    expect(agent.max_images).toBeNull();
  });
});
