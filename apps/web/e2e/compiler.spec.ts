import { expect, test, type Page, type Route } from '@playwright/test';
import { openApp } from './helpers.ts';

/**
 * The context compiler end to end (docs/COMPILER.md): compile → review a proposal → accept →
 * explain a sentence's sources → a contradiction across notes → a source edit makes claims stale →
 * re-check proposes the update → undo from AI activity; study (FSRS review with a typed answer);
 * context packs; "Explain this answer" in the assistant; "Does my memory help?" in Settings.
 */

/** Writes notes the way sync or another device would, then reloads so the library shows them. */
async function seed(page: Page, notes: Array<{ title: string; text: string; tags?: string[]; notebook?: string }>) {
  await page.waitForFunction(() => !!(window as any).__inkstoneHub);
  await page.evaluate(async (notes) => {
    const v = (window as any).__inkstoneHub.vault.vault;
    const books = new Map<string, string>();
    for (const n of notes) {
      let notebookId: string | undefined;
      if (n.notebook) {
        if (!books.has(n.notebook)) books.set(n.notebook, (await v.createNotebook(n.notebook)).id);
        notebookId = books.get(n.notebook);
      }
      const { note, pages } = await v.createNote({ title: n.title, notebookId, tags: n.tags ?? [] });
      const text = { id: `T${Math.random().toString(36).slice(2, 12)}`, x: 64, y: 80, width: 600, text: n.text, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() };
      await v.saveNote(note, [{ ...pages[0], texts: [text] }]);
    }
  }, notes);
  await page.reload();
  await expect(page.locator('.library')).toBeVisible();
}

async function editNoteText(page: Page, title: string, from: string, to: string) {
  await page.evaluate(async ({ title, from, to }) => {
    const v = (window as any).__inkstoneHub.vault.vault;
    const note = (await v.listNotes()).find((n: any) => n.title === title);
    const pages = await v.readPages(note);
    const p = pages[0];
    await v.saveNote({ ...note, updatedAt: Date.now() }, [{ ...p, texts: p.texts.map((t: any) => ({ ...t, text: t.text.replace(from, to) })) }]);
  }, { title, from, to });
}

/** A proposal item or compiled page by its exact title (the index page mentions every title). */
const itemNamed = (page: Page, scope: string, title: string) => page.locator(scope).filter({ has: page.locator('.ag-item-title', { hasText: new RegExp(`^\\s*${title}`) }) });

async function openAssistantScreen(page: Page, name: RegExp) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name }).click();
}

const ATLAS = [
  { title: 'Requirements', text: '# Performance\nLatency must stay under 50 ms.\nEmbedding: a vector that represents meaning.', tags: ['atlas'], notebook: 'Atlas' },
  { title: 'Benchmark', text: 'The new pipeline averages 110 ms.\nWe decided to use Postgres for the queue.', tags: ['atlas'], notebook: 'Atlas' },
];

