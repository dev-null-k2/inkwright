import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readZip } from '../../../packages/sync/src/zip.ts';
import { modKey, newNote, openApp, pen, pointer, texts, word, noteId, editorMenu, settingsGroup } from './helpers.ts';

const VAULT = fileURLToPath(new URL('./fixtures/obsidian-vault', import.meta.url));

async function rename(page: Page, title: string) {
  await page.locator('.ed-title').click();
  await page.locator('.dialog input').fill(title);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.locator('.ed-title-text')).toHaveText(title);
}

async function noteTitled(page: Page, title: string) {
  await newNote(page);
  await rename(page, title);
}

async function back(page: Page) {
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.locator('.library')).toBeVisible();
}

/** Opens a text box at a spot with the text tool and returns its textarea. */
async function textBox(page: Page, at: [number, number] = [220, 240]) {
  await page.keyboard.press('t');
  await pointer(page, 'pointerdown', at, { type: 'mouse' });
  await pointer(page, 'pointerup', at, { type: 'mouse' });
  const ta = page.locator('.text-area');
  await expect(ta).toBeVisible();
  return ta;
}

test.describe('links', () => {
  test('typing [[ suggests notes; the link opens the note, shows as a backlink and survives a rename', async ({ page }) => {
    await openApp(page);
    await noteTitled(page, 'Biology');
    await back(page);
    await noteTitled(page, 'Lecture');
    const ta = await textBox(page);
    await ta.pressSequentially('Read [[Bio');
    const list = page.locator('.link-suggest');
    await expect(list).toBeVisible();
    await expect(list.locator('.link-suggest-item.is-on')).toContainText('Biology');
    await ta.press('Enter');
    await expect(ta).toHaveValue('Read [[Biology]]');
    await ta.pressSequentially(' tonight');
    await page.getByRole('button', { name: 'Done' }).click();
    expect(await texts(page)).toEqual(['Read [[Biology]] tonight']);

    // The link on the page: a thread under it and an arrow to follow.
    const go = page.getByRole('button', { name: 'Open “Biology”' });
    await expect(go).toBeVisible();
    await go.click();
    await expect(page.locator('.ed-title-text')).toHaveText('Biology');

    // Linked here.
    await editorMenu(page, 'Note', 'Links');
    const panel = page.locator('.links-panel');
    const linkedHere = panel.getByRole('region', { name: 'Linked here' });
    await expect(linkedHere.locator('.link-row', { hasText: 'Lecture' })).toContainText('Read Biology tonight');

    // Renaming rewrites the link in Lecture.
    await rename(page, 'Life science');
    await expect(page.locator('.toast.is-success')).toContainText('Updated links in 1 note');
    await linkedHere.locator('.link-row', { hasText: 'Lecture' }).click();
    await expect(page.locator('.ed-title-text')).toHaveText('Lecture');
    await expect.poll(() => texts(page)).toEqual(['Read [[Life science]] tonight']);
  });

  test('unlinked mentions can be linked in one tap; #tags become tags', async ({ page }) => {
    await openApp(page);
    await noteTitled(page, 'Chemistry');
    await back(page);
    await noteTitled(page, 'Study plan');
    const ta = await textBox(page);
    await ta.fill('Chemistry exam on Friday #exams');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.keyboard.press(`${await modKey(page)}+s`);
    await back(page);
    await expect(page.locator('.nav-item', { hasText: 'exams' })).toBeVisible();
    await page.locator('.note-card', { hasText: 'Chemistry' }).first().locator('.note-open').click();
    await editorMenu(page, 'Note', 'Links');
    const mention = page.locator('.mention-row', { hasText: 'Study plan' });
    await expect(mention).toContainText('Chemistry exam on Friday');
    await mention.getByRole('button', { name: /Link the mention/ }).click();
    await expect(page.locator('.links-panel .link-row', { hasText: 'Study plan' }).first()).toBeVisible();
    await expect(page.locator('.mention-row')).toHaveCount(0);
  });

  test('lassoed handwriting becomes a link you can follow', async ({ page }) => {
    await openApp(page);
    await noteTitled(page, 'Reading list');
    await back(page);
    await newNote(page);
    await page.waitForFunction(() => (window as any).__inkwright?.doc?.meta.title !== 'Reading list' && !!document.querySelector('.ed-canvas'));
    await pen(page, word(200, 220, 140));
    await page.keyboard.press('l');
    await pen(page, [[170, 190], [370, 190], [370, 260], [170, 260], [170, 190]]);
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    const dialog = page.locator('.dialog', { hasText: 'Link to note' });
    await dialog.locator('input').fill('readi');
    await dialog.locator('input').press('Enter');
    await expect.poll(() => page.evaluate(() => ((window as any).__inkwright.doc.page(0).links ?? []).map((l: any) => l.target))).toEqual(['Reading list']);
    const id = await noteId(page);
    await page.getByRole('button', { name: 'Open “Reading list”' }).click();
    await expect(page.locator('.ed-title-text')).toHaveText('Reading list');
    await editorMenu(page, 'Note', 'Links');
    await expect(page.locator('.links-panel .link-row')).toContainText('linked ink');
    await page.locator('.links-panel .link-row').click();
    await expect.poll(() => noteId(page)).toBe(id);
  });
});

