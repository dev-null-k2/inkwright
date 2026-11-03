import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers.ts';

/**
 * Importers and the web clipper (docs/IMPORTERS.md): an Evernote export through Settings ›
 * Import & clip, a clip arriving in the URL fragment (asked first, saved as typed text), the
 * bookmarklet's in-page extraction, and the modules switched off.
 */

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const clipFragment = (c: Record<string, unknown>) => `clip=${b64url(JSON.stringify(c))}`;

const ENEX = `<?xml version="1.0" encoding="UTF-8"?>
<en-export application="Evernote" version="10">
  <note><title>Recipe ideas</title><created>20250102T030405Z</created><tag>food</tag>
    <content><![CDATA[<en-note><div>Try <b>miso</b> glaze</div><div><en-todo checked="true"/>buy miso</div></en-note>]]></content></note>
  <note><title>Packing list</title><content><![CDATA[<en-note><ul><li>passport</li><li>charger</li></ul></en-note>]]></content></note>
</en-export>`;

async function openImportSettings(page: Page) {
  await page.goto('/?e2e#settings/import');
  await expect(page.getByRole('heading', { name: 'Evernote' })).toBeVisible();
}

test.describe('importers', () => {
  test('imports an Evernote export from Settings › Import & clip', async ({ page }) => {
    await openApp(page);
    await openImportSettings(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import from Evernote' }).click();
    await (await chooser).setFiles({ name: 'Kitchen.enex', mimeType: 'application/xml', buffer: Buffer.from(ENEX) });
    await expect(page.getByText(/Imported 2 notes from Evernote/)).toBeVisible();
    await page.goto('/?e2e');
    await expect(page.locator('.library')).toContainText('Recipe ideas');
    await expect(page.locator('.library')).toContainText('Packing list');
  });

  test('a clip in the URL fragment is shown first, then saved as a note that says where it came from', async ({ page }) => {
    const clip = { v: 1, title: 'How tea is made', url: 'https://example.com/tea?x=1', text: '# Leaves\n\nWithered, rolled and dried.', site: 'Example', savedAt: Date.UTC(2026, 10, 2) };
    await page.goto(`/?e2e#${clipFragment(clip)}`);
    const dialog = page.getByRole('dialog', { name: 'Save “How tea is made” as a note?' });
    await expect(dialog).toContainText('From example.com');
    await expect(dialog).toContainText('Withered, rolled and dried.');
    // The clip left the address bar before anything else happened.
    expect(new URL(page.url()).hash).not.toContain('clip=');
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.waitForFunction(() => !!(window as any).__inkwright?.doc);
    const saved = await page.evaluate(() => {
      const { doc } = (window as any).__inkwright;
      return { title: doc.meta.title, tags: doc.meta.tags, texts: doc.page(0).texts.map((t: any) => ({ text: t.text, origin: t.origin })) };
    });
    expect(saved.title).toBe('How tea is made');
    expect(saved.tags).toContain('clipped');
    expect(saved.texts[0].text).toMatch(/^> Clipped from \[Example\]\(https:\/\/example\.com\/tea\?x=1\) on 2026-11-02/);
    expect(saved.texts[0].text).toContain('Withered, rolled and dried.');
    expect(saved.texts.every((t: any) => t.origin === 'import')).toBe(true);
  });

  test('a damaged or non-web clip is refused, and declining saves nothing', async ({ page }) => {
    await page.goto(`/?e2e#${clipFragment({ v: 1, title: 'x', url: 'javascript:alert(1)', text: 'x', savedAt: 1 })}`);
    await expect(page.getByText('Only web pages (http and https) can be clipped.')).toBeVisible();
    await page.goto(`/?e2e#${clipFragment({ v: 1, title: 'Not today', url: 'https://example.com/', text: 'nope', savedAt: 1 })}`);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.library')).not.toContainText('Not today');
  });

  test('the bookmarklet extracts readable text in the page and opens the app with it', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'one engine is enough for the extraction itself');
    await openApp(page);
    await openImportSettings(page);
    const href = await page.getByTestId('clip-bookmarklet').getAttribute('href');
    expect(href).toMatch(/^javascript:/);
    const code = decodeURIComponent(href!.slice('javascript:'.length));
    // A page to clip: navigation and a sidebar around an article.
    await page.setContent(`<html><head><title>Field notes</title><meta name="author" content="Ana"><meta property="og:site_name" content="Notes Daily"></head><body>
      <nav><a href="/">Home</a> <a href="/about">About</a></nav>
      <article><h1>Field notes</h1><p>The river rose two metres overnight.</p><ul><li>Moved the boats</li><li>Checked the levee</li></ul><pre>level: 4.2 m</pre></article>
      <aside>Subscribe to our newsletter</aside><script>var tracking = 1;</script></body></html>`);
    const opened = await page.evaluate((src) => {
      let url = '';
      (window as any).open = (u: string) => { url = u; return null; };
      // eslint-disable-next-line no-new-func
      new Function(src)();
      return url;
    }, code);
    const frag = opened.split('#')[1]!;
    expect(frag.startsWith('clip=')).toBe(true);
    const clip = JSON.parse(Buffer.from(frag.slice(5), 'base64url').toString('utf8'));
    expect(clip).toMatchObject({ v: 1, title: 'Field notes', byline: 'Ana', site: 'Notes Daily' });
    expect(clip.text).toContain('# Field notes');
    expect(clip.text).toContain('The river rose two metres overnight.');
    expect(clip.text).toContain('- Moved the boats');
    expect(clip.text).toContain('level: 4.2 m');
    expect(clip.text).not.toMatch(/Subscribe|Home|tracking/);
  });

  test('switched off: no importers, and a clip is not taken', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('inkwright.modules.v1', JSON.stringify({ enabled: { 'import-notion': false, 'import-evernote': false, 'import-onenote': false, 'import-pdf-notebooks': false, 'web-clipper': false } })));
    await page.goto(`/?e2e#${clipFragment({ v: 1, title: 'Ignored', url: 'https://example.com/', text: 'x', savedAt: 1 })}`);
    await expect(page.locator('.library')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goto('/?e2e#settings/import');
    await expect(page.getByText('All importers are switched off.')).toBeVisible();
  });
});