test('compiled wiki: compile, review, accept, explain, conflict, stale, re-check and undo', async ({ page }) => {
  await openApp(page);
  await seed(page, ATLAS);
  await openAssistantScreen(page, /^Compiled wiki/);

  // Sources and settings.
  await page.getByLabel('Add a notebook').selectOption({ label: 'Atlas' });
  await expect(page.locator('.cp-chip', { hasText: 'Atlas' })).toBeVisible();
  await page.getByRole('radio', { name: 'No AI (quotes)' }).click();

  // Compile → a proposal with every claim tagged and sourced; nothing written yet.
  await page.getByRole('button', { name: 'Compile now' }).click();
  const proposal = page.locator('.cp-proposal');
  await expect(proposal).toBeVisible({ timeout: 15_000 });
  await expect(itemNamed(page, '.cp-proposal .cp-item', 'Atlas')).toContainText('New page');
  const disputed = proposal.locator('.cp-claim', { hasText: 'Sources disagree' });
  await expect(disputed.locator('.cp-tag')).toHaveText('Ambiguous');
  await expect(proposal.locator('.cp-claim', { hasText: 'Latency must stay under 50 ms.' }).first().locator('.cp-tag')).toHaveText('Extracted');
  await expect(itemNamed(page, '.cp-proposal .cp-item', 'Glossary')).toBeVisible();

  // Untick one claim of the Atlas page, then accept everything.
  await proposal.getByRole('checkbox', { name: /Add: We decided to use Postgres/ }).uncheck();
  await proposal.getByRole('button', { name: 'Accept all' }).click();
  await expect(proposal).toHaveCount(0);
  const atlasRow = itemNamed(page, '.cp-page', 'Atlas');
  await expect(atlasRow).toBeVisible();

  // The page exists as a note in the Compiled wiki notebook, without the unticked claim.
  const text = await page.evaluate(async () => {
    const v = (window as any).__inkstoneHub.vault.vault;
    const note = (await v.listNotes()).find((n: any) => n.title === 'Atlas' && n.tags.includes('compiled'));
    const nb = (await v.listNotebooks()).find((b: any) => b.id === note.notebookId);
    return { nb: nb.name, text: (await v.readPages(note))[0].texts[0].text };
  });
  expect(text.nb).toBe('Compiled wiki');
  expect(text.text).toContain('- Latency must stay under 50 ms.');
  expect(text.text).not.toContain('Postgres');
  expect(text.text).toContain('Sources: ');

  // Explain: the sentence's tag, its source with a picture, and who wrote it.
  await atlasRow.getByRole('button', { name: 'Explain' }).click();
  const dialog = page.getByRole('dialog', { name: /Explain: Atlas/ });
  await dialog.getByRole('button', { name: /^Latency must stay under 50 ms/ }).click();
  await expect(dialog.locator('.cp-detail .cp-tag')).toHaveText('Extracted');
  await expect(dialog.locator('.cp-source')).toContainText('Requirements · page 1 · Typed');
  await expect(dialog.locator('.cp-source q')).toHaveText('Latency must stay under 50 ms.');
  await expect(dialog.locator('img.cp-thumb')).toBeVisible();
  await expect(dialog.locator('.cp-gen')).toContainText('compiler.extract/1');
  await page.keyboard.press('Escape');

  // The contradiction across notes, in Conflicts; dismissing it keeps it quiet.
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('button', { name: /^Conflicts/ }).click();
  const conflict = page.locator('.cp-conflict', { hasText: 'limit' }).first();
  await expect(conflict).toContainText('“Latency must stay under 50 ms.”');
  await expect(conflict).toContainText('“The new pipeline averages 110 ms.”');
  await conflict.getByRole('button', { name: 'Not a conflict' }).click();
  await expect(page.locator('.cp-conflict.is-decided')).toContainText('Dismissed');

  // Editing a source makes the claims citing it stale; re-check proposes the update.
  await editNoteText(page, 'Requirements', 'under 50 ms', 'under 150 ms');
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('button', { name: /^Compiled wiki/ }).click();
  await expect(itemNamed(page, '.cp-page', 'Atlas').locator('.cp-stale')).toBeVisible({ timeout: 15_000 });
  await itemNamed(page, '.cp-page', 'Atlas').getByRole('button', { name: 'Re-check' }).click();
  const update = itemNamed(page, '.cp-proposal .cp-item', 'Atlas');
  await expect(update).toContainText('Update');
  await expect(update.locator('.cp-claims.is-added')).toContainText('Latency must stay under 150 ms.');
  await expect(update.locator('.cp-claims.is-removed')).toContainText('Latency must stay under 50 ms.');
  await update.getByRole('button', { name: 'Accept Atlas' }).click();
  await expect(itemNamed(page, '.cp-page', 'Atlas').locator('.cp-stale')).toHaveCount(0, { timeout: 15_000 });

  // The update is in AI activity and undoes.
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('button', { name: /^Activity/ }).click();
  const run = page.locator('.ag-run', { hasText: 'Compiled wiki' }).first();
  await expect(run).toContainText('Updated the compiled page “Atlas”');
  await run.getByRole('button', { name: /^Undo: Updated the compiled page/ }).click();
  await expect(run.locator('.ag-op').first()).toContainText('Undone');
  const after = await page.evaluate(async () => {
    const v = (window as any).__inkstoneHub.vault.vault;
    const note = (await v.listNotes()).find((n: any) => n.title === 'Atlas' && n.tags.includes('compiled'));
    return (await v.readPages(note))[0].texts[0].text as string;
  });
  expect(after).toContain('under 50 ms');
});

