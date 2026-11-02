import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { openApp } from './helpers.ts';

/** OpenAI-compatible mock (same wire format as e2e/ai.spec.ts): scripted replies, JSON or SSE. */
async function mockLLM(page: Page, replies: ({ text: string } | { tool: string; args: object })[]) {
  const requests: any[] = [];
  let i = 0;
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const headers = { 'access-control-allow-origin': '*' };
    if (body.stream) {
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      let sse = '';
      if ('tool' in r) sse += chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${i}`, type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] }) + chunk({}, 'tool_calls');
      else sse += chunk({ content: r.text }) + chunk({}, 'stop');
      await route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'text/event-stream' }, body: sse + 'data: [DONE]\n\n' });
      return;
    }
    const msg = 'tool' in r ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] } : { role: 'assistant', content: r.text };
    await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: 'tool' in r ? 'tool_calls' : 'stop' }] }) });
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

/** A skill folder on disk, as a user would pick it. */
function skillFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'inkwright-skill-'));
  const dir = join(root, 'meeting-minutes');
  mkdirSync(join(dir, 'references'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    'name: meeting-minutes',
    'description: Turns meeting notes into minutes with decisions and owners. Use when the user asks for minutes or a meeting summary.',
    '---',
    '',
    '# Meeting minutes',
    'SECRET-BODY-MARKER: follow references/TEMPLATE.md exactly.',
  ].join('\n'));
  writeFileSync(join(dir, 'references', 'TEMPLATE.md'), '## Decisions\n## Owners\n');
  writeFileSync(join(dir, 'scripts', 'export.py'), 'print("never run")\n');
  return dir;
}

test('skills, routines and the activity log: import a skill, run a routine, undo what it did', async ({ page }) => {
  const reqs = await mockLLM(page, [
    { tool: 'create_note', args: { title: 'Routine inbox', text: '- [ ] Call the dentist' } },
    { text: 'I made a note called Routine inbox.' },
  ]);
  await openApp(page);
  await addCustomProvider(page);

  // Settings › AI › Skills: import a folder.
  await page.getByRole('button', { name: /^Skills/ }).click();
  await expect(page.getByText('Scripts in skills are never run')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import folder' }).click();
  await (await chooser).setFiles(skillFolder());
  await expect(page.locator('.ag-skill', { hasText: 'meeting-minutes' })).toBeVisible();
  await page.getByRole('button', { name: 'View meeting-minutes' }).click();
  await expect(page.locator('.ag-skill', { hasText: 'meeting-minutes' })).toContainText('Inkwright never runs them');
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();

  // Routines: write one, run it now.
  await page.getByRole('button', { name: /^Routines/ }).click();
  await expect(page.getByText('They run while Inkwright is open')).toBeVisible();
  await page.getByRole('button', { name: 'New routine' }).click();
  await page.getByPlaceholder('File my notes').fill('Inbox sweep');
  await page.getByPlaceholder(/Every evening/).fill('Collect my open to-dos into a note called Routine inbox.');
  await page.getByRole('button', { name: 'Add routine' }).click();
  await expect(page.locator('.ag-routine', { hasText: 'Inbox sweep' })).toBeVisible();
  await page.getByRole('button', { name: 'Run Inbox sweep now' }).click();
  await expect(page.locator('.ag-routine', { hasText: 'Inbox sweep' })).toContainText(/Ran just now/, { timeout: 15_000 });

  // The routine ran with the skill's name and description only (progressive disclosure).
  const system = JSON.stringify(reqs[0].messages[0]);
  expect(system).toContain('meeting-minutes: Turns meeting notes into minutes');
  expect(system).not.toContain('SECRET-BODY-MARKER');
  expect(reqs[0].tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(['create_note', 'load_skill', 'read_skill_resource']));
  expect(reqs[0].tools.map((t: any) => t.function.name)).not.toContain('remember');

  // Activity shows the change; Undo really removes the note.
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('button', { name: /^Activity/ }).click();
  const run = page.locator('.ag-run', { hasText: 'Inbox sweep' });
  await expect(run).toContainText('Created “Routine inbox”');
  await expect(run).toContainText('I made a note called Routine inbox.');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.note-card', { hasText: 'Routine inbox' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: /^Activity/ }).click();
  await run.getByRole('button', { name: 'Undo: Created “Routine inbox”' }).click();
  await expect(run.locator('.ag-op')).toContainText('Undone');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.note-card', { hasText: 'Routine inbox' })).toHaveCount(0);
  // Recoverable: it went to Trash.
  await page.getByRole('button', { name: 'Trash' }).first().click();
  await expect(page.locator('.note-card', { hasText: 'Routine inbox' })).toHaveCount(1);
});

test('assistant panel: header menu opens the assistant screens; chat changes can be undone from the reply', async ({ page }) => {
  await mockLLM(page, [
    { tool: 'create_note', args: { title: 'Packing list', text: '- [ ] passport' } },
    { text: 'Created your packing list.' },
  ]);
  await openApp(page);
  await addCustomProvider(page);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await page.locator('.ai-btn').click();
  await page.locator('.ai-input textarea').fill('Make a packing list');
  await page.locator('.ai-input textarea').press('Enter');
  await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('Created your packing list');
  const logged = page.locator('.ai-tool', { hasText: '1 change logged in Activity' });
  await expect(logged).toBeVisible();

  // Menu → Activity inside the panel.
  await page.getByRole('button', { name: 'Assistant menu' }).click();
  await page.getByRole('menuitem', { name: 'Activity' }).click();
  await expect(page.locator('.ag-panel-view .ag-run').first()).toContainText('Created “Packing list”');
  await page.getByRole('button', { name: 'Back to chat' }).click();

  // Undo straight from the chat: the note goes to Trash and Activity marks it undone.
  await logged.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.toast')).toContainText('Undid 1 change');
  await page.getByRole('button', { name: 'Assistant menu' }).click();
  await page.getByRole('menuitem', { name: 'Activity' }).click();
  await expect(page.locator('.ag-panel-view .ag-op').first()).toContainText('Undone');
  await page.getByRole('button', { name: 'Back to chat' }).click();

  // Memory screen is reachable the same way and adding an instruction works.
  await page.getByRole('button', { name: 'Assistant menu' }).click();
  await page.getByRole('menuitem', { name: 'Memory' }).click();
  await page.getByRole('textbox', { name: 'Something to remember' }).fill('Always answer in bullet points');
  await page.locator('.ag-panel-view').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.ag-panel-view .ag-memory')).toContainText('Always answer in bullet points');
  await page.getByRole('button', { name: 'Back to chat' }).click();
});

test('routines screen says when the always-on runner (inkwright-agent) is running them', async ({ page }) => {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__inkwrightHub);
  const writeLease = (renewedAgoMs: number) => page.evaluate(async (ago) => {
    const t = Date.now() - ago;
    const lease = { holder: 'runner:studio:1:ab', label: 'The Inkwright agent on Studio', kind: 'runner', acquiredAt: t, renewedAt: t, expiresAt: t + 600_000 };
    await (window as any).__inkwrightHub.vault.fs.writeText('ai/leases/routines.json', JSON.stringify(lease));
  }, renewedAgoMs);
  const openRoutines = async () => {
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await page.getByRole('button', { name: /^Routines/ }).click();
    await expect(page.getByText('They run while Inkwright is open')).toBeVisible();
  };
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: /^Routines/ }).click();
  await expect(page.getByTestId('routines-runner')).toHaveCount(0);
  // The runner on a computer holds the routines lease in the synced vault.
  await writeLease(0);
  await openRoutines();
  await expect(page.getByTestId('routines-runner')).toHaveText('The Inkwright agent on Studio is running your routines, even when Inkwright is closed. Its changes show up in Activity.');
  // A lease that wasn't renewed (the computer is asleep) hands routines back to the app.
  await writeLease(3_600_000);
  await openRoutines();
  await expect(page.getByTestId('routines-runner')).toHaveCount(0);
});
