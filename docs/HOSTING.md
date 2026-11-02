# Open Inkwright from a URL — no server needed

Inkwright's web build (`apps/web/dist`) is a set of static files. Put them on any static host and the
app opens from that URL on any device with a modern browser: phone, tablet, Mac, Windows, Linux,
ChromeOS, e-ink Android tablets. Installing it (browser menu → *Install* / *Add to Home Screen*)
makes it a full-screen app that works offline.

## Why there is no server

| Need | How it works without a server |
|---|---|
| Storing notes | On the device (Origin Private File System / IndexedDB in browsers, app storage on Android). Plain files in the vault format (`docs/VAULT_FORMAT.md`). |
| Sync between devices | Each user's own storage: Google Drive (`drive.file` scope, only files Inkwright created), any WebDAV server (Nextcloud, Synology, Fastmail…), or a local folder that the user syncs with iCloud/Dropbox/OneDrive. Three-way merge runs on the devices. |
| AI | On the device (local models, see `docs/LOCAL_AI.md`), or straight from the browser to the provider the user chose, with their own key. Keys are encrypted on the device and never touch our infrastructure. |
| Agents (Claude, ChatGPT…) | The Inkwright MCP server (`apps/mcp-server`) runs on the user's own computer next to their vault. |
| Offline | A service worker caches the app; everything except syncing and cloud AI works offline. |

A server only becomes necessary for features that are inherently shared and live, such as real-time
multi-person collaboration or team billing; those are optional add-ons, not requirements.

## Publish it

**GitHub Pages (free).** Push the repo to GitHub, then *Settings → Pages → Source: GitHub Actions*.
`.github/workflows/pages.yml` builds and publishes on every push to `main`. The app is served from
`https://<user>.github.io/<repo>/` (the build uses relative paths, so subpaths work).

**Cloudflare Pages / Netlify / Vercel (free tiers).** Build command `npm ci && npm run build`, output
directory `apps/web/dist`. Any custom domain works.

**Any web server or S3 bucket.** Upload `apps/web/dist` as is. Serve `index.html` for `/`, and make
sure `.webmanifest` is served as `application/manifest+json` and `sw.js` is not cached for long.

## Google sign-in on your domain

Google Drive sync needs an OAuth client that lists your site as an authorized JavaScript origin
(`docs/GOOGLE_SETUP.md`). Add every URL you publish to (for example the github.io address and your
custom domain).

## Content Security Policy

The production build ships a CSP (see `apps/web/vite.config.ts`) that pins scripts, styles, images
and frames to the app itself, while `connect-src` stays open so users can reach any AI provider,
local model server or WebDAV host they choose.
