import { describe, expect, test } from 'bun:test';
import Agent, { pick, runSwitch, formatTrace, parseTrace } from '../../src/agent.mjs';

/** A fake decision endpoint: deterministic, counts its calls. */
function stubDecider(script) {
  const calls = [];
  let i = 0;
  const decide = async ({ state, questions }) => {
    calls.push({ state, questions });
    const answers = typeof script === 'function' ? script(questions, i) : script[i];
    i += 1;
    if (!answers) throw new Error('stubDecider: ran out of scripted answers');
    return { answers, usage: { input_tokens: 10, output_tokens: 0 } };
  };
  return { decide, calls };
}

const choiceAnswer = (choice, probs) => ({
  type: 'choice',
  choice,
  probabilities: probs ?? { [choice]: 1 },
  confidence: 1,
});

describe('pick', () => {
  test('builds a choice question with key → text criteria', () => {
    const q = pick(
      [{ key: 'a', text: 'Read a' }, { key: 'b', text: 'Read b' }],
      { instructions: 'Which?' },
    );
    expect(q.type).toBe('choice');
    expect(q.instructions).toBe('Which?');
    expect(q.criteria).toEqual({ a: 'Read a', b: 'Read b' });
  });

  test('higher priority sorts first, so a terminal option can go last', () => {
    const q = pick([
      { key: 'stop', text: 'Stop', priority: -1 },
      { key: 'a', text: 'Read a' },
      { key: 'urgent', text: 'Urgent', priority: 5 },
    ]);
    expect(Object.keys(q.criteria)).toEqual(['urgent', 'a', 'stop']);
  });

  test('rejects an empty list, a missing key, and duplicate keys', () => {
    expect(() => pick([])).toThrow('non-empty array');
    expect(() => pick([{ text: 'no key' }])).toThrow('non-empty `key`');
    expect(() => pick([{ key: 'a' }, { key: 'a' }])).toThrow('duplicate option key');
  });
});

describe('the wire shape sent to /v1/systemone', () => {
  const base = {
    name: 't',
    initial: () => ({ n: 0 }),
    transition: (s) => ({ ...s, n: s.n + 1, done: true }),
  };

  test('private _options are stripped and bool maps to noul', async () => {
    const { decide, calls } = stubDecider([
      { go: choiceAnswer('a'), ok: { type: 'noul', noul: 0.9 } },
    ]);
    await runSwitch({
      domain: {
        ...base,
        questions: (s) =>
          s.done
            ? {}
            : {
                go: pick([{ key: 'a', text: 'A' }]),
                ok: { type: 'bool', instructions: 'Done?' },
              },
      },
      decide,
    });
    const sent = calls[0].questions;
    expect(sent.go).toEqual({ type: 'choice', criteria: { a: 'A' } });
    expect(sent.go._options).toBeUndefined();
    // `bool` is an AGL-side alias; the endpoint only knows `noul`.
    expect(sent.ok.type).toBe('noul');
  });

  test('an unsupported question type is rejected before any request', async () => {
    const { decide, calls } = stubDecider([{}]);
    await expect(
      runSwitch({
        domain: { ...base, questions: () => ({ q: { type: 'freeform' } }) },
        decide,
      }),
    ).rejects.toThrow('unsupported type "freeform"');
    expect(calls).toHaveLength(0);
  });

  test('view(state) is what the model reads, not the whole state', async () => {
    const { decide, calls } = stubDecider([{ ok: { type: 'noul', noul: 1 } }]);
    await runSwitch({
      domain: {
        ...base,
        questions: (s) => (s.done ? {} : { ok: { type: 'bool' } }),
        view: (s) => ({ only: 'this' }),
      },
      decide,
    });
    expect(calls[0].state).toEqual({ only: 'this' });
  });
});

