import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { line, modKey, openApp, pen, pointer, settingsGroup, type Pt } from './helpers.ts';
import { LAUNCH_QUESTION_LINE, NOTEBOOK_COLORS, handAt, launchSync, lecture, rule, studyNotes, thesisNotes, type SeedNote } from './showcase/content.ts';

/**
 * Raw captures for the README showcase, from the real app with realistic content:
 *   SHOWCASE=<dir> npx playwright test e2e/showcase.spec.ts --project desktop --workers=1
 * then `node scripts/brand/showcase.mjs <dir>` frames them (docs/media/showcase/).
 *
 * Handwriting is written by the app's own synthesiser (e2e/showcase/content.ts). Where a scene
 * needs an AI, a scripted OpenAI-compatible model answers on a routed URL (as in the other specs):
 * no paid API is ever called, and everything the app does with the reply — writing it in ink,
 * citing, logging, redacting — is the real code path. ML Kit is replaced by the same scripted
 * stand-in mathink.spec.ts uses. Each scene is captured on the Razr Fold's inner screen
 * (720×800 CSS px) and/or a 1280×800 laptop, at 2× pixels, in light and dark.
 */
const out = process.env.SHOWCASE;
test.skip(!out, 'README showcase captures only (set SHOWCASE=<dir>)');

const FOLD = { width: 720, height: 800 };
const LAPTOP = { width: 1280, height: 800 };
type Scheme = 'light' | 'dark';

test.use({ deviceScaleFactor: 2, viewport: FOLD });
test.describe.configure({ timeout: 180_000 });

// ── Scripted model ──────────────────────────────────────────────────────────────────────────────

type Reply = string | { tool: string; args: object } | ((body: any) => string | { tool: string; args: object });

/** An OpenAI-compatible endpoint that answers with the next scripted reply (streamed or not). */
async function scriptedModel(page: Page, replies: Reply[]) {
  const requests: any[] = [];
  let i = 0;
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    let r = replies[Math.min(i++, replies.length - 1)]!;
    if (typeof r === 'function') r = r(body);
    const msg = typeof r === 'string' ? { role: 'assistant', content: r } : { role: 'assistant', content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] };
    if (body.stream) {
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const sse = msg.tool_calls ? chunk({ role: 'assistant', tool_calls: msg.tool_calls.map((t, index) => ({ index, ...t })) }) + chunk({}, 'tool_calls') : chunk({ role: 'assistant', content: msg.content }) + chunk({}, 'stop');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: `${sse}data: [DONE]\n\n` });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 420, completion_tokens: 60 } }) });
    }
  });
  return requests;
}

/** Settings › AI › Add an AI provider: a custom OpenAI-compatible server (the scripted one). */
async function addProvider(page: Page, model = 'claude-sonnet-4-5') {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill(model);
  await page.getByRole('button', { name: 'Save provider' }).click();
  await expect(page.locator('.prov-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Back' }).first().click();
}

// ── Seeding ─────────────────────────────────────────────────────────────────────────────────────

/** Writes notes into the app's vault the way sync would, then reloads so the library shows them. */
async function seed(page: Page, notes: SeedNote[]) {
  await page.waitForFunction(() => !!(window as any).__inkwrightHub);
  const now = Date.now();
  await page.evaluate(async ({ notes, colors, now }) => {
    const v = (window as any).__inkwrightHub.vault.vault;
    const books = new Map<string, string>();
    for (const b of await v.listNotebooks()) books.set(b.name, b.id);
    // The first-run welcome note would sit pinned above everything; a lived-in library has none.
    for (const n of await v.listNotes()) if (/^Welcome to Inkwright/.test(n.title)) await v.deleteNote(n.id);
    for (const n of notes) {
      if (!books.has(n.notebook)) books.set(n.notebook, (await v.createNotebook(n.notebook, colors[n.notebook])).id);
      const { note, pages } = await v.createNote({ title: n.title, notebookId: books.get(n.notebook), tags: n.tags, paper: n.paper });
      const at = now - n.agoMin * 60_000;
      const extra = n.pages.slice(1).map((_, i) => ({ ...pages[0], id: `${pages[0].id}${i + 2}` }));
      const all = [pages[0], ...extra].map((p: any, i: number) => ({ ...p, strokes: n.pages[i]!.strokes, texts: n.pages[i]!.texts ?? [], ...(n.pages[i]!.recognizedText ? { recognizedText: n.pages[i]!.recognizedText, recognizedLines: n.pages[i]!.recognizedLines, recognizedAt: at, recognizedBy: 'mlkit' } : {}) }));
      await v.saveNote({ ...note, pageIds: all.map((p: any) => p.id), createdAt: at - 40 * 60_000, updatedAt: at }, all);
    }
  }, { notes, colors: NOTEBOOK_COLORS, now });
  await page.reload();
  await expect(page.locator('.library')).toBeVisible();
}

