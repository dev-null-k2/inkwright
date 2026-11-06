# In-app updates (Android from GitHub Releases, and the web app)

Inkwright for Android is distributed from [GitHub Releases](https://github.com/dev-null-k2/inkwright/releases).
An installed copy finds new releases by itself and updates from inside the app. No other app is
needed and nobody has to send APKs around.

## What people see

1. Shortly after the app opens, and at most every six hours while it stays open, it checks GitHub.
2. When a newer release exists, the library shows a banner: **Inkwright 0.9.0-beta.6 is ready**,
   with **What's new** (the release notes), **Update** and **Later**. *Later* hides it for a day;
   a newer release than the one snoozed shows at once. Each version is offered once.
3. **Update** downloads the APK for the phone's processor, checks it (below) and installs it.
   - The first time, Android asks once to let Inkwright install apps ("Install unknown apps"); the
     app explains this and opens the right settings page, then carries on.
   - On Android 12 and later, once Inkwright has installed itself, later updates install without a
     confirmation screen. If Android still asks, it is a single confirm.
4. **Settings › About › Updates** shows the running version, when it last checked, **Check now**, a
   **Beta updates** switch (on while Inkwright ships betas), and every state: up to date, update
   available, downloading n % (with cancel), verifying, ready to install, installing, or what went
   wrong in plain words, with retry.

Offline, a GitHub outage or GitHub's rate limit never show as errors in the library; Settings says
what happened and when it will try again.

## Publishing an update

Make a GitHub release with a version tag (`v0.9.0-beta.6`, `v1.0.0`). `release.yml` builds the
APKs, signs them with the upload key, and attaches `android-update.json`. Every installed copy
picks it up on its next check. That's all.

## How it works

- **Checking:** one request to `api.github.com/repos/dev-null-k2/inkwright/releases?per_page=10`.
  The response's ETag is kept and sent back with `If-None-Match`, so an unchanged list costs
  nothing against GitHub's limit of 60 unauthenticated requests an hour per IP address. When the
  limit is reached the app waits until GitHub's reset time. Pre-releases count only with *Beta
  updates* on.
- **The manifest:** each release has `android-update.json` with the version, versionCode, channel,
  date, notes and, per ABI (`arm64-v8a`, `armeabi-v7a`, `x86_64`), the APK's address, size and
  SHA-256 (`apps/web/scripts/release/android-update.mjs`).
- **Downloading and installing** (`apps/web/android/app/src/github/java/app/inkwright/updates`):
  the APK goes to the app's cache with progress, is verified, and is installed through a
  `PackageInstaller` session (`setRequireUserAction(USER_ACTION_NOT_REQUIRED)` on Android 12+,
  falling back to Android's confirmation screen). Downloaded files are deleted afterwards.

## Security

An update is installed only if every check passes:

1. It comes over HTTPS from GitHub.
2. Its SHA-256 matches the manifest.
3. Its signing certificate is the same as the running app's (checked before installing).
4. Android itself refuses any update not signed with the same key.

So a changed file, a wrong file or an APK signed by anyone else is never installed.

## Version codes

Android installs an update only when its versionCode is higher. Every release, betas included,
gets a higher code, and a final release sorts above its own betas:

```
versionCode = (MAJOR·10 000 + MINOR·100 + PATCH) · 1000 + stage + N
stage: alpha 100, beta 200, rc 300, final 900;  N = 0…99
0.9.0-beta.6 → 900206    0.9.0-rc.1 → 900301    0.9.0 → 900900    1.0.0 → 10000900
```

`apps/web/scripts/release/version-code.mjs`, `VersionCode.kt` and `src/updates/versionCode.ts`
implement it and are tested against the same table. A tag outside the scheme fails the release.
(Builds before 0.9.0-beta.6 used smaller codes: 900, or 905 for a locally built beta.5. Every
code above is higher, so they update normally.)

## Builds for Google Play

Google Play updates apps itself and doesn't allow `REQUEST_INSTALL_PACKAGES` for this kind of app.
The Gradle property `-Pinkwright.distribution=github|play` (default `github`) decides: the Play
bundle (`.aab`, built with `play`) has neither the permission nor the updater's code, and the app
shows no Updates section. The APKs on GitHub are built with `github`.

## Web app and Home Screen apps (iPhone, iPad, computers)

The hosted web app (and the same app added to the Home Screen on iPhone or iPad, or installed
from Chrome or Edge) gets the same banner as Android, from `src/updates/web.ts`:

- Every deployment publishes `version.json` next to the app: its version (the latest release plus
  the commits since, such as `0.9.0-beta.6+12.gd047863`, from `pages.yml`) and the CHANGELOG notes
  for it (the version's section, else Unreleased).
- After launch, when the app comes back to the foreground and every 30 minutes, it fetches that
  file, bypassing every cache. When the deployment differs from the running version the library
  shows "Inkwright … is ready" with What's new, Later and Update. Update fetches the new service
  worker and reloads, which takes a few seconds; notes live in the browser's storage and are not
  touched. After the reload the library says "Updated to Inkwright …" once.
- Settings › About › Updates shows the version, Check now and the automatic-check switch (the
  Updates module).
- Without any click, the next launch while online opens the new version anyway: the service worker
  asks the network first for the page.

## Desktop

- The web app updates itself through its service worker on the next load (above).
- The desktop app (Tauri) has its own updater, which reads `latest.json` from the release when the
  updater signing key is set (docs/DESKTOP.md); until then, new versions are downloaded from the
  Releases page.

## Needs checking on a real phone

The download, the "Install unknown apps" step and the silent install on Android 12+ run only on a
device; the tests here use a scripted native layer. Check them on the Razr Fold with the first
update after this one is published.
