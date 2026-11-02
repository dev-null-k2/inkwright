# Inkwright privacy policy

_Last updated: November 2026_

Inkwright is a note-taking app. Your notes stay under your control.

**What we collect:** nothing. Inkwright has no accounts or servers of its own, and no analytics, ads or tracking. The developer never receives your notes, recordings, keys or usage data.

**Where your notes live:**

- On your device: app storage on Android and iOS, browser storage on the web.
- If you turn on sync: in **your** Google Drive (the visible "Inkwright" folder; Inkwright can see only files it created), on **your** WebDAV server, or in a folder you choose. Data goes straight from your device to that service under your account.
- If you pair devices or share a page live: directly between the devices, end to end encrypted (see [COLLABORATION.md](COLLABORATION.md)). A STUN server (Google's by default; you can change or clear it) learns your devices' public IP addresses so they can find each other; a TURN relay or signalling server, if you set one up, carries only encrypted data. A live-session guest keeps a copy of the shared page in their own notes.

**AI features** work only when you turn them on. You either add your own API key for a provider such as OpenAI, Anthropic, Google, OpenRouter or a local model, or you use Claude inside claude.ai.

- When you ask the assistant something, Inkwright sends the request and the note content it needs (text, or page images for handwriting) directly from your device to that provider. That provider's own privacy policy applies.
- API keys are encrypted on your device and are never synced or sent anywhere except to the provider they belong to.
- **Connected apps:** if you connect an app such as Notion or Linear (through the Model Context Protocol), the assistant sends that app the requests it makes on your behalf, straight from your device. Sign-ins and tokens are encrypted on your device and never synced. By default the assistant asks before anything that changes things in a connected app.
- **Memory, skills, routines and the activity log** are stored with your notes (in the `ai` folder of your vault) and sync wherever your notes sync. Nothing is remembered about you unless you write it or accept a suggestion.
- **Routines** run while Inkwright is open on one of your devices, with the AI you chose — or, if you install the optional always-on runner on your own computer, from that computer with the AI you configure for it.
- **Outside agents** (the optional Inkwright MCP server, A2A agent and runner) run on your computer over your notes folder. They talk only to the agents you connect and the AI provider you configure; sign-in is a token you set or your own identity provider. Nothing goes through a service of ours.

**On-device handwriting recognition** (Android) runs entirely on the phone. Google's language model is downloaded once, and your handwriting never leaves the device.

**On-device AI in the Android app** (Gemini Nano through Android's AICore, its summary, proofreading and image-description tools, or an open model such as Gemma 4 run by Inkwright) works on the phone: your notes and questions are not sent anywhere. Android downloads Gemini Nano itself; open models are downloaded once from Hugging Face (a plain file download — no notes or account details are sent). Android applies its own usage quotas to Gemini Nano.

**Signatures and initials** you save for Fill & sign stay on your device, encrypted, and are never synced. A signature is only copied into a document when you place it there.

**Smart ink** (tables, solving maths, circled dates) works on your device. Handwriting is read by on-device recognition where available; it is sent to your AI provider only when you tap an action that needs it, or if you turned on automatic AI recognition. Calendar events are files you download or your calendar app's own "new event" screen — Inkwright never reads your calendar.

**Locked notes:** you can lock a note with a passcode. Its pages, pictures, recordings, version history, summary and form values are then encrypted on your device before they are saved, so the copies on your device and in your Drive, WebDAV server or folder are unreadable without the passcode. Search, links, the assistant, routines, outside agents and library thumbnails skip locked notes; the assistant button is hidden while one is open, and smart ink never sends a locked note to an AI on its own. The title, tags, notebook, dates and number of pages stay visible so the note can be listed. **There is no recovery:** Inkwright never stores the passcode or the key, so a forgotten passcode means the note can't be opened by anyone, including the developer. See "Threat model for locked notes" below.

**Proof of authorship:** each page keeps a history of edits (what changed and when, as content fingerprints) so you can sign a certificate of your handwriting. The signing key is made on your device and cannot be exported. Certificates contain the signed handwriting, its timing and your key's fingerprint; they leave your device only when you share them or export a PDF with one attached (Settings › Privacy & trust › Authorship can turn that off).

**Microphone:** used only while you record an audio note, dictate, or hold the microphone button to talk to the assistant. Recordings are saved with the note. Speech for the assistant is turned into text by your browser's speech recognition (which may use the browser maker's servers); in the Android app by Android's speech recognition, on the phone where the phone supports it (Settings › AI says whether it does; otherwise Android works offline when the language is downloaded and may use Google's servers when it isn't); or, where none is available, by your AI provider. It is not stored.

**Transcripts (speech to text):** while you record, Inkwright can write down what is said, line it up with your writing and summarize each page. Inkwright always shows where the audio is being turned into text:

- **On this device** (the default once the speech model is downloaded, and always when you choose "This device" in Settings › AI › Speech to text): an open speech model (Moonshine or Whisper) runs inside the app. No audio and no transcript leaves your device. The model is downloaded once from Hugging Face; that download sends nothing about you.
- **Browser speech service**: your browser's speech recognition hears the audio. Most browsers process it on their maker's servers (Google, Apple or Microsoft), under that company's privacy policy. Inkwright uses this only if you have not downloaded the on-device model, or if you choose it.
- **Your AI provider**: the audio is sent in short pieces, straight from your device, to the provider whose key you added (for example OpenAI, Groq or Google), under that provider's privacy policy.

Choosing "This device" never falls back to the browser or a provider: if the model is not downloaded, Inkwright offers the download instead. Dictated speech is not stored; only the text you keep. Transcripts, recording summaries and page summaries are saved with the note (next to the recording) and sync wherever your notes sync. Questions you ask during a recording, and summaries, are answered by the assistant's AI — on this device unless you chose a provider.

**Desktop app (macOS, Windows, Linux):** your notes are a folder on your computer. While Inkwright runs (also from the tray), it serves that folder to AI agents on the same computer (the MCP server, `127.0.0.1` only) — only to agents that have the token shown in Settings › Desktop app, which you can turn off or replace there. Calendar addresses you add are fetched from the computer directly. Updates are downloaded from the project's GitHub releases and must carry the project's signature. See [DESKTOP.md](DESKTOP.md).

**Memory timeline (off unless you turn it on, on each computer):** when you switch on "Capture my screen" in the desktop app, Inkwright reads the text of the window in front every few seconds, on that computer, and keeps only the text — never screenshots — in your vault (the `recall` folder) for the number of days you choose (14 by default), after which it is deleted. Before anything is saved, email addresses, phone numbers, card and bank numbers, ID numbers, street addresses, names in recognisable contexts, IP addresses, API keys, tokens and passwords are replaced by their kind ("[email]"); page addresses lose their query strings. Inkwright never captures itself, password managers, private or incognito windows it can recognise, windows while a password field has focus (where the system can tell: macOS and Windows), the apps and windows you exclude, or anything while it is paused, the screen is locked or you are away. If you also turn on the microphone, nearby speech is transcribed by an on-device model only — never by a browser or AI provider — and no audio is kept. The timeline syncs wherever your notes sync. It is sent to an AI only when you ask your assistant about it, or when you let the journal use it. You can erase a moment, a day or everything at any time; the erase reaches every device the timeline syncs to. Redaction can miss personal data that has no recognisable pattern; [MEMORY_TIMELINE.md](MEMORY_TIMELINE.md#threat-model) explains what the timeline does and does not protect against.

**Journal that writes itself (off unless you turn it on):** each evening your assistant's AI drafts a journal entry from what you wrote that day, what was said in your recordings, calendars you imported and — if you allow it — the memory timeline. That content goes to the AI you chose for the assistant, as for any routine; notes in hidden or local-only notebooks and locked notes are not used. Calendar files are kept in your vault (`ai/journal`); a calendar's address is kept encrypted on the device where you added it and is never synced.

**Deleting data:** delete notes in the app. Trash empties after 30 days, or right away with "Delete forever". Uninstall the app or clear site data to remove everything stored on the device. Synced copies stay in your Drive or server until you delete them there.

**Children:** Inkwright is not directed at children under 13.

## Threat model for locked notes

What a lock protects against:

- **Someone who gets the files** — a synced copy in a cloud account, a backup, a stolen or shared
  computer's vault folder, the browser's storage: they see the note's title, tags, notebook, dates,
  page count and page sizes, the number and size of its pictures and recordings, and when it was
  changed, but not what is written, drawn, typed, recorded or summarised in it.
- **Tampering:** encryption is authenticated (AES-GCM) and bound to each file's role and name, so a
  changed, truncated or swapped file fails to open instead of showing altered content.
- **Guessing the passcode offline:** the key is stretched with PBKDF2-SHA-256 at 600,000 iterations
  and a random salt per note, which makes each guess slow. A short or common passcode can still be
  guessed by a determined attacker with the files — use a long one for anything sensitive.

What it does not protect against:

- **A device that is unlocked and in someone else's hands while the note is open**, or malware on
  the device: while a note is open its content is in memory, readable like any open note.
- **Copies made while the note was not locked.** Locking rewrites the files, but earlier unencrypted
  copies may survive elsewhere: old file revisions kept by Google Drive or a WebDAV server, backups,
  exports, PDFs or images you shared. Lock a note before syncing sensitive content, and delete old
  revisions in your storage service if needed.
- **Metadata:** titles, tags and dates stay readable (pick a neutral title if the title is sensitive).
- **What you do with an open note:** exports, printing and copying pages out produce unencrypted files,
  and if you tap an AI action yourself (for example "Ask AI" on a selection) the content goes to the
  AI provider you chose.
- **Forgetting the passcode:** there is no reset, recovery key or back door.

The passcode is never written anywhere; the key exists only in memory while the note is open and is
forgotten when you leave it. Locking and unlocking happen entirely on your device.

**Contact:** [your support email]
