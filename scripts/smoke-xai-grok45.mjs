#!/usr/bin/env bun
/**
 * Smoke: xAI grok-4.5 inference via agl provider.
 * Loads XAI_API_KEY from env or /workspace/agl/.env (config.mjs).
 * Prints only ok/model/lengths — never keys or completion text.
 */
import * as xai from '../src/providers/xai.mjs';

const model = process.argv[2] || 'grok-4.5';

try {
  await xai.init();
} catch (e) {
  console.log(JSON.stringify({ ok: false, stage: 'init', error: e.message || String(e) }));
  process.exit(2);
}

try {
  // Confirm model appears in list when possible (non-fatal)
  let listed = false;
  try {
    const m = await xai.models();
    const ids = (m?.data || []).map((x) => x.id);
    listed = ids.includes(model) || ids.some((id) => id.includes('grok-4.5') || id.includes('grok-4'));
    console.log(JSON.stringify({ ok: true, stage: 'models', count: ids.length, targetListed: listed }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, stage: 'models', error: e.message || String(e) }));
  }

  const smoke = await xai.smokeInference({ model });
  console.log(JSON.stringify({ ok: smoke.ok, stage: 'inference', model: smoke.model, previewLen: smoke.previewLen, id: smoke.id ? 'set' : null }));
  process.exit(smoke.ok ? 0 : 1);
} catch (e) {
  console.log(JSON.stringify({
    ok: false,
    stage: 'inference',
    error: e.message || String(e),
    status: e.status || null,
  }));
  process.exit(1);
}
