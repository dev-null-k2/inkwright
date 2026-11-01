# Shipping Inkstone

One codebase produces every build:

| Target | Command | Output |
|---|---|---|
| Web / PWA (Mac, Windows, Linux, ChromeOS, iPad) | `npm run build` | `apps/web/dist/` (static files) |
| Android | `cd apps/web && npm run cap:sync && cd android && ./gradlew bundleRelease` | `.aab` for Play |
| iOS / iPadOS | on a Mac: `cd apps/web && npx cap sync ios && npx cap open ios` | Xcode archive |
| Live preview / single file | `cd apps/web && npx vite build --mode single && node scripts/artifact.mjs` | one HTML file |
| MCP server | `npm run build -w @inkstone/mcp-server` | `apps/mcp-server/dist/index.js` |

Before any release, run `npm test` (unit tests and evals) and `npm run e2e` (browser tests). Both must pass.

## Web and Mac (installable app)

The web build is static, so any static host works: Cloudflare Pages, Netlify, Vercel, Firebase Hosting, GitHub Pages or S3/CloudFront.

- Serve `apps/web/dist` over **HTTPS**. Service workers and Web Crypto need it.
- Set your Google web client ID with `VITE_GOOGLE_CLIENT_ID`, and add the site's origin to the client's authorized JavaScript origins (`docs/GOOGLE_SETUP.md`).
- **Mac:**
  - Chrome or Edge: menu → *Install Inkstone*.
  - Safari 17+: *File → Add to Dock*.
  - Either way you get a Dock app with its own window that works offline.
- **Windows and ChromeOS:** install from Chrome or Edge the same way.
- **Optional native Mac app:** wrap `apps/web/dist` with Tauri 2 (`npm create tauri-app`, `frontendDist: ../apps/web/dist`) and sign and notarize it with your Apple Developer ID. The PWA already covers offline use, file access (folder sync) and the Dock icon.

## Google Play

1. **Upload key.** Create it once and keep it safe:
   ```
   keytool -genkeypair -v -keystore inkstone-upload.jks -alias inkstone -keyalg RSA -keysize 4096 -validity 10000
   ```
   Then create `apps/web/android/keystore.properties`. It is already in `.gitignore`.
   ```
   storeFile=/absolute/path/inkstone-upload.jks
   storePassword=…
   keyAlias=inkstone
   keyPassword=…
   ```
2. **Build:** run `./gradlew bundleRelease` in `apps/web/android`. The bundle is `app/build/outputs/bundle/release/app-release.aab`.
3. **Play Console** (one-time $25 developer account):
   - Create the app, choose **Play App Signing** and upload the `.aab` to internal testing first.
   - Store listing: use the copy below, screenshots from the app (phone, 7" and 10" tablet; foldable screenshots are welcome), and the 512×512 icon at `apps/web/public/icons/icon-512.png`.
   - **Data safety:**
     - Data collected: none by the developer.
     - Data shared: none.
     - Data is encrypted in transit. Users can delete their data (delete notes or uninstall).
     - Notes go to Google Drive, WebDAV or AI providers only when the user turns that on and uses their own account or key.
   - Privacy policy: host `docs/PRIVACY.md` as a web page and link to it.
   - Permissions: microphone for audio notes (asked when the user records), internet for sync and AI, and vibrate for paper feel.
4. **Versions:** increase `versionCode` and `versionName` in `apps/web/android/app/build.gradle` for every release.

### Store listing copy

**Short description (80 characters max):** Handwriting notes that feel like paper. Scribble to erase. Bring your own AI.

**Full description:**

> Write with your stylus on paper that feels real. Inkstone's paper grain comes through the phone's haptic motor and a soft nib-on-paper sound. Pens respond to pressure: fountain, ballpoint, pencil, brush, marker and highlighter.
>
> Erase the way you would on paper. Scribble over a word to remove it, use the eraser end of your pen, or press the pen button. Hold at the end of a line or circle to make it perfect. Your palm is ignored, fingers scroll, a two-finger tap undoes.
>
> Ruled, dot, grid, engineering, isometric, Cornell, music and planner paper. Infinite canvases. Import PDFs and write on them, add photos and typed text, record audio while you write and tap your ink to hear that moment.
>
> Your notes are plain files you own. Sync them through your Google Drive, a folder or WebDAV. Use them on your Mac, in Obsidian, and with AI agents such as Claude through the built-in MCP server.
>
> Connect any AI with your own key: OpenAI, Claude, Gemini, OpenRouter, Groq, Mistral, xAI, DeepSeek, or a local model. Turn handwriting into text, ask questions about all your notes, pull out to-dos, make flashcards, translate. No account and no subscription required.

## App Store (iPhone and iPad)

You need a Mac with Xcode and an Apple Developer account ($99 per year).

1. `cd apps/web && npm run build && npx cap add ios` (first time only), then `npx cap sync ios && npx cap open ios`.
2. In Xcode:
   - Set the team, set bundle id `app.inkstone`, and add the microphone usage string ("Record audio notes while you write").
   - Add the Google iOS URL scheme.
3. Archive, upload to App Store Connect, then submit through TestFlight. Use the same privacy answers as for Play.

## The MCP server on npm (optional)

Run `cd apps/mcp-server && npm run build`, then `npm publish --access public` (after renaming the package if you like). The README then works with `npx -y <name> --vault …`.
