import { describe, expect, it } from 'vitest';
import {
  ALWAYS_EXCLUDED_APPS,
  MemoryFS,
  RecallStore,
  capturePath,
  dayOfCapturePath,
  daysToPrune,
  decodeCaptures,
  decodeRecallConfig,
  encodeCaptures,
  frameDifference,
  highlightLine,
  initialPace,
  inkMomentsBetween,
  isPrivateWindow,
  lineKinds,
  momentsNear,
  nextDelayMs,
  noteSpans,
  parseRecallQuery,
  recordLook,
  retentionCutoff,
  searchCaptures,
  shouldCapture,
  switchedWindow,
  type Capture,
  type CaptureContext,
  type FrameSignature,
  type PageInk,
} from '../src/index.ts';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// Sunday 8 Nov 2026, 20:00 local.
const NOW = at(2026, 11, 8, 20);

const ctx = (over: Partial<CaptureContext> = {}): CaptureContext => ({
  now: NOW,
  window: { app: 'Terminal', title: 'zsh — ~/thesis' },
  idleSec: 3,
  locked: false,
  secureInput: false,
  pausedUntil: null,
  config: { excludedApps: [], excludedTitles: [] },
  ...over,
});

describe('capture rules', () => {
  it('captures an ordinary window', () => {
    expect(shouldCapture(ctx())).toEqual({ capture: true });
  });

  it('never captures while paused, locked, away or with a password field focused', () => {
    expect(shouldCapture(ctx({ pausedUntil: NOW + 60_000 }))).toEqual({ capture: false, reason: 'paused' });
    expect(shouldCapture(ctx({ pausedUntil: NOW - 1 }))).toEqual({ capture: true });
    expect(shouldCapture(ctx({ locked: true }))).toEqual({ capture: false, reason: 'locked' });
    expect(shouldCapture(ctx({ idleSec: 600 }))).toEqual({ capture: false, reason: 'idle' });
    expect(shouldCapture(ctx({ secureInput: true }))).toEqual({ capture: false, reason: 'password-field' });
    expect(shouldCapture(ctx({ window: null }))).toEqual({ capture: false, reason: 'no-window' });
  });

  it('never captures password managers, whatever the settings say', () => {
    expect(ALWAYS_EXCLUDED_APPS.length).toBeGreaterThan(10);
    for (const app of ['1Password 8', 'Bitwarden', 'KeePassXC', 'Keychain Access']) expect(shouldCapture(ctx({ window: { app, title: 'Vault' } }))).toEqual({ capture: false, reason: 'excluded-app' });
    expect(shouldCapture(ctx({ window: { app: 'Passwords', title: '', bundleId: 'com.apple.Passwords' } }))).toMatchObject({ reason: 'excluded-app' });
  });

  it('honours the user\'s app and title exclusions (case-insensitive substrings)', () => {
    const config = { excludedApps: ['slack'], excludedTitles: ['My Bank'] };
    expect(shouldCapture(ctx({ config, window: { app: 'Slack', title: 'general' } }))).toMatchObject({ reason: 'excluded-app' });
    expect(shouldCapture(ctx({ config, window: { app: 'Firefox', title: 'Statement — my bank online' } }))).toMatchObject({ reason: 'excluded-title' });
    expect(shouldCapture(ctx({ config, window: { app: 'Firefox', title: 'Recipes' } }))).toEqual({ capture: true });
  });

  it('recognises private and incognito windows from their titles or the shell', () => {
    const cases: Array<[string, string, boolean]> = [
      ['Firefox', 'Bank — Mozilla Firefox Private Browsing', true],
      ['Google Chrome', 'New Tab - Google Chrome (Incognito)', true],
      ['Microsoft Edge', 'Start - [InPrivate] - Microsoft Edge', true],
      ['Tor Browser', 'Search', true],
      ['Firefox', 'The private life of plants — Mozilla Firefox', false],
      ['Google Chrome', 'Pricing - Google Chrome', false],
    ];
    for (const [app, title, priv] of cases) expect(isPrivateWindow({ app, title }), title).toBe(priv);
    expect(shouldCapture(ctx({ window: { app: 'Safari', title: 'Bank', private: true } }))).toMatchObject({ reason: 'private-window' });
  });

  it('never captures Inkwright itself', () => {
    expect(shouldCapture(ctx({ window: { app: 'Inkwright', title: 'Physics' } }))).toMatchObject({ reason: 'own-app' });
    expect(shouldCapture(ctx({ window: { app: 'inkwright', title: '', bundleId: 'app.inkwright' } }))).toMatchObject({ reason: 'own-app' });
  });
});

