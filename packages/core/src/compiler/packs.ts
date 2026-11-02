/**
 * Context packs: a compressed, cited bundle of what you know about something, for any agent.
 *
 * A pack is built from notes you pick, the compiled wiki pages about them (dense, every line
 * cited) and key ink (handwriting nobody has transcribed, as images with whatever text is known).
 * The same content is written three ways:
 *   - one Markdown file (paste it anywhere), with numbered citations to note and page;
 *   - JSON (for programs), with images as base64;
 *   - an Agent Skill folder (agentskills.io: `SKILL.md` + `references/` + `assets/`), which Claude
 *     Code, Claude, Codex and other skill-aware agents load on demand;
 * and the MCP server serves saved packs as resources (`inkstone://packs/{id}`).
 *
 * `agentsMd` writes an AGENTS.md of the user's standing preferences and decisions for coding
 * agents, each decision cited to the note it was made in.
 *
 * Budgets are in characters (≈ 4 per token): the compiled pages go in first because they are the
 * most information per character; raw note text fills what is left, newest first.
 */
import { anchorLink, parseAnchor, type ProvClaim, TAG_NAME } from './provenance.ts';
import { slugify } from './text.ts';

export interface PackNote {
  id: string;
  title: string;
  notebook?: string;
  tags: string[];
  updatedAt: number;
  summary?: string;
  /** Text per page (typed + recognized), 0-based index. */
  pages: Array<{ index: number; text: string }>;
}

export interface PackPage {
  title: string;
  kind: string;
  claims: ProvClaim[];
}

export interface PackImage {
  /** File name inside the pack (`ink-<note>-<page>.png`). */
  name: string;
  noteId: string;
  noteTitle: string;
  page: number;
  /** What is known about it (recognized text), or a description. */
  alt: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface ContextPackInput {
  title: string;
  /** What the pack is for (goes into the skill description). */
  purpose?: string;
  createdAt: number;
  notes: PackNote[];
  compiled: PackPage[];
  images: PackImage[];
  /** Standing instructions and facts (assistant memory). */
  memory?: { instructions: string[]; facts: string[] };
  /** Character budget for the Markdown (default 48 000 ≈ 12k tokens). */
  maxChars?: number;
}

export interface ContextPack {
  id: string;
  title: string;
  createdAt: number;
  markdown: string;
  json: Record<string, unknown>;
  /** The Agent Skill folder: path → contents. */
  skill: Record<string, string | Uint8Array>;
  /** Approximate tokens of the Markdown (chars / 4). */
  tokens: number;
  /** Notes whose text did not fit the budget (listed in the pack, not included). */
  truncated: string[];
}

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return typeof btoa === 'function' ? btoa(s) : (globalThis as { Buffer?: { from(x: string, e: string): { toString(e: string): string } } }).Buffer!.from(s, 'binary').toString('base64');
};