/** Background notes so the library looks lived-in. */
function library(now: number): SeedNote[] {
  return [lecture(now), studyNotes(now), ...thesisNotes(now)];
}

// ── Capture ─────────────────────────────────────────────────────────────────────────────────────

/** Opens the app at laptop size (Settings is in the side bar there) in the given colour scheme. */
async function start(page: Page, s: Scheme) {
  await page.setViewportSize(LAPTOP);
  await page.emulateMedia({ colorScheme: s, reducedMotion: 'reduce' });
  await openApp(page);
}

async function fold(page: Page) {
  await page.setViewportSize(FOLD);
  await page.waitForTimeout(500);
}

/** Waits for passing toasts and animations, then writes `<out>/<name>-<scheme>.png`. */
async function shot(page: Page, name: string, s: Scheme) {
  mkdirSync(out!, { recursive: true });
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${out}/${name}-${s}.png` });
}

async function openNote(page: Page, title: string) {
  await page.locator('.note-card', { hasText: title }).first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await page.waitForTimeout(600);
}

/** Canvas position (CSS px) of a page point. */
const toScreen = (page: Page, x: number, y: number) => page.evaluate(({ x, y }) => {
  const r = (window as any).__inkwright.engine.pageRectToScreen(0, { minX: x, minY: y, maxX: x, maxY: y });
  return [r.x, r.y] as [number, number];
}, { x, y });

/** Lassoes a page-space rectangle with the lasso tool (an ellipse around it, like a hand would). */
async function lasso(page: Page, x0: number, y0: number, x1: number, y1: number) {
  const [a, b] = await toScreen(page, x0, y0), [c, d] = await toScreen(page, x1, y1);
  await page.keyboard.press('l');
  const cx = (a + c) / 2, cy = (b + d) / 2, rx = (c - a) / 2 + 14, ry = (d - b) / 2 + 12;
  const pts: Pt[] = Array.from({ length: 96 }, (_, i) => [cx + rx * Math.cos((i / 88) * Math.PI * 2), cy + ry * Math.sin((i / 88) * Math.PI * 2)]);
  await pen(page, pts, { type: 'mouse' });
}

/** Sets the editor's zoom and scrolls so page y `top` is at the top edge (page centred). */
async function view(page: Page, zoom: number, top: number) {
  await page.evaluate(({ zoom, top }) => {
    const e = (window as any).__inkwright.engine;
    const v = e.viewport;
    v.zoom = zoom;
    v.panX = (v.width - e.layout.width * zoom) / 2;
    v.panY = -top * zoom;
    e.invalidate();
  }, { zoom, top });
  await page.waitForTimeout(250);
}

const ANSWER = 'Two things: Priya’s sync fix, landing Friday, and the week of soak tests after it. Pen lag on older tablets is a risk, not a blocker.';

for (const s of ['light', 'dark'] as Scheme[]) {
  test(`hero: a handwritten question answered in ink (${s})`, async ({ page }) => {
    await scriptedModel(page, [
      ANSWER,
      { tool: 'search_memory', args: { query: 'action items owners' } },
      (body) => {
        const raw = String(body.messages.filter((m: any) => m.role === 'tool').pop()?.content ?? '');
        const hits = raw ? JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).results ?? [] : [];
        const h = hits.find((x: any) => x.title === 'Beta launch sync');
        const cite = h ? ` ([${h.title}, p. ${h.page}](${h.link}))` : '';
        return `Three actions from the beta sync${cite}: Dev drafts the release notes (done), Sam books the design review, and you email the waitlist on Nov 17, the day before 200 people get the beta.`;
      },
    ]);
    await start(page, s);
    await addProvider(page);
    const now = Date.now();
    await seed(page, [...library(now), launchSync(now)]);
    await fold(page);
    await shot(page, 'library-fold', s);
    await openNote(page, 'Beta launch sync');
    const y = rule(LAUNCH_QUESTION_LINE);
    await lasso(page, 130, y - 30, 560, y + 8);
    await page.getByRole('toolbar', { name: /selected/ }).getByRole('button', { name: 'Answer' }).click();
    await expect(page.getByText('Answered on the page')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('p');
    await view(page, 1.05, 110);
    await shot(page, 'hero-fold', s);
    await page.setViewportSize(LAPTOP);
    await page.waitForTimeout(500);
    await view(page, 1.1, 80);
    await shot(page, 'hero-laptop', s);

    // The assistant, asked on the fold, answers with a citation to the handwritten page.
    await fold(page);
    await view(page, 0.79, 70);
    await page.locator('.ai-btn').click();
    await page.locator('.ai-input textarea').fill('What are the action items, and who owns them?');
    await page.locator('.ai-input textarea').press('Enter');
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('waitlist on Nov 17', { timeout: 20_000 });
    await shot(page, 'actions-fold', s);
  });
}

// ── Students: maths solved on the device, flashcards from handwriting ───────────────────────────

/**
 * ML Kit's digital-ink symbol reader can't run in a desktop browser; this is the scripted stand-in
 * from mathink.spec.ts (ranked candidates, with ML Kit's usual "t" for "+" confusion). The
 * grouping, the 2D layout, the grammar and the exact solver are the app's own.
 */
async function installFakeMlKit(page: Page) {
  await page.addInitScript(() => {
    type Ink = { strokes: { x: number[]; y: number[] }[] };
    const straight = (s: { x: number[]; y: number[] }) => {
      const n = s.x.length - 1;
      const chord = Math.hypot(s.x[n]! - s.x[0]!, s.y[n]! - s.y[0]!);
      let len = 0;
      for (let i = 1; i <= n; i++) len += Math.hypot(s.x[i]! - s.x[i - 1]!, s.y[i]! - s.y[i - 1]!);
      return len > 0 && chord / len > 0.95;
    };
    const answer = (ink: Ink) => {
      const ss = ink.strokes;
      const c = (...xs: [string, number][]) => ({ candidates: xs.map(([text, score]) => ({ text, score })) });
      if (ss.length === 2 && ss.every(straight)) {
        const s0 = ss[0]!, s1 = ss[1]!;
        const flat = (s: typeof s0) => Math.abs(s.y[s.y.length - 1]! - s.y[0]!) < Math.abs(s.x[s.x.length - 1]! - s.x[0]!) * 0.3;
        if (!flat(s0) && !flat(s1) && Math.abs(s0.x[0]! - s0.x[s0.x.length - 1]!) > 4) return c(['x', 0.6], ['X', 1.4], ['×', 2.1]);
        if (flat(s0) && flat(s1)) return c(['=', 0.5], ['z', 2.4]);
        return c(['t', 1.1], ['+', 1.35], ['f', 3.2]);
      }
      if (ss.length === 2) return c(['4', 0.5], ['y', 2.4], ['9', 3]);
      const s = ss[0]!;
      if (straight(s)) return c(['l', 0.9], ['1', 1.0], ['|', 2.2]);
      return s.x[s.x.length - 1]! > s.x[0]! ? c(['2', 0.4], ['z', 2.0], ['Z', 2.6]) : c(['3', 0.45], ['B', 2.3], ['}', 3.1]);
    };
    (window as any).__inkwrightFakeRecognizer = {
      async prepareRecognizer() { return { state: 'ready' }; },
      async recognize(o: { lines: unknown[] }) { return { lines: o.lines.map(() => '') }; },
      async recognizeSymbols(o: { inks: Ink[] }) { return { results: o.inks.map(answer) }; },
    };
  });
}

/** Glyphs as a hand draws them, in canvas px; (x, y) is the top-left of a symbol `h` px tall. */
const seg = (a: Pt, b: Pt, n = 16): Pt[] => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
const curve = (pts: Pt[], n = 12): Pt[] => pts.slice(1).flatMap((b, i) => { const a = pts[i]!; return Array.from({ length: n }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n] as Pt); }).concat([pts[pts.length - 1]!]);
const G = {
  two: (x: number, y: number, k: number) => [curve([[x, y + 10 * k], [x + 8 * k, y], [x + 22 * k, y + 2 * k], [x + 24 * k, y + 13 * k], [x + 2 * k, y + 40 * k], [x + 26 * k, y + 40 * k]])],
  three: (x: number, y: number, k: number) => [curve([[x + 3 * k, y + 4 * k], [x + 14 * k, y], [x + 22 * k, y + 9 * k], [x + 10 * k, y + 19 * k], [x + 23 * k, y + 28 * k], [x + 15 * k, y + 40 * k], [x + k, y + 37 * k]])],
  four: (x: number, y: number, k: number) => [curve([[x + 16 * k, y], [x, y + 26 * k], [x + 26 * k, y + 26 * k]]), seg([x + 18 * k, y + 12 * k], [x + 18 * k, y + 40 * k])],
  plus: (x: number, y: number, k: number) => [seg([x, y + 20 * k], [x + 24 * k, y + 20 * k]), seg([x + 12 * k, y + 8 * k], [x + 12 * k, y + 32 * k])],
  equals: (x: number, y: number, k: number) => [seg([x, y + 15 * k], [x + 26 * k, y + 15 * k]), seg([x, y + 26 * k], [x + 26 * k, y + 26 * k])],
  x: (x: number, y: number, k: number) => [seg([x, y + 14 * k], [x + 20 * k, y + 40 * k]), seg([x + 20 * k, y + 14 * k], [x, y + 40 * k])],
  one: (x: number, y: number, k: number) => [seg([x + 6 * k, y], [x + 6 * k, y + 40 * k], 20)],
};

/** Writes "3x + 2 = 14" with the pen at a page position; returns its screen box. */
async function writeEquation(page: Page, px: number, py: number) {
  const [x0, y0] = await toScreen(page, px, py);
  const [x1] = await toScreen(page, px + 100, py);
  const k = ((x1 - x0) / 100) * 1.05;
  const glyphs: [keyof typeof G, number][] = [['three', 0], ['x', 32], ['plus', 70], ['two', 108], ['equals', 148], ['one', 186], ['four', 210]];
  for (const [g, dx] of glyphs) for (const s of G[g](x0 + dx * k, y0, k)) await pen(page, s, { pressure: 0.55 });
  return { x0, y0, x1: x0 + 240 * k, y1: y0 + 40 * k };
}

for (const s of ['light', 'dark'] as Scheme[]) {
  test(`students: solve on the device, then review flashcards (${s})`, async ({ page }) => {
    await installFakeMlKit(page);
    await start(page, s);
    const now = Date.now();
    await seed(page, [...library(now), launchSync(now)]);
    await fold(page);
    await openNote(page, 'Lecture 9');
    await view(page, 1.0, 40);
    const box = await writeEquation(page, 150, rule(8) - 46);
    await page.keyboard.press('l');
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, rx = (box.x1 - box.x0) / 2 + 26, ry = (box.y1 - box.y0) / 2 + 22;
    await pen(page, Array.from({ length: 96 }, (_, i) => [cx + rx * Math.cos((i / 88) * Math.PI * 2), cy + ry * Math.sin((i / 88) * Math.PI * 2)] as Pt), { type: 'mouse' });
    await page.locator('.sel-btn', { hasText: 'Solve' }).click();
    const result = page.getByRole('button', { name: /^Result x = 4/ });
    await expect(result).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('p');
    await shot(page, 'solve-fold', s);
    // Scrolled so the handwritten equation and its result sit just above the steps dialog.
    await view(page, 1.0, 175);
    await result.click();
    await page.getByRole('menuitem', { name: 'Show steps' }).click();
    await expect(page.getByRole('dialog', { name: 'Steps' })).toContainText('Worked out exactly on this device');
    await shot(page, 'solve-steps-fold', s);
    await page.keyboard.press('Escape');

    // Flashcards from the handwritten "Week 6" page, reviewed with FSRS.
    await page.getByRole('button', { name: 'Back to library' }).click();
    await page.setViewportSize(LAPTOP);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: /^Study/ }).click();
    await page.getByLabel('Note to make cards from').selectOption({ label: 'Week 6 — series' });
    await page.getByRole('button', { name: 'Make cards' }).click();
    const deck = page.locator('.ag-item', { hasText: 'Week 6' });
    await expect(deck).toContainText('cards', { timeout: 15_000 });
    await fold(page);
    await shot(page, 'study-deck-fold', s);
    await deck.getByRole('button', { name: 'Review' }).click();
    const review = page.getByRole('dialog', { name: 'Review' });
    await expect(review.locator('.cp-card-q')).toBeVisible();
    await shot(page, 'study-q-fold', s);
    await page.keyboard.press('Space');
    await expect(review.locator('.cp-card-a')).toBeVisible();
    await shot(page, 'study-a-fold', s);
  });
}

// ── Professionals: a contract filled in and signed by hand ───────────────────────────────────────

/** A one-page consulting agreement with real form fields and a printed signature line. */
async function agreementPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const p = pdf.addPage([612, 792]);
  const ink = rgb(0.13, 0.12, 0.16), grey = rgb(0.42, 0.4, 0.45);
  p.drawText('Consulting agreement', { x: 72, y: 716, size: 22, font: bold, color: ink });
  p.drawText('Between Northwind Analytics ("the client") and the consultant named below.', { x: 72, y: 690, size: 10.5, font, color: grey });
  const form = pdf.getForm();
  const field = (label: string, name: string, y: number, w = 300) => {
    p.drawText(label, { x: 72, y: y + 26, size: 9.5, font, color: grey });
    const f = form.createTextField(name);
    f.addToPage(p, { x: 72, y, width: w, height: 22, font, borderWidth: 0.6, borderColor: rgb(0.75, 0.73, 0.78) });
  };
  field('Consultant', 'consultant', 620);
  field('Start date', 'start', 566, 180);
  field('Day rate (USD)', 'rate', 512, 180);
  const terms = ['1. Work is described in statements of work signed by both parties.', '2. Invoices are paid within 30 days of receipt.', '3. Each party keeps the other’s information confidential.'];
  terms.forEach((t, i) => p.drawText(t, { x: 72, y: 460 - i * 20, size: 10.5, font, color: ink }));
  const agree = form.createCheckBox('agree');
  agree.addToPage(p, { x: 72, y: 382, width: 14, height: 14 });
  p.drawText('I have read and agree to these terms.', { x: 94, y: 385, size: 10.5, font, color: ink });
  p.drawLine({ start: { x: 72, y: 300 }, end: { x: 330, y: 300 }, thickness: 0.8, color: ink });
  p.drawText('Signature', { x: 72, y: 286, size: 9.5, font, color: grey });
  return Buffer.from(await pdf.save());
}

/** Client coordinates of a page point (page units). */
async function clientPoint(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(({ x, y }) => {
    const { engine } = (window as any).__inkwright;
    const r = (document.querySelector('.ed-canvas') as HTMLElement).getBoundingClientRect();
    const s = engine.pageRectToScreen(0, { minX: x, minY: y, maxX: x + 1, maxY: y + 1 });
    return [r.left + s.x, r.top + s.y] as [number, number];
  }, { x, y });
}

for (const s of ['light', 'dark'] as Scheme[]) {
  test(`professionals: a contract filled in and signed (${s})`, async ({ page }) => {
    await start(page, s);
    await fold(page);
    await page.locator('input[type=file]').first().setInputFiles({ name: 'Consulting agreement.pdf', mimeType: 'application/pdf', buffer: await agreementPdf() });
    await page.waitForFunction(() => (window as any).__inkwright?.doc?.pageCount === 1, null, { timeout: 20_000 });
    const chip = page.locator('.fill-chip');
    await expect(chip).toContainText('fields', { timeout: 15_000 });
    await chip.getByRole('button', { name: 'Fill in' }).click();
    await expect(page.getByRole('toolbar', { name: 'Fill and sign' })).toBeVisible({ timeout: 15_000 });
    for (const [f, v] of [['consultant', 'Maya Okafor'], ['start', '1 December 2026'], ['rate', '950']]) {
      await page.locator(`.fill-field[data-field="${f}"]`).fill(v!);
      await page.locator(`.fill-field[data-field="${f}"]`).press('Enter');
    }
    await page.locator('.fill-field[data-field="agree"]').click();
    // The signature, written once in the pad with the app's handwriting (script) and reused.
    await page.getByRole('toolbar', { name: 'Fill and sign' }).getByRole('button', { name: 'Sign' }).click();
    await page.getByRole('button', { name: 'New signature' }).click();
    const pad = (await page.locator('.sig-pad').boundingBox())!;
    const sig = handAt('Maya Okafor', 0, 0, { style: 'script', xHeight: 20, seed: 17, messiness: 0.5 });
    const xs = sig.strokes.flatMap((st) => st.points.map((p) => p.x)), ys = sig.strokes.flatMap((st) => st.points.map((p) => p.y));
    const k = Math.min((pad.width * 0.8) / (Math.max(...xs) - Math.min(...xs)), (pad.height * 0.6) / (Math.max(...ys) - Math.min(...ys)));
    const ox = pad.x + pad.width * 0.1 - Math.min(...xs) * k, oy = pad.y + pad.height * 0.2 - Math.min(...ys) * k;
    for (const st of sig.strokes) {
      await page.mouse.move(ox + st.points[0]!.x * k, oy + st.points[0]!.y * k);
      await page.mouse.down();
      for (const p of st.points.slice(1)) await page.mouse.move(ox + p.x * k, oy + p.y * k);
      await page.mouse.up();
    }
    await page.getByRole('button', { name: 'Save signature' }).click();
    await expect(page.locator('.fill-hint')).toHaveText('Tap where to sign');
    const [sx, sy] = await clientPoint(page, 150, (792 - 300) * (4 / 3) - 14);
    await page.mouse.click(sx, sy);
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
    await view(page, 0.9, -40);
    await shot(page, 'sign-fold', s);
  });
}

// ── Engineers: a sketch that runs, and notes that know the code ─────────────────────────────────

const LATENCY_CSV = 'service,p99_ms\ncheckout,412\nsearch,188\nauth,265\npayments,301\nprofile,120\nfeed,233\n';
const STATUS = 'Checkout, payments and auth are over the 250 ms p99 budget since the 14:05 deploy. Rolling back the checkout cache change; next update in 30 min.';

const typeBox = (page: Page, text: string, x: number, y: number, width = 170) => page.evaluate(({ text, x, y, width }) => {
  const d = (window as any).__inkwright.doc;
  d.upsertText(0, { id: `t${Math.round(x)}${Math.round(y)}`, x, y, width, text, fontSize: 15, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() });
}, { text, x, y, width });

for (const s of ['light', 'dark'] as Scheme[]) {
  test(`engineers: a whiteboard sketch that runs (${s})`, async ({ page }) => {
    await page.route('https://metrics.internal.test/latency.csv', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/csv', 'access-control-allow-origin': '*' }, body: LATENCY_CSV }));
    await scriptedModel(page, [STATUS]);
    await start(page, s);
    await addProvider(page);
    await seed(page, [{ title: 'Checkout latency — incident 2291', notebook: 'Platform team', tags: ['incident'], paper: { style: 'dot_grid', tint: 'white', texture: 'smooth', spacing: 0 }, pages: [{ strokes: [] }], agoMin: 4 }]);
    await openNote(page, 'Checkout latency');
    await view(page, 1, 40);
    // Boxes and arrows drawn with the pen, a little wobbly, the way a whiteboard sketch is.
    const W = 250, H = 58;
    const box = async (x: number, y: number) => {
      const [a, b] = await toScreen(page, x, y), [c, d] = await toScreen(page, x + W, y + H);
      const j = (p: Pt[], i: number): Pt[] => p.map(([px, py], n) => [px + Math.sin(n / 5 + i) * 1.2, py + Math.cos(n / 6 + i) * 1.2]);
      await pen(page, [...j(line([a, b], [c, b + 2]), 1), ...j(line([c, b + 2], [c - 1, d]), 2).slice(1), ...j(line([c - 1, d], [a + 1, d - 1]), 3).slice(1), ...j(line([a + 1, d - 1], [a, b + 3]), 4).slice(1)], { pressure: 0.6 });
    };
    const arrow = async (x0: number, y0: number, x1: number, y1: number) => {
      const [s1, t1] = await toScreen(page, x0, y0), [e1, f1] = await toScreen(page, x1, y1);
      await pen(page, line([s1, t1], [e1, f1]), { pressure: 0.6 });
      const ang = Math.atan2(f1 - t1, e1 - s1), L = 12;
      await pen(page, [[e1 - L * Math.cos(ang - 0.5), f1 - L * Math.sin(ang - 0.5)], [e1, f1], [e1 - L * Math.cos(ang + 0.5), f1 - L * Math.sin(ang + 0.5)]], { pressure: 0.6 });
    };
    const X = 80, Y = [170, 290, 410];
    for (const y of Y) await box(X, y);
    const labels = ['fetch metrics.internal.test/latency.csv', 'filter p99_ms > 250', 'draft a status update for #incidents'];
    for (let i = 0; i < 3; i++) await typeBox(page, labels[i]!, X + 14, Y[i]! + 12, W - 28);
    for (let i = 0; i < 2; i++) await arrow(X + W / 2, Y[i]! + H + 6, X + W / 2 + 2, Y[i + 1]! - 6);
    await page.keyboard.press(`${await modKey(page)}+a`);
    await page.getByRole('toolbar', { name: /selected/ }).getByRole('button', { name: 'Run' }).click();
    const bar = page.getByRole('region', { name: 'Run the diagram' });
    await expect(bar).toContainText('3 steps, 2 arrows');
    await bar.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('group', { name: /Step: draft a status update/ })).toContainText('Rolling back', { timeout: 20_000 });
    await page.keyboard.press('p');
    await shot(page, 'pipeline-laptop', s);
  });
}

const FIXTURES = fileURLToPath(new URL('./fixtures/dev-repo/', import.meta.url));

for (const s of ['light', 'dark'] as Scheme[]) {
  test(`engineers: a note flags the code it describes when it drifts (${s})`, async ({ page }) => {
    await start(page, s);
    const scan = async (file: string, first: boolean) => {
      await page.locator('.nav-item', { hasText: 'Settings' }).click();
      await settingsGroup(page, 'Extend', 'Code & runbooks');
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: first ? 'Import .zip or .tar.gz' : 'Re-scan shop-v1' }).click();
      await (await chooser).setFiles(FIXTURES + file);
      await expect(page.locator('.toast.is-success').last()).toContainText('shop-v1: 6 symbols');
      await page.getByRole('button', { name: 'Back' }).click();
    };
    await scan('shop-v1.zip', true);
    // A design note: handwriting, and a typed line that links the function it describes.
    const title = handAt('Auth sessions — design notes', 134, 112, { style: 'script', xHeight: 14, seed: 91 });
    const n1 = handAt('Every session gets a TTL, no forever logins.', 134, 196, { style: 'script', xHeight: 10, seed: 92 });
    const n2 = handAt('Ask Priya about refresh tokens', 134, 720, { style: 'print', xHeight: 9, seed: 93, color: '#FFB3412F' });
    await seed(page, [{ title: 'Auth sessions — design notes', notebook: 'Platform team', tags: ['design'], paper: { style: 'ruled_narrow', tint: 'ivory', texture: 'standard', spacing: 0 }, pages: [{ strokes: [...title.strokes, ...n1.strokes, ...n2.strokes], recognizedText: 'Auth sessions — design notes\nEvery session gets a TTL, no forever logins.\nAsk Priya about refresh tokens' }], agoMin: 60 * 24 * 9 }]);
    await openNote(page, 'Auth sessions');
    const id = await page.evaluate(() => (window as any).__inkwright.doc.meta.id as string);
    await page.keyboard.press('t');
    const [tx, ty] = await toScreen(page, 134, 262);
    await pointer(page, 'pointerdown', [tx, ty], { type: 'mouse' });
    await pointer(page, 'pointerup', [tx, ty], { type: 'mouse' });
    const ta = page.locator('.text-area');
    await ta.pressSequentially('Sessions start in [[code:createSes');
    await ta.press('Enter');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Back to library' }).click();
    // The code changes underneath: re-scan the newer archive.
    await scan('shop-v2.zip', false);
    await page.goto(`/?e2e#note/${id}`);
    await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
    await fold(page);
    await view(page, 1, 60);
    const chip = page.locator('.dev-code-chip[data-ref="src/auth.ts#createSession"]');
    await expect(chip).toHaveClass(/is-drift/, { timeout: 15_000 });
    await chip.click();
    await expect(page.getByTestId('symbol-card')).toContainText('Signature changed since this note was written');
    await shot(page, 'drift-fold', s);
  });
}

