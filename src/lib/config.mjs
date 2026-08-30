import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';

let settingsCache = null;

/**
 * Nested YAML subset: comments, maps, quoted/plain scalars, integers.
 * Enough for ~/.config/agl/config.yaml (`default_model`, `context_windows`).
 */
export function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];

  for (const rawLine of String(text || '').split('\n')) {
    const stripped = stripInlineComment(rawLine);
    if (!stripped.trim()) continue;
    const indent = stripped.length - stripped.trimStart().length;
    const trimmed = stripped.trim();
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = unquote(trimmed.slice(0, colon).trim());
    if (!key) continue;
    const rest = trimmed.slice(colon + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].node;
    if (rest === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = coerceScalar(rest);
    }
  }
  return root;
}

function stripInlineComment(line) {
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === inQuote && line[i - 1] !== '\\') inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function coerceScalar(raw) {
  const s = unquote(raw);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

async function settings() {
  if (settingsCache !== null) return settingsCache;
  settingsCache = {};
  try {
    const text = await readFile(
      resolve(import.meta.dir ?? '.', '../../config.yaml'),
      'utf8',
    );
    Object.assign(settingsCache, parseYaml(text));
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
    return parseYaml(text);
  } catch {
    return {};
  }
}

/** Sync counterpart for resolveContextWindow / listModels (no network). */
export function readUserConfigSync() {
  try {
    const text = readFileSync(userConfigPath(), 'utf8');
    return parseYaml(text);
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
