import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import { newNote, openApp } from './helpers.ts';

/**
 * The trust layer end to end, against a mocked OpenAI-compatible provider: the privacy firewall
 * (what the provider receives vs. what the user sees), the AI usage page, the audit trail with
 * export and verification, Routing & privacy rules (a notebook that stays on the device, a hidden
 * notebook), and dry-run proposals.
 */

type Reply = { text: string } | { tool: string; args: object };

async function mockLLM(page: Page, replies: Reply[] | ((i: number) => Reply)) {
  const requests: any[] = [];
  let i = 0;
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const r = typeof replies === 'function' ? replies(i++) : replies[Math.min(i++, replies.length - 1)]!;
    const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const sse = 'tool' in r
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${i}`, type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] }) + chunk({}, 'tool_calls')
      : chunk({ content: r.text }) + chunk({}, 'stop');
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' }, body: `${sse}data: [DONE]\n\n` });
  });
  return requests;
}

async function addCustomProvider(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-1');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await expect(page.locator('.prov-row')).toHaveCount(1);
}

async function openAgentScreen(page: Page, name: RegExp) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name }).click();
}

async function ask(page: Page, text: string) {
  await page.locator('.ai-btn').click();
  await page.locator('.ai-input textarea').fill(text);
  await page.locator('.ai-input textarea').press('Enter');
}

test('privacy firewall: the provider never sees the email, the user does; usage and a verifiable audit trail record it', async ({ page }) => {
  const reqs = await mockLLM(page, [{ text: 'I will write to ⟦EMAIL_1⟧ about the invoice today.' }]);
  await openApp(page);
  await addCustomProvider(page);
  await page.getByRole('button', { name: 'Back' }).click();
  await newNote(page);
  await ask(page, 'Draft a reply to ana.souza@acme.io about the invoice');
  await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('I will write to ana.souza@acme.io about the invoice today.');
  const sent = JSON.stringify(reqs[0].messages);
  expect(sent).not.toContain('ana.souza@acme.io');
  expect(sent).toContain('⟦EMAIL_1⟧');

  // AI usage: one request, one value kept private.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back' }).first().click();
  await openAgentScreen(page, /^AI usage/);
  const stats = page.locator('.trust-stats');
  await expect(stats).toContainText('Requests1');
  await expect(stats).toContainText('Kept private1');
  await expect(page.locator('.trust-usage .ag-item')).toContainText('Custom (OpenAI-compatible) · mock-1');

  // Audit trail: the call is there with what was kept private; it verifies and exports.
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('button', { name: /^Audit trail/ }).click();
  await expect(page.locator('.trust-event.is-ai_call').first()).toContainText('kept private: 1 email');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('.trust-verify')).toContainText('The record checks out.');
  await expect(page.locator('.trust-verify')).toContainText('all signed');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export (JSONL)' }).click();
  const file = readFileSync(await (await download).path(), 'utf8');
  const events = file.trim().split('\n').map((l) => JSON.parse(l));
  expect(events.some((e) => e.kind === 'ai_call' && e.redactions?.email === 1)).toBe(true);
  expect(events.every((e, i) => i === 0 || e.dev !== events[i - 1].dev || e.prev === events[i - 1].hash)).toBe(true);
  expect(file).not.toContain('ana.souza@acme.io');
});

test('routing & privacy: a notebook kept on this device never reaches the cloud, and a hidden one is invisible to the assistant', async ({ page }) => {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__inkwrightHub);
  const ids = await page.evaluate(async () => {
    const v = (window as any).__inkwrightHub.vault.vault;
    const clients = await v.createNotebook('Clients');
    const diary = await v.createNotebook('Diary');
    const make = async (title: string, notebookId: string, text: string) => {
      const { note, pages } = await v.createNote({ title, notebookId });
      await v.saveNote(note, [{ ...pages[0], texts: [{ id: `t${title.length}`, x: 64, y: 80, width: 600, text, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() }] }]);
      return note.id;
    };
    return { clients: clients.id, diary: diary.id, acme: await make('Acme contract', clients.id, 'Secret fee 9000'), entry: await make('Dear diary', diary.id, 'Private thoughts') };
  });
  await page.reload();
  await expect(page.locator('.library')).toBeVisible();
  const reqs = await mockLLM(page, [{ tool: 'list_notes', args: {} }, { tool: 'read_note', args: { note_id: ids.acme } }, { text: 'never reached' }]);
  await addCustomProvider(page);

  // The form writes ai/policy.json: Clients stays on this device; Diary is hidden.
  await page.getByRole('button', { name: /^Routing & privacy/ }).click();
  await page.getByRole('combobox', { name: 'Add a rule for a notebook' }).selectOption({ label: 'Clients' });
  const clientsRule = page.locator('.trust-rule', { hasText: 'Clients' });
  await expect(clientsRule.getByRole('checkbox', { name: 'Stays on this device' })).toBeChecked();
  await page.getByRole('combobox', { name: 'Add a rule for a notebook' }).selectOption({ label: 'Diary' });
  const diaryRule = page.locator('.trust-rule', { hasText: 'Diary' });
  // The form saves to the vault, then shows the saved state (so a plain click, then wait).
  await diaryRule.getByRole('checkbox', { name: 'Stays on this device' }).click();
  await expect(diaryRule.getByRole('checkbox', { name: 'Stays on this device' })).not.toBeChecked();
  await diaryRule.getByRole('radio', { name: 'Hidden' }).click();
  await expect(diaryRule.getByRole('radio', { name: 'Hidden' })).toHaveAttribute('aria-checked', 'true');
  const policy = await page.evaluate(async () => JSON.parse(await (window as any).__inkwrightHub.vault.fs.readText('ai/policy.json')));
  expect(policy.notebooks[ids.clients]).toEqual({ localOnly: true });
  expect(policy.notebooks[ids.diary]).toEqual({ access: 'none', localOnly: false });

  // The assistant lists notes (the cloud sees the Clients note only as a private placeholder and
  // not the Diary at all), then reads the Clients note: the next request must stay on the
  // device, and there is no model here, so it stops with an explanation.
  await page.getByRole('button', { name: 'Back' }).first().click();
  await newNote(page);
  await ask(page, 'What is in my notes?');
  await expect(page.locator('.ai-msg.is-error').last()).toContainText('must stay on this device');
  await expect(page.locator('.ai-msg.is-error').last()).toContainText('No model is available on this device');
  expect(reqs).toHaveLength(2);
  const listed = JSON.stringify(reqs[1].messages);
  expect(listed).toContain('Private note (stays on this device)');
  expect(listed).not.toContain('Acme contract');
  expect(listed).not.toContain('Dear diary');
  expect(JSON.stringify(reqs)).not.toContain('Secret fee 9000');
});

test('dry run: the assistant proposes, the change waits in Activity with a diff, approving applies it', async ({ page }) => {
  await mockLLM(page, [{ tool: 'create_note', args: { title: 'Weekly plan', text: 'Monday: draft the report' } }, { text: 'I proposed a note for you.' }]);
  await openApp(page);
  await addCustomProvider(page);
  await page.getByRole('button', { name: /^Routing & privacy/ }).click();
  await page.getByRole('radiogroup', { name: 'How the assistant change notes' }).getByRole('radio', { name: 'Propose' }).click();
  await page.getByRole('button', { name: 'Back' }).first().click();
  await newNote(page);
  await ask(page, 'Plan my week');
  await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('I proposed a note for you.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back' }).first().click();
  await expect(page.locator('.note-card', { hasText: 'Weekly plan' })).toHaveCount(0);

  await openAgentScreen(page, /^Activity/);
  const card = page.locator('.trust-proposal', { hasText: 'Create note “Weekly plan”' });
  await expect(card).toBeVisible();
  await expect(card.locator('.trust-diff')).toContainText('+ Monday: draft the report');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('.toast')).toContainText('Created “Weekly plan”');
  await expect(card).toHaveCount(0);
  await expect(page.locator('.ag-run').first()).toContainText('Created “Weekly plan”');
  await page.getByRole('button', { name: 'Back' }).first().click();
  await expect(page.locator('.note-card', { hasText: 'Weekly plan' })).toHaveCount(1);
});
