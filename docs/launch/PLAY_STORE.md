# Publishing Inkwright on Google Play

Everything Play asks for is already in this repository. This page walks through the parts only the account owner can do, in order. Allow about **3 weeks** end to end for a new personal account: new personal accounts must run a 14-day closed test with at least 12 testers before they can publish to production.

## What's ready

| Play asks for | Where it is |
|---|---|
| App bundle (.aab), signed with the upload key | `release.yml` builds it from a version tag. To build it locally, see "Build the bundle" below. |
| App name, short and full description | `fastlane/metadata/android/en-US/{title,short_description,full_description}.txt` |
| App icon 512×512 | `fastlane/metadata/android/en-US/images/icon.png` |
| Feature graphic 1024×500 | `fastlane/metadata/android/en-US/images/featureGraphic.jpg` |
| Phone, 7-inch and 10-inch screenshots | `fastlane/metadata/android/en-US/images/{phone,sevenInch,tenInch}Screenshots/`. Regenerate them with `STORE=docs/store/screenshots npx playwright test e2e/store.spec.ts --project desktop` (run in `apps/web`), then `node scripts/brand/store-frames.mjs`. |
| Privacy policy URL | `https://dev-null-k2.github.io/inkwright/privacy.html`, built from `docs/PRIVACY.md` by the Pages workflow |
| Release notes | `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` |
| Target API level | `targetSdk 36` (Android 16), which is what Play requires for new apps and updates from 31 August 2026 |

## 1. Create the developer account (once)

1. Go to <https://play.google.com/console/signup> and pick **Personal**. Pick **Organization** only if you have a company with a D-U-N-S number. An organization account is exempt from the 12-tester rule and shows a company name, which is better for selling to businesses later.
2. Pay the one-time US$25 fee and verify your identity.
3. Install the **Play Console** app on an Android phone and confirm the device when asked. Personal accounts must do this before they can publish anything.

## 2. Create the app

Play Console › **Create app**:
- Name: *Inkwright: handwriting notes*
- Type: App
- Price: Free
- Accept the declarations.

**Set up your app** (Dashboard) asks for the following.

| Section | Answer |
|---|---|
| Privacy policy | `https://dev-null-k2.github.io/inkwright/privacy.html` |
| App access | All functionality is available without special access |
| Ads | No ads |
| Content rating | Fill in the questionnaire. Category: Productivity/Utility. No violence, sexual content, gambling or drugs. Users can share content and the app connects to AI chat services the user chooses, so answer **Yes** to "users can interact or exchange content" only if you count live page sharing; it's between the user's own invitees. You'll most likely get *Everyone* or *Teen*. |
| Target audience | 13+ (the privacy policy says it isn't directed at children under 13) |
| News app | No |
| Data safety | See below |
| Government app / financial features / health | No |

### Data safety (conservative answers)

The developer collects nothing. Play still counts data that the app sends off the device, even when the user started the request and chose the destination. Declaring it is the safe choice.

- **Does your app collect or share any of the required user data types?** Yes.
- **Data shared with third parties.** These are the AI provider, Google Drive or WebDAV the user configures, and only when the user turns those features on.
  - App activity › *Other user-generated content* (notes text and handwriting): purpose *App functionality*; optional.
  - Audio › *Voice or sound recordings*: purpose *App functionality*; optional. This covers transcription when the user picks a cloud provider.
  - Files and docs: purpose *App functionality*; optional. This covers sync to the user's own storage.
- **Is all user data encrypted in transit?** Yes.
- **Can users request that data be deleted?** Yes. Notes are deleted in the app, and synced copies live in the user's own storage.
- **Data collected by the developer:** none. There are no analytics, no crash reporting service and no accounts.

## 3. App signing and the upload key

1. Under Play Console › **Test and release › App integrity**, keep **Play App Signing** on (the default). Google holds the app signing key, and you sign uploads with your upload key.
2. The upload key was generated in the build session (`inkwright-upload.jks`, alias `inkwright-upload`). Keep the file and its password in a password manager. If you ever lose them, the account owner can ask Google to reset the upload key.
   - Upload key SHA-1: `62:4D:60:8C:7A:A5:A2:CA:EA:3F:47:71:D6:83:13:51:39:02:B5:2A`
   - Upload key SHA-256: `35:B7:EF:94:14:1F:B0:83:07:A3:21:1B:2B:70:B7:60:08:E9:E8:1D:0F:EF:84:DC:BC:A0:D1:7A:9D:CB:69:B1`
3. For the release workflow, add these GitHub repository secrets (Settings › Secrets and variables › Actions):
   - `ANDROID_KEYSTORE_BASE64`: the output of `base64 -w0 inkwright-upload.jks`
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS` = `inkwright-upload`
   - `ANDROID_KEY_PASSWORD`

## 4. Google sign-in for the store build

Google sign-in works only after you register OAuth clients in your own Google Cloud project. Full steps are in `docs/GOOGLE_SETUP.md`.

1. Create a **Web** OAuth client, and put its ID in the build as the `VITE_GOOGLE_CLIENT_ID` repository variable (or in `apps/web/.env` for local builds).
2. Create **Android** OAuth clients for package `app.inkwright` with these SHA-1 fingerprints:
   - the **app signing key**. Copy it from Play Console › App integrity once the first bundle is uploaded. This is the one store users get.
   - the upload key: `62:4D:60:8C:7A:A5:A2:CA:EA:3F:47:71:D6:83:13:51:39:02:B5:2A`
   - the debug key used for test APKs from this build session: `5B:46:31:7B:05:BE:EE:0B:83:43:86:27:52:14:15:1B:06:61:AE:F8`
3. In the OAuth consent screen, publish the app to **In production**. The scopes are `drive.file`, `openid`, `email` and `profile`, which Google treats as non-sensitive, so there is no security review.

Until this is done, the app explains that Google sign-in isn't set up and offers device pairing, WebDAV or a folder instead.

## 5. Closed test (14 days, at least 12 testers)

1. Go to **Test and release › Testing › Closed testing › Create track** and name it "Beta".
2. Testers: create an email list with at least 12 Google accounts (friends, classmates, colleagues). Testers on the internal track don't count toward the 12, so use the closed track.
3. Create a release and upload the `.aab`, with release notes from `changelogs/10000.txt`. Roll it out to the closed track.
4. Share the opt-in link. Every tester must **opt in and keep the app installed for 14 consecutive days**.
5. Ask testers to use it and send feedback. Google checks for real engagement. The in-app device check (Settings › About) gives them a report they can send you.
6. After 14 days, go to **Dashboard › Apply for production** and answer the questions about your test. Google usually replies within about 7 days.

## 6. Production

1. **Store presence › Main store listing:** paste the texts and upload the images from `fastlane/metadata/android/en-US`. Category: Productivity. Tags: Note taking, Productivity.
2. **Production › Create release:** promote the closed-test bundle, or upload a new one. Use a staged rollout (20% → 50% → 100%) so problems surface early.
3. Optional: automate later uploads with `fastlane supply --aab <file> --track production`, using a Play service-account JSON key.

## Build the bundle locally

```sh
cp /path/to/keystore.properties apps/web/android/keystore.properties   # storeFile, storePassword, keyAlias, keyPassword
cd apps/web && npx vite build --mode native && npx cap sync android
cd android && ./gradlew bundleRelease          # → app/build/outputs/bundle/release/app-release.aab
```

Bump `versionCode` (it must increase with every upload) and `versionName` in `apps/web/android/app/build.gradle`. A version tag (`git tag v1.0.0 && git push --tags`) makes the release workflow do it for you.