describe('the loop', () => {
  test('an empty question set ends the run and costs no request', async () => {
    const { decide, calls } = stubDecider([]);
    const out = await runSwitch({
      domain: { name: 't', initial: () => ({}), questions: () => ({}), transition: (s) => s },
      decide,
    });
    expect(out.ended).toBe('done');
    expect(out.steps).toBe(0);
    // The endpoint 400s on an empty set, so it must never be asked.
    expect(calls).toHaveLength(0);
  });

  test('steps until the domain stops asking, accumulating usage', async () => {
    const { decide } = stubDecider((q, i) => ({ go: choiceAnswer(i < 2 ? 'more' : 'stop') }));
    const out = await runSwitch({
      domain: {
        name: 't',
        limits: { steps: 10 },
        initial: () => ({ seen: 0, done: false }),
        questions: (s) => (s.done ? {} : { go: pick([{ key: 'more' }, { key: 'stop' }]) }),
        transition: (s, a) =>
          a.go.choice === 'stop' ? { ...s, done: true } : { ...s, seen: s.seen + 1 },
      },
      decide,
    });
    expect(out.ended).toBe('done');
    expect(out.steps).toBe(3);
    expect(out.state.seen).toBe(2);
    expect(out.usage).toEqual({ input_tokens: 30, output_tokens: 0, requests: 3 });
  });

  test('a runaway domain stops at the step limit instead of looping forever', async () => {
    const { decide } = stubDecider(() => ({ go: choiceAnswer('a') }));
    const out = await runSwitch({
      domain: {
        name: 't',
        limits: { steps: 3 },
        initial: () => ({}),
        questions: () => ({ go: pick([{ key: 'a' }]) }),   // never empty
        transition: (s) => s,
      },
      decide,
    });
    expect(out.ended).toBe('step limit');
    expect(out.steps).toBe(3);
  });

  test('a throwing transition ends the run as failed, not as a crash', async () => {
    const { decide } = stubDecider(() => ({ go: choiceAnswer('a') }));
    const out = await runSwitch({
      domain: {
        name: 't',
        initial: () => ({}),
        questions: () => ({ go: pick([{ key: 'a' }]) }),
        transition: () => { throw new Error('boom'); },
      },
      decide,
    });
    expect(out.ended).toBe('failed');
    expect(out.trace.find((r) => r.type === 'error')?.message).toBe('boom');
  });

  test('a transition that returns undefined is a failure, not an empty state', async () => {
    const { decide } = stubDecider(() => ({ go: choiceAnswer('a') }));
    const out = await runSwitch({
      domain: {
        name: 't',
        initial: () => ({}),
        questions: () => ({ go: pick([{ key: 'a' }]) }),
        transition: () => undefined,
      },
      decide,
    });
    expect(out.ended).toBe('failed');
  });

  test('a domain missing questions/transition is rejected', async () => {
    await expect(runSwitch({ domain: { name: 't' }, decide: async () => ({}) }))
      .rejects.toThrow('domain.questions must be a function');
  });
});

