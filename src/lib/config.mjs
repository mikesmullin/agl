import { readFile } from 'fs/promises';
import { resolve } from 'path';

let dotenvCache = null;

async function _parseDotenv() {
  if (dotenvCache !== null) return dotenvCache;
  dotenvCache = {};
  try {
    const content = await readFile(resolve(import.meta.dir ?? '.', '../../.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      dotenvCache[key] = val;
    }
  } catch {
    // .env file not found or unreadable
  }
  return dotenvCache;
}

export async function read(var_name) {
  if (var_name in process.env) return process.env[var_name];
  const env = await _parseDotenv();
  if (var_name in env) return env[var_name];
  return null;
}
