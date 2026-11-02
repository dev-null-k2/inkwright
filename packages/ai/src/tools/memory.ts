import { formatStamp } from '@inkwright/core';
import type { AgentTool } from '../agent.ts';

/** One passage found in the user's notes, with the exact place it is written. */
export interface MemoryHit {
  noteId: string;
  title: string;
  /** 0-based. */
  pageIndex: number;
  /** typed text, handwriting, PDF text, note details (title/tags/summary), or speech from a recording. */
  source: 'text' | 'handwriting' | 'pdf' | 'meta' | 'speech';
  text: string;
  /** Region on the page, page units. */
  rect?: { x: number; y: number; width: number; height: number };
  /** Speech: the recording and the moment in it (ms from its start). */
  said?: { clipId: string; startMs: number; endMs: number };
  score: number;
}

/** Implemented by the app over its memory index (hybrid keyword + semantic search). */
export interface MemorySearchHost {
  searchMemory(query: string, opts?: { limit?: number; noteId?: string }): Promise<MemoryHit[]>;
}

/**
 * The in-app link that opens a note at a page and highlights a region. The app handles clicks on
 * these anywhere (assistant replies included), so the model can cite places as Markdown links.
 */
export function memoryLink(h: Pick<MemoryHit, 'noteId' | 'pageIndex' | 'rect' | 'said'>): string {
  const r = h.rect ? `/${[h.rect.x, h.rect.y, h.rect.width, h.rect.height].map((v) => Math.round(v)).join(',')}` : '';
  // Speech passages also say where in the recording: `@<clipId>:<ms>` (opening seeks the audio).
  const t = h.said ? `@${encodeURIComponent(h.said.clipId)}:${Math.round(h.said.startMs)}` : '';
  return `#mem/${encodeURIComponent(h.noteId)}/${h.pageIndex + 1}${r}${t}`;
}

export interface ParsedMemoryLink {
  noteId: string;
  pageIndex: number;
  rect?: { x: number; y: number; width: number; height: number };
  /** A moment in a recording to play from. */
  seek?: { clipId: string; ms: number };
}

/** Parses a link made by `memoryLink`. */
export function parseMemoryLink(href: string): ParsedMemoryLink | null {
  const m = /#mem\/([^/]+)\/(\d+)(?:\/(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+))?(?:@([^:/]+):(\d+))?$/.exec(href);
  if (!m) return null;
  const out: ParsedMemoryLink = { noteId: decodeURIComponent(m[1]!), pageIndex: Math.max(0, Number(m[2]) - 1) };
  if (m[3] != null) out.rect = { x: Number(m[3]), y: Number(m[4]), width: Number(m[5]), height: Number(m[6]) };
  if (m[7] != null) out.seek = { clipId: decodeURIComponent(m[7]), ms: Number(m[8]) };
  return out;
}

const SOURCE_LABEL: Record<MemoryHit['source'], string> = { text: 'typed text', handwriting: 'handwriting', pdf: 'PDF text', meta: 'note title/tags/summary', speech: 'what was said in a recording' };

export const MEMORY_TOOL_NAMES = ['search_memory'] as const;

/**
 * `search_memory`: semantic + keyword search over every passage of every note, returning the
 * exact page and region of each hit so the assistant can quote and cite precisely.
 */
export function createMemoryTools(host: MemorySearchHost): AgentTool[] {
  return [
    {
      name: 'search_memory',
      description:
        'Search everything the user has written — typed text, recognized handwriting, imported PDF text, titles and tags, and transcripts of their recordings (what was said, with the time) — by meaning as well as keywords. Use it for questions like "what did the professor say about Fourier transforms across my lectures". Returns passages with the note, page and a link to the exact spot. Quote what the passages say and cite each one as a Markdown link with its title and page, e.g. [Lecture 3, p. 2](#mem/…). Pass a natural-language query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in plain words.', minLength: 1 },
          limit: { type: 'integer', description: 'Maximum passages (default 8).', minimum: 1, maximum: 30 },
          note_id: { type: 'string', description: 'Only search inside this note.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      readOnly: true,
      async execute(a: { query: string; limit?: number; note_id?: string }) {
        const hits = await host.searchMemory(a.query, { limit: a.limit ?? 8, noteId: a.note_id });
        return {
          query: a.query,
          count: hits.length,
          results: hits.map((h) => ({
            note_id: h.noteId,
            title: h.title || 'Untitled',
            page: h.pageIndex + 1,
            from: SOURCE_LABEL[h.source],
            text: h.text.length > 700 ? `${h.text.slice(0, 700)}…` : h.text,
            ...(h.said ? { said_at: formatStamp(h.said.startMs) } : {}),
            link: memoryLink(h),
          })),
          ...(hits.length ? {} : { hint: 'Nothing found. Try other words, or search_notes for exact keywords.' }),
        };
      },
    },
  ];
}
