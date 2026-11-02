import { handwrite, newId, type InkPoint, type InkStroke, type PageInk, type PaperSpec, type TextBox, type Vault } from '@inkwright/core';

/**
 * "Try sample notebooks": a small, realistic library written with the handwriting synthesizer —
 * lecture notes with a sketched waveform, a weekly plan, a design review with margin notes and a
 * journal page — so a first-time user (or an app-store reviewer) sees what Inkwright does with real
 * pages instead of an empty desk. Everything is ordinary ink and text: erase it, lasso it, search it,
 * ask about it. Recognized text is filled in so search and Ask work before any AI is set up.
 */

const INK = '#FF1F2433';
const BLUE = '#FF1F3A93';
const RED = '#FFB3412F';
/** The AI's ink: the `--ai-ink` colour answers are written in, so they're never mistaken for yours. */
const AI_INK = '#FF2D5A8C';

function stroke(points: [number, number][], pen: InkStroke['pen'], color: string, size: number, t0: number): InkStroke {
  const pts: InkPoint[] = points.map(([x, y], i) => ({ x, y, t: i * 9, p: 0.45 + 0.25 * Math.sin((Math.PI * i) / Math.max(1, points.length - 1)), tilt: -1, orient: -1 }));
  return { id: newId(), pen, color, size, points: pts, createdAt: t0 };
}

function line(x0: number, y0: number, x1: number, y1: number, pen: InkStroke['pen'], color: string, size: number, t0: number, wobble = 0.6, seed = 1) {
  const n = Math.max(8, Math.round(Math.hypot(x1 - x0, y1 - y0) / 6));
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push([x0 + (x1 - x0) * f + Math.sin(f * 9 + seed) * wobble, y0 + (y1 - y0) * f + Math.cos(f * 7 + seed) * wobble]);
  }
  return stroke(pts, pen, color, size, t0);
}

function text_(x: number, y: number, width: number, body: string, size = 16, font: TextBox['font'] = 'sans'): TextBox {
  return { id: newId(), x, y, width, text: body, fontSize: size, color: '#FF1B1F24', font, createdAt: Date.now() };
}

const RULED: PaperSpec = { style: 'ruled_narrow', tint: 'ivory', texture: 'standard', spacing: 0 };
const DOTS: PaperSpec = { style: 'dot_grid', tint: 'white', texture: 'smooth', spacing: 0 };

interface Built { strokes: InkStroke[]; recognized: string[]; y: number }

/** Writes paragraphs top to bottom, collecting strokes and the recognized text. */
function writer(x: number, y: number, width: number, t0: number) {
  const out: Built = { strokes: [], recognized: [], y };
  let clock = t0, seed = Math.floor(t0 / 997);
  const write = (body: string, opts: { xHeight?: number; style?: 'script' | 'print'; color?: string; pen?: InkStroke['pen']; gap?: number; indent?: number } = {}) => {
    const r = handwrite(body, { x: x + (opts.indent ?? 0), y: out.y, width: width - (opts.indent ?? 0), xHeight: opts.xHeight ?? 8.5, style: opts.style ?? 'script', color: opts.color ?? INK, pen: opts.pen ?? 'fountain', seed: ++seed, startTime: clock, messiness: 0.4 });
    out.strokes.push(...r.strokes);
    out.recognized.push(body);
    clock = (r.strokes[r.strokes.length - 1]?.createdAt ?? clock) + 1500;
    const top = out.y;
    out.y = r.bottom + (opts.gap ?? 14);
    return { top, bottom: r.bottom, baselines: r.baselines };
  };
  return { out, write, now: () => clock };
}

