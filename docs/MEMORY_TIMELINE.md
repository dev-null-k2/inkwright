# Memory timeline and the journal that writes itself

Two opt-in modules that use what your day held: the **memory timeline** remembers what was on
your screen (and, if you want, what was said near your computer) so you can find it again, and the
**journal that writes itself** drafts each evening's journal entry from your day for you to correct
with the pen.

Rewind (macOS, closed source) shut down and Screenpipe is no longer open-source licensed. The
memory timeline is an open alternative with a narrower, privacy-first design: text only, redacted
before it is stored, kept in your own vault for a time you choose, and never sent anywhere unless
you ask your own AI about it.

Both modules are **off by default** and **no preset switches them on** (`OPT_IN_ONLY` in
`apps/web/src/recall/modules.ts`). Capturing is switched on separately on each computer.

| | macOS | Windows | Linux (X11) | Linux (Wayland) | Web, Android, iOS |
|---|---|---|---|---|---|
| Capture the screen | Desktop app | Desktop app | Desktop app | No (see below) | No |
| Know a password field has focus | Yes (`IsSecureEventInputEnabled`) | Yes (UI Automation `IsPassword`) | No | — | — |
| Idle / screen locked | Idle (CoreGraphics); lock via idle | Idle (`GetLastInputInfo`); lock via idle | Idle and lock (GNOME, KDE over D-Bus) | — | — |
| Microphone transcription | Desktop app, on-device model | Desktop app, on-device model | Desktop app, on-device model | Desktop app, on-device model | No |
| Browse, search, erase the timeline | Yes | Yes | Yes | Yes | Yes (synced captures) |
| Journal drafts | Yes | Yes | Yes | Yes | Yes |

The desktop app keeps running in the tray when its window is closed (docs/DESKTOP.md), so capture
and the evening journal keep working.

## The memory timeline

### What happens when capture is on

Code: `apps/web/src/recall/service.ts` (the loop), `packages/core/src/recall/schedule.ts` (the
rules), `apps/desktop/src-tauri/src/recall.rs` (window facts and pixels),
`apps/web/src/recall/ocr.ts`, `packages/ai/src/recall/redact.ts`.

1. Every 3 seconds the app asks the desktop shell which window is in front, how long you have been
   idle, whether the screen is locked and whether a password field has focus. This is cheap: no
   pixels.
2. `shouldCapture` decides. It **never** captures while paused, locked, idle for two minutes or
   more, with no window in front, **Inkwright itself**, **while a password field has focus** (where
   the OS can tell), **password managers and credential apps** (1Password, Bitwarden, KeePass(XC),
   LastPass, Dashlane, Enpass, Proton Pass, Keychain Access, Passwords, authenticator apps and more —
   a fixed list the settings cannot remove), **private and incognito browser windows** (by title:
   Firefox, Chrome and Edge on Windows and Linux, Brave, Opera, Vivaldi, Tor Browser), and the apps
   and window titles you exclude. The reason is shown in the timeline's status line.