test.describe('daily notes and templates', () => {
  test('Today opens the same dated note in the Journal', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /^Today/ }).click();
    const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    await expect(page.locator('.ed-title-text')).toHaveText(today);
    const first = await noteId(page);
    expect(await page.evaluate(() => (window as any).__inkwright.doc.meta.daily)).toBe(today);
    await back(page);
    await expect(page.locator('.nav-item', { hasText: 'Journal' })).toBeVisible();
    await page.keyboard.press('Alt+d');
    await expect(page.locator('.ed-title-text')).toHaveText(today);
    expect(await noteId(page)).toBe(first);
  });

  test('a note saved as a template starts new notes', async ({ page }) => {
    await openApp(page);
    await noteTitled(page, 'Meeting');
    const ta = await textBox(page);
    await ta.fill('# {{title}}\nAttendees:');
    await page.getByRole('button', { name: 'Done' }).click();
    await editorMenu(page, 'Note', 'Save as template');
    await page.locator('.dialog input').fill('Meeting notes');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('Saved “Meeting notes”');
    await back(page);
    await page.getByRole('button', { name: 'More ways to create' }).click();
    await page.locator('.template-chip', { hasText: 'Meeting notes' }).click();
    await expect(page.locator('.ed-title-text')).toContainText('Meeting notes');
    const title = await page.locator('.ed-title-text').textContent();
    await expect.poll(() => texts(page)).toEqual([`# ${title}\nAttendees:`]);
  });
});

