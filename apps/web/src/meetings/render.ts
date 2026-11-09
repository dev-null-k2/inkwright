/**
 * Showing AI-written Markdown from meetings (recipes, briefs): citations become links — `[12:03]`
 * to that moment of the recording, `[M2]` / `[M2 12:03]` to that meeting (and moment) — then the
 * Markdown is rendered and sanitised like assistant replies (no images, frames, forms or styles,
 * so a reply can never load remote content).
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { meetingCitations } from '@inkwright/ai';
import type { NoteMeta, TranscriptSegment } from '@inkwright/core';
import { linkLiveCitations, saidHref } from '../lib/listen/session.ts';

const FORBID = { FORBID_TAGS: ['img', 'image', 'svg', 'iframe', 'form', 'input', 'style', 'video', 'audio', 'source', 'object', 'embed'], FORBID_ATTR: ['style', 'srcset'] };

export function safeMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string, FORBID);
}

const mdText = (t: string) => t.replace(/[[\]()*_`]/g, ' ').replace(/\s+/g, ' ').trim();

/** `[M2 12:03]` → `[Meeting title · 12:03](#said/…)`; `[M2]` → `[Meeting title](#note/…)`. */
export function linkMeetingCitations(text: string, meetings: readonly Pick<NoteMeta, 'id' | 'title' | 'recordings'>[]): string {
  let out = text;
  for (const c of meetingCitations(text)) {
    const m = meetings[c.index];
    if (!m) continue;
    const clip = m.recordings?.[0];
    const label = mdText(m.title || 'Untitled').slice(0, 40);
    const stamp = c.match.replace(/^\[M\d+[ ,]*/, '').replace(/\]$/, '');
    const link = c.ms != null && clip ? `[${label} · ${stamp}](${saidHref(m.id, clip.id, c.ms)})` : `[${label}](#note/${encodeURIComponent(m.id)})`;
    out = out.split(c.match).join(link);
  }
  return out;
}

/** A recipe or brief reply as safe HTML with working citations. */
export function meetingReplyHtml(text: string, meetings: readonly Pick<NoteMeta, 'id' | 'title' | 'recordings'>[], single?: { noteId: string; clipId: string; segments: TranscriptSegment[] } | null): string {
  let md = linkMeetingCitations(text, meetings);
  if (single) md = linkLiveCitations(md, single.noteId, { clipId: single.clipId, segments: single.segments });
  return safeMarkdown(md);
}
