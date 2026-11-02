import { expect, test } from '@playwright/test';
import { openApp } from './helpers.ts';

/** "Sign in with Google" is never a dead button: without a client ID it explains and offers alternatives. */
test.use({ viewport: { width: 720, height: 800 }, hasTouch: true });

test('without a client ID, sign-in explains what is missing and what syncs now', async ({ page }) => {
  await openApp(page);
  await page.goto('/?e2e#settings/sync');
  const btn = page.getByRole('button', { name: 'Sign in with Google' });
  await expect(btn).toBeEnabled();
  await btn.click();
  const dlg = page.getByRole('dialog', { name: "Google sign-in isn't set up in this build" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Pair your devices');
  await expect(dlg).toContainText('WebDAV');
  await page.screenshot({ path: 'test-results/google-setup.png' });
  // A publisher can paste a client ID; a wrong one is caught before it's used.
  await dlg.getByText('I publish this app').click();
  await dlg.getByLabel('Web client ID').fill('not-a-client-id');
  await expect(dlg.getByRole('button', { name: 'Save and sign in' })).toBeDisabled();
  await dlg.getByLabel('Web client ID').fill('1234-abc.apps.googleusercontent.com');
  await expect(dlg.getByRole('button', { name: 'Save and sign in' })).toBeEnabled();
  // The alternative takes you there.
  await dlg.getByRole('button', { name: 'Pair your devices' }).click();
  await expect(page.locator('.settings')).toContainText(/Pair a new device/);
});
