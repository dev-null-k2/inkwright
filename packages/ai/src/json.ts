/**
 * Robust JSON extraction from model output: whole-text JSON, fenced code blocks, or the first
 * balanced `{…}` / `[…]` span amid prose, with light repairs (trailing commas, smart quotes).
 */

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    /* fall through to repairs */
  }
  const repaired = repairJson(s);
  if (repaired !== s) {
    try {
      return { ok: true, value: JSON.parse(repaired) };
    } catch {
      /* give up */
    }
  }
  return { ok: false };
}

/** Light repairs for common model mistakes. Never changes valid JSON's meaning. */
export function repairJson(s: string): string {
  return s
    .replace(/^﻿/, '')
    .replace(/[“”]/g, '"')
    .replace(/,\s*([}\]])/g, '$1');
}

/** Index just past the balanced bracket span starting at `start`, or -1. String-aware. */
function balancedEnd(s: string, start: number): number {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  const stack: string[] = [close];
  let inStr = false;
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/**
 * Returns the first JSON value found in `text`, or `undefined`. Prefers fenced blocks (```json),
 * then the whole text, then balanced spans scanning left to right.
 */
export function extractJson(text: string): unknown {
  if (!text) return undefined;
  const t = text.trim();
  const fence = /```[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  for (let m = fence.exec(t); m; m = fence.exec(t)) {
    const body = m[2]!.trim();
    const r = tryParse(body);
    if (r.ok) return r.value;
    const inner = scan(body);
    if (inner !== undefined) return inner;
  }
  // An unterminated fence (output cut off or model forgot to close it).
  const open = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*)$/.exec(t);
  if (open && !open[1]!.includes('```')) {
    const r = tryParse(open[1]!.trim());
    if (r.ok) return r.value;
  }
  const whole = tryParse(t);
  if (whole.ok && (typeof whole.value === 'object' || !/\s/.test(t))) return whole.value;
  return scan(t);
}

function scan(t: string): unknown {
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '{' && c !== '[') continue;
    const end = balancedEnd(t, i);
    if (end < 0) continue;
    const r = tryParse(t.slice(i, end));
    if (r.ok) return r.value;
  }
  return undefined;
}

/** Like extractJson but returns `fallback` when nothing parses. */
export function extractJsonOr<T>(text: string, fallback: T): unknown | T {
  const v = extractJson(text);
  return v === undefined ? fallback : v;
}

/**
 * Finds an array in model output: a top-level array, or the first array-valued property of an
 * object (`{"todos": [...]}`), or `[obj]` for a single object.
 */
export function extractJsonArray(text: string): unknown[] | undefined {
  const v = extractJson(text);
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const val of Object.values(v)) if (Array.isArray(val)) return val;
    return [v];
  }
  return undefined;
}

/** Removes a wrapping code fence and surrounding quotes from plain-text model output. */
export function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  return m ? m[1]! : t;
}
