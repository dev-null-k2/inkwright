import { expect, test, type Page, type Route } from '@playwright/test';
import { newNote, openApp, pen, word } from './helpers.ts';

/**
 * Time travel across the vault (version history read as the past) and branches for dry-run
 * proposals (try on a branch, compare side by side, merge), against a mocked AI provider.
 */

const strokeCount = (page: Page) => page.evaluate(() => (window as any).__inkstone.doc.page(0).strokes.length as number);

async function backToLibrary(page: Page) {
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.locator('.library')).toBeVisible();
}

async function openNote(page: Page, title: string) {
  await page.getByRole('button', { name: `Open ${title}` }).click();
  await page.waitForFunction((t) => (window as any).__inkstone?.doc?.meta.title === t, title);
}

test('show my notes as of a date: the library and a note read the past, read-only, until back to today', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-01T09:00:00') });
  await openApp(page);
  await newNote(page);
  await pen(page, word(200, 220, 200));
  await page.locator('.ed-title').click();
  await page.getByLabel('Title').fill('Diary');
  await page.getByRole('button', { name: 'Rename' }).click();
  await backToLibrary(page); // the closing snapshot: one line, at nine

  await page.clock.fastForward('03:00:00');
  await openNote(page, 'Diary');
  await pen(page, word(200, 280, 200));
  await pen(page, word(200, 340, 200));
  await backToLibrary(page); // three lines at noon

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByLabel('Search', { exact: true }).fill('as of a date');
  await page.getByRole('option', { name: /Show notes as of a date/ }).click();
  await page.getByLabel('Date and time').fill('2026-10-01T10:30');
  await page.getByRole('button', { name: 'Show', exact: true }).click();

  const bar = page.getByRole('region', { name: 'Time travel' });
  await expect(bar).toContainText('read-only');
  await openNote(page, 'Diary');
  expect(await strokeCount(page)).toBe(1);
  // The past can be looked at, not changed.
  await pen(page, word(200, 420, 200));
  expect(await strokeCount(page)).toBe(1);
  await backToLibrary(page);

  await bar.getByRole('button', { name: 'Back to today' }).click();
  await expect(bar).toHaveCount(0);
  await openNote(page, 'Diary');
  expect(await strokeCount(page)).toBe(3);
});

type Reply = { text: string } | { tool: string; args: object };

async function mockLLM(page: Page, replies: Reply[]) {
  let i = 0;
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const sse = 'tool' in r
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${i}`, type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] }) + chunk({}, 'tool_calls')
      : chunk({ content: r.text }) + chunk({}, 'stop');
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' }, body: `${sse}data: [DONE]\n\n` });
  });
}

async function openActivity(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: /^Activity/ }).click();
}

test('dry run onto a branch: compare it with the notes side by side, then merge it', async ({ page }) => {
  await mockLLM(page, [{ tool: 'create_note', args: { title: 'Weekly plan', text: 'Monday: draft the report' } }, { text: 'I proposed a note for you.' }]);
  await openApp(page);
  // A provider and "Propose" for the assistant (Settings › AI › Routing & privacy).
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-1');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await page.getByRole('button', { name: /^Routing & privacy/ }).click();
  await page.getByRole('radiogroup', { name: 'How the assistant change notes' }).getByRole('radio', { name: 'Propose' }).click();
  await page.getByRole('button', { name: 'Back' }).first().click();

  await newNote(page);
  await page.locator('.ai-btn').click();
  await page.locator('.ai-input textarea').fill('Plan my week');
  await page.locator('.ai-input textarea').press('Enter');
  await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('I proposed a note for you.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back' }).first().click();

  await openActivity(page);
  const card = page.locator('.trust-proposal', { hasText: 'Create note “Weekly plan”' });
  await card.getByRole('button', { name: 'Try on a branch' }).click();
  await page.getByLabel(/Branch name/).fill('Planning ideas');
  await page.getByRole('button', { name: 'Try it' }).click();
  await expect(card).toHaveCount(0);
  const branch = page.locator('.branch-card', { hasText: 'Planning ideas' });
  await expect(branch).toContainText('Weekly plan (new)');

  // Not in the notes yet.
  await page.getByRole('button', { name: 'Back' }).first().click();
  await expect(page.locator('.library')).toBeVisible();
  await expect(page.locator('.note-card', { hasText: 'Weekly plan' })).toHaveCount(0);

  await openActivity(page);
  await branch.getByRole('button', { name: 'Compare' }).click();
  const compare = page.getByRole('region', { name: 'Compare Weekly plan' });
  await expect(compare.locator('.branch-cell.is-added')).toContainText(['# Weekly plan', 'Monday: draft the report']);
  await page.getByRole('button', { name: 'Merge into my notes' }).click();
  await expect(page.locator('.toast', { hasText: 'Merged into your notes (1 note)' })).toBeVisible();
  await expect(branch).toHaveCount(0);
  await page.getByRole('button', { name: 'Back' }).first().click();
  await expect(page.locator('.library')).toBeVisible();
  await expect(page.locator('.note-card', { hasText: 'Weekly plan' })).toHaveCount(1);
  // What the agent wrote is marked as AI content in the merged note.
  await openNote(page, 'Weekly plan');
  expect(await page.evaluate(() => (window as any).__inkstone.doc.page(0).texts.map((t: any) => t.origin))).toEqual(['ai']);
});
