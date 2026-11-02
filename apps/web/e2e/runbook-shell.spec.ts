import { expect, test, type Page } from '@playwright/test';
import { newNote, openApp, pointer } from './helpers.ts';

/**
 * Runbook ```sh blocks (docs/DEVELOPERS.md › Runbooks): they never run in the page. The test plays
 * the computer through the vault, as the runner does through sync: it announces itself, checks
 * the signed approval the app wrote (with the same verification the runner uses), and answers.
 */

const shell = (page: Page) => page.evaluate(() => !!(window as any).__inkwrightShell);

async function shBlockNote(page: Page) {
  await newNote(page);
  await page.keyboard.press('t');
  await pointer(page, 'pointerdown', [220, 240], { type: 'mouse' });
  await pointer(page, 'pointerup', [220, 240], { type: 'mouse' });
  const ta = page.locator('.text-area');
  await expect(ta).toBeVisible();
  await ta.fill('Restart the worker\n```bash cwd=shop restart\necho hello from the runner\n```');
  await page.getByRole('button', { name: 'Done' }).click();
}

test.describe('runbook shell blocks', () => {
  test('are plain text while the module is off', async ({ page }) => {
    await openApp(page);
    await shBlockNote(page);
    await expect(page.getByRole('button', { name: /Run sh block/ })).toHaveCount(0);
  });

  test('ask for a computer, then run there after a signed approval', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('inkwright.modules.v1', JSON.stringify({ enabled: { 'runbook-shell': true } })));
    await openApp(page);
    await expect.poll(() => shell(page)).toBe(true);
    await shBlockNote(page);
    const run = page.getByRole('button', { name: 'Run sh block restart' });
    await expect(run).toBeVisible();

    // No computer yet: nothing runs, and the result says how to set one up.
    await run.click();
    const out = page.getByRole('region', { name: 'Run result' });
    await expect(out).toContainText('No computer is set up to run shell blocks');
    await expect(out).toContainText('--shell-trust');

    // A computer announces itself in the vault, trusting this device.
    const fp = await page.evaluate(() => (window as any).__inkwrightShell.fingerprint());
    await page.evaluate(async (fingerprint) => {
      const fs = (window as any).__inkwrightShell.fs();
      await fs.writeText('dev/shell/runners/sh-testlaptop.json', JSON.stringify({ v: 1, id: 'sh-testlaptop', label: 'Test laptop', platform: 'linux', allow: ['/home/me/code'], shells: ['sh', 'bash'], timeoutSeconds: 60, trusted: [fingerprint], heartbeatAt: Date.now() }));
    }, fp);

    // Declining writes nothing.
    await run.click();
    const dialog = page.getByRole('dialog', { name: 'Run this on Test laptop?' });
    await expect(dialog).toContainText('echo hello from the runner');
    await expect(dialog).toContainText('Shell: bash · Folder: shop');
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(async () => (await (window as any).__inkwrightShell.fs().list('dev/shell/requests')).length)).toBe(0);

    await run.click();
    await page.getByRole('button', { name: 'Run on Test laptop' }).click();
    // The computer finds the request, verifies it as the runner would, and answers.
    let req: any = null;
    await expect.poll(async () => (req = await page.evaluate(async () => {
      const fs = (window as any).__inkwrightShell.fs();
      const list = await fs.list('dev/shell/requests');
      return list.length ? JSON.parse(await fs.readText(`dev/shell/requests/${list[0].name}`)) : null;
    })), { timeout: 10_000 }).not.toBeNull();
    expect(req).toMatchObject({ runner: 'sh-testlaptop', command: 'echo hello from the runner', dialect: 'bash', cwd: 'shop', device: { fingerprint: fp } });
    const verdict = await page.evaluate(async ([r, f]) => (window as any).__inkwrightShell.verify(r, [f]), [req, fp] as const);
    expect(verdict).toEqual({ ok: true });
    // A changed command doesn't verify.
    expect((await page.evaluate(async ([r, f]) => (window as any).__inkwrightShell.verify({ ...r, command: 'rm -rf ~' }, [f]), [req, fp] as const)).ok).toBe(false);
    // An untrusted device doesn't either.
    expect((await page.evaluate(async ([r]) => (window as any).__inkwrightShell.verify(r, ['0000 0000 0000 0000 0000']), [req] as const)).ok).toBe(false);

    await page.evaluate(async (r) => {
      const fs = (window as any).__inkwrightShell.fs();
      await fs.writeText(`dev/shell/results/${r.id}.json`, JSON.stringify({ v: 1, id: r.id, runner: 'sh-testlaptop', status: 'done', exitCode: 0, startedAt: Date.now(), finishedAt: Date.now(), output: 'hello from the runner\n', outputBytes: 22, shortened: false, cwd: '/home/me/code/shop' }));
    }, req);
    await expect(out).toContainText('hello from the runner', { timeout: 10_000 });
    await expect(out).toContainText('On Test laptop in /home/me/code/shop · exit 0');
    // The request is cleaned up once answered; the run is in Activity.
    expect(await page.evaluate(async () => (await (window as any).__inkwrightShell.fs().list('dev/shell/requests')).length)).toBe(0);
    const runs = await page.evaluate(async () => (await (window as any).__inkwrightHub.activity.list()).filter((r: any) => r.label === 'Runbook').map((r: any) => ({ status: r.status, op: r.ops[0]?.summary })));
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'done', op: expect.stringMatching(/^Ran \(exit 0\) on Test laptop: echo hello from the runner/) }),
      expect.objectContaining({ status: 'cancelled' }),
    ]));
  });
});
