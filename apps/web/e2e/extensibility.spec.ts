import { expect, test, type Page } from '@playwright/test';
import { newNote, openApp } from './helpers.ts';

/**
 * The platform: modules (Settings › Modules), sandboxed plugins (install, permissions, panels,
 * commands, exporters, network through the host, isolation, revocation, uninstall), links from
 * other apps, the window.inkwright automation API and API keys.
 */

const SLOW = { timeout: 15_000 };

async function settings(page: Page, section: string) {
  await page.goto(`/?e2e#settings/${section}`);
  await expect(page.locator('.settings')).toBeVisible();
  await page.locator('.set-nav .nav-item', { hasText: section === 'modules' ? 'Modules' : section === 'plugins' ? 'Plugins' : 'Developer' }).click();
}

/** Puts typed text on the open note's first page (one undo step, like typing). */
async function typeText(page: Page, text: string) {
  await page.evaluate((text) => {
    const { doc } = (window as any).__inkwright;
    doc.upsertText(0, { id: `t${Date.now()}`, x: 80, y: 120, width: 500, text, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() }, 'Text');
  }, text);
}

async function moduleSwitch(page: Page, name: string) {
  return page.locator('.mod-row').filter({ has: page.getByText(name, { exact: true }) }).getByRole('switch');
}