// ── Researchers: a compiled wiki with provenance, and a linter for contradictions ────────────────

for (const s of ['light', 'dark'] as Scheme[]) {
  test(`researchers: compiled wiki, contradictions and Explain (${s})`, async ({ page }) => {
    await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
      const body = route.request().postDataJSON();
      const last = body.messages[body.messages.length - 1];
      let msg: any;
      if (body.tools && last.role === 'user') msg = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_memory', arguments: JSON.stringify({ query: 'response rate' }) } }] };
      else {
        const raw = String(body.messages.filter((m: any) => m.role === 'tool').pop()?.content ?? '');
        const hits = raw ? JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).results ?? [] : [];
        const cite = (t: string) => { const h = hits.find((x: any) => x.title.startsWith(t)); return h ? ` ([${h.title}, p. ${h.page}](${h.link}))` : ''; };
        msg = { role: 'assistant', content: `The methods require a response rate above 40%${cite('Methods')}, but the pilot averages 23%${cite('Results')}. Rural sites answered least, so weighting by region matters most there.` };
      }
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const sse = msg.tool_calls ? chunk({ role: 'assistant', tool_calls: msg.tool_calls.map((t: any, index: number) => ({ index, ...t })) }) + chunk({}, 'tool_calls') : chunk({ content: msg.content }) + chunk({}, 'stop');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: `${sse}data: [DONE]\n\n` });
    });
    await start(page, s);
    await addProvider(page);
    const now = Date.now();
    await seed(page, [...library(now), launchSync(now)]);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: /^Compiled wiki/ }).click();
    await page.getByLabel('Add a notebook').selectOption({ label: 'Thesis' });
    await page.getByRole('radio', { name: 'No AI (quotes)' }).click();
    await page.getByRole('button', { name: 'Compile now' }).click();
    await expect(page.locator('.cp-proposal')).toBeVisible({ timeout: 20_000 });
    await fold(page);
    await page.locator('.cp-proposal').scrollIntoViewIfNeeded();
    await shot(page, 'wiki-fold', s);
    await page.setViewportSize(LAPTOP);
    await page.locator('.cp-proposal').getByRole('button', { name: 'Accept all' }).click();
    await page.goto('/?e2e');
    await openNote(page, 'Methods — sampling');
    await fold(page);
    await view(page, 1, 60);
    const badge = page.getByRole('button', { name: 'This disagrees with another note' });
    await expect(badge).toBeVisible({ timeout: 20_000 });
    await badge.click();
    await expect(page.locator('.cp-badge-pop .cp-conflict')).toContainText('23%');
    await shot(page, 'conflict-fold', s);
    await page.keyboard.press('Escape');
    await page.locator('.ai-btn').click();
    await page.locator('.ai-input textarea').fill('Is our response rate good enough?');
    await page.locator('.ai-input textarea').press('Enter');
    const answer = page.locator('.ai-msg.is-assistant').last();
    await expect(answer).toContainText('weighting by region', { timeout: 20_000 });
    await shot(page, 'ask-cited-fold', s);
    await answer.getByRole('button', { name: 'Explain' }).click();
    const dialog = page.getByRole('dialog', { name: /Explain: Answer/ });
    await dialog.getByRole('button', { name: /response rate above 40%/ }).click();
    await shot(page, 'explain-fold', s);
  });
}