/** Builds a pack. Pure: the caller loads notes, pages, images and memory. */
export function buildContextPack(input: ContextPackInput): ContextPack {
  const budget = input.maxChars ?? 48_000;
  const titles = new Map(input.notes.map((n) => [n.id, n.title]));
  const cites: string[] = [];
  const citeIndex = new Map<string, number>();
  const cite = (src: string) => {
    const a = parseAnchor(src);
    if (!a) return null;
    const key = `${a.noteId}/${a.page}${a.clip ? `@${a.clip}:${a.ms}` : ''}`;
    let n = citeIndex.get(key);
    if (n == null) {
      n = cites.length + 1;
      citeIndex.set(key, n);
      const t = titles.get(a.noteId) ?? 'a note';
      cites.push(`[${n}]: ${t}, page ${a.page + 1}${a.clip ? `, at ${Math.floor((a.ms ?? 0) / 60000)}:${String(Math.floor(((a.ms ?? 0) % 60000) / 1000)).padStart(2, '0')} in the recording` : ''} — inkstone ${anchorLink(a)}`);
    }
    return n;
  };

  const head = [`# ${input.title}`, '', `Context pack made ${new Date(input.createdAt).toISOString().slice(0, 10)} from ${input.notes.length} ${input.notes.length === 1 ? 'note' : 'notes'}${input.compiled.length ? ` and ${input.compiled.length} compiled wiki ${input.compiled.length === 1 ? 'page' : 'pages'}` : ''}.`,
    'Every line of the compiled pages says how it was made — EXTRACTED (quoted from the notes), INFERRED (synthesised from them) or AMBIGUOUS (the notes disagree) — and cites its sources as [n].', ''];
  if (input.memory && (input.memory.instructions.length || input.memory.facts.length)) {
    head.push('## Standing preferences', ...input.memory.instructions.map((i) => `- ${i}`), ...input.memory.facts.map((f) => `- ${f}`), '');
  }
  const compiled: string[] = [];
  for (const p of input.compiled) {
    compiled.push(`## ${p.title}`);
    for (const c of p.claims) {
      const refs = c.src.map(cite).filter((n): n is number => n != null);
      compiled.push(`- ${c.s} _(${TAG_NAME[c.t].toLowerCase()})_${refs.length ? ` ${[...new Set(refs)].map((n) => `[${n}]`).join('')}` : ''}`);
    }
    compiled.push('');
  }
  const ink = input.images.length ? ['## Handwriting', ...input.images.map((im) => `- ![${im.alt.replace(/[[\]]/g, '')}](assets/${im.name}) ${im.noteTitle}, page ${im.page + 1}${im.alt ? `: ${im.alt}` : ''}`), ''] : [];

  let used = head.join('\n').length + compiled.join('\n').length + ink.join('\n').length;
  const notesOut: string[] = [];
  const truncated: string[] = [];
  const included: PackNote[] = [];
  for (const n of [...input.notes].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const block = [`### ${n.title}`, `_${[n.notebook, n.tags.map((t) => `#${t}`).join(' '), new Date(n.updatedAt).toISOString().slice(0, 10)].filter(Boolean).join(' · ')}_`, ...(n.summary ? [`> ${n.summary.replace(/\n/g, ' ')}`] : []),
      ...n.pages.filter((p) => p.text.trim()).map((p) => `${n.pages.length > 1 ? `**Page ${p.index + 1}**\n` : ''}${p.text.trim()} [${cite(`${n.id}/${p.index + 1}#0`) ?? ''}]`), ''].join('\n');
    if (used + block.length > budget) { truncated.push(n.title); continue; }
    used += block.length;
    notesOut.push(block);
    included.push(n);
  }
  const md = [
    ...head,
    ...(compiled.length ? ['# Compiled', '', ...compiled] : []),
    ...ink,
    ...(notesOut.length ? ['# Notes', '', ...notesOut] : []),
    ...(truncated.length ? [`_Not included (over the size budget): ${truncated.join(', ')}._`, ''] : []),
    ...(cites.length ? ['# Sources', '', ...cites] : []),
  ].join('\n').trim() + '\n';

  // Vault ids are ASCII (docs/VAULT_FORMAT.md): drop letters a slug of a non-Latin title keeps.
  const id = `${slugify(input.title).replace(/[^0-9A-Za-z_-]/g, '') || 'pack'}-${input.createdAt.toString(36)}`.slice(0, 64);
  const json = {
    format: 'inkstone-context-pack/1',
    id,
    title: input.title,
    createdAt: new Date(input.createdAt).toISOString(),
    memory: input.memory ?? { instructions: [], facts: [] },
    compiled: input.compiled.map((p) => ({ title: p.title, kind: p.kind, claims: p.claims.map((c) => ({ text: c.s, tag: TAG_NAME[c.t], confidence: c.c, sources: c.src.map((s) => { const a = parseAnchor(s); return a ? { noteId: a.noteId, note: titles.get(a.noteId), page: a.page + 1, ...(a.rect ? { rect: a.rect } : {}), ...(a.clip ? { recording: a.clip, ms: a.ms } : {}), link: anchorLink(a) } : s; }) })) })),
    notes: included.map((n) => ({ id: n.id, title: n.title, notebook: n.notebook, tags: n.tags, updatedAt: new Date(n.updatedAt).toISOString(), summary: n.summary, pages: n.pages })),
    images: input.images.map((im) => ({ name: im.name, noteId: im.noteId, page: im.page + 1, alt: im.alt, mediaType: im.mediaType, base64: toB64(im.bytes) })),
    truncated,
  };

  const skillName = `notes-${slugify(input.title).replace(/[^a-z0-9-]/g, '') || 'pack'}`.replace(/-{2,}/g, '-').slice(0, 64).replace(/-+$/, '');
  const description = `${input.purpose ? `${input.purpose.replace(/\s+/g, ' ').trim()} ` : ''}Context from the user's own notes about ${input.title}: compiled facts with sources, the notes themselves and key handwriting. Use when working on anything about ${input.title}.`.slice(0, 1024);
  const skill: Record<string, string | Uint8Array> = {
    [`${skillName}/SKILL.md`]: ['---', `name: ${skillName}`, `description: ${JSON.stringify(description)}`, 'metadata:', '  source: inkstone', `  created: "${new Date(input.createdAt).toISOString()}"`, '---', '',
      `# ${input.title}`, '', 'Read `references/context.md` for the compiled facts and notes. Lines are tagged EXTRACTED, INFERRED or AMBIGUOUS and cite sources as [n] (listed at the end).',
      'Treat AMBIGUOUS lines as open questions: the user\'s notes disagree. Prefer EXTRACTED lines when facts matter.', ...(input.images.length ? ['', `Handwriting images are in \`assets/\` (${input.images.length}).`] : []), ''].join('\n'),
    [`${skillName}/references/context.md`]: md,
  };
  for (const im of input.images) skill[`${skillName}/assets/${im.name}`] = im.bytes;
  return { id, title: input.title, createdAt: input.createdAt, markdown: md, json, skill, tokens: Math.ceil(md.length / 4), truncated };
}

/** A standing decision found in the notes (claims of kind `decision`, or the user's own). */
export interface AgentsDecision {
  text: string;
  noteTitle?: string;
  /** Anchor of where it was decided. */
  src?: string;
  date?: string;
}

/**
 * AGENTS.md for coding agents (the agents.md convention): the user's standing instructions and
 * facts from assistant memory, and decisions recorded in notes, each with where it was made.
 */
export function agentsMd(input: { title?: string; instructions: string[]; facts: string[]; decisions: AgentsDecision[]; createdAt: number }): string {
  const lines = [`# ${input.title ?? 'AGENTS.md'}`, '', `Standing preferences and decisions, exported from Inkstone on ${new Date(input.createdAt).toISOString().slice(0, 10)}. Follow them unless the task says otherwise.`, ''];
  if (input.instructions.length) lines.push('## Preferences', ...input.instructions.map((i) => `- ${i}`), '');
  if (input.facts.length) lines.push('## Context', ...input.facts.map((f) => `- ${f}`), '');
  if (input.decisions.length) {
    lines.push('## Decisions');
    for (const d of input.decisions) {
      const a = d.src ? parseAnchor(d.src) : null;
      lines.push(`- ${d.text.replace(/^[-*]\s+/, '')}${d.noteTitle ? ` _(${d.noteTitle}${a ? `, page ${a.page + 1}` : ''}${d.date ? `, ${d.date}` : ''})_` : ''}`);
    }
    lines.push('');
  }
  if (!input.instructions.length && !input.facts.length && !input.decisions.length) lines.push('_Nothing recorded yet. Add standing instructions in Settings › AI › Memory, or write decisions in your notes ("We decided to …")._', '');
  return lines.join('\n');
}
