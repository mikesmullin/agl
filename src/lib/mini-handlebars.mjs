/**
 * Minimal Handlebars subset for AGL system_prompt templating.
 * Supported: {{path}}, {{#if}}/{{#unless}}/{{#each}}/{{#with}} (+ else / else if),
 * {{this}} ./ ../, @index @key @first @last, {{~ ~}} whitespace, \{{escape}}.
 * Not supported: comments, custom helpers, partials, subexpressions, hash
 * arguments, block parameters, raw blocks, HTML escaping.
 *
 *   compile("Hi {{name}}")({ name: "Ada" })  // => "Hi Ada"
 */

const BUILTIN = { if: true, unless: true, each: true, with: true };

export function compile(template) {
  const ast = parse(String(template ?? ''));
  return (locals) => render(ast, [frame(locals ?? {})]);
}

/**
 * Apply Handlebars substitution when locals is a plain object; otherwise
 * return the template unchanged (so existing {{...}} in prompts is preserved
 * unless the caller opts in).
 */
export function applyLocals(template, locals) {
  if (locals == null || typeof locals !== 'object' || Array.isArray(locals)) {
    return template;
  }
  return compile(template != null ? String(template) : '')(locals);
}

function err(msg) {
  return new Error(`mini-handlebars: ${msg}`);
}

// --- tokenize ---------------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  let textStart = 0;
  const flushText = (end) => {
    if (end <= textStart) return;
    tokens.push({ type: 'text', value: src.slice(textStart, end) });
  };
  while (i < n) {
    if (src[i] === '\\' && src[i + 1] === '{' && src[i + 2] === '{') {
      flushText(i);
      const scanned = scanEscaped(src, i);
      tokens.push({ type: 'text', value: scanned.text });
      i = scanned.next;
      textStart = i;
      continue;
    }
    if (src[i] === '{' && src[i + 1] === '{') {
      flushText(i);
      const tok = scanMustache(src, i);
      tokens.push(tok);
      i = tok.next;
      textStart = i;
      continue;
    }
    i++;
  }
  flushText(n);
  return tokens;
}

function scanEscaped(src, i) {
  // \{{...}} or \{{{...}}} → emit the mustache without the backslash.
  const j = i + 1;
  const triple = src[j + 2] === '{';
  const openLen = triple ? 3 : 2;
  const k = j + openLen;
  const closer = triple ? '}}}' : '}}';
  const idx = src.indexOf(closer, k);
  if (idx < 0) throw err('unclosed escaped mustache');
  const next = idx + closer.length;
  return { text: src.slice(j, next), next };
}

function scanMustache(src, i) {
  let j = i + 2;
  let triple = false;
  if (src[j] === '{') {
    triple = true;
    j++;
  }
  let stripLeft = false;
  if (src[j] === '~') {
    stripLeft = true;
    j++;
  }
  let k = j;
  const n = src.length;
  let stripRight = false;
  let end = -1;
  let closeEnd = -1;
  while (k < n) {
    if (triple) {
      if (
        src[k] === '~' &&
        src[k + 1] === '}' &&
        src[k + 2] === '}' &&
        src[k + 3] === '}'
      ) {
        stripRight = true;
        end = k;
        closeEnd = k + 4;
        break;
      }
      if (src[k] === '}' && src[k + 1] === '}' && src[k + 2] === '}') {
        end = k;
        closeEnd = k + 3;
        break;
      }
    } else {
      if (src[k] === '~' && src[k + 1] === '}' && src[k + 2] === '}') {
        stripRight = true;
        end = k;
        closeEnd = k + 3;
        break;
      }
      if (src[k] === '}' && src[k + 1] === '}') {
        end = k;
        closeEnd = k + 2;
        break;
      }
    }
    k++;
  }
  if (end < 0) throw err('unclosed mustache');
  const content = src.slice(j, end);
  const tag = parseTagContent(content);
  tag.stripLeft = stripLeft;
  tag.stripRight = stripRight;
  tag.triple = triple;
  tag.next = closeEnd;
  return tag;
}

