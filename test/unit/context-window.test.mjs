import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listModels,
  resolveContextWindow,
  resolveContextWindowAsync,
} from '../../src/agent.mjs';
import { parseYaml } from '../../src/lib/config.mjs';

const prevPath = process.env.AGL_CONFIG_PATH;

function writeConfig(text) {
  const dir = mkdtempSync(join(tmpdir(), 'agl-cfg-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, text);
  process.env.AGL_CONFIG_PATH = path;
  return { dir, path };
}

afterEach(() => {
  if (prevPath === undefined) delete process.env.AGL_CONFIG_PATH;
  else process.env.AGL_CONFIG_PATH = prevPath;
});

describe('parseYaml', () => {
  test('keeps colons in scalar values and nested maps', () => {
    const doc = parseYaml(`
default_model: llama-server:gemma-4-12b-qat
context_windows:
  xai:
    grok-4.6: 500000  # dotted id
    default: 131072
`);
    expect(doc.default_model).toBe('llama-server:gemma-4-12b-qat');
    expect(doc.context_windows.xai['grok-4.6']).toBe(500000);
    expect(doc.context_windows.xai.default).toBe(131072);
  });
});

describe('resolveContextWindow yaml', () => {
  test('unknown id uses provider default, then 32768', () => {
    const { dir } = writeConfig(`context_windows:
  xai:
    default: 131072
    grok-4.6: 500000
`);
    expect(resolveContextWindow('xai:not-a-model')).toBe(131_072);
    expect(resolveContextWindow('runpod:mystery')).toBe(32_768);
    rmSync(dir, { recursive: true, force: true });
  });

  test('re-reads the file every call', () => {
    const { dir } = writeConfig(`context_windows:
  llama-server:
    gemma-4-12b-qat: 8192
`);
    expect(resolveContextWindow('llama-server:gemma-4-12b-qat')).toBe(8192);
    writeFileSync(
      join(dir, 'config.yaml'),
      `context_windows:
  llama-server:
    gemma-4-12b-qat: 1048576
`,
    );
    expect(resolveContextWindow('llama-server:gemma-4-12b-qat')).toBe(1_048_576);
    rmSync(dir, { recursive: true, force: true });
  });

  test('async path is a disk read, not a network refresh', async () => {
    writeConfig(`context_windows:
  llama-server:
    gemma-4-12b-qat: 1048576
`);
    const prev = process.env.MYCLOUD_BASE_URL;
    process.env.MYCLOUD_BASE_URL = 'https://192.0.2.1:1234';
    try {
      const t0 = Date.now();
      const n = await resolveContextWindowAsync('llama-server:gemma-4-12b-qat');
      expect(Date.now() - t0).toBeLessThan(500);
      expect(n).toBe(1_048_576);
    } finally {
      if (prev == null) delete process.env.MYCLOUD_BASE_URL;
      else process.env.MYCLOUD_BASE_URL = prev;
    }
  });
});

describe('listModels yaml', () => {
  test('lists provider:model ids and skips default', async () => {
    writeConfig(`context_windows:
  xai:
    default: 131072
    grok-4.6: 500000
    grok-4.5: 131072
  llama-server:
    gemma-4-12b-qat: 1048576
`);
    const { data } = await listModels();
    const ids = data.map((r) => r.id).sort();
    expect(ids).toEqual([
      'llama-server:gemma-4-12b-qat',
      'xai:grok-4.5',
      'xai:grok-4.6',
    ]);
    expect(ids.some((id) => id.endsWith(':default'))).toBe(false);
  });
});
