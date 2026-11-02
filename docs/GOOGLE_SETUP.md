# Google sign-in and Drive sync setup

Google requires every app that signs users in to register an OAuth client. This is free, takes about five minutes, and only the app's owner can do it. Inkwright asks for the `drive.file` scope only. It can see just the files it creates, in a visible **Inkwright** folder in your Drive, and nothing else in your Drive. Google classes this scope as non-sensitive, so publishing doesn't require a security review.

## 1. Create the project and enable Drive

1. Open <https://console.cloud.google.com/> and create a project, for example `Inkwright`.
2. Go to **APIs & Services → Library**, search for **Google Drive API** and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen** (also called "Google Auth Platform → Branding/Audience").
   - Choose **External**.
   - App name: Inkwright. Add a support email and the logo from `apps/web/public/icons/icon-512.png`.
   - Scopes: `openid`, `email`, `profile`, `.../auth/drive.file`.
   - While testing, add your own Gmail as a **test user**. Publish the app to production when you're ready; the scopes above don't need verification.

## 2. Create the client IDs

**Web (browsers, PWA, and also used by Android/iOS sign-in):**

1. Go to **Credentials → Create credentials → OAuth client ID → Web application**.
2. Under **Authorized JavaScript origins**, add every address you serve Inkwright from, for example `https://inkwright.example.com` and `http://localhost:5173` for development.
3. Copy the **client ID**. It ends in `.apps.googleusercontent.com`.

**Android (needed for the native account picker):**

1. Go to **Create credentials → OAuth client ID → Android**.
2. Package name: `app.inkwright`.
3. SHA-1: the fingerprint of the key that signs your APK. Get it with:
   - debug key: `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`
   - Play App Signing key: Play Console → Setup → App integrity
4. Create one Android client per signing key you use.

**iOS:**

1. Go to **Create credentials → OAuth client ID → iOS**.
2. Bundle ID: `app.inkwright`.
3. Add its reversed client ID as a URL scheme in Xcode, as the `@capgo/capacitor-social-login` docs describe.

## 3. Give Inkwright the web client ID

Pick one of these:

- **Build it in (recommended for publishing):** put `VITE_GOOGLE_CLIENT_ID=<your web client id>` in `apps/web/.env`, then rebuild.
- **Paste it at runtime:** Settings → Account & sync → *Google OAuth client ID*.

Then tap **Sign in with Google**. Notes sync to `My Drive/Inkwright/`. On a Mac with Google Drive for desktop that folder is at
`~/Library/CloudStorage/GoogleDrive-<you@gmail.com>/My Drive/Inkwright`. Point Obsidian or the Inkwright MCP server (`apps/mcp-server`) at it.

## Notes

- Tokens stay in memory and refresh silently. Inkwright never stores your Google password or a refresh token in the browser.
- Signing out revokes the token on the web.
- Deleted notes are moved to Drive's trash, so you can recover them.
