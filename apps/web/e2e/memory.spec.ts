import { expect, test, type Page, type Route } from '@playwright/test';
import { openApp, settingsGroup } from './helpers.ts';

/**
 * The memory timeline and the journal that writes itself (docs/MEMORY_TIMELINE.md).
 *  1. The timeline over captures that arrived by sync (this browser can't capture): scrub by day
 *     and hour, see what was written at the same time, search in plain words, erase.
 *  2. The evening journal routine against a mocked model: sources from a note and an imported
 *     calendar, uncited paragraphs dropped, the draft written in AI ink with its sources.
 *  3. The desktop capture loop end to end with the Tauri bridge mocked (Chromium): a window's
 *     pixels → on-device OCR (tesseract.js, for real) → redaction → the vault folder → the timeline.
 */

const enableModules = (page: Page, ids: string[]) => page.addInitScript((on) => {
  const key = 'inkwright.modules.v1';
  const cur = JSON.parse(localStorage.getItem(key) ?? '{"enabled":{}}');
  for (const id of on) cur.enabled[id] = true;
  localStorage.setItem(key, JSON.stringify({ enabled: cur.enabled, preset: null }));
}, ids);

const hubReady = (page: Page) => page.waitForFunction(() => !!(window as any).__inkwrightHub);

/** Memory timeline and Journal are tabs of Settings › Knowledge (Desktop app: Sync & devices). */
async function openSettings(page: Page, section: string) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await settingsGroup(page, section === 'Desktop app' ? 'Sync & devices' : 'Knowledge', section);
}