function parseTagContent(content) {
  const s = String(content).trim();
  if (!s) throw err('empty mustache');
  if (s[0] === '#') {
    const { helper, arg } = splitHelper(s.slice(1).trim());
    if (!BUILTIN[helper]) throw err(`unknown helper '${helper}'`);
    return { type: 'open', helper, arg };
  }
  if (s[0] === '/') {
    const helper = s.slice(1).trim();
    if (!BUILTIN[helper]) throw err(`unknown helper '${helper}'`);
    return { type: 'close', helper };
  }
  if (s === 'else' || s.startsWith('else ')) {
    const rest = s.slice(4).trim();
    if (!rest) return { type: 'else' };
    if (rest.startsWith('if ')) {
      return { type: 'else', helper: 'if', arg: rest.slice(3).trim() };
    }
    if (rest.startsWith('unless ')) {
      return { type: 'else', helper: 'unless', arg: rest.slice(7).trim() };
    }
    throw err(`invalid else: ${s}`);
  }
  return { type: 'expr', path: s };
}

function splitHelper(rest) {
  const m = /^([A-Za-z_][\w-]*)(?:\s+([\s\S]+))?$/.exec(rest);
  if (!m) throw err(`invalid block helper: ${rest}`);
  return { helper: m[1], arg: m[2] != null ? m[2].trim() : '' };
}

// --- whitespace -------------------------------------------------------------

function isBlockish(tok) {
  return tok != null && (tok.type === 'open' || tok.type === 'close' || tok.type === 'else');
}

// Standalone block tags eat their indent + trailing newline, matching Handlebars.
// The tag must be the only non-whitespace on its line (other mustaches on the
// same line disqualify it).
function applyWhitespace(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (isBlockish(tokens[i]) && standaloneLine(tokens, i)) {
      stripStandalone(tokens[i - 1], tokens[i + 1]);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'text') continue;
    if (tok.stripLeft) stripWsRight(tokens[i - 1]);
    if (tok.stripRight) stripWsLeft(tokens[i + 1]);
  }
  return tokens;
}

function lineLeftOk(tokens, i) {
  let j = i - 1;
  while (j >= 0) {
    const t = tokens[j];
    if (t.type !== 'text') return false;
    if (!/(?:^|\n)[ \t]*$/.test(t.value)) return false;
    if (/\n/.test(t.value)) return true;
    j--;
  }
  return true;
}

function lineRightOk(tokens, i) {
  let j = i + 1;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.type !== 'text') return false;
    if (!/^[ \t]*(?:\n|$)/.test(t.value)) return false;
    if (/\n/.test(t.value)) return true;
    j++;
  }
  return true;
}

function standaloneLine(tokens, i) {
  return lineLeftOk(tokens, i) && lineRightOk(tokens, i);
}

function stripStandalone(prev, next) {
  if (prev?.type === 'text') {
    prev.value = prev.value.replace(/[ \t]*$/, '');
  }
  if (next?.type === 'text') {
    next.value = next.value.replace(/^[ \t]*\n?/, '');
  }
}

function stripWsRight(tok) {
  if (tok?.type !== 'text') return;
  tok.value = tok.value.replace(/\s+$/, '');
}

function stripWsLeft(tok) {
  if (tok?.type !== 'text') return;
  tok.value = tok.value.replace(/^\s+/, '');
}

// --- parse ------------------------------------------------------------------

