import { expect, test, type Page } from '@playwright/test';
import { line, newNote, openApp, pen, strokes, word, type Pt } from './helpers.ts';

/** Canvas-relative screen point of a page point. */
const toScreen = (page: Page, x: number, y: number, pageIndex = 0) =>
  page.evaluate(({ x, y, pageIndex }) => { const r = (window as any).__inkwright.engine.pageRectToScreen(pageIndex, { minX: x, minY: y, maxX: x, maxY: y }); return [r.x, r.y] as [number, number]; }, { x, y, pageIndex });
const pageOf = (page: Page, i = 0) => page.evaluate((i) => (window as any).__inkwright.doc.page(i), i);
const more = (page: Page) => page.getByRole('button', { name: 'More', exact: true }).click();
const menuItem = (page: Page, name: RegExp | string) => page.getByRole('menuitem', { name }).click();
const flush = (page: Page) => page.keyboard.press('Control+s');

test('selective eraser: long-press the eraser, erase only the highlighter', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await pen(page, word(200, 250, 220));
  await page.getByRole('radio', { name: /^Highlighter/ }).click();
  await pen(page, line([190, 252], [440, 252]));
  expect((await strokes(page)).map((s: { pen: string }) => s.pen)).toEqual(['fountain', 'highlighter']);
  // Press and hold the eraser: choose what it erases.
  const eraser = page.getByRole('button', { name: 'Eraser' });
  await eraser.hover();
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await page.getByRole('radio', { name: /Only highlighter/ }).click();
  await expect(page.locator('.tool-filter-badge')).toBeVisible();
  await pen(page, line([300, 200], [300, 300]));
  expect((await strokes(page)).map((s: { pen: string }) => s.pen)).toEqual(['fountain']);
  // "Only shapes" leaves the handwriting alone too.
  await eraser.hover();
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await page.getByRole('radio', { name: /Only shapes/ }).click();
  await pen(page, line([300, 200], [300, 300]));
  expect(await strokes(page)).toHaveLength(1);
});

test('snapping: a moved selection lands on the page margin with a jade guide; Alt places freely', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await pen(page, word(300, 300, 120));
  // Lasso it.
  await page.keyboard.press('l');
  const loop: Pt[] = [[280, 270], [440, 270], [440, 340], [280, 340], [280, 272]];
  await pen(page, loop.flatMap((p, i) => (i ? line(loop[i - 1]!, p, 10).slice(1) : [p])));
  await expect(page.locator('.sel-bar, .selection-bar').first()).toBeVisible();
  const minX = async () => page.evaluate(() => Math.min(...(window as any).__inkwright.doc.page(0).strokes[0].points.map((p: any) => p.x)));
  const midY = await page.evaluate(() => { const ys = (window as any).__inkwright.doc.page(0).strokes[0].points.map((p: any) => p.y); return (Math.min(...ys) + Math.max(...ys)) / 2; });
  const x0 = await minX();
  // Drag so the left edge comes within ~3 units of the 48-unit margin.
  const [sx, cy] = await toScreen(page, x0 + 20, midY);
  const [tx] = await toScreen(page, 48 + 3 + 20, 0);
  await page.evaluate(({ sx, cy, tx }) => {
    const el = document.querySelector('.ed-canvas') as HTMLElement;
    const r = el.getBoundingClientRect();
    const fire = (type: string, x: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + cy, pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1 }));
    fire('pointerdown', sx);
    for (let i = 1; i <= 12; i++) fire('pointermove', sx + ((tx - sx) * i) / 12);
  }, { sx, cy, tx });
  await expect(page.locator('.ink-guides line')).toHaveCount(1);
  await page.evaluate(({ tx, cy }) => {
    const el = document.querySelector('.ed-canvas') as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, clientX: r.left + tx, clientY: r.top + cy, pressure: 0, buttons: 0 }));
  }, { tx, cy });
  await expect(page.locator('.ink-guides line')).toHaveCount(0);
  // The selection's box (ink plus its nib width) now sits on the margin: the ink's points just inside it.
  const snapped = await minX();
  expect(snapped).toBeGreaterThan(48);
  expect(snapped).toBeLessThan(48 + 3);
  // With Alt held the same kind of drag is not snapped.
  const x1 = await minX();
  const [ax] = await toScreen(page, x1 + 20, 0);
  const [bx] = await toScreen(page, x1 + 20 + 30 - 3, 0); // would be 3 units short of nothing in particular
  await page.evaluate(({ ax, bx, cy }) => {
    const el = document.querySelector('.ed-canvas') as HTMLElement;
    const r = el.getBoundingClientRect();
    const fire = (type: string, x: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + cy, pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1, altKey: true }));
    fire('pointerdown', ax);
    for (let i = 1; i <= 6; i++) fire('pointermove', ax + ((bx - ax) * i) / 6);
    fire('pointerup', bx);
  }, { ax, bx, cy });
  expect(await minX()).toBeCloseTo(x1 + 27, 0);
});

