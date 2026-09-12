# K Scan AI Apple App Store Submission Runbook

Last updated: 2026-09-08

> Release-scope warning: this runbook is the iOS/App Store source of truth and must not be reused for Google Play or Data Safety answers. For Android Data Safety, use `docs/play-store-readiness-notes.md`.
>
> Every claim here is derived from `app.json` and `eas.json` → `build.production` on the current release authority. Where a claim depends on an artifact that does not exist yet (the submitted build number), it is marked ARTIFACT GATE rather than guessed.

## Current Release Scope

- App version: `1.0.1`
- iOS bundle ID: `com.kscanai.app`
- EAS project: `@ams2dad/kscan`
- **Checked-in source build number** (`app.json` → `ios.buildNumber`): `26`
- **Submitted archive build number: ARTIFACT GATE — do not state until the production artifact exists.** `eas.json` sets `cli.appVersionSource: "remote"` and `build.production.autoIncrement: true`, so EAS assigns the build number remotely at build time. The checked-in `26` is the source value, not a prediction of what the submitted archive will carry. Read the real number off the produced artifact / App Store Connect before recording it anywhere reviewer-facing.
- Included for this release: camera scan analysis, TextScan, retailer-neutral commerce discovery, Closet (saved scans, batch review, candidate staging, direct intake), Signature Style, StyleChat/Elise, Dressing Rooms, room chat, shared rooms, private Dressing Rooms, Mirror Selfie, photo-library inspiration upload, Google Sign-In, Sign in with Apple (including credential-state revocation handling), email/password sign-in, coarse foreground location for weather-aware StyleChat, and the account deletion + restoration lifecycle.
- Built but DISABLED in the production profile, and therefore not part of the reviewer flow: VoiceScan, Virtual Try-On, K+, Packing Intelligence, Wardrobe Concierge, Smart Watchlist, Today with Elise.
- Microphone and Speech Recognition: purpose strings SHIP IN THE BINARY (`NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`) because VoiceScan is built into the codebase. Production VoiceScan is disabled, so no microphone or speech prompt is expected during review. Do not claim the app lacks microphone capability — the submitted artifact contains it.
- Push notifications: `expo-notifications` ships and the onboarding Permissions step can request notification permission in production. It is optional and defaults off, and no push is produced in this configuration because Smart Watchlist is disabled. Do not claim "no push notifications".
- Not present: tracking/ATT, ads, and any reachable purchase or subscription surface (the K+ boundary is disabled).

## Local Submission Readiness

- `app.json` contains App Store bundle metadata, camera purpose text, `ios.buildNumber`, `ios.supportsTablet: true` (universal iPhone + iPad submission), export encryption config, and privacy manifest declarations.
- `eas.json` contains a `production` iOS store-distribution profile using `macos-sequoia-15.6-xcode-26.0`.
- `store.config.json` contains a linted EAS Metadata draft for App Store categories, release mode, age-rating questionnaire, and English (U.S.) listing copy.
- Pending-deletion accounts are limited to Privacy controls instead of Scan/Home/Library.
- `docs/account-deletion-operations.md` and `scripts/process-deletion-request.js` provide the manual service-role deletion process for completing eligible deletion requests within 30 days.
- Public website copy has been scoped to the current iOS release surface.
- `.easignore` excludes local QA audit/deploy artifacts from future EAS uploads.

Run the local submission preflight before credentials/build work:

```powershell
npm run verify:apple-readiness
```

Run the full local submission gate before queuing a production build:

```powershell
npm run verify:apple-submission
```

## Native iOS Verification Note

This Windows workstation cannot generate an Expo iOS native project with `npx expo prebuild --platform ios`. A Docker/Linux prebuild proof was attempted, but dependency installation on the Windows-mounted temp tree timed out before producing `ios/`. Treat final `Info.plist`, `PrivacyInfo.xcprivacy`, SDK, entitlement, and permission verification as an EAS/macOS build-inspection step after iOS credentials are configured.

## Current External Blocker

The remote iOS production build has not been queued because EAS credentials are incomplete for non-interactive store builds.

Observed command:

```powershell
npx --yes eas-cli@latest build --platform ios --profile production --non-interactive --json
```

Observed result:

```text
Distribution Certificate is not validated for non-interactive builds.
Failed to set up credentials.
Credentials are not set up. Run this command again in interactive mode.
```

