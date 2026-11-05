# Inkwright on iPhone and iPad

The iOS app is the same app as Android and the web, in a Capacitor shell (`apps/web/ios`), with a
small Swift plugin for what only iOS offers.

## What's native on iOS

| | How |
|---|---|
| Apple Pencil | Pressure, tilt and hover come through the web view's pointer events (`pointerType: "pen"`), so the pen engine is the same as everywhere else. Double-tap and squeeze (Pencil 2, Pro) switch to the tool chosen in Settings › Pen button and back (`UIPencilInteraction`). |
| On-device AI | Apple's on-device model (Foundation Models, iOS 26 and later, Apple Intelligence on) is the assistant's native engine: no download, no account, nothing leaves the device. The app's own retrieval, tools and citations work on top of it, as with Gemini Nano on Android. Settings shows why it's unavailable when it is (device not eligible, Apple Intelligence off, model still downloading). |
| Your notes in Files | Notes live in the app's Documents folder, which the Files app shows as **On My iPhone/iPad › Inkwright**: plain files you can back up, move or open elsewhere. |
| Open in Inkwright | PDFs, images and text files offer **Open in Inkwright** in Files and other apps' share sheets (document types in `Info.plist`). The file is copied into the app and imported like the library's Open file: a PDF becomes pages to write on. |
| Links from other apps | `inkwright://new?title=…&text=…`, `inkwright://open?note=…`, `inkwright://search?q=…` and `inkwright://capture?url=…` work from Shortcuts, Safari and other apps ([API.md](API.md)). |
| Sharing, haptics, keyboard, status bar | Capacitor's plugins. |
| Google Drive sign-in | Native Google sign-in, once an iOS OAuth client exists (below). |

Not on iOS, by design: the in-app updater (the App Store and TestFlight update apps) and the
Android-only handwriting recognizer (ML Kit). Handwriting is read by the built-in reader or the AI
you choose.

## Code

- `apps/web/ios/App/App/InkwrightApplePlugin.swift`: Foundation Models (`availability`, streamed
  `generate` with `llmDelta` events, `cancel`), Pencil events (`pencil`) and files from other
  apps (`takeSharedFiles`, `sharedFiles`; the same contract as Android's plugin).
- `apps/web/ios/App/App/InkwrightBridgeViewController.swift`: registers the plugin and keeps the
  paper colour behind the web view.
- `apps/web/ios/App/App/SceneDelegate.swift`: passes opened files to the plugin and links to
  Capacitor (`appUrlOpen`).
- `apps/web/src/ai/apple/plugin.ts`: the web side; registers Apple's model as a `NativeLLM`.
  `src/lib/openFiles.ts` takes incoming files from either platform's plugin.
- `apps/web/ios/App/App/Info.plist`: Files app access, document types, the `inkwright` URL
  scheme, permissions text.
- `apps/web/ios/App/App/Assets.xcassets`: the icon (light, dark and tinted, from
  `public/icons/icon.svg`) and the launch screen's mark and paper colour.

## Building and testing

CI (`.github/workflows/ios.yml`) builds the app on a Mac runner for every change to the app and
runs it on the newest iPhone Pro and iPad Pro simulators, in light and in dark mode. It fills the
app's Documents folder with real handwritten notes, then walks through the app as a person would:
the library, a lecture, a pen stroke on it (real pointer events, as Apple Pencil delivers them),
the assistant, a meeting and settings, saving a picture of each step. It fails if the app doesn't
start or stay running, the walk doesn't finish, or the stroke isn't in the note's file on disk
afterwards. After each walk it opens an `inkwright://new` link as another app would and checks
the note was created. The pictures, a full-screen screenshot, the app's log (JavaScript console included)
and `report.json` are the `ios-simulator` artifact. `scripts/ios/simulator-run.mjs` does the
simulator part and also works locally:

```sh
cd apps/web && npx vite build --mode native && npx cap sync ios
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/dd \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
cd ../../../.. && node scripts/ios/simulator-run.mjs /tmp/dd/Build/Products/Debug-iphonesimulator/App.app ios-out
```

To run it yourself on a Mac with Xcode:

```sh
npm ci
cd apps/web && npx vite build --mode native && npx cap sync ios && npx cap open ios
```

Then pick a simulator or your device in Xcode and press Run. Running on your own device with a
free Apple ID works for 7 days at a time; TestFlight and the App Store need the Apple Developer
Program.

Without the native app, iPhone and iPad users can open the web app in Safari and add it to the
Home Screen: it works offline and Apple Pencil writes with pressure and tilt (no double-tap or
squeeze, no Apple on-device model, notes stay in Safari's storage until synced).

## Google sign-in on iOS

1. In Google Cloud (the same project as Android), **Clients › Create client › iOS**, bundle ID
   `app.inkwright`.
2. Put its client ID in the build as `VITE_GOOGLE_IOS_CLIENT_ID`, and add its reversed form
   (`com.googleusercontent.apps.<number>-<id>`) as a URL scheme in `Info.plist`
   (`CFBundleURLTypes`).

## Publishing (TestFlight and the App Store)

`.github/workflows/ios-release.yml` runs on every version tag, next to the Android, web and
desktop releases. It archives the app for devices, signs it with Xcode's automatic (cloud-managed)
signing and uploads it to App Store Connect, where it appears in TestFlight after Apple processes
it. The version shown is the tag's `MAJOR.MINOR.PATCH`; the build number is the same version code
Android uses, so each beta is a newer build. There are no certificates or profiles to manage.

One-time setup (needs the Apple Developer Program, US$99 a year, under the owner's name):

1. In [App Store Connect](https://appstoreconnect.apple.com) › Apps › **+** › New App: platform
   iOS, name Inkwright, bundle ID `app.inkwright` (register it under Certificates, Identifiers &
   Profiles › Identifiers first if it isn't offered), SKU `inkwright`.
2. Users and Access › Integrations › App Store Connect API › **Generate API Key** with the
   **Admin** role (needed for cloud-managed signing). Download `AuthKey_<id>.p8` (once only).
3. Add four repository secrets (Settings › Secrets and variables › Actions):
   - `APPLE_TEAM_ID`: the team ID from developer.apple.com › Membership
   - `ASC_KEY_ID`: the key's ID
   - `ASC_ISSUER_ID`: the issuer ID shown above the keys
   - `ASC_KEY_P8_BASE64`: `base64 -i AuthKey_<id>.p8 | pbcopy` on a Mac
4. Publish a release as usual. Without the secrets the iOS release job says so in its summary and
   succeeds.

TestFlight builds reach up to 10,000 testers by link, with no review for internal testers and a
short review for external ones. Testers install the TestFlight app once; after that each new build
arrives as an update. The App Store needs a full review.