test('sticky notes: add, write and type on one, fold it to an icon and open it again', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await page.getByRole('button', { name: 'More tools' }).click();
  await page.getByRole('button', { name: /Sticky note/ }).click();
  const sticky = async () => (await pageOf(page)).objects?.find((o: any) => o.type === 'sticky');
  const s0 = await sticky();
  expect(s0).toBeTruthy();
  // Pen ink that starts on the sticky goes onto it.
  const [x, y] = await toScreen(page, s0.x + 30, s0.y + 90);
  const [x2] = await toScreen(page, s0.x + 140, 0);
  await pen(page, word(x, y, x2 - x));
  expect((await sticky()).strokes).toHaveLength(1);
  expect(await strokes(page)).toHaveLength(0);
  // Type on it.
  await page.getByRole('button', { name: 'Type on sticky note' }).click();
  await page.getByRole('textbox', { name: 'Sticky note text' }).fill('Buy oat milk');
  await page.getByRole('textbox', { name: 'Sticky note text' }).press('Escape');
  expect((await sticky()).text).toBe('Buy oat milk');
  // Fold away, then open again.
  await page.getByRole('button', { name: 'Fold sticky note away' }).click();
  expect((await sticky()).collapsed).toBe(true);
  await page.getByRole('button', { name: 'Open sticky note' }).click();
  expect((await sticky()).collapsed).toBe(false);
  // Undo goes back through the steps.
  await page.keyboard.press('Control+z');
  expect((await sticky()).collapsed).toBe(true);
});

test('tape covers ink; a tap reveals it, and View › Reveal all tape shows everything', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await pen(page, word(220, 300, 200));
  await page.getByRole('button', { name: 'More tools' }).click();
  await page.getByRole('button', { name: /^Tape/ }).click();
  await page.keyboard.press('Escape');
  await pen(page, line([200, 300], [450, 300], 30));
  const tape = (await pageOf(page)).objects.find((o: any) => o.type === 'tape');
  expect(tape.width).toBeGreaterThan(5);
  const revealed = () => page.evaluate((id) => (window as any).__inkwright.engine.isTapeRevealed(id), tape.id);
  expect(await revealed()).toBe(false);
  // Back to the pen: a tap on the tape reveals it instead of leaving a dot.
  await page.keyboard.press('p');
  await pen(page, [[320, 301], [320, 301]]);
  expect(await revealed()).toBe(true);
  expect(await strokes(page)).toHaveLength(1);
  await pen(page, [[320, 301], [320, 301]]);
  expect(await revealed()).toBe(false);
  await more(page);
  await menuItem(page, /^View/);
  await page.getByText('Reveal all tape').click();
  expect(await revealed()).toBe(true);
});

test('calligraphy pen: broad nib with an adjustable angle, stored on the stroke', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  const active = page.locator('.tray .pen.is-on');
  await active.click(); // tap the active pen again: its settings
  await page.getByRole('radio', { name: /Calligraphy/ }).click();
  const angle = page.getByRole('slider', { name: 'Nib angle' });
  await angle.fill('60');
  await page.keyboard.press('Escape');
  await pen(page, word(200, 300, 200));
  const s = (await pageOf(page)).strokes[0];
  expect(s.pen).toBe('calligraphy');
  expect(s.nib).toBe(60);
});

test('two-page view: pages side by side on a wide screen, ink lands on the right-hand page', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await page.evaluate(() => { (window as any).__inkwright.doc.addPage(1); });
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.engine.spreadsOn)).toBe(true);
  const [rx, ry] = await toScreen(page, 120, 200, 1);
  const [lx] = await toScreen(page, 120, 200, 0);
  expect(rx).toBeGreaterThan(lx + 100);
  await pen(page, word(rx, ry, 100));
  expect(await strokes(page, 1)).toHaveLength(1);
  expect(await strokes(page, 0)).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__inkwright.engine.currentPageIndex)).toBe(1);
  // ••• › View › One page.
  await more(page);
  await menuItem(page, /^View/);
  await page.getByRole('radio', { name: 'One page' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.engine.spreadsOn)).toBe(false);
});