async function lecture(vault: Vault, notebookId: string): Promise<string> {
  const { note, pages } = await vault.createNote({ title: 'Lecture 7 — Fourier series', notebookId, tags: ['signals', 'exam'], paper: RULED });
  const t0 = Date.now() - 3 * 86400_000;
  const w = writer(70, 64, 640, t0);
  const title = w.write('Lecture 7 — Fourier series', { xHeight: 12, gap: 20 });
  w.out.strokes.push(line(66, title.bottom + 2, 440, title.bottom + 1, 'highlighter', '#FFFFD54A', 14, w.now()));
  w.write('Any periodic signal can be written as a sum of sines and cosines at multiples of the base frequency.');
  w.write('x(t) = a0 + sum [ an cos(nwt) + bn sin(nwt) ]', { style: 'print', color: BLUE, xHeight: 9 });
  w.write('Square wave: only odd harmonics, amplitudes fall as 1/n.');
  // A sketched square wave and its three-term approximation.
  const gx = 90, gy = w.out.y + 46, gw = 560, amp = 34;
  w.out.strokes.push(line(gx - 10, gy, gx + gw + 10, gy, 'ballpoint', INK, 1.4, w.now(), 0.3, 3));
  w.out.strokes.push(line(gx, gy - amp - 18, gx, gy + amp + 18, 'ballpoint', INK, 1.4, w.now(), 0.3, 4));
  const sq: [number, number][] = [];
  for (let k = 0; k < 4; k++) {
    const x0 = gx + (k * gw) / 4, x1 = gx + ((k + 0.5) * gw) / 4, x2 = gx + ((k + 1) * gw) / 4;
    sq.push([x0, gy - amp], [x1, gy - amp], [x1, gy + amp], [x2, gy + amp]);
  }
  w.out.strokes.push(stroke(sq.flatMap(([x, y], i) => (i ? [[(sq[i - 1]![0] + x) / 2, (sq[i - 1]![1] + y) / 2] as [number, number], [x, y] as [number, number]] : [[x, y] as [number, number]])), 'fountain', INK, 2.2, w.now()));
  const approx: [number, number][] = [];
  for (let i = 0; i <= 240; i++) {
    const f = i / 240, th = f * 4 * 2 * Math.PI;
    const v = (4 / Math.PI) * (Math.sin(th) + Math.sin(3 * th) / 3 + Math.sin(5 * th) / 5);
    approx.push([gx + f * gw, gy - v * amp * 0.86]);
  }
  w.out.strokes.push(stroke(approx, 'fountain', RED, 1.8, w.now()));
  w.out.y = gy + amp + 40;
  const q = w.write('Why does it ring at the edges? Gibbs: about 9% overshoot that never goes away.', { gap: 10 });
  w.out.strokes.push(line(60, q.top - 4, 60, q.bottom + 4, 'marker', RED, 2.6, w.now(), 0.4, 9));
  w.write('Ask in office hours: does the overshoot matter for audio?', { style: 'print', color: BLUE, indent: 18 });
  const page: PageInk = { ...pages[0]!, strokes: w.out.strokes, recognizedText: w.out.recognized.join('\n'), recognizedAt: Date.now(), recognizedBy: 'sample' };
  await vault.saveNote({ ...note, createdAt: t0, updatedAt: t0 + 3600_000 }, [page]);
  return note.id;
}

async function weekly(vault: Vault, notebookId: string) {
  const { note, pages } = await vault.createNote({ title: 'This week', notebookId, tags: ['plan'], paper: RULED });
  const t0 = Date.now() - 86400_000;
  const w = writer(70, 64, 640, t0);
  w.write('This week', { xHeight: 12, gap: 22 });
  const items: [string, boolean][] = [['Review convolution before Thursday', true], ['Finish lab 4 write-up', true], ['Email Prof. Rao about the midterm', false], ['Draft the launch post', false], ['Call home on Sunday', false]];
  for (const [item, done] of items) {
    const r = w.write(item, { style: 'print', indent: 34, gap: 16 });
    const b = r.baselines[0]!;
    w.out.strokes.push(line(72, b - 14, 88, b - 14, 'ballpoint', INK, 1.4, w.now(), 0.2, 1), line(88, b - 14, 88, b + 1, 'ballpoint', INK, 1.4, w.now(), 0.2, 2), line(88, b + 1, 72, b + 1, 'ballpoint', INK, 1.4, w.now(), 0.2, 3), line(72, b + 1, 72, b - 14, 'ballpoint', INK, 1.4, w.now(), 0.2, 4));
    if (done) w.out.strokes.push(stroke([[74, b - 6], [79, b - 1], [92, b - 20]], 'fountain', '#FF2E7D57', 2.2, w.now()));
  }
  await vault.saveNote({ ...note, createdAt: t0, updatedAt: t0 + 1800_000 }, [{ ...pages[0]!, strokes: w.out.strokes, recognizedText: w.out.recognized.join('\n'), recognizedAt: Date.now(), recognizedBy: 'sample' }]);
}

