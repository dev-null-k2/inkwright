# Inkwright on iPhone and iPad

The iOS app is the same app as Android and the web, in a Capacitor shell (`apps/web/ios`), with a
small Swift plugin for what only iOS offers.

## What's native on iOS

| | How |
|---|---|
| Apple Pencil | Pressure, tilt and hover come through the web view's pointer events (`pointerType: "pen"`), so the pen engine is the same as everywhere else. Double-tap and squeeze (Pencil 2, Pro) switch to the tool chosen in Settings › Pen button and back (`UIPencilInteraction`). |
| On-device AI | Apple's on-device model (Foundation Models, iOS 26 and later, Apple Intelligence on) is the assistant's native engine: no download, no account, nothing leaves the device. The app's own retrieval, tools and citations work on top of it, as with Gemini Nano on Android. Settings shows why it's unavailable when it is (device not eligible, Apple Intelligence off, model still downloading). |
| Your notes in Files | Notes live in the app's Documents folder, which the Files app shows as **On My iPhone/iPad › Inkwright**: plain files you can back up, move or open elsewhere. |
| Sharing, haptics, keyboard, status bar | Capacitor's plugins. |
| Google Drive sign-in | Native Google sign-in, once an iOS OAuth client exists (below). |

Not on iOS, by design: the in-app updater (the App Store and TestFlight update apps) and the
Android-only handwriting recognizer (ML Kit). Handwriting is read by the built-in reader or the AI
you choose.

## Code

- `apps/web/ios/App/App/InkwrightApplePlugin.swift`: Foundation Models (`availability`, streamed
  `generate` with `llmDelta` events, `cancel`) and Pencil events (`pencil`).
- `apps/web/ios/App/App/InkwrightBridgeViewController.swift`: registers the plugin.
- `apps/web/src/ai/apple/plugin.ts`: the web side; registers Apple's model as a `NativeLLM`.
- `apps/web/ios/App/App/Info.plist`: Files app access, permissions text.

## Building and testing

CI (`.github/workflows/ios.yml`) builds the app on a Mac runner for every change to the app, runs
it on the newest iPhone Pro and iPad Pro simulators, and keeps light and dark screenshots and the
app's log (JavaScript console included) as the `ios-simulator` artifact. It fails if the app
doesn't stay running. `scripts/ios/simulator-run.mjs` does the simulator part and also works
locally.

On a Mac with Xcode:

```sh
npm ci
cd apps/web && npx vite build --mode native && npx cap sync ios && npx cap open ios
```

Then pick a simulator or your device in Xcode and press Run. Running on your own device with a
free Apple ID works for 7 days at a time; TestFlight and the App Store need the Apple Developer
Program.

## Google sign-in on iOS

1. In Google Cloud (the same project as Android), **Clients › Create client › iOS**, bundle ID
   `app.inkwright`.
2. Put its client ID in the build as `VITE_GOOGLE_IOS_CLIENT_ID`, and add its reversed form
   (`com.googleusercontent.apps.<number>-<id>`) as a URL scheme in `Info.plist`
   (`CFBundleURLTypes`).

## Publishing (TestFlight and the App Store)

Needs an Apple Developer Program membership (US$99 a year) under the account owner's name.

1. In App Store Connect, create the app with bundle ID `app.inkwright`.
2. Create an App Store Connect API key and a distribution certificate; add them as repository
   secrets for an archive job (`xcodebuild archive` + `-exportArchive`, then upload with
   `xcrun altool` or `fastlane pilot`).
3. TestFlight builds reach up to 10,000 testers by link, with no review for internal testers and a
   short review for external ones. The App Store needs a full review.