3. When it is time for a look (every 20 s while the screen changes, backing off to 8× that while it
   doesn't, 3 s after you switch windows), the shell captures **only the window in front** and
   returns a 64 × 40 luminance signature and a grayscale image. If fewer than 0.4 % of the
   signature's cells changed (a blinking cursor, a clock), nothing more happens.
4. The text is recognised **on the device** (below).
5. The text, the window title and the page address are **redacted** (below), then appended to the
   vault. Pixels are dropped; nothing visual is ever stored. A capture whose lines were all in the
   previous capture of the same window is not stored again.

### On-device OCR: why tesseract.js

The app's handwriting recognizers read ink strokes, not pixels, so screen text needs an OCR engine.
Inkwright uses **tesseract.js 7** (Tesseract 5's LSTM engine compiled to WebAssembly, Apache-2.0) in
a Web Worker, with the English model (`4.0.0_best_int`) **bundled in the desktop app** — nothing is
downloaded at run time and the worker is released after three idle minutes.

- One engine on every desktop OS, so one behaviour to test — it runs in this repository's e2e suite
  (`e2e/memory.spec.ts`), on real pixels.
- Linux has no system OCR; macOS's Vision and Windows.Media.Ocr are faster and better on their
  systems and are the obvious next engines behind the same `recognize()` seam.
- Cost: the bundled files are about 7 MB (only in the desktop build). Recognising a full window
  takes a few seconds of one core (longer for the first capture, while the worker starts); HiDPI
  windows are halved before OCR. Because frames that didn't change are skipped and the pace backs
  off, a quiet screen costs almost nothing. These are estimates, not measurements on the release
  targets; measure on a real Mac and PC before quoting numbers.

### Microphone (optional)

`apps/web/src/recall/mic.ts` reuses the app's speech pipeline (voice activity detection, 10–30 s
windows, Whisper or Moonshine in the on-device AI worker). **Only on-device engines are allowed**:
the browser speech service and AI providers would send audio away, so the timeline refuses them
and asks you to download an on-device model instead. Audio is never stored — only the redacted
text, as `audio` captures.

### Redaction before storage

`redactCapture` runs the trust layer's privacy firewall (`detectPii`, `packages/ai/src/trust/pii.ts`,
the same recognizers and validators that guard every AI request, docs/TRUST.md) over the text, the
window title and the page address before anything is written. Unlike the firewall's reversible
placeholders, this is one-way: values become `[email]`, `[phone]`, `[card number]`,
`[bank account]`, `[ID number]`, `[secret]` (API keys, tokens, passwords in `password=`-style text,
private keys, high-entropy strings), `[address]`, `[name]` (names in recognisable contexts) and
`[IP address]`; only a count per kind is kept, never the value. Page addresses keep their origin
and path; query strings and fragments (where sign-in tokens and search terms live) are dropped.
The firewall's measured precision and recall per kind are in docs/TRUST.md; redaction is not
perfect, which is why exclusions, pauses and erasing exist.

### Storage, retention and erasing

Captures are text in the vault (docs/VAULT_FORMAT.md § Memory timeline):
`recall/<YYYY-MM-DD>/<HH>-<device>.jsonl`, one JSON object per line, and `recall/config.json` for the
settings every device shares. One file per device per hour means a write rewrites at most an hour
of text and two devices never write the same file. Sync merges these files by capture id with
erasing winning (`packages/sync/src/merge-recall.ts`).

Erasing also writes a small record (`recall/erased-<device>.jsonl`: the ids, or the day's time
range). Sync never lets a deletion beat an edit, so when you erase a day on one device while
another is still capturing into that hour's file, the file comes back with the other device's
copy; every device hides what an erasure record covers at once, and deletes those lines at its
next prune. Records expire with the retention period, when what they cover is gone anyway.

Shared settings changed on one device (an app excluded, a shorter retention) apply on the others
as soon as sync delivers `recall/config.json`, or, in the desktop app, as soon as another program
changes it in the vault folder (`apps/web/src/lib/vaultChanges.ts`) — not at the next restart.

- **Retention**: captures older than the chosen period (1, 3, 7, **14 by default**, 30 or 90 days)
  are deleted by whichever device runs Inkwright — on start and every six hours — including
  phones that only show synced captures.
- **Erase** a single moment or a whole day from the timeline, or **everything** from Settings ›
  Memory timeline. Erasing deletes the files; your notes are never touched. (Copies already in a
  backup or a sync service's file history are outside Inkwright's reach; see the threat model.)
- Switching the module off stops capture and hides the timeline; kept moments stay until erased or
  until retention resumes.

### Using it

Settings › Memory timeline, the palette ("Memory timeline"), the tray menu, or a `#recall/<ms>`
link (the journal's sources use these). The timeline shows days, an hour strip (how much was
captured each hour) and the moments, each with its app, window title, text, what was hidden, and
**what you wrote at the same time**: every stroke and text box carries its time, so the notes
written within five minutes of a moment are found exactly (`inkMomentsBetween`) and open at the
page.

Search understands plain questions (`packages/core/src/recall/search.ts`):

