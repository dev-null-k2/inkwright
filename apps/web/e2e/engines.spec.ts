import { expect, test, type Page } from '@playwright/test';
import { newNote, openApp } from './helpers.ts';

/**
 * Heavy engines (DuckDB, the on-device AI runtime, code parsers) are not part of the install: they
 * download once when first needed, are checked against the checksum published with the build, and
 * then work offline (src/engines, docs/PERFORMANCE.md). Web builds serve them next to the app; the
 * native apps fetch the same files from a pinned CDN through the same code.
 */

async function openAbout(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Downloaded when first used' })).toBeVisible();
}

const cachedEngineFiles = (page: Page) => page.evaluate(async () => {
  const cache = await caches.open('inkwright-engines-v1');
  return (await cache.keys()).map((r) => new URL(r.url).pathname.split('/').pop()).sort();
});

test('engines say they are a one-time download, download verified, and can be removed', async ({ page }) => {
  await openApp(page);
  await openAbout(page);
  const row = page.locator('.lai-row[data-engine="tree-sitter"]');
  await expect(row).toContainText('Code parsers');
  // The size is shown before anything is fetched, and nothing was fetched at startup.
  const download = row.getByRole('button', { name: /^Download · [\d.]+ [KM]B$/ });
  await expect(download).toBeVisible();
  expect(await cachedEngineFiles(page)).toEqual([]);
  await download.click();
  await expect(row).toContainText('On this device', { timeout: 30_000 });
  expect(await cachedEngineFiles(page)).toEqual([
    'tree-sitter-go.wasm', 'tree-sitter-java.wasm', 'tree-sitter-javascript.wasm', 'tree-sitter-python.wasm',
    'tree-sitter-rust.wasm', 'tree-sitter-tsx.wasm', 'tree-sitter-typescript.wasm', 'tree-sitter.wasm',
  ]);
  // Still there after a reload: stored, not just in memory.
  await openApp(page);
  await openAbout(page);
  await expect(page.locator('.lai-row[data-engine="tree-sitter"]')).toContainText('On this device');
  await page.locator('.lai-row[data-engine="tree-sitter"]').getByRole('button', { name: 'Remove Code parsers' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.lai-row[data-engine="tree-sitter"]').getByRole('button', { name: /^Download/ })).toBeVisible();
  expect(await cachedEngineFiles(page)).toEqual([]);
});

test('a file that does not match its published checksum is refused and not kept', async ({ page }) => {
  await page.route('**/engines/**/tree-sitter-go.wasm', (route) => route.fulfill({ status: 200, contentType: 'application/wasm', body: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]) }));
  await openApp(page);
  await openAbout(page);
  const row = page.locator('.lai-row[data-engine="tree-sitter"]');
  await row.getByRole('button', { name: /^Download/ }).click();
  await expect(row.getByRole('alert')).toContainText('tree-sitter-go.wasm did not match its published checksum');
  expect(await cachedEngineFiles(page)).not.toContain('tree-sitter-go.wasm');
  await expect(row.getByRole('button', { name: /^Finish download|^Download/ })).toBeVisible();
});

test('data queries work before DuckDB is downloaded, in SQLite, and say why', async ({ page }) => {
  // As if offline on first use: the engine files cannot be fetched.
  await page.route('**/engines/duckdb**', (route) => route.abort('internetdisconnected'));
  await openApp(page);
  await newNote(page);
  await page.evaluate(() => {
    const el = document.querySelector('.ed-canvas')!;
    const dt = new DataTransfer();
    dt.items.add(new File(['region,amount\nNorth,10.5\nSouth,5\nNorth,7\n'], 'sales.csv', { type: 'text/csv' }));
    const r = el.getBoundingClientRect();
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 200 }));
  });
  await page.getByRole('button', { name: 'Query' }).click();
  const dlg = page.getByRole('dialog', { name: 'Data' });
  await expect(dlg).toContainText('Runs on this device in SQLite', { timeout: 30_000 });
  await expect(dlg).toContainText(/DuckDB needs a one-time download of about \d+ MB/);
  await dlg.getByLabel('SQL').fill('SELECT round(sum(amount), 1) AS total FROM sales');
  await dlg.getByRole('button', { name: 'Run' }).click();
  await expect(dlg.getByRole('table')).toContainText('22.5');
});