test.describe('graph', () => {
  test('renders the notes in 3D, filters and switches to 2D', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'New notebook' }).click();
    await page.locator('.dialog input').fill('Science');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('.new-btn').click();
    await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
    await rename(page, 'Atoms');
    const ta = await textBox(page);
    await ta.fill('See [[Welcome to Inkwright]] #physics');
    await page.getByRole('button', { name: 'Done' }).click();
    await back(page);
    await page.getByRole('button', { name: 'All notes' }).click();

    await page.getByRole('button', { name: 'Graph' }).click();
    await page.waitForFunction(() => (window as any).__inkwrightGraph?.frames() > 3, null, { timeout: 20000 });
    const info = await page.evaluate(() => { const g = (window as any).__inkwrightGraph; return { renderer: g.renderer, nodes: g.nodes, edges: g.edges }; });
    // 3D needs WebGL; without it (some headless browsers) the graph falls back to 2D by design.
    const webgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2') || !!document.createElement('canvas').getContext('webgl'));
    expect(info.renderer).toBe(webgl ? '3d' : '2d');
    const notes = info.nodes.filter((n: any) => n.kind === 'note').map((n: any) => n.label).sort();
    expect(notes).toEqual(['Atoms', 'Welcome to Inkwright']);
    expect(info.nodes.some((n: any) => n.kind === 'tag' && n.label === '#physics')).toBe(true);
    expect(info.nodes.some((n: any) => n.kind === 'notebook' && n.label === 'Science')).toBe(true);
    expect(info.edges).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.graph-count')).toContainText('2 notes · 1 link');

    // The WebGL canvas really drew something (not just the desk colour).
    const varied = await page.evaluate(() => {
      const c = document.querySelector('.graph-canvas') as HTMLCanvasElement;
      const t = document.createElement('canvas');
      t.width = 64; t.height = 64;
      const g = t.getContext('2d')!;
      g.drawImage(c, 0, 0, 64, 64);
      const d = g.getImageData(0, 0, 64, 64).data;
      const seen = new Set<string>();
      for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]! >> 3},${d[i + 1]! >> 3},${d[i + 2]! >> 3}`);
      return seen.size;
    });
    expect(varied).toBeGreaterThan(3);

    // Hover shows the title; selecting puts the card up with an Open button.
    await page.evaluate(() => (window as any).__inkwrightGraph.select((window as any).__inkwrightGraph.nodes.find((n: any) => n.label === 'Atoms').id));
    await expect(page.locator('.graph-card h2')).toHaveText('Atoms');
    await expect(page.locator('.graph-card')).toContainText('1 out');

    // Filter by notebook: only the Science note (and its notebook) remain.
    await page.getByRole('combobox', { name: 'Notebook' }).selectOption({ label: 'Science' });
    await expect.poll(() => page.evaluate(() => (window as any).__inkwrightGraph.nodes.filter((n: any) => n.kind === 'note').map((n: any) => n.label))).toEqual(['Atoms']);
    await page.getByRole('combobox', { name: 'Notebook' }).selectOption({ label: 'All notebooks' });

    // Time slider back to the start hides later notes.
    await page.getByRole('slider', { name: 'Show notes created until' }).fill('0');
    await expect.poll(() => page.evaluate(() => (window as any).__inkwrightGraph.nodes.filter((n: any) => n.kind === 'note' && n.visible).length)).toBe(1);
    await page.getByRole('slider', { name: 'Show notes created until' }).fill('1000');

    // Flat view.
    await page.getByRole('radio', { name: '2D' }).click();
    await page.waitForFunction(() => (window as any).__inkwrightGraph?.renderer === '2d' && (window as any).__inkwrightGraph.frames() > 0);
    await page.getByRole('button', { name: 'Back to library' }).click();
    await expect(page.locator('.library')).toBeVisible();
  });
});

test.describe('Obsidian', () => {
  test('exports an Obsidian vault zip with Markdown, properties, links and page pictures', async ({ page }) => {
    await openApp(page);
    await noteTitled(page, 'Plans');
    const ta = await textBox(page);
    await ta.fill('Next: [[Welcome to Inkwright]] #todo');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.keyboard.press('p');
    await pen(page, word(200, 400, 120));
    await back(page);
    await page.locator('.nav-item', { hasText: 'Settings' }).click();
    await settingsGroup(page, 'Knowledge');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export as .zip' }).click();
    const d = await download;
    expect(d.suggestedFilename()).toMatch(/^Inkwright for Obsidian .*\.zip$/);
    const entries = await readZip(new Uint8Array(readFileSync((await d.path())!)));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('Inkwright/Plans.md');
    expect(paths).toContain('Inkwright/Welcome to Inkwright.md');
    expect(paths).toContain('Inkwright/attachments/Plans - page 1.png');
    const md = new TextDecoder().decode(entries.find((e) => e.path === 'Inkwright/Plans.md')!.bytes);
    expect(md).toMatch(/^---\ntags:\n {2}- todo\ncreated: \d{4}-/);
    expect(md).toContain('inkwright-id: ');
    expect(md).toContain('Next: [[Welcome to Inkwright]] #todo');
    expect(md).toContain('![[Plans - page 1.png]]');
    const png = entries.find((e) => e.path === 'Inkwright/attachments/Plans - page 1.png')!.bytes;
    expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  });

  test('imports a Markdown vault folder: notebooks, tags, links and images', async ({ page }) => {
    await openApp(page);
    await page.locator('.nav-item', { hasText: 'Settings' }).click();
    await settingsGroup(page, 'Knowledge');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import a vault folder' }).click();
    await (await chooser).setFiles(VAULT);
    await expect(page.locator('.toast.is-success')).toContainText('Imported 3 notes into 1 new notebook');
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('.nav-item', { hasText: 'Projects' })).toBeVisible();
    await expect(page.locator('.nav-item', { hasText: 'idea' })).toBeVisible();
    await page.locator('.nav-item', { hasText: 'Projects' }).click();
    await expect(page.locator('.note-card')).toHaveCount(2);
    await page.locator('.note-card', { hasText: 'Roadmap' }).locator('.note-open').click();
    // The editor is its own chunk: wait for it before reading the document through the test hook.
    await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
    await expect.poll(() => texts(page)).toEqual(['# Roadmap\n\n- Ship the [[Spec]]\n- Review [[Inbox]]']);
    expect(await page.evaluate(() => (window as any).__inkwright.doc.meta.tags)).toEqual(['plan', 'q4']);
    await page.getByRole('button', { name: 'Open “Inbox”' }).click();
    await expect(page.locator('.ed-title-text')).toHaveText('Inbox');
    // The title shows before the note's document is loaded; wait for the document itself.
    await page.waitForFunction(() => (window as any).__inkwright?.doc?.meta.title === 'Inbox');
    expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).images.length)).toBe(1);
    expect((await texts(page)).join('\n')).toContain('See also [[Spec|the spec]].');
  });
});
