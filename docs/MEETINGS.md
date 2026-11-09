# Meetings

Notes made better with what was said. Write what matters to you during a meeting, by hand or
typed; record it (in the room, or both sides of a call with no bot joining); afterwards Inkwright
writes the notes out in full, shaped by a template, with your own words kept and marked and every
added line linked to the moment it was said. The **Meetings** module (Settings › Extend › Modules)
owns all of it and can be switched off; enhanced notes stay in each note.

## What you can do

| | Where |
|---|---|
| **Enhanced notes** — your notes plus the details from the transcript, your lines in ink colour, the AI's in grey, each with its moment (tap to hear it and see what you were writing) | Editor › ••• › Audio › Meeting notes › Notes |
| **Templates** — 15 built in (1:1, stand-up, sales call, customer discovery, hiring interview, investor, kickoff, retro, design review, lecture, all-hands, partnership, brainstorm, appointment, general) and your own; picked from the meeting's title | The template chip in the Meeting panel; Settings › Knowledge › Meetings |
| **Edit by asking** ("shorter", "add the pricing details"), check off action items, edit a line, **versions** with restore, a warning before regenerating over your edits | Meeting panel › Notes |
| **Recipes** — saved prompts on one meeting (follow-up email, action items, decisions, TL;DR for Slack, coach me, PRD, objections) or many (feature requests, weekly recap, what I owe them, best quotes, themes), and your own | Meeting panel › Recipes; Meetings › Ask |
| **Ask across meetings** — a time range, a person or a company; answers cite the meeting and moment | Meetings › Ask |
| **Coming up** — meetings from your calendars (Google, Outlook, iCloud by their private iCal address, or an `.ics` file), join link, **Prepare notes / Take notes** (title, attendees, call link and template filled in; recording starts), a **brief** before it from earlier meetings with the same people, and a reminder a few minutes before | Meetings |
| **People and companies** — from attendees, companies by work email domain (your own and personal providers left out), each with **Ask** | Meetings › People, Companies |
| **Record a call** — both sides of Zoom, Meet, Teams or any call, without a bot: the browser shares the call's tab or window sound, mixed with your microphone; **who spoke** (you or them, by which side was louder; the other person's name on a two-person call) | Editor › ••• › Audio › Record a call; automatic for meetings with a call link |
| **Transcript editing** — delete a line, name a speaker | Meeting panel › Transcript › Edit |
| **Keep audio** off — each recording's audio is deleted once its transcript is saved | Settings › Knowledge › Meetings › Privacy |
| **Onto the page** — the AI's additions written beside your notes in AI ink, in a hand matched to yours (size, slant, pen, messiness), or as a text box | Meeting panel › Notes › ✎ |
| **Share** — copy (rich text, Markdown, Slack), email the attendees, and send to Slack, Microsoft Teams, Discord, Notion, Linear, Jira, GitHub, Todoist, HubSpot, Attio or any webhook (Zapier, Make, n8n…), always with a preview and a Send button | Meeting panel › Notes › Share |

Everything runs through the AI chosen in Settings › AI. With the on-device model, transcription,
enhanced notes, recipes and briefs all happen on the device, offline.

## How enhancing works

`packages/ai/src/meetings/prompts.ts`. The model gets the template's sections, your notes (typed
text and the handwriting read from your pages) and the transcript with times and speakers, and
writes a plain line format small models follow (`## Section`, `- point [m:ss]`, `- [ ] task —
owner [m:ss]`). The parser then makes the result trustworthy whatever the model did:

- **Your words are never lost.** Each of your note lines is matched to the reply; one the model
  only paraphrased is put back word for word above the line it is closest to, which becomes its
  detail. Only lines that match nothing go to "Also in your notes".
- **Every grey line has its moment.** Times the model gave are kept only when a transcript line
  near them supports the text; lines without times get the moments whose words they share. A line
  with no support gets no time rather than a guess.
- Times past the end of the recording are dropped, `unassigned`/`TBD` owners are no owner, and
  `<think>` blocks, code fences, bold headings, star bullets and numbered lists are all read.

The real on-device model (Qwen3 1.7B) is run against a sales-call fixture in
`packages/ai/evals/meetings.eval.ts` (`INKWRIGHT_REAL_MODELS=meetings`), and its actual reply is a
regression test in `packages/ai/test/meetings.test.ts`.

## Code

- `packages/core/src/meetings/`: the data model (`NoteMeta.meeting`, `meeting-notes.json`),
  templates and recipes, your library, calendar helpers (call links, coming up, attendees),
  people and companies, related meetings, export (Markdown, Slack, HTML, Notion blocks, mailto).
- `packages/core/src/transcript.ts`: speakers (`assignSides`, `speakerName`).
- `packages/core/src/handwrite.ts`: `handStyleOf`, a hand like yours.
- `packages/ai/src/meetings/prompts.ts`: enhance, edit, recipes, briefs, the parser and grounding.
- `packages/sync/src/merge-listen.ts`: merging enhanced notes and speaker names; the library in
  `merge.ts`.
- `apps/web/src/meetings/`: the panel, the Meetings screen, settings, enhancing, calendar,
  integrations, writing onto the page; `lib/audio.ts` records calls.
- `apps/desktop/src-tauri/src/integrations.rs`: requests to services that don't allow browsers.
- Tests: `packages/core/test/meetings.test.ts`, `packages/ai/test/meetings.test.ts`,
  `packages/sync/test/meetings-merge.test.ts`, `apps/web/e2e/meetings.spec.ts` (Chromium,
  Firefox and phone sizes).

## Where it works

| | Web (Chrome, Edge) | Web (Safari, Firefox) | Desktop app | Android | iPhone, iPad |
|---|---|---|---|---|---|
| Enhanced notes, templates, recipes, ask, briefs, people | ✓ | ✓ | ✓ | ✓ | ✓ |
| Recording in the room, transcript, speakers by name | ✓ | ✓ | ✓ | ✓ | ✓ |
| Recording both sides of a call | ✓ (tab or system sound) | — | Windows ✓ | — | — |
| Calendar by address | via `.ics` file when the server refuses browsers | same | ✓ | ✓ | ✓ |
| Slack, Discord, Linear, GitHub, Todoist, webhooks | ✓ | ✓ | ✓ | ✓ | ✓ |
| Teams, Notion, Jira, HubSpot, Attio | — (those services refuse browsers) | — | ✓ | ✓ | ✓ |

Phones can't record another app's call sound (the systems don't allow it); record in the room on
speaker, or record the call on a computer.
