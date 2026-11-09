/**
 * Enhanced notes out of the app: Markdown (copy, Notion, Obsidian), Slack's mrkdwn, simple HTML
 * (email and rich paste) and Notion blocks. `[m:ss]` stamps are kept as text so a reader can
 * find the moment; links back into the app are added by the caller when it has one.
 */
import { formatStamp } from '../transcript.ts';
import type { MeetingAttendee, MeetingItem, MeetingNotesVersion } from './model.ts';

export interface MeetingHeader {
  title: string;
  /** When it happened (epoch ms). */
  at?: number;
  attendees?: readonly MeetingAttendee[];
  /** Link back to the note, when there is one to share. */
  link?: string;
}

const fmtDate = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const stamps = (it: MeetingItem) => (it.cites?.length ? ` [${it.cites.slice(0, 2).map(formatStamp).join(', ')}]` : '');
const itemLine = (it: MeetingItem, opts: { stamps: boolean; check?: boolean }) =>
  `${opts.check ? (it.done ? '[x] ' : '[ ] ') : ''}${it.text}${it.owner ? ` — ${it.owner}` : ''}${opts.stamps ? stamps(it) : ''}`;

function isActions(heading: string) {
  return /action|next step|to.?do|follow.?up/i.test(heading);
}

export function meetingMarkdown(h: MeetingHeader, v: MeetingNotesVersion, opts: { stamps?: boolean } = {}): string {
  const out: string[] = [`# ${h.title}`];
  const meta: string[] = [];
  if (h.at) meta.push(fmtDate(h.at));
  if (h.attendees?.length) meta.push(h.attendees.map((a) => a.name).join(', '));
  if (meta.length) out.push(`*${meta.join(' · ')}*`);
  if (v.tldr) out.push('', `> ${v.tldr}`);
  for (const s of v.sections) {
    if (!s.items.length) continue;
    out.push('', `## ${s.heading}`);
    const check = isActions(s.heading);
    for (const it of s.items) out.push(`${it.depth ? '  ' : ''}- ${itemLine(it, { stamps: opts.stamps !== false, check })}`);
  }
  if (h.link) out.push('', `[Open in Inkwright](${h.link})`);
  return `${out.join('\n')}\n`;
}

/** Slack mrkdwn: *bold* headings, • bullets, no Markdown headings or links Slack can't render. */
export function meetingSlack(h: MeetingHeader, v: MeetingNotesVersion): string {
  const out: string[] = [`*${h.title}*${h.at ? `  _${fmtDate(h.at)}_` : ''}`];
  if (v.tldr) out.push(v.tldr);
  for (const s of v.sections) {
    if (!s.items.length) continue;
    out.push('', `*${s.heading}*`);
    const check = isActions(s.heading);
    for (const it of s.items) out.push(`${it.depth ? '    ◦ ' : '• '}${check ? (it.done ? '☑ ' : '☐ ') : ''}${it.text}${it.owner ? ` — ${it.owner}` : ''}`);
  }
  if (h.link) out.push('', `<${h.link}|Open in Inkwright>`);
  return out.join('\n');
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Simple HTML for email bodies and rich paste (Docs, Notion, Outlook). */
export function meetingHtml(h: MeetingHeader, v: MeetingNotesVersion): string {
  const out: string[] = [`<h1>${esc(h.title)}</h1>`];
  const meta: string[] = [];
  if (h.at) meta.push(esc(fmtDate(h.at)));
  if (h.attendees?.length) meta.push(esc(h.attendees.map((a) => a.name).join(', ')));
  if (meta.length) out.push(`<p><em>${meta.join(' · ')}</em></p>`);
  if (v.tldr) out.push(`<p><strong>${esc(v.tldr)}</strong></p>`);
  for (const s of v.sections) {
    if (!s.items.length) continue;
    out.push(`<h2>${esc(s.heading)}</h2>`, '<ul>');
    const check = isActions(s.heading);
    let open = false;
    for (const it of s.items) {
      const li = `<li>${check ? (it.done ? '☑ ' : '☐ ') : ''}${esc(it.text)}${it.owner ? ` — ${esc(it.owner)}` : ''}`;
      if (it.depth && !open && out[out.length - 1]!.endsWith('</li>')) { out[out.length - 1] = `${out[out.length - 1]!.replace(/<\/li>$/, '')}<ul>`; out.push(`${li}</li>`); open = true; }
      else if (it.depth) out.push(`${li}</li>`);
      else { if (open) { out.push('</ul></li>'); open = false; } out.push(`${li}</li>`); }
    }
    if (open) out.push('</ul></li>');
    out.push('</ul>');
  }
  if (h.link) out.push(`<p><a href="${esc(h.link)}">Open in Inkwright</a></p>`);
  return out.join('\n');
}

type NotionText = { type: 'text'; text: { content: string } };
const rt = (t: string): NotionText[] => [{ type: 'text', text: { content: t.slice(0, 1900) } }];

/** Notion API blocks for a page body (headings, bullets, to-dos; nesting flattened to one level). */
export function meetingNotionBlocks(h: MeetingHeader, v: MeetingNotesVersion): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const meta: string[] = [];
  if (h.at) meta.push(fmtDate(h.at));
  if (h.attendees?.length) meta.push(h.attendees.map((a) => a.name).join(', '));
  if (meta.length) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(meta.join(' · ')) } });
  if (v.tldr) blocks.push({ object: 'block', type: 'callout', callout: { rich_text: rt(v.tldr), icon: { type: 'emoji', emoji: '📝' } } });
  for (const s of v.sections) {
    if (!s.items.length) continue;
    blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: rt(s.heading) } });
    const check = isActions(s.heading);
    for (const it of s.items) {
      const text = `${it.depth ? '↳ ' : ''}${it.text}${it.owner ? ` — ${it.owner}` : ''}${stamps(it)}`;
      blocks.push(check ? { object: 'block', type: 'to_do', to_do: { rich_text: rt(text), checked: !!it.done } } : { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(text) } });
    }
  }
  if (h.link) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Open in Inkwright', link: { url: h.link } } }] } });
  return blocks.slice(0, 100);
}

/** A mailto: link with subject and plain-text body (mail apps take no HTML here). */
export function meetingMailto(h: MeetingHeader, v: MeetingNotesVersion, to: readonly string[] = [], body?: string): string {
  const text = body ?? meetingMarkdown(h, v, { stamps: false }).replace(/^# .*\n/, '').replace(/^\*(.*)\*$/m, '$1').replace(/^## /gm, '').replace(/\[( |x)\] /g, '');
  const subject = /^Subject:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? `Notes: ${h.title}`;
  const clean = text.replace(/^Subject:.*\n+/im, '');
  return `mailto:${to.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(clean.slice(0, 1800))}`;
}