| You type | It searches |
|---|---|
| `what was that command in Tuesday's lecture` | Tuesday; lines that look like shell commands; "lecture" in the window title *or in the title of a note you were writing then* |
| `pricing page yesterday afternoon` | yesterday 12:00–18:00, "pricing" and "page" |
| `the error around 3pm` | today 14:00–16:00, lines that look like errors |
| `make in Terminal last week` | last Monday–Sunday, the app Terminal, "make" |
| `what was mentioned about the deadline` | speech captures only, "deadline" |

Dates: today, yesterday, weekdays ("Tuesday", "Tuesday's", "last Tuesday"), this/last week,
"3 days ago", `2026-11-03`, "Nov 3"/"3 Nov"; parts of the day (morning, afternoon, evening, last
night) and times ("at 3pm", "around 14:30", ±1 hour). Every remaining word must be found; rarer
words weigh more.

Your assistant can search it too (`search_timeline`), when the module is on — that is the only way
timeline text reaches an AI, and only the AI you chose, through the guarded provider (whose privacy
firewall applies again).

### Threat model

What the timeline is designed to protect:

- **Nothing leaves the device by itself.** Capture, OCR, speech recognition and redaction run on
  the computer; the result is written to your vault. It travels only where your vault already
  syncs (your Drive, WebDAV server or folder, or paired devices), and to an AI only when you ask
  yours (the assistant's `search_timeline`, or the journal if you allow it).
- **What is never captured**: listed above. Inkwright's own windows are skipped, so notes in
  local-only or locked notebooks are not copied into the timeline from Inkwright itself.
- **Values that are redacted are gone**: the stored text has the kind, not the value.

What it does not protect against — read this before switching capture on:

- **What redaction misses.** Personal data without a recognisable pattern (a diagnosis, a salary,
  a private message) is stored as seen. Exclude the apps where such things live, pause before
  sensitive work, or erase afterwards.
- **Private windows the OS does not mark.** Safari and Chrome on macOS do not put "private" in the
  window title; exclude Safari/Chrome or pause when browsing privately.
- **Password fields on Linux** cannot be detected; exclude apps where you type secrets.
- **Local-only notebooks' content shown elsewhere**: the timeline treats every window the same. If
  the same text is open in another app (a PDF viewer, a browser), it is captured like anything
  else; local-only rules apply to notes, not to the screen.
- **Anyone who can read your vault** can read the timeline: it is as private as your vault, your
  sync service and your devices. Lock-style encryption does not apply to `recall/`.
- **Copies outside Inkwright**: backups, file-version history in Drive or WebDAV, and AI providers
  you sent excerpts to keep what they received.
- **Wayland**: Linux sessions using Wayland do not let apps see which window is in front or
  capture it without a system prompt each time, so capture is unavailable there (the app says so).
  Use an X11 session.

## The journal that writes itself

Code: `packages/ai/src/journal/` (sources, draft checks, tools), `apps/web/src/journal/` (gathering,
writing, settings, calendars), the routine template `daily-journal` in `packages/ai/src/routines.ts`.

Each evening (21:30 by default, any time you choose) the routine **Journal that writes itself** runs
through the app's routine runner (packages/ai `routines.ts`; catch-up rules apply, so a missed
evening runs once when Inkwright opens):

1. `journal_sources` gathers the day's sources, each with a citation id:
   - **What you wrote that day** — only ink and typed text whose timestamps fall on the day, read
     from the line-level handwriting recognition when available, anchored to the exact lines; AI
     ink, imported content and earlier journal drafts are not sources. Notes in **hidden or
     local-only** notebooks (docs/TRUST.md) and locked notes are left out, because the AI writing
     the draft may be a cloud model.
   - **What was said** in that day's recordings (transcripts).
   - **Calendar events** from calendars you imported (below), with recurrences and time zones.
   - **The memory timeline**, grouped by app and hour — only when the timeline module is on *and*
     "Use the memory timeline" is on in Settings › Journal.