function parse(src) {
  const tokens = applyWhitespace(tokenize(src));
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  const parseUntil = (closeName) => {
    const nodes = [];
    while (i < tokens.length) {
      const tok = peek();
      if (tok.type === 'close') {
        if (closeName != null && tok.helper === closeName) return nodes;
        throw err(`unexpected {{/${tok.helper}}}`);
      }
      if (tok.type === 'else') {
        if (closeName == null) throw err('{{else}} at top level');
        return nodes;
      }
      next();
      if (tok.type === 'text') {
        if (tok.value) nodes.push(tok);
      } else if (tok.type === 'expr') {
        nodes.push(tok);
      } else if (tok.type === 'open') {
        nodes.push(parseBlock(tok));
      } else {
        throw err(`unexpected token ${tok.type}`);
      }
    }
    if (closeName != null) throw err(`unclosed {{#${closeName}}}`);
    return nodes;
  };

  // untilName: when set, this block is an {{else if}}/{{else unless}} nested
  // inside another helper — wait for that helper's close, and do not consume it.
  const parseBlock = (open, untilName) => {
    const consumeClose = untilName == null;
    untilName = untilName ?? open.helper;
    const body = parseUntil(untilName);
    let inverse = [];
    const tok = peek();
    if (tok?.type === 'else') {
      next();
      if (tok.helper) {
        inverse = [parseBlock({ helper: tok.helper, arg: tok.arg }, untilName)];
      } else {
        inverse = parseUntil(untilName);
      }
    }
    if (consumeClose) {
      const closer = peek();
      if (!(closer?.type === 'close' && closer.helper === untilName)) {
        throw err(`unclosed {{#${open.helper}}}`);
      }
      next();
    }
    return {
      type: 'block',
      helper: open.helper,
      arg: open.arg,
      body,
      inverse,
    };
  };

  return parseUntil(null);
}

// --- paths / lookup ---------------------------------------------------------

function frame(value, data) {
  return { value, data: data || {} };
}

function parsePath(str) {
  const s = String(str ?? '').trim();
  const segs = [];
  if (!s) return segs;
  let data = false;
  let i = 0;
  if (s[0] === '@') {
    data = true;
    i = 1;
  }
  const n = s.length;
  let leading = true;
  while (i < n) {
    if (
      s[i] === '.' &&
      s[i + 1] === '.' &&
      (s[i + 2] === '/' || s[i + 2] === '.' || i + 2 >= n)
    ) {
      segs.push({ type: 'parent' });
      i += 2;
      if (s[i] === '/') i++;
      leading = true;
      continue;
    }
    if (s[i] === '.') {
      if (leading && segs.length === 0) segs.push({ type: 'current' });
      i++;
      if (s[i] === '/') i++;
      leading = false;
      continue;
    }
    if (s[i] === '/') {
      i++;
      continue;
    }
    if (s[i] === '[') {
      const j = s.indexOf(']', i + 1);
      if (j < 0) throw err(`unclosed literal segment in path: ${s}`);
      let inner = s.slice(i + 1, j);
      if (
        (inner[0] === '"' && inner[inner.length - 1] === '"') ||
        (inner[0] === "'" && inner[inner.length - 1] === "'")
      ) {
        inner = inner.slice(1, -1);
      }
      segs.push({ type: 'literal', name: inner });
      i = j + 1;
      leading = false;
      continue;
    }
    const m = /^[A-Za-z0-9_$-]+/.exec(s.slice(i));
    if (!m) throw err(`invalid path: ${s}`);
    const name = m[0];
    i += name.length;
    if (leading && name === 'this' && segs.length === 0) {
      segs.push({ type: 'current' });
    } else {
      segs.push({ type: 'id', name });
    }
    leading = false;
  }
  return { data, segs };
}

function literalArg(s) {
  if (s === 'true') return { ok: true, value: true };
  if (s === 'false') return { ok: true, value: false };
  if (s === 'null') return { ok: true, value: null };
  if (s === 'undefined') return { ok: true, value: undefined };
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return { ok: true, value: Number(s) };
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    return { ok: true, value: s.slice(1, -1) };
  }
  return { ok: false };
}

function resolveArg(arg, frames) {
  if (arg == null || arg === '') return undefined;
  const s = String(arg).trim();
  const lit = literalArg(s);
  if (lit.ok) return lit.value;
  return lookup(s, frames);
}

function getProp(obj, key) {
  if (obj == null) return undefined;
  if (typeof obj === 'function') return undefined;
  return obj[key];
}

function hasProp(obj, key) {
  if (obj == null) return false;
  const t = typeof obj;
  if (t !== 'object' && t !== 'function' && t !== 'string') return false;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  try {
    return obj[key] !== undefined;
  } catch {
    return false;
  }
}