describe('capture pace and change detection', () => {
  const sig = (fill: (i: number) => number): FrameSignature => ({ width: 64, height: 40, cells: Uint8Array.from({ length: 64 * 40 }, (_, i) => fill(i)) });

  it('a blinking cursor is not a change; a new line of text is', () => {
    const a = sig(() => 240);
    const cursor = sig((i) => (i === 700 ? 30 : 240));
    const line = sig((i) => (i >= 1280 && i < 1300 ? 40 : 240));
    expect(frameDifference(a, cursor)).toBeLessThan(0.004);
    expect(frameDifference(a, line)).toBeGreaterThan(0.004);
    expect(frameDifference(null, a)).toBe(1);
    expect(frameDifference(sig(() => 0), { width: 32, height: 20, cells: new Uint8Array(640) })).toBe(1);
  });

  it('backs off while nothing changes and looks again soon after a window switch', () => {
    const w = { app: 'Terminal', title: 'zsh' };
    let pace = initialPace();
    expect(nextDelayMs(pace, 20, w)).toBe(20_000);
    pace = recordLook(pace, w, true);
    for (let i = 0; i < 3; i++) pace = recordLook(pace, w, false);
    expect(nextDelayMs(pace, 20, w)).toBe(40_000);
    for (let i = 0; i < 20; i++) pace = recordLook(pace, w, false);
    expect(nextDelayMs(pace, 20, w)).toBe(160_000); // capped at 8×
    const other = { app: 'Firefox', title: 'Docs' };
    expect(switchedWindow(pace, other)).toBe(true);
    expect(nextDelayMs(pace, 20, other)).toBe(3000);
    pace = recordLook(pace, other, false);
    expect(pace.unchanged).toBe(0); // a different window resets the back-off
  });
});

describe('capture files and config', () => {
  it('paths are per local day, hour and device', () => {
    const p = capturePath(at(2026, 11, 3, 9, 41), 'mac/Studio 1');
    expect(p).toBe('recall/2026-11-03/09-macStudio1.jsonl');
    expect(dayOfCapturePath(p)).toBe('2026-11-03');
    expect(dayOfCapturePath('recall/config.json')).toBeNull();
    expect(dayOfCapturePath('recall/2026-13-40/09-a.jsonl')).toBeNull();
  });

  it('round-trips captures and skips torn lines', () => {
    const cs: Capture[] = [{ id: 'a', at: 1, kind: 'screen', app: 'Terminal', text: 'npm test', redacted: { email: 1 } }, { id: 'b', at: 2, end: 9, kind: 'audio', text: 'hello' }];
    const text = encodeCaptures(cs) + '{"id":"c","at":3,"kin';
    expect(decodeCaptures(text)).toEqual(cs);
    expect(decodeCaptures('{"id":"x","at":1,"kind":"video","text":""}\n')).toEqual([]);
  });

  it('config falls back to safe defaults and clamps values', () => {
    expect(decodeRecallConfig(null)).toMatchObject({ retentionDays: 14, intervalSec: 20, microphone: false });
    expect(decodeRecallConfig('{"retentionDays": 0, "intervalSec": 1, "excludedApps": ["Slack", 3, " "], "microphone": "yes"}')).toMatchObject({ retentionDays: 1, intervalSec: 5, excludedApps: ['Slack'], microphone: false });
    expect(decodeRecallConfig('not json').retentionDays).toBe(14);
  });
});