describe('answers', () => {
  test('a choice answer keeps the distribution and the picked option object', async () => {
    const { decide } = stubDecider([
      { go: choiceAnswer('b', { a: 0.1, b: 0.9 }) },
    ]);
    const out = await runSwitch({
      domain: {
        name: 't',
        initial: () => ({ done: false }),
        questions: (s) => (s.done ? {} : {
          go: pick([{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }]),
        }),
        transition: (s) => ({ ...s, done: true }),
      },
      decide,
    });
    expect(out.answers.go).toMatchObject({
      type: 'choice',
      choice: 'b',
      probability: 0.9,
      probabilities: { a: 0.1, b: 0.9 },
      source: 'systemone',
      option: { key: 'b', text: 'B' },
    });
  });

  test('noul keeps the raw probability; the boolean is ours, via an explicit threshold', async () => {
    const run = (noul, bool_threshold) =>
      runSwitch({
        domain: {
          name: 't',
          initial: () => ({ done: false }),
          questions: (s) => (s.done ? {} : { ok: { type: 'bool' } }),
          transition: (s) => ({ ...s, done: true }),
        },
        decide: async () => ({ answers: { ok: { type: 'noul', noul } }, usage: {} }),
        bool_threshold,
      });

    const a = (await run(0.42)).answers.ok;
    expect(a).toMatchObject({ type: 'noul', noul: 0.42, value: false, bool_threshold: 0.5 });

    // Same number, different threshold -> different boolean. The model never
    // said "false"; AGL decided it did.
    const b = (await run(0.42, 0.4)).answers.ok;
    expect(b.value).toBe(true);
  });

  test('a score answer keeps the expected level, legend and distribution', async () => {
    const out = await runSwitch({
      domain: {
        name: 't',
        initial: () => ({ done: false }),
        questions: (s) => (s.done ? {} : {
          u: { type: 'score', criteria: ['low', 'high'] },
        }),
        transition: (s) => ({ ...s, done: true }),
      },
      decide: async () => ({
        answers: { u: { type: 'score', score: 1.3, legend: { 0: 'low', 1: 'high' }, probabilities: { 0: 0.7, 1: 0.3 }, confidence: 0.4 } },
        usage: {},
      }),
    });
    expect(out.answers.u).toMatchObject({ type: 'score', score: 1.3, confidence: 0.4, source: 'systemone' });
  });

  test('a missing answer for an asked question is an error, not a null', async () => {
    await expect(
      runSwitch({
        domain: {
          name: 't',
          initial: () => ({}),
          questions: () => ({ go: pick([{ key: 'a' }]) }),
          transition: (s) => s,
        },
        decide: async () => ({ answers: {}, usage: {} }),
      }),
    ).rejects.toThrow('no answer for question "go"');
  });
});

describe('trace, replay and drift', () => {
  const mkDomain = (instructions = 'Which?') => ({
    name: 'triage',
    version: '0.1.0',
    limits: { steps: 6 },
    initial: ({ n } = {}) => ({ seen: 0, cap: n ?? 2, done: false }),
    questions: (s) =>
      s.done
        ? {}
        : { go: pick([{ key: 'more' }, { key: 'stop' }], { instructions }) },
    transition: (s, a) =>
      a.go.choice === 'stop' || s.seen + 1 >= s.cap
        ? { ...s, seen: s.seen + 1, done: true }
        : { ...s, seen: s.seen + 1 },
  });

  async function record() {
    const { decide } = stubDecider(() => ({ go: choiceAnswer('more', { more: 0.8, stop: 0.2 }) }));
    return await runSwitch({ domain: mkDomain(), input: { n: 2 }, decide, describe: 'systemone:default' });
  }

  test('the trace is JSONL with meta, one row per step, and an end row', async () => {
    const out = await record();
    const rows = parseTrace(formatTrace(out.trace));
    expect(rows[0]).toMatchObject({ type: 'meta', domain: 'triage', decision_model: 'systemone:default', mode: 'run' });
    expect(rows.filter((r) => r.type === 'step')).toHaveLength(out.steps);
    expect(rows.at(-1)).toMatchObject({ type: 'end', ended: 'done' });
    // Recorded in the endpoint's own vocabulary: no derived fields.
    const step0 = rows.find((r) => r.type === 'step');
    expect(step0.answers.go).toEqual({ type: 'choice', choice: 'more', probabilities: { more: 0.8, stop: 0.2 }, confidence: 1 });
    expect(step0.answers.go.source).toBeUndefined();
  });

  test('replay reproduces the final state with ZERO model calls', async () => {
    const out = await record();
    const { decide, calls } = stubDecider([]);
    const again = await runSwitch({ domain: mkDomain(), replay: formatTrace(out.trace), decide });
    expect(calls).toHaveLength(0);
    expect(again.usage.requests).toBe(0);
    expect(again.state).toEqual(out.state);
    expect(again.ended).toBe('done');
    expect(again.answers.go.source).toBe('trace');
  });

  test('a changed domain is caught as drift instead of silently answering differently', async () => {
    const out = await record();
    const drifted = await runSwitch({
      domain: mkDomain('Reworded question.'),   // instructions changed
      replay: formatTrace(out.trace),
    });
    expect(drifted.ended).toBe('drift');
    const row = drifted.trace.find((r) => r.type === 'drift');
    expect(row.step).toBe(0);
    expect(row.expected.go.instructions).toBe('Which?');
    expect(row.actual.go.instructions).toBe('Reworded question.');
  });

  test('fork replays n steps and then goes back to the model', async () => {
    const out = await record();
    expect(out.steps).toBe(2);
    const { decide, calls } = stubDecider(() => ({ go: choiceAnswer('stop') }));
    const forked = await runSwitch({
      domain: mkDomain(),
      replay: formatTrace(out.trace),
      fork: 1,
      decide,
    });
    // Step 0 came from the trace, step 1 from the model.
    expect(calls).toHaveLength(1);
    expect(forked.trace.filter((r) => r.type === 'step').map((r) => r.source))
      .toEqual(['trace', 'systemone']);
  });

  test('a pure replay needs no decider at all', async () => {
    const out = await record();
    const again = await runSwitch({ domain: mkDomain(), replay: formatTrace(out.trace) });
    expect(again.state).toEqual(out.state);
  });
});

