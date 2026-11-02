/**
 * The small part of YAML that Markdown front matter uses (Obsidian "properties"): scalars,
 * quoted strings, flow lists `[a, b]`, block lists, nested maps and `|`/`>` block text. Enough to
 * read any vault's front matter faithfully and to write ours; not a general YAML library.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line { indent: number; text: string; no: number }

function scalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_m, c: string) =>
      c[0] === 'u' ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c] ?? c);
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') && s.endsWith(']')) return splitFlow(s.slice(1, -1)).map(scalar);
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) && !/^0\d/.test(s)) return Number(s);
  return s;
}

/** Splits `a, "b, c", d` at top-level commas. */
function splitFlow(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let depth = 0;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/** Removes a trailing ` # comment` outside quotes. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd();
  }
  return s;
}

/** Index of the `key:` separator (colon followed by space or end) outside quotes, or -1. */
function keySep(s: string): number {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) { if (ch === q) q = null; continue; }
    if ((ch === '"' || ch === "'") && i === 0) q = ch;
    else if (ch === ':' && (i === s.length - 1 || s[i + 1] === ' ' || s[i + 1] === '\t')) return i;
  }
  return -1;
}

export function parseYaml(src: string): Record<string, YamlValue> {
  const lines: Line[] = [];
  src.replace(/\r\n?/g, '\n').split('\n').forEach((raw, no) => {
    if (!raw.trim() || /^\s*#/.test(raw)) { lines.push({ indent: -1, text: '', no }); return; }
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, text: raw.slice(indent), no });
  });
  let i = 0;
  const skipBlank = () => { while (i < lines.length && lines[i]!.indent < 0) i++; };

  const blockText = (parentIndent: number, folded: boolean): string => {
    const out: string[] = [];
    let base = -1;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.indent >= 0 && l.indent <= parentIndent) break;
      if (l.indent < 0) { out.push(''); i++; continue; }
      if (base < 0) base = l.indent;
      out.push(' '.repeat(Math.max(0, l.indent - base)) + l.text);
      i++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return folded ? out.join(' ').replace(/ {2,}/g, ' ') : out.join('\n');
  };

  const value = (rest: string, indent: number): YamlValue => {
    const r = stripComment(rest).trim();
    if (r === '|' || r === '|-' || r === '|+') { i++; return blockText(indent, false); }
    if (r === '>' || r === '>-' || r === '>+') { i++; return blockText(indent, true); }
    if (r !== '') { i++; return scalar(r); }
    i++;
    skipBlank();
    const next = lines[i];
    if (!next || next.indent < indent || (next.indent === indent && !next.text.startsWith('- '))) return null;
    if (next.text.startsWith('-')) return list(next.indent);
    if (next.indent > indent) return map(next.indent);
    return null;
  };

  const list = (indent: number): YamlValue[] => {
    const out: YamlValue[] = [];
    for (;;) {
      skipBlank();
      const l = lines[i];
      if (!l || l.indent !== indent || !(l.text === '-' || l.text.startsWith('- '))) break;
      const rest = l.text.slice(1).trimStart();
      const sep = keySep(rest);
      if (rest && sep > 0 && !rest.startsWith('"') && !rest.startsWith("'") && !rest.startsWith('[')) {
        // "- key: value" starts a map item.
        const inner = indent + (l.text.length - rest.length);
        lines[i] = { indent: inner, text: rest, no: l.no };
        out.push(map(inner));
      } else out.push(value(rest, indent));
    }
    return out;
  };

  const map = (indent: number): Record<string, YamlValue> => {
    const out: Record<string, YamlValue> = {};
    for (;;) {
      skipBlank();
      const l = lines[i];
      if (!l || l.indent !== indent) break;
      const sep = keySep(l.text);
      if (sep < 0) { i++; continue; }
      let key = l.text.slice(0, sep).trim();
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
      out[key] = value(l.text.slice(sep + 1), indent);
    }
    return out;
  };

  skipBlank();
  if (i >= lines.length) return {};
  return map(lines[i]!.indent);
}

const PLAIN_UNSAFE = /^[\s\-?:,[\]{}#&*!|>'"%@`]|: |\s#|\s$|^(true|false|null|yes|no|on|off|~)$/i;

function emitScalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === '' || PLAIN_UNSAFE.test(v) || /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v) || v.includes('\n')) {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
  }
  return v;
}

/** YAML for a map of values, block style (lists as `- item`), as front matter tools expect. */
export function emitYaml(obj: Record<string, YamlValue>, indent = 0): string {
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = /^[\w-]+$/.test(k) ? k : emitScalar(k);
    if (Array.isArray(v)) {
      if (!v.length) { out.push(`${pad}${key}: []`); continue; }
      out.push(`${pad}${key}:`);
      for (const item of v) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const inner = emitYaml(item, indent + 4).split('\n').filter(Boolean);
          out.push(`${pad}  - ${inner[0]!.trimStart()}`, ...inner.slice(1));
        } else if (Array.isArray(item)) out.push(`${pad}  - [${item.map((x) => emitScalar(x as string)).join(', ')}]`);
        else out.push(`${pad}  - ${emitScalar(item)}`);
      }
    } else if (v && typeof v === 'object') {
      out.push(`${pad}${key}:`, emitYaml(v, indent + 2).replace(/\n$/, ''));
    } else out.push(`${pad}${key}: ${emitScalar(v)}`);
  }
  return out.join('\n') + '\n';
}

/** Splits `---\nfront matter\n---\nbody`. Text without front matter has `{}`. */
export function splitFrontmatter(md: string): { data: Record<string, YamlValue>; body: string; raw: string | null } {
  const text = md.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text, raw: null };
  let data: Record<string, YamlValue> = {};
  try { data = parseYaml(m[1]!); } catch { data = {}; }
  return { data, body: text.slice(m[0].length), raw: m[1]! };
}