test('memory timeline over synced captures: days, hours, notes written at the time, search, erase', async ({ page }) => {
  await enableModules(page, ['memory-timeline']);
  await openApp(page);
  await hubReady(page);
  // Captures as a desktop app would have synced them, and a lecture note written on Tuesday.
  const seeded = await page.evaluate(async () => {
    const hub = (window as any).__inkwrightHub;
    const today = new Date();
    const back = (today.getDay() - 2 + 7) % 7; // most recent Tuesday (today counts)
    const tue = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const at = (d: Date, h: number, m: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const mon = new Date(tue.getFullYear(), tue.getMonth(), tue.getDate() - 1);
    const line = (c: object) => JSON.stringify(c);
    await hub.vault.fs.writeText(`recall/${key(tue)}/10-laptop.jsonl`, [
      line({ id: 'c-clone', at: at(tue, 10, 5), kind: 'screen', app: 'Terminal', title: 'zsh — fft-lab', text: '$ ssh lab@cluster\n$ git clone https://github.com/example/fft-lab\n$ make bench', device: 'laptop' }),
      line({ id: 'c-wiki', at: at(tue, 10, 20), kind: 'screen', app: 'Firefox', title: 'Fast Fourier transform - Wikipedia', text: 'An FFT computes the DFT in O(n log n)\nWritten to [email] about the lab', redacted: { email: 1 }, device: 'laptop' }),
    ].join('\n') + '\n');
    await hub.vault.fs.writeText(`recall/${key(tue)}/15-laptop.jsonl`, line({ id: 'c-build', at: at(tue, 15, 2), kind: 'screen', app: 'Terminal', title: 'zsh', text: '$ npm run build\nerror TS2322: Type string is not assignable', device: 'laptop' }) + '\n');
    await hub.vault.fs.writeText(`recall/${key(mon)}/09-laptop.jsonl`, line({ id: 'c-mon', at: at(mon, 9, 30), kind: 'screen', app: 'Terminal', title: 'zsh', text: '$ make clean', device: 'laptop' }) + '\n');
    // The lecture note: ink written at 10:06 on Tuesday.
    const v = hub.vault.vault;
    const { note, pages } = await v.createNote({ title: 'Signals lecture 7' });
    const t0 = at(tue, 10, 6);
    const pts = Array.from({ length: 30 }, (_, i) => ({ x: 80 + i * 6, y: 120 + Math.sin(i) * 4, t: i * 30, p: 0.5, tilt: 0, orient: 0 }));
    await v.saveNote({ ...note, createdAt: t0 - 60_000, updatedAt: t0 + 60_000 }, [{ ...pages[0], strokes: [{ id: 's-lec', pen: 'fountain', color: '#FF1B1F24', size: 2.4, createdAt: t0, points: pts }] }]);
    return { tue: key(tue), mon: key(mon), noteId: note.id };
  });
  await page.reload();
  await expect(page.locator('.library')).toBeVisible();

  await openSettings(page, 'Memory timeline');
  await expect(page.getByText('Capturing needs the Inkwright desktop app', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/4 moments over 2 days/)).toBeVisible();
  await page.getByRole('button', { name: 'Open the timeline' }).click();
  const tl = page.getByRole('dialog', { name: 'Memory timeline' });
  await expect(tl).toBeVisible();
  await expect(tl.getByTestId('recall-status')).toContainText('Capturing needs the Inkwright desktop app');

  // The newest day opens first: Tuesday, with its hours.
  await expect(tl.locator('.rc-day.is-on')).toHaveCount(1);
  await expect(tl.locator('.rc-moment')).toHaveCount(3);
  await expect(tl.getByRole('button', { name: /^10:00, 2 moments$/ })).toBeEnabled();
  await expect(tl.getByRole('button', { name: /^15:00, 1 moment$/ })).toBeEnabled();
  await expect(tl.getByRole('button', { name: /^12:00, 0 moments$/ })).toBeDisabled();
  const clone = tl.locator('[data-capture="c-clone"]');
  await expect(clone).toContainText('git clone https://github.com/example/fft-lab');
  await expect(clone.getByRole('button', { name: 'Signals lecture 7' })).toBeVisible();
  await expect(tl.locator('[data-capture="c-wiki"]')).toContainText('Hidden before saving: 1 email');
  await expect(tl.locator('[data-capture="c-build"] .rc-notes')).toHaveCount(0);

  // Monday.
  await tl.locator('.rc-day').filter({ hasNotText: /^(Today|Yesterday)$/ }).last().click();
  await expect(tl.locator('.rc-moment')).toHaveCount(1);
  await expect(tl.locator('.rc-moment')).toContainText('make clean');

  // Plain-words search: the lecture is found through the note written at the time.
  await tl.getByLabel('Search the memory timeline').fill("what was that command in Tuesday's lecture");
  await expect(tl.locator('.rc-summary')).toContainText(/moment/);
  const first = tl.locator('.rc-hit').first();
  await expect(first).toContainText('git clone');
  await expect(first.getByRole('button', { name: 'Signals lecture 7' })).toBeVisible();
  await expect(tl.locator('.rc-hit')).not.toContainText(['make clean']);
  await tl.getByLabel('Search the memory timeline').fill('fourier banana');
  await expect(tl.locator('.rc-summary')).toHaveText('Nothing found');
  await tl.getByLabel('Search the memory timeline').fill('');

  // Erase one moment: gone from the view and from the file.
  await tl.locator('.rc-day').first().click();
  await tl.locator('[data-capture="c-build"]').getByRole('button', { name: 'Erase this moment' }).click();
  await expect(tl.locator('[data-capture="c-build"]')).toHaveCount(0);
  const file = await page.evaluate((day) => (window as any).__inkwrightHub.vault.fs.readText(`recall/${day}/15-laptop.jsonl`), seeded.tue);
  expect(file).toBeNull();
  // Sync can bring the file back (another device appended to it: an edit beats a deletion); the
  // erasure record keeps the moment hidden.
  await page.evaluate(async (day) => {
    const fs = (window as any).__inkwrightHub.vault.fs;
    const back = { id: 'c-build', at: new Date(`${day}T15:02:00`).getTime(), kind: 'screen', app: 'Terminal', title: 'zsh', text: '$ npm run build', device: 'laptop' };
    await fs.writeText(`recall/${day}/15-laptop.jsonl`, JSON.stringify(back) + '\n');
  }, seeded.tue);
  await tl.locator('.rc-day').nth(1).click();
  await tl.locator('.rc-day').first().click();
  await expect(tl.locator('[data-capture="c-clone"]')).toBeVisible();
  await expect(tl.locator('[data-capture="c-build"]')).toHaveCount(0);

  // A note written at the same moment opens at its page.
  await tl.locator('[data-capture="c-clone"]').getByRole('button', { name: 'Signals lecture 7' }).click();
  await expect(tl).toHaveCount(0);
  await page.waitForFunction((id) => (window as any).__inkwright?.doc?.meta?.id === id, seeded.noteId);

  // Erase everything (settings stay).
  await page.goto('/?e2e#settings/recall');
  await page.getByRole('button', { name: 'Erase everything' }).click();
  await page.getByRole('button', { name: 'Erase everything' }).last().click();
  await expect(page.getByText(/0 moments over 0 days/)).toBeVisible();
});

// ---- Journal ---------------------------------------------------------------------------------------

/** OpenAI-compatible mock (as in agent.spec.ts): scripted replies, JSON or SSE. */
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
  await settingsGroup(page, 'AI');
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-1');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await expect(page.locator('.prov-row')).toHaveCount(1);
}