async function installFromCatalog(page: Page, name: string) {
  await page.locator('.plg-cat', { hasText: name }).getByRole('button', { name: 'Install' }).click();
  const dialog = page.getByRole('dialog', { name: `Install ${name}?` });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('modules switch features off and back, with dependencies and presets', async ({ page }) => {
  await openApp(page);
  await settings(page, 'modules');
  // Links & daily notes is needed by Graph: turning it off asks first.
  await (await moduleSwitch(page, 'Links & daily notes')).click({ force: true });
  const confirm = page.getByRole('dialog', { name: 'Turn off Links & daily notes?' });
  await expect(confirm).toContainText('Graph');
  await confirm.getByRole('button', { name: 'Turn off' }).click();
  await expect(await moduleSwitch(page, 'Graph')).not.toBeChecked();
  await expect(page.locator('.set-nav')).not.toContainText('Notes, links & Obsidian');
  // Turning Graph back on brings what it needs.
  await (await moduleSwitch(page, 'Graph')).click({ force: true });
  await expect(await moduleSwitch(page, 'Links & daily notes')).toBeChecked();

  // Minimal preset: the editor keeps paper and pen only.
  await page.getByRole('radio', { name: /Minimal/ }).click();
  await expect(await moduleSwitch(page, 'Assistant & routines')).not.toBeChecked();
  await openApp(page);
  await newNote(page);
  await expect(page.locator('.ai-btn')).toHaveCount(0);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toContainText('Paper');
  await expect(menu).not.toContainText('Authorship');
  await expect(menu).not.toContainText('Transcript');
  await expect(menu).not.toContainText('Search everything');
  await page.keyboard.press('Escape');

  // Developer preset: everything is back (and survives a reload).
  await settings(page, 'modules');
  await page.getByRole('radio', { name: /Developer/ }).click();
  await page.reload();
  await expect(page.locator('.set-nav')).toContainText('Developer');
  await openApp(page);
  await newNote(page);
  await expect(page.locator('.ai-btn')).toBeVisible();
});

test('a plugin from the curated list: permission prompt, panel, command, exporter, revoke and uninstall', async ({ page }) => {
  await openApp(page);
  await settings(page, 'plugins');
  const prompt = await installFromCatalog(page, 'Word count & reading time');
  await expect(prompt).toContainText('Read your notes');
  await expect(prompt).toContainText('Give the assistant new tools');
  await expect(prompt).toContainText('Panels: Word count');
  await prompt.getByRole('button', { name: 'Install' }).click();
  await expect(page.locator('.plg-card', { hasText: 'Word count & reading time' })).toBeVisible();
  // It lives in the vault, so it syncs.
  const cfg = await page.evaluate(async () => {
    const fs = (window as any).__inkwrightHub?.vault?.fs;
    return fs ? JSON.parse(await fs.readText('plugins/plugins.json')) : null;
  });
  if (cfg) expect(cfg.plugins[0]).toMatchObject({ id: 'app.inkwright.examples.word-count', enabled: true });

  await openApp(page);
  await newNote(page);
  await typeText(page, 'The quick brown fox jumps over the lazy dog');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /Plugins/ }).click();
  await page.getByRole('menuitem', { name: /^Word count/ }).click();
  const frame = page.frameLocator('.plg-panel iframe');
  await expect(frame.locator('[data-k="words"]')).toHaveText('9', SLOW);
  // Live: the panel hears the note change.
  await typeText(page, 'two more');
  await expect(frame.locator('[data-k="words"]')).toHaveText('11', SLOW);

  // The command, from the search palette.
  await page.keyboard.press('Control+k');
  await page.locator('.pal-input').fill('count words');
  await page.getByText('Count words in this note').click();
  await expect(page.locator('.toasts')).toContainText('11 words', SLOW);

  // The exporter.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export and share' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Plain text/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.txt$/);

  // Revoking a permission takes effect at once.
  await settings(page, 'plugins');
  const card = page.locator('.plg-card', { hasText: 'Word count & reading time' });
  await card.getByRole('button', { name: 'Details' }).click();
  await card.locator('.plg-perm', { hasText: 'Read your notes' }).getByRole('switch').click({ force: true });
  await openApp(page);
  await page.locator('.note-card').first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await page.keyboard.press('Control+k');
  await page.locator('.pal-input').fill('count words');
  await page.getByText('Count words in this note').click();
  await expect(page.locator('.toasts')).toContainText('does not have the “notes:read” permission', SLOW);

  // Uninstall removes it and its files.
  await settings(page, 'plugins');
  await page.locator('.plg-card', { hasText: 'Word count' }).getByRole('button', { name: 'Details' }).click();
  await page.getByRole('button', { name: 'Uninstall' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall' }).click();
  await expect(page.locator('.plg-card')).toHaveCount(0);
});

test('plugins are sandboxed: no network, no app access; the webhook plugin posts through the host', async ({ page }) => {
  // A plugin served from a URL that probes its sandbox.
  const probe = `export default { activate(inkwright) {
    inkwright.commands.register('probe', async () => {
      const out = [];
      try { await fetch('https://example.com/'); out.push('fetch allowed'); } catch { out.push('fetch blocked'); }
      try { void window.parent.document.title; out.push('parent allowed'); } catch { out.push('parent blocked'); }
      try { localStorage.setItem('x', '1'); out.push('storage allowed'); } catch { out.push('storage blocked'); }
      try { await inkwright.notes.list(); out.push('notes allowed'); } catch (e) { out.push(e.code); }
      await inkwright.ui.toast(out.join(', '));
    });
    inkwright.importers.register('rows', ({ text }) => text.trim().split('\\n').map((line) => ({ title: line, text: 'Imported row' })));
  } };`;
  const manifest = { id: 'test.probe', name: 'Probe', version: '1.0.0', author: 'Tests', description: 'Checks the sandbox.', minAppVersion: '1.0.0', permissions: [], contributes: { commands: [{ id: 'probe', title: 'Probe the sandbox' }], importers: [{ id: 'rows', title: 'Rows as notes', extensions: ['csv'] }] } };
  await page.route('https://plugins.test/probe/**', (r) => {
    const name = new URL(r.request().url()).pathname.split('/').pop();
    if (name === 'manifest.json') return r.fulfill({ contentType: 'application/json', body: JSON.stringify(manifest), headers: { 'access-control-allow-origin': '*' } });
    if (name === 'main.js') return r.fulfill({ contentType: 'text/javascript', body: probe, headers: { 'access-control-allow-origin': '*' } });
    return r.fulfill({ status: 404, body: '' });
  });
  const hook: { body?: string; headers?: Record<string, string> } = {};
  await page.route('https://hooks.test/**', async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    hook.body = r.request().postData() ?? '';
    hook.headers = r.request().headers();
    return r.fulfill({ status: 200, body: 'ok', headers: { 'access-control-allow-origin': '*' } });
  });

  await openApp(page);
  await settings(page, 'plugins');
  await page.getByLabel('Link to a plugin (its manifest.json, folder or .zip)').fill('https://plugins.test/probe/');
  await page.locator('form.plg-url').getByRole('button', { name: 'Install' }).click();
  const prompt = page.getByRole('dialog', { name: 'Install Probe?' });
  await expect(prompt).toContainText('asks for no permissions');
  await prompt.getByRole('button', { name: 'Install' }).click();

  const webhook = await installFromCatalog(page, 'Send selection to a webhook');
  await expect(webhook).toContainText('Connect to the internet');
  await webhook.getByRole('button', { name: 'Install' }).click();
  const card = page.locator('.plg-card', { hasText: 'Send selection to a webhook' });
  await card.getByRole('button', { name: 'Details' }).click();
  await card.locator('input[name="url"]').fill('https://hooks.test/in');
  await card.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('.toasts')).toContainText('Plugin settings saved');

  await openApp(page);
  await newNote(page);
  await page.keyboard.press('Control+k');
  await page.locator('.pal-input').fill('probe');
  await page.getByText('Probe the sandbox').click();
  await expect(page.locator('.toasts')).toContainText('fetch blocked, parent blocked, storage blocked, permission_denied', SLOW);

  // A plugin importer: each row of a CSV file becomes a note.
  await page.keyboard.press('Control+k');
  await page.locator('.pal-input').fill('rows as notes');
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('Import: Rows as notes').click();
  await (await chooser).setFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: Buffer.from('Alpha\nBeta\n') });
  await expect(page.locator('.toasts')).toContainText('imported 2 notes', SLOW);
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.meta.title === 'Alpha', null, SLOW);

  await openApp(page);
  await newNote(page);
  await typeText(page, 'Ship the beta on Friday');
  await page.evaluate(() => (window as any).__inkwright.engine.selectAll?.());
  await page.keyboard.press('Control+k');
  await page.locator('.pal-input').fill('webhook');
  await page.getByText('Send selection to webhook').click();
  await expect(page.locator('.toasts')).toContainText('Sent to hooks.test', SLOW);
  expect(JSON.parse(hook.body!)).toMatchObject({ text: 'Ship the beta on Friday', title: expect.any(String) });
  expect(hook.headers!.cookie).toBeUndefined();
});

