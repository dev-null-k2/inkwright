import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createFakeMcp } from '../../../packages/ai/test/fake-mcp.ts';
import { openApp } from './helpers.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-expose-headers': 'www-authenticate, mcp-protocol-version, mcp-session-id',
};

/**
 * Serves the in-process fake MCP server (official SDK server + OAuth authorization server, see
 * packages/ai/test/fake-mcp.ts) at https://fake-mcp.test for every page, including the sign-in
 * popup. The authorization endpoint "consents" and redirects back to the app like a real one.
 */
async function serveFakeMcp(context: BrowserContext) {
  const fake = createFakeMcp({ oauth: true });
  await context.route('https://fake-mcp.test/**', async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    if (url.pathname === '/authorize') return route.fulfill({ status: 302, headers: { location: fake.approve(url).toString() } });
    const headers = { ...(await req.allHeaders()) };
    delete headers['content-length'];
    const res = await fake.fetch(new Request(req.url(), { method: req.method(), headers, body: req.method() === 'GET' ? undefined : (req.postData() ?? undefined) }));
    const out: Record<string, string> = { ...CORS };
    res.headers.forEach((v, k) => { out[k] = v; });
    await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
  });
  return fake;
}

async function mockLLM(page: Page, replies: ({ text: string } | { tool: string; args: object })[]) {
  let i = 0;
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const body = route.request().postDataJSON();
    const msg = 'tool' in r ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] } : { role: 'assistant', content: r.text };
    if (body.stream) {
      const delta = 'tool' in r ? { role: 'assistant', tool_calls: [{ index: 0, ...msg.tool_calls![0] }] } : { content: r.text };
      const sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool' in r ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`;
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: 'tool' in r ? 'tool_calls' : 'stop' }] }) });
  });
}

test('connected apps: OAuth sign-in in a popup, per-tool approval, and the assistant using the app', async ({ page, context }) => {
  const fake = await serveFakeMcp(context);
  await mockLLM(page, [
    { tool: 'tasks__add_task', args: { title: 'Revise chapter 3' } },
    { text: 'Added “Revise chapter 3” to your tasks.' },
  ]);
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-1');
  await page.getByRole('button', { name: 'Save provider' }).click();

  await page.getByRole('button', { name: /^Connected apps/ }).click();
  await page.getByPlaceholder('https://example.com/mcp').fill('https://fake-mcp.test/mcp');
  await page.getByPlaceholder('Shown in the assistant').fill('Tasks');
  const popup = context.waitForEvent('page');
  await page.locator('.ag-add-form').getByRole('button', { name: 'Connect' }).click();
  // The sign-in popup goes to the authorization server and comes back to the app, which closes it.
  const p = await popup;
  await p.waitForEvent('close', { timeout: 15_000 }).catch(() => {});
  const row = page.locator('.ag-server', { hasText: 'Tasks' });
  await expect(row).toContainText('Connected · 5 tools', { timeout: 15_000 });
  await expect(row).toContainText('MCP 2026-07-28');
  expect(fake.state.clients.size).toBe(1);
  expect([...fake.state.accessTokens]).toHaveLength(1);

  // Per-tool settings: read-only tools don't ask; tools that change things do.
  await page.getByRole('button', { name: 'Show Tasks tools' }).click();
  await expect(page.getByRole('checkbox', { name: 'Ask before add_task' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Ask before list_tasks' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Use delete_everything' }).uncheck();

  // The assistant uses the app; the write waits for approval.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkstone?.engine);
  await page.locator('.ai-btn').click();
  await page.locator('.ai-input textarea').fill('Add revise chapter 3 to my tasks');
  await page.locator('.ai-input textarea').press('Enter');
  await expect(page.getByRole('dialog', { name: 'Allow Tasks to run “add_task”?' })).toBeVisible();
  expect(fake.state.tasksAdded).toEqual([]);
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('Added “Revise chapter 3”');
  expect(fake.state.tasksAdded).toEqual(['Revise chapter 3']);
  await expect(page.locator('.ai-tool').first()).toContainText('Used add_task in Tasks');

  // It's in Activity as a change in another app (listed, undone there).
  await page.getByRole('button', { name: 'Assistant menu' }).click();
  await page.getByRole('menuitem', { name: 'Activity' }).click();
  await expect(page.locator('.ag-panel-view .ag-op').first()).toContainText('Used “Add task” in Tasks');
  await page.getByRole('button', { name: 'Back to chat' }).click();

  // The app's prompts are picked by the user and land in the input to review.
  await page.getByRole('button', { name: 'Assistant menu' }).click();
  await page.getByRole('menuitem', { name: 'Connected apps' }).click();
  await page.getByRole('button', { name: 'Show Tasks tools' }).click();
  await page.locator('.ag-prompt', { hasText: 'Plan my week' }).getByRole('button', { name: 'Use' }).click();
  await page.getByRole('dialog').locator('input').fill('exams');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.ai-input textarea')).toHaveValue('Plan my week around exams, using my open tasks.');
});

test('connected apps: a server that blocks web apps is explained, not a silent failure', async ({ page, context }) => {
  // The server is up (a plain no-cors GET gets an answer) but the browser blocks the app's
  // cross-origin MCP requests, as it does for servers that send no CORS headers.
  await context.route('https://no-cors.test/**', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, body: 'ok' }) : route.abort('failed')));
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: /^Connected apps/ }).click();
  await page.getByPlaceholder('https://example.com/mcp').fill('https://no-cors.test/mcp');
  await page.getByRole('radio', { name: 'None' }).click();
  await page.locator('.ag-add-form').getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.ag-server-error')).toContainText('doesn’t allow web apps to connect', { timeout: 15_000 });
});

test('connected apps: an address that is not an MCP server gets a plain explanation', async ({ page, context }) => {
  await context.route('https://not-mcp.test/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: '{"hello":"world"}' }));
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: /^Connected apps/ }).click();
  await page.getByPlaceholder('https://example.com/mcp').fill('https://not-mcp.test/api');
  await page.getByRole('radio', { name: 'None' }).click();
  await page.locator('.ag-add-form').getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.ag-server-error')).toContainText('didn’t answer like an MCP server', { timeout: 15_000 });
});
