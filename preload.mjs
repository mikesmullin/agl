// Tolerant bunfig preload. The container-era path below exists only inside
// the /workspace container; on machines without it (e.g. the MacBook) the
// import is skipped instead of hard-failing every `bun run`/`bun -e` — and
// every bun CHILD spawned from this cwd tree (a hard preload failure there
// poisoned passman CLI resolution from agl's working tree).
try {
  await import('/workspace/agl-common/node_modules/bun-coffeescript/register');
} catch {
  // No agl-common here — plain-JS/ESM operation only. Fine.
}