describe('agent.switch() wiring', () => {
  test('systemone binds the generic client at the documented default port', async () => {
    const agent = await Agent.factory({
      model: 'llama-server:default',
      decision_model: 'systemone:default',
    });
    expect(agent.decision_spec).toBe('systemone:default');
    expect(agent.decision_base_url).toBe('http://127.0.0.1:1237');
    expect(typeof agent.decision_client.decisions).toBe('function');
  });

  test('SYSTEMONE_URL overrides the default port', async () => {
    const prev = process.env.SYSTEMONE_URL;
    process.env.SYSTEMONE_URL = 'http://10.0.0.5:9931';
    try {
      const agent = await Agent.factory({ decision_model: 'systemone:default' });
      expect(agent.decision_base_url).toBe('http://10.0.0.5:9931');
    } finally {
      if (prev == null) delete process.env.SYSTEMONE_URL;
      else process.env.SYSTEMONE_URL = prev;
    }
  });

  test('a bad decision_model spec is rejected at factory time', async () => {
    await expect(Agent.factory({ decision_model: 'systemone' }))
      .rejects.toThrow('Invalid decision_model format');
    await expect(Agent.factory({ decision_model: 'nope:x' }))
      .rejects.toThrow('Unknown decision provider: nope');
  });

  test('a chat-only provider is refused as a decision model', async () => {
    // copilot has no decisions() export, so it cannot serve /v1/systemone.
    await expect(Agent.factory({ decision_model: 'copilot:gpt-4o' }))
      .rejects.toThrow('has no decision endpoint');
  });

  test('switch() without a decision model and without a replay refuses', async () => {
    const agent = await Agent.factory({ model: 'llama-server:default' });
    await expect(
      agent.switch({
        domain: { name: 't', initial: () => ({}), questions: () => ({}), transition: (s) => s },
        input: {},
      }),
    ).rejects.toThrow('needs a decision model');
  });

  test('switch() routes through the bound decision client and records its spec', async () => {
    const agent = await Agent.factory({ decision_model: 'systemone:default' });
    const seen = [];
    agent.decision_client = {
      init: async () => {},
      decisions: async (req) => {
        seen.push(req);
        return { answers: { go: choiceAnswer('stop') }, usage: { input_tokens: 7, output_tokens: 0 } };
      },
    };
    const out = await agent.switch({
      domain: {
        name: 't',
        initial: () => ({ done: false }),
        questions: (s) => (s.done ? {} : { go: pick([{ key: 'stop' }]) }),
        transition: (s) => ({ ...s, done: true }),
      },
      input: {},
    });
    expect(out.ended).toBe('done');
    expect(seen[0]).toMatchObject({ model: 'default', base_url: 'http://127.0.0.1:1237' });
    expect(out.trace[0].decision_model).toBe('systemone:default');
    expect(out.usage.input_tokens).toBe(7);
  });
});