test('study: cards from a note, a calm review with a typed answer, FSRS rating; context pack download', async ({ page }) => {
  await openApp(page);
  await seed(page, [{ title: 'Physics', text: 'Embedding: a vector that represents meaning.\nLatency must stay under 50 ms.' }]);
  await openAssistantScreen(page, /^Study/);
  await page.getByLabel('Note to make cards from').selectOption({ label: 'Physics' });
  await page.getByRole('button', { name: 'Make cards' }).click();
  await expect(page.locator('.ag-item', { hasText: 'Physics' })).toContainText('2 cards · 2 due · 2 new');
  await page.locator('.ag-item', { hasText: 'Physics' }).getByRole('button', { name: 'Review' }).click();

  const review = page.getByRole('dialog', { name: 'Review' });
  await expect(review.locator('.cp-card-q')).toHaveText('What is Embedding?');
  await review.getByLabel('Your answer').fill('a vector that represents meaning');
  await review.getByRole('button', { name: 'Show answer' }).click();
  await expect(review.locator('.cp-grade')).toContainText('That matches.');
  await expect(review.locator('.cp-source')).toContainText('Physics · page 1');
  await expect(review.getByRole('button', { name: /^Good/ })).toContainText(/min|day/);
  await page.keyboard.press('3');
  await expect(review.locator('.cp-card-q')).toHaveText('Latency must stay under ___.');
  await page.keyboard.press('Space');
  await expect(review.locator('.cp-card-a')).toHaveText('50 ms');
  await page.keyboard.press('1');
  await expect(review).toContainText('Done for now: 2 cards reviewed.');
  const deck = await page.evaluate(async () => {
    const fs = (window as any).__inkstoneHub.vault.fs;
    const files = await fs.list('ai/study');
    return JSON.parse(await fs.readText(`ai/study/${files[0].name}`));
  });
  expect(deck.reviews.map((r: any) => r.rating)).toEqual([3, 1]);
  expect(deck.cards.every((c: any) => c.mem.reps === 1 && c.src)).toBe(true);
  await review.getByRole('button', { name: 'Close review' }).click();

  // Context pack from the editor's ••• menu.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Open Physics', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).__inkstone?.engine);
  await page.getByRole('button', { name: 'More', exact: true }).first().click();
  await page.getByRole('menuitem', { name: /^Context pack/ }).click();
  const packDialog = page.getByRole('dialog', { name: 'Context pack' });
  await packDialog.getByRole('button', { name: 'Build pack' }).click();
  await expect(packDialog.locator('.cp-preview')).toContainText('# Physics');
  const download = page.waitForEvent('download');
  await packDialog.getByRole('button', { name: 'Agent Skill (.zip)' }).click();
  expect((await download).suggestedFilename()).toBe('Physics skill.zip');
  await packDialog.getByRole('button', { name: /Save for agents/ }).click();
  await expect.poll(() => page.evaluate(async () => (await (window as any).__inkstoneHub.vault.fs.list('ai/packs')).length)).toBe(1);
});

/** An OpenAI-compatible mock that answers by what is asked: compile pages, chat with search, eval answers. */
async function mockLLM(page: Page) {
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    const sys = String(body.messages[0]?.content ?? '');
    const last = body.messages[body.messages.length - 1];
    const user = typeof last.content === 'string' ? last.content : (last.content ?? []).map((p: any) => p.text ?? '').join('');
    let msg: any;
    if (sys.includes('You compile one page')) {
      const refs = [...user.matchAll(/^(S\d+) \[[^\]]*\]: (.+)$/gm)];
      msg = { role: 'assistant', content: JSON.stringify({ sentences: [...refs.map(([, r, t]) => ({ text: t, sources: [r], tag: 'EXTRACTED' })), { text: 'Atlas runs on a quantum computer.', sources: ['S1'], tag: 'INFERRED' }] }) };
    } else if (sys.includes('Answer the question about the user')) {
      const p = /\[P1\] \([^)]*\) (.+)/.exec(user);
      msg = { role: 'assistant', content: p ? `${p[1]} [P1]` : "I don't know" };
    } else if (body.tools && last.role === 'user') {
      msg = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_memory', arguments: JSON.stringify({ query: 'latency limit' }) } }] };
    } else {
      const toolMsg = body.messages.filter((m: any) => m.role === 'tool').pop();
      // Tool results arrive inside the agent firewall's untrusted-content markers (docs/TRUST.md):
      // read the JSON between them, as a model would.
      const raw = toolMsg ? String(toolMsg.content) : '';
      const hit = raw ? JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).results?.[0] : null;
      msg = { role: 'assistant', content: hit ? `Latency must stay under 50 ms ([${hit.title}, p. ${hit.page}](${hit.link})). The moon is made of cheese.` : 'Nothing found.' };
    }
    if (body.stream) {
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const sse = msg.tool_calls ? chunk({ role: 'assistant', tool_calls: msg.tool_calls.map((t: any, index: number) => ({ index, ...t })) }) + chunk({}, 'tool_calls') : chunk({ content: msg.content }) + chunk({}, 'stop');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse + 'data: [DONE]\n\n' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 8 } }) });
  });
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