describe('retention and erasing', () => {
  it('works out which days go whole and which day is trimmed', () => {
    const cutoff = retentionCutoff(NOW, 14);
    expect(new Date(cutoff).getDate()).toBe(25); // 25 Oct, 20:00
    const { whole, partial } = daysToPrune(['2026-11-08', '2026-10-26', '2026-10-25', '2026-10-24', '2026-10-01'], cutoff);
    expect(whole.sort()).toEqual(['2026-10-01', '2026-10-24']);
    expect(partial).toBe('2026-10-25');
  });

  it('prunes old captures, erases single moments and erases everything but the settings', async () => {
    const fs = new MemoryFS();
    const store = new RecallStore(fs, 'laptop');
    await store.writeConfig({ retentionDays: 14, intervalSec: 20, excludedApps: ['Slack'], excludedTitles: [], microphone: false }, NOW);
    const mk = (id: string, t: number): Capture => ({ id, at: t, kind: 'screen', app: 'Terminal', text: id });
    await store.append([mk('old', at(2026, 10, 1, 9)), mk('edge-early', at(2026, 10, 25, 8)), mk('edge-late', at(2026, 10, 25, 21)), mk('recent', at(2026, 11, 8, 9)), mk('recent2', at(2026, 11, 8, 9, 5))]);
    expect(await store.days()).toEqual(['2026-11-08', '2026-10-25', '2026-10-01']);
    const r = await store.prune(NOW, 14);
    expect(r).toEqual({ days: 1, captures: 1 });
    expect((await store.readRange(0, NOW + 1)).map((c) => c.id)).toEqual(['edge-late', 'recent', 'recent2']);
    expect(await store.erase(new Set(['recent']))).toBe(1);
    expect((await store.readDay('2026-11-08')).map((c) => c.id)).toEqual(['recent2']);
    await store.eraseAll();
    expect(await store.days()).toEqual([]);
    expect((await store.readConfig()).excludedApps).toEqual(['Slack']);
  });

  it('appends from two devices to separate files and reads them as one day', async () => {
    const fs = new MemoryFS();
    const a = new RecallStore(fs, 'mac');
    const b = new RecallStore(fs, 'pc');
    await Promise.all([a.append([{ id: '1', at: at(2026, 11, 3, 9, 1), kind: 'screen', text: 'one' }]), b.append([{ id: '2', at: at(2026, 11, 3, 9, 0), kind: 'screen', text: 'two', device: 'pc' }]), a.append([{ id: '3', at: at(2026, 11, 3, 9, 2), kind: 'screen', text: 'three' }])]);
    expect((await fs.list('recall/2026-11-03')).map((e) => e.name).sort()).toEqual(['09-mac.jsonl', '09-pc.jsonl']);
    expect((await a.readDay('2026-11-03')).map((c) => c.id)).toEqual(['2', '1', '3']);
    expect(await a.usage()).toMatchObject({ days: 1, captures: 3 });
  });
});

