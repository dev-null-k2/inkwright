import { expect, test, type Page, type Route } from '@playwright/test';
import { openApp } from './helpers.ts';

/** A fake OpenAI-compatible server: scripted replies, streamed as SSE like the real API. */
async function mockLLM(page: Page, replies: ({ text: string } | { tool: string; args: object })[]) {
  const requests: any[] = [];
  let i = 0;
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    let sse = '';
    if ('tool' in r) {
      sse += chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${i}`, type: 'function', function: { name: r.tool, arguments: '' } }] });
      const args = JSON.stringify(r.args);
      sse += chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 10) } }] });
      sse += chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] });
      sse += chunk({}, 'tool_calls');
    } else {
      for (const w of r.text.split(/(?<= )/)) sse += chunk({ content: w });
      sse += chunk({}, 'stop');
    }
    sse += 'data: [DONE]\n\n';
    if (body.stream) await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse });
    else {
      const msg = 'tool' in r ? { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] } : { role: 'assistant', content: r.text };
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: 'tool' in r ? 'tool_calls' : 'stop' }] }) });
    }
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

test('bring-your-own AI: the assistant creates a note through a tool call', async ({ page }) => {
  const reqs = await mockLLM(page, [
    { tool: 'create_note', args: { title: 'Groceries', text: '- [ ] milk\n- [ ] eggs' } },
    { text: 'I made a note called Groceries with your list.' },
  ]);
  await openApp(page);
  await addCustomProvider(page);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await page.locator('.ai-btn').click();
  await page.locator('.ai-input textarea').fill('Make a grocery list with milk and eggs');
  await page.locator('.ai-input textarea').press('Enter');
  await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('I made a note called Groceries');
  await expect(page.locator('.ai-tool').first()).toContainText('Created a note');
  // The tool definitions were sent and the tool result went back to the model.
  expect(reqs[0].tools.map((t: any) => t.function.name)).toContain('create_note');
  expect(JSON.stringify(reqs[1].messages)).toContain('Groceries');
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.locator('.note-card', { hasText: 'Groceries' })).toHaveCount(1);
});

test('quick action: summarize and save the summary to the note', async ({ page }) => {
  await mockLLM(page, [{ text: '- Inkwright saves notes as plain files\n- Any AI can be connected' }]);
  await openApp(page);
  await addCustomProvider(page);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await page.locator('.ai-btn').click();
  await page.getByRole('button', { name: 'Summarize' }).click();
  await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('plain files');
  await page.getByRole('button', { name: 'Save as note summary' }).click();
  const summary = await page.evaluate(() => (window as any).__inkwright.doc.meta.summary);
  expect(summary).toContain('plain files');
});

test('without any AI the panel explains how to connect one', async ({ page }) => {
  await openApp(page);
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await page.locator('.ai-btn').click();
  await expect(page.locator('.ai-setup')).toContainText('Use any AI with your notes');
});

test('provider errors are shown in plain language', async ({ page }) => {
  await page.route('https://mock-llm.test/v1/chat/completions', (r) => r.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }) }));
  await openApp(page);
  await addCustomProvider(page);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await page.locator('.ai-btn').click();
  await page.locator('.ai-input textarea').fill('hello');
  await page.locator('.ai-input textarea').press('Enter');
  await expect(page.locator('.ai-msg.is-error')).toBeVisible();
});
