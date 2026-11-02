# Inkstone privacy policy

_Last updated: November 2026_

Inkstone is a note-taking app. Your notes stay under your control.

**What we collect:** nothing. Inkstone has no accounts or servers of its own, and no analytics, ads or tracking. The developer never receives your notes, recordings, keys or usage data.

**Where your notes live:**

- On your device: app storage on Android and iOS, browser storage on the web.
- If you turn on sync: in **your** Google Drive (the visible "Inkstone" folder; Inkstone can see only files it created), on **your** WebDAV server, or in a folder you choose. Data goes straight from your device to that service under your account.

**AI features** work only when you turn them on. You either add your own API key for a provider such as OpenAI, Anthropic, Google, OpenRouter or a local model, or you use Claude inside claude.ai.

- When you ask the assistant something, Inkstone sends the request and the note content it needs (text, or page images for handwriting) directly from your device to that provider. That provider's own privacy policy applies.
- API keys are encrypted on your device and are never synced or sent anywhere except to the provider they belong to.
- **Connected apps:** if you connect an app such as Notion or Linear (through the Model Context Protocol), the assistant sends that app the requests it makes on your behalf, straight from your device. Sign-ins and tokens are encrypted on your device and never synced. By default the assistant asks before anything that changes things in a connected app.
- **Memory, skills, routines and the activity log** are stored with your notes (in the `ai` folder of your vault) and sync wherever your notes sync. Nothing is remembered about you unless you write it or accept a suggestion.
- **Routines** run while Inkstone is open on one of your devices, with the AI you chose — or, if you install the optional always-on runner on your own computer, from that computer with the AI you configure for it.
- **Outside agents** (the optional Inkstone MCP server, A2A agent and runner) run on your computer over your notes folder. They talk only to the agents you connect and the AI provider you configure; sign-in is a token you set or your own identity provider. Nothing goes through a service of ours.

**On-device handwriting recognition** (Android) runs entirely on the phone. Google's language model is downloaded once, and your handwriting never leaves the device.

**Signatures and initials** you save for Fill & sign stay on your device, encrypted, and are never synced. A signature is only copied into a document when you place it there.

**Smart ink** (tables, solving maths, circled dates) works on your device. Handwriting is read by on-device recognition where available; it is sent to your AI provider only when you tap an action that needs it, or if you turned on automatic AI recognition. Calendar events are files you download or your calendar app's own "new event" screen — Inkstone never reads your calendar.

**Proof of authorship:** each page keeps a history of edits (what changed and when, as content fingerprints) so you can sign a certificate of your handwriting. The signing key is made on your device and cannot be exported. Certificates contain the signed handwriting, its timing and your key's fingerprint; they leave your device only when you share them or export a PDF with one attached (Settings › Authorship can turn that off).

**Microphone:** used only while you record an audio note, or while you hold the microphone button to talk to the assistant. Recordings are saved with the note. Speech for the assistant is turned into text by your browser's speech recognition (which may use the browser maker's servers) or, where that is not available, by your AI provider; it is not stored.

**Deleting data:** delete notes in the app. Trash empties after 30 days, or right away with "Delete forever". Uninstall the app or clear site data to remove everything stored on the device. Synced copies stay in your Drive or server until you delete them there.

**Children:** Inkstone is not directed at children under 13.

**Contact:** [your support email]