async function review(vault: Vault, notebookId: string, lectureTitle: string) {
  const { note, pages } = await vault.createNote({ title: 'Design review — offline sync', notebookId, tags: ['meeting'], paper: DOTS });
  const t0 = Date.now() - 2 * 86400_000;
  const texts: TextBox[] = [
    text_(64, 64, 620, '# Design review — offline sync', 18, 'serif'),
    text_(64, 120, 470, ['**Decision:** three-way merge per page; no server.', '', '- Notes stay plain files on each device', '- Drive, WebDAV or a synced folder carries them', '- Conflicts merge stroke by stroke', '', `Background reading: [[${lectureTitle}]]`].join('\n'), 15),
  ];
  const w = writer(560, 130, 170, t0 + 600_000);
  w.write('latency budget?', { style: 'print', color: RED, xHeight: 7.5 });
  w.write('ask Priya re: tests', { style: 'print', color: RED, xHeight: 7.5 });
  // A small hand-drawn diagram: two devices and the user's own storage.
  const box = (x: number, y: number, bw: number, bh: number, t: number) => [line(x, y, x + bw, y, 'fountain', INK, 1.8, t, 0.5, 1), line(x + bw, y, x + bw, y + bh, 'fountain', INK, 1.8, t, 0.5, 2), line(x + bw, y + bh, x, y + bh, 'fountain', INK, 1.8, t, 0.5, 3), line(x, y + bh, x, y, 'fountain', INK, 1.8, t, 0.5, 4)];
  const d = writer(0, 0, 200, t0 + 900_000);
  const strokes = [...w.out.strokes, ...box(90, 360, 150, 70, w.now()), ...box(430, 360, 150, 70, w.now()), ...box(255, 520, 160, 70, w.now())];
  for (const [label, x, y] of [['phone', 128, 382], ['laptop', 465, 382], ['your Drive', 278, 542]] as const) {
    const r = handwrite(label, { x, y, xHeight: 8, style: 'print', seed: label.length * 7, startTime: d.now(), color: BLUE, pen: 'ballpoint' });
    strokes.push(...r.strokes);
  }
  strokes.push(line(170, 432, 280, 518, 'fountain', INK, 1.6, w.now(), 0.8, 5), line(500, 432, 395, 518, 'fountain', INK, 1.6, w.now(), 0.8, 6));
  await vault.saveNote({ ...note, createdAt: t0, updatedAt: t0 + 900_000 }, [{ ...pages[0]!, texts, strokes, recognizedText: [...w.out.recognized, 'phone', 'laptop', 'your Drive'].join('\n'), recognizedAt: Date.now(), recognizedBy: 'sample' }]);
}

/** A page where the student asked in ink and the AI answered in its own ink (as "Answer" does). */
async function askPage(vault: Vault, notebookId: string, lectureTitle: string) {
  const { note, pages } = await vault.createNote({ title: 'Asking the page', notebookId, tags: ['signals'], paper: RULED });
  const t0 = Date.now() - 2 * 3600_000;
  const w = writer(70, 64, 640, t0);
  w.write('Questions after lecture 7', { xHeight: 11, gap: 22 });
  const q = w.write('Why does the overshoot at the jump never go away, even with more terms?', { gap: 18 });
  // The lasso the question was asked with, left on the page as a light bracket.
  w.out.strokes.push(line(58, q.top - 2, 58, q.bottom + 2, 'ballpoint', '#FF8A8190', 1.2, w.now(), 0.3, 2));
  const answer = handwrite(
    'Because the partial sums converge pointwise, not uniformly. Near the jump each new term squeezes the ripple closer to the edge but its peak stays near 9% of the jump (the Gibbs phenomenon). Smoothing the coefficients, e.g. Fejer or Lanczos sigma factors, removes it.',
    { x: 92, y: w.out.y + 6, width: 600, xHeight: 8, style: 'print', color: AI_INK, pen: 'ballpoint', seed: 77, startTime: w.now() + 4000, origin: 'ai', messiness: 0.2 },
  );
  const text = [text_(70, answer.bottom + 26, 600, `From [[${lectureTitle}]] and the course notes.`, 13)];
  await vault.saveNote({ ...note, createdAt: t0, updatedAt: t0 + 600_000 }, [{ ...pages[0]!, strokes: [...w.out.strokes, ...answer.strokes], texts: text, recognizedText: w.out.recognized.join('\n'), recognizedAt: Date.now(), recognizedBy: 'sample' }]);
}

async function journal(vault: Vault, notebookId: string) {
  const day = new Date();
  const title = day.toISOString().slice(0, 10);
  const { note, pages } = await vault.createNote({ title, notebookId, tags: ['journal'], paper: { style: 'blank', tint: 'ivory', texture: 'toothy', spacing: 0 } });
  const w = writer(80, 80, 600, Date.now() - 3600_000);
  w.write(day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), { xHeight: 11, gap: 22 });
  w.write('Quiet morning. Wrote the first page by hand before opening the laptop and the whole day felt slower, in a good way.');
  w.write('Idea: let the AI answer in ink, right on the page, marked so it is never mistaken for mine.', { color: BLUE });
  await vault.saveNote(note, [{ ...pages[0]!, strokes: w.out.strokes, recognizedText: w.out.recognized.join('\n'), recognizedAt: Date.now(), recognizedBy: 'sample' }]);
}

/** Adds the sample notebooks. Safe to call more than once (each call adds a fresh set). */
export async function seedSampleLibrary(vault: Vault): Promise<{ notebooks: number; notes: number }> {
  const study = await vault.createNotebook('Signals & Systems', '#FF2E6B57');
  const work = await vault.createNotebook('Startup', '#FFB3412F');
  const life = await vault.createNotebook('Journal', '#FF1F3A93');
  const lectureId = await lecture(vault, study.id);
  const lectureTitle = (await vault.readNote(lectureId))?.title ?? 'Lecture 7 — Fourier series';
  await weekly(vault, study.id);
  await review(vault, work.id, lectureTitle);
  await askPage(vault, study.id, lectureTitle);
  await journal(vault, life.id);
  return { notebooks: 3, notes: 5 };
}