test('layers: write on the drawing layer, hide it, and lock it against the eraser', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await more(page);
  await menuItem(page, /^View/);
  await page.getByRole('radio', { name: /Drawing layer/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.layer-pill')).toHaveText('Drawing layer');
  await pen(page, word(200, 300, 200));
  expect((await pageOf(page)).strokes[0].layer).toBe('drawing');
  // Lock it: the eraser can't touch it (and writing moves to the writing layer).
  await more(page);
  await menuItem(page, /^View/);
  await page.getByRole('button', { name: 'Lock drawing layer' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.layer-pill')).toHaveCount(0);
  await page.keyboard.press('e');
  await pen(page, line([300, 250], [300, 350]));
  expect(await strokes(page)).toHaveLength(1);
  // Hide it.
  await more(page);
  await menuItem(page, /^View/);
  await page.getByRole('button', { name: 'Hide drawing layer' }).click();
  expect((await pageOf(page)).layers).toEqual({ drawing: { hidden: true, locked: true } });
});

test('version history: restore an earlier version, then copy a page back in from history', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await pen(page, word(200, 250, 200));
  await pen(page, word(200, 320, 200));
  await flush(page);
  await more(page);
  await menuItem(page, 'Version history');
  const dialog = page.getByRole('dialog', { name: 'Version history' });
  await expect(dialog.locator('.history-item')).toHaveCount(2); // opened (blank) and now
  await expect(dialog.locator('.history-item.is-on')).toContainText('Opened');
  await expect(dialog.locator('.history-page img')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Restore this version' }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect.poll(async () => (await strokes(page)).length).toBe(0);
  // The state before the restore is a version of its own: copy its page back in.
  await more(page);
  await menuItem(page, 'Version history');
  await dialog.locator('.history-item', { hasText: 'Before restoring' }).click();
  await dialog.getByRole('button', { name: 'Copy page 1 into the note' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.pageCount)).toBe(2);
  expect(await strokes(page, 1)).toHaveLength(2);
  // Restoring is undoable like any edit.
  await dialog.getByRole('button', { name: 'Close' }).click();
});

test('lock a note: encrypted cover in the library, passcode to open, kept out of search and AI', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await page.evaluate(() => {
    const { doc } = (window as any).__inkwright;
    doc.upsertText(0, { id: 'secret-text', x: 80, y: 120, width: 300, text: 'zanzibar treasure map', fontSize: 18, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() });
  });
  await pen(page, word(200, 320, 200));
  await flush(page);
  await more(page);
  await menuItem(page, 'Lock note');
  const dialog = page.getByRole('dialog', { name: 'Lock this note' });
  await dialog.getByLabel('Passcode', { exact: true }).fill('tulip-42');
  await dialog.getByLabel('Repeat passcode').fill('tulip-42');
  await expect(dialog.getByRole('button', { name: 'Lock note' })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Lock note' }).click();
  await expect(page.locator('.toast', { hasText: 'Locked' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.ai-btn')).toHaveCount(0);
  const id = await page.evaluate(() => (window as any).__inkwright.doc.meta.id);
  // Search doesn't find it any more.
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.locator('.note-card .locked-cover')).toHaveCount(1);
  await page.keyboard.press('Control+k');
  await page.locator('.pal-input').fill('zanzibar');
  await expect(page.getByText('Nothing in your notes matches “zanzibar”')).toBeVisible();
  await page.keyboard.press('Escape');
  // Opening asks for the passcode.
  await page.locator('.note-card', { has: page.locator('.locked-cover') }).locator('.note-open').click();
  const gate = page.getByRole('region', { name: 'Locked note' });
  await gate.getByLabel('Passcode').fill('wrong');
  await gate.getByRole('button', { name: 'Open' }).click();
  await expect(gate.getByRole('alert')).toContainText('doesn’t open');
  await gate.getByLabel('Passcode').fill('tulip-42');
  await gate.getByRole('button', { name: 'Open' }).click();
  await page.waitForFunction((id) => (window as any).__inkwright?.doc?.meta.id === id && (window as any).__inkwright.doc.page(0).strokes.length === 1, id, { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).texts[0].text)).toBe('zanzibar treasure map');
  // The files in the vault hold no readable trace of it.
  const leaked = await page.evaluate(async (id) => {
    const dbs = await indexedDB.databases();
    const name = dbs.map((d) => d.name).find((n) => n && n.includes('inkwright-vault'));
    if (!name) return 'no-db';
    return await new Promise<string>((resolve) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => {
        const db = req.result;
        const out: string[] = [];
        const tx = db.transaction([...db.objectStoreNames], 'readonly');
        for (const s of db.objectStoreNames) {
          const cur = tx.objectStore(s).openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            const v = c.value;
            const key = String(c.key);
            if (key.includes(id)) {
              const bytes = v?.bytes ?? v?.data ?? v;
              const text = bytes instanceof Uint8Array || bytes instanceof ArrayBuffer ? new TextDecoder().decode(bytes) : typeof bytes === 'string' ? bytes : JSON.stringify(bytes);
              if (text.includes('zanzibar')) out.push(key);
            }
            c.continue();
          };
        }
        tx.oncomplete = () => resolve(out.join(','));
      };
    });
  }, id);
  expect(leaked).toBe('');
});