function lookupData(segs, frames) {
  let dataIdx = frames.length - 1;
  let i = 0;
  while (i < segs.length && segs[i].type === 'parent') {
    dataIdx--;
    i++;
    if (dataIdx < 0) return undefined;
  }
  while (i < segs.length && segs[i].type === 'current') i++;
  const data = frames[dataIdx]?.data || {};
  if (i >= segs.length) return data;
  let val = data[segs[i].name];
  i++;
  while (i < segs.length && val != null) {
    val = getProp(val, segs[i].name);
    i++;
  }
  return val;
}

function lookup(pathStr, frames) {
  const parsed = parsePath(pathStr);
  const segs = parsed.segs;
  if (!segs.length) return undefined;
  if (parsed.data) return lookupData(segs, frames);
  let frameIdx = frames.length - 1;
  let i = 0;
  let currentOnly = false;
  while (i < segs.length) {
    if (segs[i].type === 'parent') {
      frameIdx--;
      if (frameIdx < 0) return undefined;
      i++;
    } else if (segs[i].type === 'current') {
      currentOnly = true;
      i++;
      break;
    } else {
      break;
    }
  }
  if (frameIdx < 0) return undefined;
  if (i >= segs.length) return frames[frameIdx].value;
  const first = segs[i];
  let key = first.name;
  let obj;
  if (currentOnly || first.type === 'literal') {
    obj = getProp(frames[frameIdx].value, key);
  } else {
    for (let f = frameIdx; f >= 0; f--) {
      const ctx = frames[f].value;
      if (hasProp(ctx, key)) {
        obj = getProp(ctx, key);
        break;
      }
    }
  }
  i++;
  while (i < segs.length && obj != null) {
    key = segs[i].name;
    obj = getProp(obj, key);
    i++;
  }
  if (typeof obj === 'function') {
    try {
      return obj.call(frames[frameIdx].value);
    } catch {
      return undefined;
    }
  }
  return obj;
}

function stringify(v) {
  if (v == null || v === false) return '';
  if (typeof v === 'function') return stringify(v());
  return String(v);
}

function isFalsy(v) {
  if (v == null || v === false || v === '' || v === 0) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function isEmpty(v) {
  if (v === undefined || v === null || v === false || v === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

// --- render -----------------------------------------------------------------

function render(nodes, frames) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.value;
    else if (node.type === 'expr') out += stringify(resolveArg(node.path, frames));
    else if (node.type === 'block') out += renderBlock(node, frames);
  }
  return out;
}

function renderBlock(node, frames) {
  switch (node.helper) {
    case 'if': {
      const v = resolveArg(node.arg, frames);
      return isFalsy(v)
        ? render(node.inverse, frames)
        : render(node.body, frames);
    }
    case 'unless': {
      const v = resolveArg(node.arg, frames);
      return isFalsy(v)
        ? render(node.body, frames)
        : render(node.inverse, frames);
    }
    case 'with': {
      const v = resolveArg(node.arg, frames);
      if (isEmpty(v)) return render(node.inverse, frames);
      return render(node.body, frames.concat([frame(v, frames[frames.length - 1].data)]));
    }
    case 'each':
      return renderEach(node, frames);
    default:
      throw err(`unknown helper '${node.helper}'`);
  }
}

function renderEach(node, frames) {
  const v = resolveArg(node.arg, frames);
  if (Array.isArray(v)) {
    if (v.length === 0) return render(node.inverse, frames);
    let out = '';
    const last = v.length - 1;
    for (let idx = 0; idx < v.length; idx++) {
      const data = {
        index: idx,
        key: idx,
        first: idx === 0,
        last: idx === last,
      };
      out += render(node.body, frames.concat([frame(v[idx], data)]));
    }
    return out;
  }
  if (v != null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return render(node.inverse, frames);
    let out = '';
    const last = keys.length - 1;
    for (let idx = 0; idx < keys.length; idx++) {
      const key = keys[idx];
      const data = {
        index: idx,
        key,
        first: idx === 0,
        last: idx === last,
      };
      out += render(node.body, frames.concat([frame(v[key], data)]));
    }
    return out;
  }
  return render(node.inverse, frames);
}
