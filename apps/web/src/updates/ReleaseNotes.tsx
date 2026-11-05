import type { ReactNode } from 'react';

/**
 * Release notes (the CHANGELOG section, Markdown) as plain React elements: headings, bullet lists
 * (with wrapped continuation lines), paragraphs, **bold** and `code`. Links show their text only.
 * Nothing is parsed as HTML, so notes can't inject markup into the app.
 */
export function ReleaseNotes({ markdown }: { markdown: string }) {
  const blocks = parseNotes(markdown);
  if (!blocks.length) return <p className="muted">No notes for this release.</p>;
  return (
    <div className="update-notes">
      {blocks.map((b, i) =>
        b.kind === 'heading' ? <h3 key={i}>{inline(b.text)}</h3>
          : b.kind === 'list' ? <ul key={i}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>
            : <p key={i}>{inline(b.text)}</p>,
      )}
    </div>
  );
}

export type NoteBlock = { kind: 'heading' | 'paragraph'; text: string } | { kind: 'list'; items: string[] };

/** Splits Markdown into the blocks above (exported for tests). */
export function parseNotes(markdown: string): NoteBlock[] {
  const out: NoteBlock[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (para.length) out.push({ kind: 'paragraph', text: para.join(' ') });
    para = [];
    if (list) out.push({ kind: 'list', items: list });
    list = null;
  };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) { flush(); out.push({ kind: 'heading', text: heading[1] }); }
    else if (bullet) {
      if (para.length) { out.push({ kind: 'paragraph', text: para.join(' ') }); para = []; }
      (list ??= []).push(bullet[1]);
    } else if (list && /^\s+\S/.test(raw)) list[list.length - 1] += ` ${line.trim()}`;
    else { if (list) { out.push({ kind: 'list', items: list }); list = null; } para.push(line.trim()); }
  }
  flush();
  return out;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // [text](url) → text; then **bold** and `code`.
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const m of plain.matchAll(re)) {
    if (m.index > last) out.push(plain.slice(last, m.index));
    out.push(m[1] != null ? <strong key={m.index}>{m[1]}</strong> : <code key={m.index}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < plain.length) out.push(plain.slice(last));
  return out;
}