describe('searching the timeline', () => {
  // Tuesday 3 Nov 2026: a lecture 10:00–11:00 with a terminal open.
  const caps: Capture[] = [
    { id: 'c1', at: at(2026, 11, 3, 10, 5), kind: 'screen', app: 'Terminal', title: 'zsh', text: 'Last login: Tue\n$ ssh lab@cluster\n$ git clone https://github.com/example/fft-lab\n$ make bench' },
    { id: 'c2', at: at(2026, 11, 3, 10, 20), kind: 'screen', app: 'Firefox', title: 'Fourier transform - Wikipedia', text: 'The Fourier transform of a function\nhttps://en.wikipedia.org/wiki/Fourier_transform' },
    { id: 'c3', at: at(2026, 11, 3, 15, 0), kind: 'screen', app: 'Terminal', title: 'zsh', text: '$ npm run build\nerror TS2322: Type string is not assignable' },
    { id: 'c4', at: at(2026, 11, 2, 10, 15), kind: 'screen', app: 'Terminal', title: 'zsh', text: '$ make clean' },
    { id: 'c5', at: at(2026, 11, 3, 10, 40), end: at(2026, 11, 3, 10, 41), kind: 'audio', text: 'remember to run make bench before Friday' },
  ];
  const lecture = { noteId: 'n1', title: 'Signals lecture 7', from: at(2026, 11, 3, 10, 0), to: at(2026, 11, 3, 11, 0) };

  it('reads dates, parts of the day, times and apps out of the question', () => {
    const q = parseRecallQuery("what was that command in Tuesday's lecture", NOW);
    expect(q.terms).toEqual(['lecture']);
    expect(q.wants).toEqual(['command']);
    expect([q.from, q.to]).toEqual([at(2026, 11, 3), at(2026, 11, 4)]);
    expect(q.when).toContain('Tuesday');

    const y = parseRecallQuery('pricing yesterday afternoon', NOW);
    expect([y.from, y.to]).toEqual([at(2026, 11, 7, 12), at(2026, 11, 7, 18)]);
    expect(y.terms).toEqual(['pricing']);

    const t = parseRecallQuery('the error around 3pm on tuesday', NOW);
    expect([t.from, t.to]).toEqual([at(2026, 11, 3, 14), at(2026, 11, 3, 16)]);
    expect(t.wants).toEqual(['error']);

    const app = parseRecallQuery('make in Terminal last week', NOW, ['Terminal', 'Firefox']);
    expect(app.app).toBe('Terminal');
    expect(app.terms).toEqual(['make']);
    expect([app.from, app.to]).toEqual([at(2026, 10, 26), at(2026, 11, 2)]);

    expect(parseRecallQuery('3 Nov fourier', NOW)).toMatchObject({ from: at(2026, 11, 3), terms: ['fourier'] });
    expect(parseRecallQuery('2026-11-02', NOW)).toMatchObject({ from: at(2026, 11, 2), terms: [] });
    expect(parseRecallQuery('what was mentioned about friday', NOW).kind).toBe('audio');
    // "last Sunday" on a Sunday is a week ago; "Sunday" is today.
    expect(parseRecallQuery('last sunday', NOW).from).toBe(at(2026, 11, 1));
    expect(parseRecallQuery('sunday', NOW).from).toBe(at(2026, 11, 8));
  });

  it('finds the command from Tuesday\'s lecture through the note written at the time', () => {
    const q = parseRecallQuery("what was that command in Tuesday's lecture", NOW);
    const hits = searchCaptures(caps, q, { notes: [lecture] });
    expect(hits[0]!.capture.id).toBe('c1');
    expect(hits[0]!.lines.some((l) => l.includes('git clone'))).toBe(true);
    expect(hits[0]!.notes.map((n) => n.title)).toEqual(['Signals lecture 7']);
    // Monday's terminal and Tuesday afternoon's build are outside the lecture.
    expect(hits.map((h) => h.capture.id)).not.toContain('c4');
    expect(hits.map((h) => h.capture.id)).not.toContain('c3');
  });

  it('every word must be found; rarer words rank higher; a date alone lists the range', () => {
    expect(searchCaptures(caps, parseRecallQuery('fourier transform', NOW)).map((h) => h.capture.id)).toEqual(['c2']);
    expect(searchCaptures(caps, parseRecallQuery('fourier banana', NOW))).toEqual([]);
    const make = searchCaptures(caps, parseRecallQuery('make', NOW));
    expect(make.map((h) => h.capture.id).sort()).toEqual(['c1', 'c4', 'c5']);
    expect(searchCaptures(caps, parseRecallQuery('tuesday', NOW)).length).toBe(4);
    expect(searchCaptures(caps, parseRecallQuery('what was said about bench', NOW)).map((h) => h.capture.id)).toEqual(['c5']);
    expect(searchCaptures(caps, parseRecallQuery('errors tuesday', NOW)).map((h) => h.capture.id)).toEqual(['c3']);
  });

  it('classifies lines and highlights matches', () => {
    expect(lineKinds('$ git status')).toContain('command');
    expect(lineKinds('kubectl get pods -A')).toContain('command');
    expect(lineKinds('see https://example.com/a')).toContain('url');
    expect(lineKinds('Traceback (most recent call last):')).toContain('error');
    expect(lineKinds('The meeting moved to Friday')).toEqual([]);
    expect(highlightLine('$ git clone repo', ['clo'])).toEqual([{ text: '$ git ', hit: false }, { text: 'clone', hit: true }, { text: ' repo', hit: false }]);
  });
});

describe('moments and notes written at the same time', () => {
  it('finds the ink written around a capture, per page', () => {
    const t0 = at(2026, 11, 3, 10, 6);
    const page: PageInk = {
      id: 'p1', formatVersion: 2,
      strokes: [
        { id: 's1', pen: 'fountain', color: '#FF000000', size: 2, createdAt: t0, points: [{ x: 10, y: 10, t: 0 }, { x: 40, y: 12, t: 600 }] },
        { id: 's2', pen: 'fountain', color: '#FF000000', size: 2, createdAt: t0 + 3 * 3_600_000, points: [{ x: 10, y: 50, t: 0 }, { x: 40, y: 52, t: 300 }] },
      ],
      texts: [{ id: 't1', x: 0, y: 100, width: 200, text: 'FFT is O(n log n)', fontSize: 14, color: '#FF000000', font: 'sans', createdAt: t0 + 60_000 }],
    } as unknown as PageInk;
    const moments = inkMomentsBetween([{ meta: { id: 'n1', title: 'Signals lecture 7' }, pages: [page] }], at(2026, 11, 3, 10), at(2026, 11, 3, 11));
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ noteId: 'n1', pageIndex: 0, strokeIds: ['s1'], textIds: ['t1'] });
    expect(noteSpans(moments)).toEqual([{ noteId: 'n1', title: 'Signals lecture 7', from: t0, to: t0 + 60_000 }]);
    expect(momentsNear(moments, t0 + 4 * 60_000)).toHaveLength(1);
    expect(momentsNear(moments, t0 + 30 * 60_000)).toHaveLength(0);
  });
});
