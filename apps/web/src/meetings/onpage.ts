/**
 * Enhanced notes onto the page. Your own lines are already there in your ink, so only what the AI
 * added is written: section by section, in AI ink (its own colour, origin 'ai', one undo step)
 * in a hand matched to yours (`handStyleOf`: size, slant, pen, messiness) — or as a typed text box.
 */
import { handStyleOf, type MeetingNotesVersion, type NoteDocument } from '@inkwright/core';
import { placeTypedAnswer, writeInInk } from '../inkanswer/write.ts';
import { meetingMarkdown } from '@inkwright/core';

/** The lines the AI added, as short plain text for handwriting. */
export function additionsText(v: MeetingNotesVersion): string {
  const out: string[] = [];
  if (v.tldr) out.push(v.tldr, '');
  for (const s of v.sections) {
    const added = s.items.filter((i) => !i.mine);
    if (!added.length) continue;
    out.push(`${s.heading}:`);
    for (const it of added) out.push(`${it.depth ? '   ' : ''}– ${it.text}${it.owner ? ` (${it.owner})` : ''}`);
    out.push('');
  }
  return out.join('\n').trim();
}

export async function writeMeetingNotesOnPage(doc: NoteDocument, pageIndex: number, v: MeetingNotesVersion, style: 'typed' | 'hand'): Promise<{ pageIndex: number }> {
  if (style === 'typed') {
    const md = meetingMarkdown({ title: 'Enhanced notes' }, v, { stamps: false }).replace(/^# .*\n/, '## Enhanced notes\n');
    return placeTypedAnswer(doc, pageIndex, md, null);
  }
  const text = additionsText(v);
  if (!text) throw new Error('Everything in these notes is already in your own writing.');
  const hand = handStyleOf(doc.pages.flatMap((p) => p.strokes));
  return writeInInk(doc, pageIndex, text, { hand, label: 'Enhanced notes in ink' });
}