2. The model writes paragraphs, each citing the ids it rests on, and calls `write_journal_draft`.
   **A paragraph without a valid citation is dropped** (and reported back), whatever it says.
3. The draft is written as **AI writing** — in AI handwriting (`handwrite()`, `origin: 'ai'`, the
   default; joined or print) or as typed text — through `NoteDocument`, so authorship certificates
   never count it as yours. It becomes the day's daily note if you have none yet (so Today opens
   it), otherwise its own note "<day> · journal" in the Journal notebook linking to your daily note.
   Numbered markers in the text point to a typed **Sources** list with links to the ink, the
   moment in a recording (`#said/…`), the event and the screen moment (`#recall/…`). The draft's
   sentences are also recorded in the note's provenance (`ink:<first stroke id>` for handwriting,
   `text:<box id>` for typed text), so **Explain** shows each sentence's sources (docs/COMPILER.md).
4. You correct it with the pen. A re-run replaces a draft nobody has written on yet and leaves one
   you corrected alone. The draft appears in AI activity, where it can be undone.

### Calendars

Settings › Journal › Calendars: import an `.ics` file, or add a calendar's address (Google
Calendar: Settings › your calendar › "Secret address in iCal format"; Apple and Outlook publish
`webcal://` addresses). No calendar account access is needed. Calendars are kept as their original
`.ics` files in `ai/journal/calendars/` and expanded when a day is drafted
(`packages/core/src/icalendar.ts`: folded lines, all-day events, UTC/floating/`TZID` times including
Outlook's Windows zone names, DURATION, RRULE daily/weekly/monthly/yearly with INTERVAL, COUNT,
UNTIL, BYDAY with ordinals, BYMONTHDAY, BYMONTH, EXDATE, moved occurrences, cancelled events).

A calendar **address is a secret** — anyone with it can read the calendar — so it is kept in the
device's encrypted secret store, never in the vault; other devices use the last copy it fetched.
Addresses are refreshed before each draft. The desktop app fetches them natively; in a browser the
calendar server usually refuses (no CORS), and the app says to import the file instead.

## Tests

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npx vitest run --project core packages/core/test/recall.test.ts packages/core/test/icalendar.test.ts` | capture rules (pause, lock, idle, password fields, password managers, private windows, exclusions, Inkwright itself), change detection and pace, file paths and codec, config defaults, retention (whole and partial days), erase one/day/all, two devices, query parsing (dates, parts of day, times, apps, line kinds), search ranking and the lecture-note context, highlighting, ink moments; iCalendar parsing, zones and DST, all-day, recurrence rules, EXDATE, moved occurrences |
| Unit | `npx vitest run --project ai packages/ai/test/recall-journal.test.ts` | redaction before storage (values never kept, validators keep false positives out, URLs trimmed), repeats; journal sources (only that day's own writing, transcripts, events, screen moments, budget), draft checks (no citation → dropped), composing with sources and provenance, the evening routine with a scripted model |
| Unit | `npx vitest run --project sync packages/sync/test/recall-merge.test.ts` | capture files merge by id; erasing wins; with the real sync engine, an erased day or moment stays hidden while another device keeps appending to the same file, and pruning removes it for good; erasure records merge and expire |
| Unit | `npx vitest run --project web apps/web/src/recall apps/web/src/modules` | the shell's frame format, `#recall` links, journal config, external changes, shared settings changed on another device applied at once, DesktopFS over the shell; presets never switch the modules on |
| Unit (Rust) | `cd apps/desktop/src-tauri && cargo test` | signatures and grayscale for OCR, frame layout, Inkwright's own windows recognised by process (plus the desktop shell's own tests) |
| End-to-end | `cd apps/web && PW_PORT=4204 npx playwright test e2e/memory.spec.ts --project desktop` | the timeline over synced captures (days, hours, notes written at the time, search, erase, erase everything); the journal routine with a mocked model (calendar import, sources, dropped paragraph, AI ink, sources list, activity); the desktop capture loop with the shell mocked: real tesseract.js OCR on drawn text, redaction before storage, no repeat, password manager excluded, pause, tray state |
