# Send selection to a webhook

Select ink or text in a note, then ••• › Plugins › Send selection to webhook (or search for it
with Ctrl/⌘-K). The plugin POSTs the selection's text — typed text and recognized handwriting —
with the note's title to the URL set in Settings › Plugins.

- **json** (default): `{"title","text","noteId","page","sentAt"}` — Zapier and Make catch hooks, n8n, your server.
- **slack**: `{"text"}` — Slack incoming webhooks, Discord's `/slack` endpoint, Mattermost.

Permissions: see the open note and selection; connect to the internet (any https site, since you
choose the URL). The request is made by Inkwright on the plugin's behalf, without cookies; the
receiving site must allow cross-origin requests (most webhook services do).
