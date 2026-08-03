import { readFile } from 'fs/promises';
import { resolve } from 'path';

let settingsCache = null;

async function settings() {
  if (settingsCache !== null) return settingsCache;
  settingsCache = {};
  try {
    const text = await readFile(resolve(import.meta.dir ?? '.', '../../config.yaml'), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*:\s*(.*?)\s*$/);
      if (match) settingsCache[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // AGL has safe defaults for all non-secret configuration.
  }
  return settingsCache;
}

export async function read(var_name) {
  return process.env[var_name] || null;
}

export async function setting(name, fallback = null) {
  return (await settings())[name] || fallback;
}
