import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { isEngineNoise, modKey, newNote, openApp, pointer } from './helpers.ts';

/**
 * The developer module ("notes that know your code"): a repository archive scanned in the page,
 * a [[code:…]] link with autocomplete and its symbol card, drift after a re-scan with a changed
 * signature (and "Mark reviewed"), a runbook ```http block against a routed endpoint, and a
 * verified diagram that refuses bad IR and renders good IR on the page.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/dev-repo/', import.meta.url));

async function openDeveloperSettings(page: Page) {
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Code & runbooks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Code-aware notes' })).toBeVisible();
}

async function importZip(page: Page, file: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import .zip or .tar.gz' }).click();
  await (await chooser).setFiles(FIXTURES + file);
  await expect(page.locator('.toast.is-success')).toContainText('shop-v1: 6 symbols in 3 files');
}

async function textBox(page: Page, at: [number, number] = [220, 240]) {
  await page.keyboard.press('t');
  await pointer(page, 'pointerdown', at, { type: 'mouse' });
  await pointer(page, 'pointerup', at, { type: 'mouse' });
  const ta = page.locator('.text-area');
  await expect(ta).toBeVisible();
  return ta;
}

const codeRefs = (page: Page) => page.evaluate(() => (window as any).__inkwright.doc.meta.codeRefs ?? null);

test.describe('developer module', () => {
  test('scans a repository zip, links code with autocomplete, and flags drift after a re-scan', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' && !isEngineNoise(m.text())) errors.push(m.text()); });
    await openApp(page);
    await openDeveloperSettings(page);
    await importZip(page, 'shop-v1.zip');
    const row = page.locator('.dev-source-row', { hasText: 'shop-v1' });
    await expect(row).toContainText('Zip archive · 6 symbols · 3 files');
    await page.getByRole('button', { name: 'Back' }).click();

    // A note that links a function, picked from [[code: autocomplete.
    await newNote(page);
    const ta = await textBox(page);
    await ta.pressSequentially('Sessions start in [[code:createSes');
    const list = page.locator('.link-suggest');
    await expect(list.locator('.link-suggest-item.is-on')).toContainText('createSession');
    await ta.press('Enter');
    await expect(ta).toHaveValue('Sessions start in [[code:src/auth.ts#createSession]]');
    await page.getByRole('button', { name: 'Done' }).click();

    // The link reads as the symbol; its code mark is quiet, and the baseline is recorded.
    const chip = page.locator('.dev-code-chip[data-ref="src/auth.ts#createSession"]');
    await expect(chip).toBeVisible();
    await expect(chip).not.toHaveClass(/is-drift/);
    await expect.poll(() => codeRefs(page)).toMatchObject({ 'src/auth.ts#createSession': { signature: 'function createSession(userId: string, ttlMs: number): string', sourceId: 'shop-v1' } });

    // Hover shows the symbol, read-only, with its source.
    await chip.hover();
    const card = page.getByTestId('symbol-card');
    await expect(card).toContainText('Matches the code');
    await expect(card.locator('.dev-source')).toContainText('return hashToken(userId) + ttlMs;');
    await page.mouse.move(5, 5);

    // Following the link opens the code, never a new note called "code:…".
    await page.getByRole('button', { name: 'Open “createSession”' }).click();
    await expect(page.getByRole('dialog', { name: 'Code' }).getByTestId('symbol-card')).toContainText('src/auth.ts:2');
    await page.keyboard.press('Escape');
    const id = await page.evaluate(() => (window as any).__inkwright.doc.meta.id as string);

    // The code changes: re-scan from the newer archive.
    await page.getByRole('button', { name: 'Back to library' }).click();
    await openDeveloperSettings(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Re-scan shop-v1' }).click();
    await (await chooser).setFiles(FIXTURES + 'shop-v2.zip');
    await expect(page.locator('.toast.is-success').last()).toContainText('shop-v1: 6 symbols');

    // The vault-wide drift list has it.
    await page.getByRole('button', { name: 'Code drift' }).click();
    const drift = page.getByRole('dialog', { name: 'Code drift' });
    await expect(drift.locator('.dev-drift-row')).toHaveCount(1);
    await expect(drift.locator('.dev-drift-row')).toContainText('Changed');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Back' }).click();

    // On the page: the mark turns amber with a word; old vs new side by side; never auto-edited.
    await page.goto(`/?e2e#note/${id}`);
    await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
    await expect(chip).toHaveClass(/is-drift/);
    await expect(chip).toContainText('Changed');
    await chip.click();
    await expect(card).toContainText('Signature changed since this note was written');
    await expect(card.locator('.dev-sig.is-old')).toHaveText('function createSession(userId: string, ttlMs: number): string');
    await expect(card.locator('.dev-sig.is-new')).toHaveText('function createSession(userId: string, ttlMs: number, scope: string[]): string');
    expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).texts[0].text)).toBe('Sessions start in [[code:src/auth.ts#createSession]]');
    await card.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(chip).not.toHaveClass(/is-drift/);
    await expect.poll(() => codeRefs(page)).toMatchObject({ 'src/auth.ts#createSession': { signature: 'function createSession(userId: string, ttlMs: number, scope: string[]): string', reviewedAt: expect.any(Number) } });
    expect(errors).toEqual([]);
  });

  test('runs a runbook http block after approval and logs it in Activity', async ({ page }) => {
    let calls = 0;
    await page.route('https://status.example.test/**', (route) => {
      calls++;
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-region', 'x-region': 'eu-west' }, body: JSON.stringify({ status: 'ok', db: 'up' }) });
    });
    await openApp(page);
    await newNote(page);
    const ta = await textBox(page);
    await ta.fill('Health check\n```http\nGET https://status.example.test/health\nAccept: application/json\n```');
    await page.getByRole('button', { name: 'Done' }).click();

    const run = page.getByRole('button', { name: 'Run http block' });
    await expect(run).toBeVisible();
    // Declining sends nothing.
    await run.click();
    await expect(page.getByRole('dialog', { name: 'Send GET to status.example.test?' })).toContainText('GET https://status.example.test/health');
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(calls).toBe(0);

    await run.click();
    await page.getByRole('button', { name: 'Send request' }).click();
    const out = page.getByRole('region', { name: 'Run result' });
    await expect(out.locator('.dev-status')).toHaveText('200 OK');
    await expect(out.locator('.dev-body')).toContainText('"db": "up"');
    await expect(out.locator('.dev-headers')).toContainText('x-region');
    expect(calls).toBe(1);

    const runs = await page.evaluate(async () => (await (window as any).__inkwrightHub.activity.list()).filter((r: any) => r.label === 'Runbook').map((r: any) => ({ status: r.status, op: r.ops[0]?.summary })));
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'done', op: expect.stringMatching(/^GET https:\/\/status\.example\.test\/health → 200/) }),
      expect.objectContaining({ status: 'cancelled', op: 'Declined GET https://status.example.test/health' }),
    ]));
  });

  test('runs sql over an attached CSV and js in a sandboxed worker', async ({ page }) => {
    await openApp(page);
    await newNote(page);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Developer/ }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: /^Attach data file/ }).click();
    await (await chooser).setFiles(FIXTURES + 'incidents.csv');
    await expect(page.locator('.toast.is-success')).toContainText('Attached 1 data file');

    const ta = await textBox(page, [220, 200]);
    await ta.fill('```sql\nSELECT service, SUM(minutes) AS down FROM incidents GROUP BY service ORDER BY down DESC\n```');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Run sql block' }).click();
    const out = page.getByRole('region', { name: 'Run result' });
    await expect(out.locator('.dev-table thead')).toHaveText('servicedown');
    await expect(out.locator('.dev-table tbody tr').first()).toHaveText('api49');
    await out.getByRole('button', { name: 'Close result' }).click();

    const js = await textBox(page, [220, 520]);
    await js.fill('```js\nconsole.log("sum", [1, 2, 3].reduce((a, b) => a + b));\nreturn { network: typeof fetch, storage: typeof indexedDB };\n```');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Run js block' }).click();
    // Console output and the returned value; no network or storage inside the sandbox.
    await expect(page.getByRole('region', { name: 'Run result' }).locator('.dev-body')).toContainText('sum 6');
    await expect(page.getByRole('region', { name: 'Run result' }).locator('.dev-body')).toContainText('"network": "undefined"');
    await expect(page.getByRole('region', { name: 'Run result' }).locator('.dev-body')).toContainText('"storage": "undefined"');
  });

  test('a verified diagram: bad IR is refused with a receipt, good IR renders on the page', async ({ page }) => {
    await openApp(page);
    await newNote(page);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Developer/ }).click();
    await page.getByRole('menuitem', { name: 'Insert diagram…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Insert diagram' });
    const ir = dialog.getByLabel('Diagram IR (JSON)');
    const place = dialog.getByRole('button', { name: 'Place on page' });

    await ir.fill(JSON.stringify({ nodes: [{ id: 'web', kind: 'client' }, { id: 'api', kind: 'servce' }], edges: [{ from: 'web', to: 'apii' }] }));
    const receipt = dialog.getByTestId('diagram-receipt');
    await expect(receipt).toContainText('/nodes/1/kind');
    await expect(receipt).toContainText('Did you mean "service"?');
    await expect(receipt).toContainText('Did you mean "api"?');
    await expect(place).toBeDisabled();

    await ir.fill(JSON.stringify({ title: 'Login', nodes: [{ id: 'web', label: 'Web app', kind: 'client' }, { id: 'api', label: 'API', kind: 'service' }, { id: 'db', label: 'Users', kind: 'database' }], edges: [{ from: 'web', to: 'api' }, { from: 'api', to: 'db', kind: 'data' }] }));
    await expect(receipt).toContainText('Valid diagram (3 nodes, 2 edges)');
    await place.click();

    const obj = await page.evaluate(() => (window as any).__inkwright.doc.page(0).objects?.[0]);
    expect(obj).toMatchObject({ type: 'diagram', ir: { title: 'Login' } });
    expect(obj.origin).toBeUndefined(); // the user's own diagram
    // Drawn on the canvas: ink inside the diagram's box.
    await expect.poll(() => page.evaluate(() => {
      const { doc, engine } = (window as any).__inkwright;
      const o = doc.page(0).objects[0];
      const s = engine.pageRectToScreen(0, { minX: o.x, minY: o.y, maxX: o.x + o.width, maxY: o.y + o.height });
      const c = document.querySelector('.ink-base') as HTMLCanvasElement;
      const k = c.width / c.getBoundingClientRect().width;
      const d = c.getContext('2d')!.getImageData(Math.round(s.x * k), Math.round(s.y * k), Math.round(s.w * k), Math.round(s.h * k)).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 16) if (255 - (d[i]! + d[i + 1]! + d[i + 2]!) / 3 > 90) dark++;
      return dark;
    })).toBeGreaterThan(150);
    // And it undoes like any edit.
    await page.keyboard.press(`${await modKey(page)}+z`);
    expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).objects?.length ?? 0)).toBe(0);
  });

  test('turning the module off removes it from the editor', async ({ page }) => {
    await openApp(page);
    await openDeveloperSettings(page);
    await page.locator('.row-switch', { hasText: 'Code-aware notes' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await newNote(page);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /^Developer/ })).toHaveCount(0);
  });
});