test('the journal routine drafts the day in AI ink, citing a note and the calendar, dropping what is not backed', async ({ page }) => {
  await enableModules(page, ['journal']);
  const requests = await mockLLM(page, [
    { tool: 'journal_sources', args: {} },
    { tool: 'write_journal_draft', args: { paragraphs: [
      { text: 'Planned the team offsite, then worked through why the FFT is n log n.', sources: ['s1', 's2'] },
      { text: 'Felt on top of everything.', sources: [] },
    ] } },
    { text: 'Your journal draft for today is in your Journal.' },
  ]);
  await openApp(page);
  await hubReady(page);
  const today = await page.evaluate(async () => {
    const hub = (window as any).__inkwrightHub;
    const v = hub.vault.vault;
    // Only today's own writing counts: the welcome note the app made on first open goes.
    for (const n of await v.listNotes()) await v.trashNote(n.id);
    const { note, pages } = await v.createNote({ title: 'Fourier notes' });
    await v.saveNote(note, [{ ...pages[0], texts: [{ id: 't-fft', x: 64, y: 80, width: 600, text: 'The FFT computes the DFT in n log n time.', fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() }] }]);
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  });
  const dayTitle = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6)}`;
  await page.reload();
  await expect(page.locator('.library')).toBeVisible();
  await addCustomProvider(page);

  // Import a calendar with an all-day event today.
  await settingsGroup(page, 'Knowledge', 'Journal');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:offsite@example.com', `DTSTART;VALUE=DATE:${today}`, 'SUMMARY:Team offsite planning', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  await page.getByLabel('Calendar file').setInputFiles({ name: 'team.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await expect(page.locator('.jr-cals li')).toContainText('team');
  await expect(page.locator('.jr-cals li')).toContainText('1 event');
  const stored = await page.evaluate(() => (window as any).__inkwrightHub.vault.fs.readText('ai/journal/config.json'));
  expect(JSON.parse(stored).calendars[0]).toMatchObject({ name: 'team', source: 'file', events: 1 });

  // Set up the evening routine, then draft today now.
  await page.getByRole('button', { name: 'Set up' }).click();
  await expect(page.getByText('Every day at 21:30')).toBeVisible();
  await page.getByRole('button', { name: 'Draft today now' }).click();
  await expect(page.getByRole('button', { name: 'Draft today now' })).toBeEnabled({ timeout: 20_000 });

  // The model saw the day's sources: the event first (all day), then the note.
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  const toolResult = JSON.stringify(requests[1].messages.filter((m: any) => m.role === 'tool'));
  expect(toolResult).toContain('Team offsite planning');
  expect(toolResult).toContain('The FFT computes the DFT in n log n time.');

  // The draft became today's daily note, in AI ink, with its sources.
  await page.goto('/?e2e');
  await expect(page.locator('.note-card', { hasText: dayTitle })).toHaveCount(1);
  await page.locator('.note-card', { hasText: dayTitle }).click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.doc);
  const content = await page.evaluate(() => {
    const doc = (window as any).__inkwright.doc;
    const p = doc.page(0);
    return { aiStrokes: p.strokes.filter((s: any) => s.origin === 'ai').length, userStrokes: p.strokes.filter((s: any) => s.origin !== 'ai').length, texts: (p.texts ?? []).map((t: any) => ({ text: t.text as string, origin: t.origin as string | undefined })) as Array<{ text: string; origin?: string }>, tags: doc.meta.tags, daily: doc.meta.daily };
  });
  expect(content.aiStrokes).toBeGreaterThan(20);
  expect(content.userStrokes).toBe(0);
  expect(content.tags).toContain('journal');
  expect(content.daily).toBe(dayTitle);
  const all = content.texts.map((t) => t.text).join('\n');
  expect(content.texts.every((t) => t.origin === 'ai')).toBe(true);
  expect(all).toContain('Journal draft, written by AI from your day.');
  expect(all).toContain('1. Team offsite planning — calendar');
  expect(all).toMatch(/2\. \[Fourier notes\]\(#mem\/[^)]+\) — your note/);
  expect(all).not.toContain('Felt on top');
  // Provenance for Explain: the ink body's sentence cites the note, and says the calendar too.
  const prov = JSON.parse(await page.evaluate(() => { const w = window as any; return w.__inkwrightHub.vault.fs.readText(`notes/${w.__inkwright.doc.meta.id}/assets/provenance.json`); }));
  const [key, item] = Object.entries(prov.items)[0] as [string, { claims: Array<{ s: string; src: string[]; why?: string }> }];
  expect(key).toMatch(/^ink:/);
  expect(item.claims[0]!.s).toContain('[1, 2]');
  expect(item.claims[0]!.src[0]).toMatch(/^[0-9A-Za-z_-]+\/1\//);
  expect(item.claims[0]!.why).toBe('Also from: calendar');

  // AI activity lists the draft, with undo.
  const runs = await page.evaluate(() => (window as any).__inkwrightHub.activity.list());
  expect(JSON.stringify(runs)).toContain(`Drafted the journal for ${dayTitle}`);
});

// ---- The desktop capture loop, with the Tauri bridge mocked ------------------------------------------

/**
 * Stands in for the desktop shell: the vault folder as an in-memory map (so DesktopFS is
 * exercised), and a "window in front" whose pixels are text drawn on a canvas. Everything else —
 * the capture rules, change detection, tesseract.js OCR, redaction, storage — is the real app.
 */
function mockDesktopShell() {
  const w = window as any;
  const files = new Map<string, Uint8Array>();
  const mock = { files, tray: [] as string[], grabs: 0, window: { app: 'Terminal', title: 'zsh — deploy' } as { app: string; title: string } };
  w.__shell = mock;
  let next = 1;
  const callbacks = new Map<number, unknown>();
  const frame = () => {
    const W = 900, H = 240;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#000000'; g.font = '34px sans-serif';
    g.fillText('npm run deploy staging', 24, 80);
    g.fillText('mail ada.lovelace@example.com', 24, 170);
    const px = g.getImageData(0, 0, W, H).data;
    const gray = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) gray[i] = (px[i * 4]! * 77 + px[i * 4 + 1]! * 150 + px[i * 4 + 2]! * 29) >> 8;
    const SW = 64, SH = 40;
    const sig = new Uint8Array(SW * SH);
    for (let cy = 0; cy < SH; cy++) for (let cx = 0; cx < SW; cx++) {
      let sum = 0, n = 0;
      for (let y = Math.floor((cy * H) / SH); y < Math.floor(((cy + 1) * H) / SH); y++) for (let x = Math.floor((cx * W) / SW); x < Math.floor(((cx + 1) * W) / SW); x++) { sum += gray[y * W + x]!; n++; }
      sig[cy * SW + cx] = n ? Math.round(sum / n) : 0;
    }
    const out = new Uint8Array(16 + sig.length + gray.length);
    new Uint32Array(out.buffer, 0, 4).set([SW, SH, W, H]);
    out.set(sig, 16);
    out.set(gray, 16 + sig.length);
    return out.buffer;
  };
  const list = (dir: string) => {
    const pre = dir ? `${dir}/` : '';
    const seen = new Map<string, { name: string; kind: string; size?: number }>();
    for (const [p, b] of files) {
      if (!p.startsWith(pre)) continue;
      const [name, ...more] = p.slice(pre.length).split('/');
      if (!seen.has(name!)) seen.set(name!, more.length ? { name: name!, kind: 'dir' } : { name: name!, kind: 'file', size: b.length });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    transformCallback(cb: unknown) { const id = next++; callbacks.set(id, cb); return id; },
    unregisterCallback(id: number) { callbacks.delete(id); },
    convertFileSrc: (p: string) => p,
    async invoke(cmd: string, args: any, options?: { headers?: Record<string, string> }) {
      switch (cmd) {
        case 'vault_read': { const b = files.get(args.path); if (!b) throw 'ENOENT'; return b.slice().buffer; }
        case 'vault_write': files.set(decodeURIComponent(options!.headers!['x-vault-path']!), new Uint8Array(args).slice()); return null;
        case 'vault_delete': files.delete(args.path); return null;
        case 'vault_delete_dir': for (const p of [...files.keys()]) if (p.startsWith(`${args.path}/`)) files.delete(p); return null;
        case 'vault_list': return list(args.path);
        case 'desktop_info': return { version: '1.0.0', os: 'macos', arch: 'aarch64', vaultDir: '/Users/ada/Documents/Inkwright', keepInTray: true, mcpEnabled: true, mcpPort: 7337, updatesConfigured: false, sidecarBundled: true };
        case 'opened_files_take': return [];
        case 'plugin:event|listen': return next++;
        case 'plugin:event|unlisten': return null;
        case 'plugin:deep-link|get_current': return null;
        case 'plugin:autostart|is_enabled': return false;
        case 'mcp_status': return { running: true, url: 'http://127.0.0.1:7337/mcp', binary: '/Applications/Inkwright.app/Contents/MacOS/inkwright-mcp', error: null, log: [], enabled: true, port: 7337, token: 'f'.repeat(64) };
        case 'recall_probe': return { window: mock.window, idleSec: 1, locked: false, secureInput: false, canDetectSecureInput: true, permitted: true, wayland: false, platform: 'macos' };
        case 'recall_grab': mock.grabs++; return frame();
        case 'recall_tray_state': mock.tray.push(args.value); return null;
        case 'recall_request_permission': return true;
        default: throw `The mock shell has no command ${cmd}`;
      }
    },
  };
}

test('desktop capture loop: the window in front is read on the device, redacted, stored in the vault folder and shown', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The mocked desktop shell runs tesseract.js in Chromium, the engine of the Windows and Linux desktop apps.');
  test.setTimeout(120_000);
  await enableModules(page, ['memory-timeline']);
  await page.addInitScript(mockDesktopShell);
  await openApp(page);
  // The vault lives in the "folder" (DesktopFS over the shell), not IndexedDB.
  await expect.poll(() => page.evaluate(() => [...(window as any).__shell.files.keys()].some((p: string) => p.startsWith('notes/')))).toBe(true);

  await openSettings(page, 'Memory timeline');
  await page.getByRole('switch', { name: /Capture my screen/ }).click({ force: true });
  await page.getByRole('button', { name: 'Start capturing' }).click();
  await expect(page.getByTestId('recall-settings-status')).toContainText('Capturing · last saved', { timeout: 90_000 });

  const stored = await page.evaluate(() => {
    const files: Map<string, Uint8Array> = (window as any).__shell.files;
    const dec = new TextDecoder();
    return [...files].filter(([p]) => /^recall\/\d{4}-\d{2}-\d{2}\/\d{2}-[\w-]+\.jsonl$/.test(p)).map(([, b]) => dec.decode(b)).join('');
  });
  expect(stored).toContain('deploy');
  expect(stored).toContain('[email]');
  expect(stored).not.toContain('lovelace');
  expect(stored).not.toContain('example.com');
  const capture = JSON.parse(stored.trim().split('\n')[0]!);
  expect(capture).toMatchObject({ kind: 'screen', app: 'Terminal', title: 'zsh — deploy', engine: 'tesseract.js 7 · eng', redacted: { email: 1 } });
  expect(await page.evaluate(() => (window as any).__shell.tray)).toContain('on');

  await page.getByRole('button', { name: 'Open the timeline' }).click();
  const tl = page.getByRole('dialog', { name: 'Memory timeline' });
  // The same screen looked at again is not stored twice.
  await expect(tl.locator('.rc-moment')).toHaveCount(1);
  await expect(tl.locator('.rc-moment')).toContainText('deploy');
  await expect(tl.locator('.rc-moment')).toContainText('Hidden before saving: 1 email');

  // A password manager in front: nothing is grabbed.
  await page.evaluate(() => { (window as any).__shell.window = { app: '1Password', title: 'Vault' }; });
  await expect(tl.getByTestId('recall-status')).toHaveText('This app is excluded', { timeout: 15_000 });
  const before = await page.evaluate(() => (window as any).__shell.grabs);
  await page.waitForTimeout(4000);
  expect(await page.evaluate(() => (window as any).__shell.grabs)).toBe(before);

  // Pause from the timeline; the tray follows.
  await tl.getByRole('button', { name: 'Pause for an hour' }).click();
  await expect(tl.getByTestId('recall-status')).toHaveText('Paused');
  await expect.poll(() => page.evaluate(() => (window as any).__shell.tray.at(-1))).toBe('paused');
  await tl.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('switch', { name: /Capture my screen/ }).click({ force: true });
  await expect.poll(() => page.evaluate(() => (window as any).__shell.tray.at(-1))).toBe('off');
});