## Required Interactive Credential Step

Run this from the mobile repo and complete the Apple Developer prompts:

```powershell
npx --yes eas-cli@latest credentials -p ios
```

Choose or create credentials for:

- Bundle ID: `com.kscanai.app`
- Distribution type: App Store
- Apple distribution certificate
- App Store provisioning profile

After credentials are created, re-run:

```powershell
npx --yes eas-cli@latest build --platform ios --profile production --non-interactive --json
```

## App Store Connect Setup

Create or verify the App Store Connect app record before submission:

- Bundle ID: `com.kscanai.app`
- SKU: `kscan-ios`
- App name: `K Scan AI`
- Subtitle: `AI fashion discovery`
- Primary category: Shopping
- Secondary category: Lifestyle
- Privacy URL: `https://kscan.app/legal/privacy`
- Support URL: `https://kscan.app/support`
- Release option: manual release after approval
- Age rating: not Made for Kids. EAS Metadata currently supports `NONE`, `SEVENTEEN_PLUS`, and `UNRATED` for `ageRatingOverride`; it does not encode a 13+ override. Leave `ageRatingOverride: "NONE"` unless App Store Connect review requires a manual higher rating.

Build numbers are assigned remotely (`appVersionSource: "remote"` + `autoIncrement`), so a manual bump of `ios.buildNumber` is normally unnecessary. If App Store Connect reports a collision for version `1.0.1`, resolve it through the remote version authority rather than by hand-editing `app.json`.

After the App Store Connect app record exists, add the numeric App Store Connect app ID to:

```json
{
  "submit": {
    "production": {
      "ios": {
        "metadataPath": "./store.config.json",
        "ascAppId": "REPLACE_WITH_ASC_APP_ID"
      }
    }
  }
}
```

## Final Build And Submit Commands

```powershell
npx --yes eas-cli@latest metadata:lint
npx --yes eas-cli@latest build --platform ios --profile production --non-interactive
npx --yes eas-cli@latest submit --platform ios --profile production --latest --non-interactive
```

After the binary has processed in App Store Connect, push the metadata if desired:

```powershell
npx --yes eas-cli@latest metadata:push --non-interactive
```

## UGC / Report and Local Hide

- Shared Dressing Rooms and room chat are the primary UGC surfaces in this build.
- Each room message has a **Report** action that opens a confirmation with **Report & Hide**.
- Confirming immediately hides the message locally on the device using `kscan.hidden_content_ids.v1` and filters content from the reported sender using `kscan.hidden_user_ids.v1` when the sender id is known.
- A server-side `content_reports` moderation migration has been added for internal review and is pending deployment if not yet applied. Full server-side moderation, reporting storage, and user blocking remain future enhancements.

## iOS Permission Matrix

Current as of the release authority. "Capability in binary" and "prompt expected
during review" are deliberately separate columns — a shipped purpose string does
not mean the reviewer will see a prompt.

| Permission | Capability in binary? | Request is JIT? | Production feature that triggers it | Optional? | Expected on the normal App Review path? |
|---|---|---|---|---|---|
| Camera | Yes (`NSCameraUsageDescription`, `expo-camera`) | Yes — at scan start | Scanner | Required for scanning | **Yes** |
| Photo library | Yes (`NSPhotoLibraryUsageDescription`, `expo-image-picker`) | Yes — at picker open | Scan from library, Closet intake, Mirror Selfie, StyleChat attachments | Yes | Likely, if the reviewer picks an existing photo |
| Microphone | Yes (`NSMicrophoneUsageDescription`, `expo-audio`) | Yes — at VoiceScan start | VoiceScan — **disabled in production** | n/a | **No** |
| Speech Recognition | Yes (`NSSpeechRecognitionUsageDescription`) | Yes — at VoiceScan start | VoiceScan — **disabled in production** | n/a | **No** |
| Location (When In Use, approximate) | Yes (`NSLocationWhenInUseUsageDescription`, `expo-location`) | Yes — after a prominent in-app disclosure | Weather-aware StyleChat | Yes | Only if that flow is exercised |
| Notifications | Yes (`expo-notifications`) | Yes — from the onboarding Permissions toggle | Onboarding Permissions step; delivery would come from Smart Watchlist, which is **disabled in production** | Yes, defaults off | Only if the reviewer turns the toggle on |

Proven absent from the current source and configuration:

