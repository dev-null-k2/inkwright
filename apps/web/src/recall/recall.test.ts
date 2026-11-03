import { describe, expect, it, vi, afterEach } from 'vitest';
import { DEFAULT_RECALL_CONFIG, MemoryFS, RecallStore } from '@inkwright/core';
import { parseFrame, startRecall } from './service.ts';
import { useRecall } from './state.ts';
import { useApp } from '../state/app.ts';
import { vaultChanged } from '../lib/vaultChanges.ts';
import type { AppVault } from '../lib/vault.ts';
import { parseRecallHref } from './ui.ts';
import { decodeJournalConfig, checkCalendar } from '../journal/config.ts';
import { changedNoteIds, needsFullRescan } from '../desktop/integration.ts';

describe('memory timeline in the app', () => {
  it('parses the shell\'s frame layout and refuses truncated frames', () => {
    const sig = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const gray = Uint8Array.from({ length: 12 }, (_, i) => i * 10);
    const bytes = new Uint8Array(16 + sig.length + gray.length);
    new DataView(bytes.buffer).setUint32(0, 3, true);
    new DataView(bytes.buffer).setUint32(4, 2, true);
    new DataView(bytes.buffer).setUint32(8, 4, true);
    new DataView(bytes.buffer).setUint32(12, 3, true);
    bytes.set(sig, 16);
    bytes.set(gray, 22);
    const f = parseFrame(bytes);
    expect(f.sig).toMatchObject({ width: 3, height: 2 });
    expect([...f.sig.cells]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([f.width, f.height, f.gray.length, f.gray[11]]).toEqual([4, 3, 12, 110]);
    expect(() => parseFrame(bytes.subarray(0, 30))).toThrow(/Truncated/);
  });

  it('reads #recall links', () => {
    expect(parseRecallHref('#recall/1793736060000')).toBe(1793736060000);
    expect(parseRecallHref('#recall/abc')).toBeNull();
    expect(parseRecallHref('#mem/x/1')).toBeNull();
  });
});

describe('journal settings', () => {
  it('decodes the config defensively', () => {
    expect(decodeJournalConfig(null)).toMatchObject({ style: 'ink', hand: 'script', includeTimeline: true, calendars: [] });
    const c = decodeJournalConfig(JSON.stringify({ style: 'typed', hand: 'print', includeTimeline: false, calendars: [{ id: 'a1', name: 'Work', source: 'url', host: 'calendar.google.com', events: 3, updatedAt: 5 }, { id: '../x', name: 'Bad' }, null] }));
    expect(c).toMatchObject({ style: 'typed', hand: 'print', includeTimeline: false });
    expect(c.calendars).toEqual([{ id: 'a1', name: 'Work', source: 'url', host: 'calendar.google.com', events: 3, updatedAt: 5 }]);
    expect(decodeJournalConfig('{oops').style).toBe('ink');
  });

  it('accepts only calendar files', () => {
    expect(checkCalendar('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261103T090000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR')).toBe(1);
    expect(() => checkCalendar('<html>Sign in</html>')).toThrow(/not a calendar/);
  });
});

describe('desktop: changes made outside the app', () => {
  it('maps changed paths to notes, and folder-level changes to a full rescan', () => {
    expect(changedNoteIds(['notes/A1/note.json', 'notes/A1/pages/p.ink.json', 'notes/B2', 'recall/2026-11-03/09-mac.jsonl', 'ai/routines/r.json'])).toEqual(['A1', 'B2']);
    expect(needsFullRescan(['notes'])).toBe(true);
    expect(needsFullRescan(['notes/A1/note.json'])).toBe(false);
  });
});

describe('memory timeline settings changed on another device', () => {
  it('apply as soon as sync or the folder watcher reports files under recall/', async () => {
    const fs = new MemoryFS();
    useApp.setState({ vault: { fs } as unknown as AppVault });
    const stop = startRecall();
    try {
      await vi.waitFor(() => expect(useRecall.getState().configLoaded).toBe(true));
      // The other device writes the shared settings; this one hears about it through a sync.
      await new RecallStore(fs, 'other').writeConfig({ ...DEFAULT_RECALL_CONFIG, excludedApps: ['Slack'] });
      vaultChanged(['notes/a/note.json']);
      await new Promise((r) => setTimeout(r, 20));
      expect(useRecall.getState().config.excludedApps).toEqual([]);
      const version = useRecall.getState().version;
      vaultChanged(['notes/a/note.json', 'recall/config.json']);
      await vi.waitFor(() => expect(useRecall.getState().config.excludedApps).toEqual(['Slack']));
      expect(useRecall.getState().version).toBeGreaterThan(version);
    } finally {
      stop();
      useApp.setState({ vault: null });
    }
  });
});

describe('DesktopFS over the shell', () => {
  afterEach(() => { vi.resetModules(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

  it('maps VaultFS calls to shell commands: raw bytes, the path in a header, missing files as null', async () => {
    const calls: Array<{ cmd: string; args: unknown; headers?: Record<string, string> }> = [];
    const files = new Map<string, Uint8Array>([['notes/a/note.json', new TextEncoder().encode('{"id":"a"}')]]);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      async invoke(cmd: string, args: any, options?: { headers?: Record<string, string> }) {
        calls.push({ cmd, args, headers: options?.headers });
        if (cmd === 'vault_read') { const b = files.get(args.path); if (!b) throw 'ENOENT'; return b.buffer; }
        if (cmd === 'vault_write') { files.set(decodeURIComponent(options!.headers!['x-vault-path']!), new Uint8Array(args)); return null; }
        if (cmd === 'vault_list') return [{ name: 'a', kind: 'dir' }];
        if (cmd === 'vault_read_fail') throw 'EACCES';
        return null;
      },
    };
    vi.resetModules(); // bridge.ts decides isDesktop when it loads
    const { DesktopFS } = await import('../desktop/fs.ts');
    const fs = new DesktopFS();
    expect(await fs.readText('notes/a/note.json')).toBe('{"id":"a"}');
    expect(await fs.readText('notes/missing/note.json')).toBeNull();
    await fs.writeText('notes/b c/note.json', 'é');
    expect(new TextDecoder().decode(files.get('notes/b c/note.json'))).toBe('é');
    expect(calls.find((c) => c.cmd === 'vault_write')!.headers).toEqual({ 'x-vault-path': 'notes%2Fb%20c%2Fnote.json' });
    expect(await fs.list('')).toEqual([{ name: 'a', kind: 'dir' }]);
    await expect(fs.readText('notes/../etc/passwd')).rejects.toThrow(/escapes/);
  });
});