test('with an AI: validated model drafts, "Explain this answer" in the assistant, and the memory eval', async ({ page }) => {
  await mockLLM(page);
  await openApp(page);
  await seed(page, [...ATLAS, ...Array.from({ length: 4 }, (_, i) => ({ title: `Service ${i}`, text: `Service ${i} timeout must stay under ${(i + 2) * 10} ms.` }))]);
  await addCustomProvider(page);

  // A compile written by "My AI": the invented sentence never reaches the proposal.
  await page.getByRole('button', { name: /^Compiled wiki/ }).click();
  await page.getByLabel('Add a notebook').selectOption({ label: 'Atlas' });
  await page.getByRole('radio', { name: 'My AI' }).click();
  await page.getByRole('button', { name: 'Compile now' }).click();
  const item = itemNamed(page, '.cp-proposal .cp-item', 'Atlas');
  await expect(item).toContainText('Latency must stay under 50 ms.', { timeout: 15_000 });
  await expect(item.locator('.cp-claims')).not.toContainText('quantum');
  await item.locator('.cp-dropped summary').click();
  await expect(item.locator('.cp-dropped')).toContainText('Atlas runs on a quantum computer.');
  await expect(page.locator('.cp-proposal')).toContainText('Written by Custom');

  // The memory eval: honest numbers, saved in the vault.
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByLabel('Number of questions').selectOption('10');
  await page.getByRole('button', { name: 'Run the eval' }).click();
  const report = page.getByLabel('Memory eval results');
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report.getByRole('row', { name: /Model alone/ })).toContainText('0%');
  await expect(report.getByRole('row', { name: /With your notes/ })).toContainText('100%');
  await expect(report).toContainText(/too few to tell|No significant difference|answered more questions/);

  // Ask in the assistant; Explain separates what the notes support from what they don't.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Open Requirements', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).__inkstone?.engine);
  // A quiet badge beside the sentence another note disagrees with; tap shows both sides.
  const badge = page.getByRole('button', { name: 'This disagrees with another note' });
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await badge.click();
  await expect(page.locator('.cp-badge-pop .cp-conflict')).toContainText('The new pipeline averages 110 ms.');
  await page.keyboard.press('Escape');
  await page.locator('.ai-btn').click();
  await page.locator('.ai-input textarea').fill('What is the latency limit?');
  await page.locator('.ai-input textarea').press('Enter');
  const answer = page.locator('.ai-msg.is-assistant').last();
  await expect(answer).toContainText('The moon is made of cheese.');
  await answer.getByRole('button', { name: 'Explain' }).click();
  const dialog = page.getByRole('dialog', { name: /Explain: Answer/ });
  await dialog.getByRole('button', { name: /Latency must stay under 50 ms/ }).click();
  await expect(dialog.locator('.cp-detail .cp-tag')).toHaveText('Extracted');
  await expect(dialog.locator('.cp-source')).toContainText('Requirements');
  await expect(dialog.locator('.cp-gen')).toContainText('assistant.chat/1');
  await dialog.getByRole('button', { name: /moon is made of cheese/ }).click();
  await expect(dialog.locator('.cp-detail .cp-tag')).toHaveText('Not from your notes');
});
