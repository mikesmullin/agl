import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';

let settingsCache = null;

function parseSimpleYaml(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([\w.-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function settings() {
  if (settingsCache !== null) return settingsCache;
  settingsCache = {};
  try {
    const text = await readFile(resolve(import.meta.dir ?? '.', '../../config.yaml'), 'utf8');
    Object.assign(settingsCache, parseSimpleYaml(text));
  } catch {
    // AGL has safe defaults for all non-secret configuration.
  }
  return settingsCache;
}

/** Path to the user-level AGL config (`default_model`, …). Override with AGL_CONFIG_PATH. */
export function userConfigPath() {
  const override = process.env.AGL_CONFIG_PATH;
  if (override && String(override).trim()) return String(override).trim();
  return join(homedir(), '.config', 'agl', 'config.yaml');
}

/**
 * Read ~/.config/agl/config.yaml (or AGL_CONFIG_PATH) with no cache.
 * Callers that omit `model` re-parse this on every inference so a disk edit
 * takes effect without restarting dependent processes.
 */
export async function readUserConfig() {
  try {
    const text = await readFile(userConfigPath(), 'utf8');
    return parseSimpleYaml(text);
  } catch {
    return {};
  }
}

/** `default_model` from the user config file, or null if unset/unreadable. */
export async function readUserDefaultModel() {
  const v = (await readUserConfig()).default_model;
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

export async function read(var_name) {
  return process.env[var_name] || null;
}

export async function setting(name, fallback = null) {
  return (await settings())[name] || fallback;
}