// ── Enterprise: per-notebook policy, dry-run approvals, a signed audit trail ─────────────────────

for (const s of ['light', 'dark'] as Scheme[]) {
  test(`enterprise: policy, approvals and a verifiable audit trail (${s})`, async ({ page }) => {
    await scriptedModel(page, [
      'I will send the summary to ⟦EMAIL_1⟧ once you approve the note.',
      { tool: 'create_note', args: { title: 'Northwind renewal — summary', text: 'Renewal at the current day rate.\nSend the signed SOW by Friday.\nNext review in March.' } },
      'I proposed a summary note; it is waiting for your approval in Activity.',
    ]);
    await start(page, s);
    await addProvider(page);
    const now = Date.now();
    await seed(page, [...library(now), launchSync(now)]);
    await page.waitForFunction(() => !!(window as any).__inkwrightHub);
    await page.evaluate(async () => {
      const v = (window as any).__inkwrightHub.vault.vault;
      for (const name of ['Clients', 'HR', 'Journal']) await v.createNotebook(name, '#FF5F5666');
    });
    await page.reload();
    await page.getByRole('button', { name: 'Settings' }).click();
    await settingsGroup(page, 'Privacy & trust', 'AI privacy');
    await page.getByRole('button', { name: /^Routing & privacy/ }).click();
    const add = page.getByRole('combobox', { name: 'Add a rule for a notebook' });
    await add.selectOption({ label: 'Clients' });
    await add.selectOption({ label: 'HR' });
    await add.selectOption({ label: 'Journal' });
    const journal = page.locator('.trust-rule', { hasText: 'Journal' });
    await journal.getByRole('checkbox', { name: 'Stays on this device' }).click();
    await journal.getByRole('radio', { name: 'Hidden' }).click();
    await expect(journal.getByRole('radio', { name: 'Hidden' })).toHaveAttribute('aria-checked', 'true');
    const hr = page.locator('.trust-rule', { hasText: 'HR' });
    await hr.getByRole('radio', { name: /Read-only|Read only/ }).click().catch(() => {});
    await page.getByRole('radiogroup', { name: 'How the assistant change notes' }).getByRole('radio', { name: 'Propose' }).click();
    await fold(page);
    await page.getByText('Notebooks and tags', { exact: true }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, 'policy-fold', s);
    await page.setViewportSize(LAPTOP);
    await page.goto('/?e2e');
    await openNote(page, 'Beta launch sync');
    await page.locator('.ai-btn').click();
    await page.locator('.ai-input textarea').fill('Email a renewal summary to ana.souza@northwind.example');
    await page.locator('.ai-input textarea').press('Enter');
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('ana.souza@northwind.example');
    await page.locator('.ai-input textarea').fill('Write the renewal summary as a note');
    await page.locator('.ai-input textarea').press('Enter');
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('waiting for your approval');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Back to library' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: /^Activity/ }).click();
    await expect(page.locator('.trust-proposal').first()).toBeVisible();
    await fold(page);
    await shot(page, 'approve-fold', s);
    await page.setViewportSize(LAPTOP);
    await page.goto('/?e2e');
    await page.getByRole('button', { name: 'Settings' }).click();
    await settingsGroup(page, 'Privacy & trust', 'AI privacy');
    await page.getByRole('button', { name: /^Audit trail/ }).click();
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.locator('.trust-verify')).toContainText('The record checks out.');
    await fold(page);
    await shot(page, 'audit-fold', s);
  });
}