test('links from other apps create, open and search notes', async ({ page }) => {
  await openApp(page);
  await page.goto('/?e2e&action=new&title=From%20a%20link&text=Hello%20from%20Shortcuts&tags=inbox');
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.meta.title === 'From a link', null, SLOW);
  const note = await page.evaluate(() => { const d = (window as any).__inkwright.doc; return { id: d.meta.id, tags: d.meta.tags, text: d.page(0).texts?.[0]?.text, origin: d.page(0).texts?.[0]?.origin }; });
  expect(note).toMatchObject({ tags: ['inbox'], text: 'Hello from Shortcuts', origin: 'import' });
  expect(new URL(page.url()).searchParams.get('action')).toBeNull();

  await page.goto(`/?e2e&link=${encodeURIComponent('web+inkwright://search?q=shortcuts')}`);
  await expect(page.locator('.pal-input')).toHaveValue('shortcuts', SLOW);

  await page.goto(`/?e2e&action=open&note=${note.id}`);
  await page.waitForFunction((id) => (window as any).__inkwright?.doc?.meta.id === id, note.id, SLOW);

  await page.goto('/?e2e&action=capture&url=https%3A%2F%2Fexample.com%2Fpost&title=A%20post&text=worth%20reading');
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.meta.title === 'A post', null, SLOW);
  expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).texts[0].text)).toBe('[A post](https://example.com/post)\n\n> worth reading');
});

test('Settings › Developer: window.inkwright with its own permissions, and API keys', async ({ page }) => {
  await openApp(page);
  expect(await page.evaluate(() => 'inkwright' in window)).toBe(false);
  await settings(page, 'modules');
  await (await moduleSwitch(page, 'Developer tools')).click({ force: true });
  await page.locator('.set-nav .nav-item', { hasText: 'Developer' }).click();

  await page.getByText('Turn on window.inkwright').click();
  await page.waitForFunction(() => !!(window as any).inkwright);
  const titles = await page.evaluate(async () => (await (window as any).inkwright.notes.list()).map((n: any) => n.title));
  expect(titles.length).toBeGreaterThan(0);
  const denied = await page.evaluate(async () => { try { await (window as any).inkwright.notes.create({ title: 'x' }); return 'created'; } catch (e) { return (e as any).code; } });
  expect(denied).toBe('permission_denied');
  await page.locator('.row-switch', { hasText: 'Create and change notes' }).click();
  const created = await page.evaluate(async () => (await (window as any).inkwright.notes.create({ title: 'From the console', text: 'hi' })).title);
  expect(created).toBe('From the console');

  // API keys: shown once, stored hashed, revocable.
  await page.getByLabel('New key for').fill('Shortcuts');
  await page.getByRole('button', { name: 'Create key' }).click();
  const key = await page.getByTestId('new-api-key').textContent();
  expect(key).toMatch(/^ink_[0-9a-z]{10}_[A-Za-z0-9_-]{43}$/);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.dev-key', { hasText: 'Shortcuts' })).toContainText('notes:read');
  await expect(page.locator('.dev-key', { hasText: 'Shortcuts' })).not.toContainText(key!.slice(15));
  await page.locator('.dev-key', { hasText: 'Shortcuts' }).getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.locator('.dev-key', { hasText: 'Shortcuts' })).toContainText('revoked');

  await page.getByText('Turn on window.inkwright').click();
  await page.waitForFunction(() => !(window as any).inkwright);
});