- **No background location** — `NSLocationAlwaysAndWhenInUseUsageDescription` is not declared and `UIBackgroundModes` is absent from `app.json`.
- **No background listening** — no `audio` background mode; microphone use is foreground VoiceScan only, and VoiceScan is disabled in production.
- **No ATT request** — `NSUserTrackingUsageDescription` is not declared and no AppTrackingTransparency dependency exists.
- **No contacts** — no contacts usage description or dependency.
- **No Bluetooth** — no Bluetooth usage description or dependency.

## App Privacy Defaults

Use these as the App Store Connect App Privacy baseline for the current build:

- Email address: collected, linked to user, app functionality/account management
- User ID: collected, linked to user, app functionality/account management
- Photos or videos: collected for user-submitted scan analysis, linked to user if associated with an authenticated account, app functionality
- Diagnostics: declare only if retained in production logs
- Tracking: no
- Data used for tracking: no
- Approximate/When-In-Use location: yes for weather-aware StyleChat only (coarse, transient, optional, not stored or linked to user)
- Contacts, payment, purchases, health, fitness, sensitive info, browsing history, advertising data: no for this build
- Audio: no audio is captured — VoiceScan is disabled in production, though its purpose strings ship in the binary
- Search history: declared in the privacy manifest (TextScan queries are sent while authenticated and persisted against the account when saved)
- Device ID: collected, linked to user, app functionality — the Watchlist push-registration installation identifier
- **Product Interaction — POSTHOG PRODUCTION STATE — PENDING REPAIR 03 ENVIRONMENT VERIFICATION.** The privacy manifest currently declares Product Interaction as collected, NOT linked, for Analytics. Whether that linkage is correct depends on whether PostHog is actually configured in the production EAS environment, which has not yet been authoritatively verified. Do not answer the App Store Connect analytics questions, and do not change the Product Interaction declaration, until Repair 03 closes.

## Location / Prominent Disclosure

The app requests only `NSLocationWhenInUseUsageDescription` approximate location for weather-aware StyleChat. A prominent in-app disclosure is shown before the OS permission prompt. The disclosure explains that location is optional, used only while the app is in use, and that raw coordinates are not stored.

Reviewer-facing wording:

```text
K Scan AI requests When-In-Use approximate location only to tailor StyleChat suggestions to local weather. Location is optional, and raw coordinates are not stored.
```

## App Review Notes

Use `docs/app-review-information-template.md` when filling App Store Connect. Enter real reviewer credentials directly in App Store Connect or a secure secret manager, not in git.

Include the UGC note from the Review Notes section of `docs/app-review-information-template.md` so reviewers understand the no-DB report + local-hide behavior.

Use this operational deletion statement only after the service-role process in `docs/account-deletion-operations.md` has been accepted by the release owner:

```text
Users can request account deletion in the app from Privacy > Delete Account. Submitting the request deactivates the account immediately and starts a 30-day restoration window, during which the user can restore the account. A deactivated account is limited to Privacy controls and a clear sign-out path. If the account is not restored within that window, the account and associated data are permanently deleted, subject to required legal retention. K Scan AI completes eligible permanent deletions using the service-role operator process in docs/account-deletion-operations.md.
```

## Final QA Before App Review

- Install the TestFlight build on a physical iPhone.
- Sign in with a pre-verified reviewer account.
- Allow camera permission and complete one scan.
- Save and delete a local library item.
- Verify no microphone, speech-recognition, ATT, or payment prompts appear (VoiceScan is disabled in production even though its purpose strings ship). Camera, photo library, and contextual approximate-location prompts may appear when their feature flows are exercised. The notifications prompt appears only if the optional onboarding Permissions toggle is turned on.
- Submit export/correction requests from Privacy controls.
- Submit account deletion and verify the confirmation states immediate deactivation and the 30-day restoration window before sign-out.
- Re-login to a deactivated account and verify access is limited to Privacy controls and that the restore path is presented.
- In a shared room with chat enabled, post a room message, tap **Report**, confirm **Report & Hide**, and verify the message is hidden locally. If server reporting is unavailable or fails, verify the fallback report email targets `kscanai.app@gmail.com`.
- Confirm live pages return 200:
  - `https://kscan.app/legal/privacy`
  - `https://kscan.app/privacy`
  - `https://kscan.app/legal/delete-account`
  - `https://kscan.app/support`
