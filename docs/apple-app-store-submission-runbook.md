# K Scan Apple App Store Submission Runbook

Last updated: 2026-07-07

> Release-scope warning: This runbook contains Apple/App Store preparation notes from an earlier candidate and must not be reused as Google Play/Data Safety source-of-truth. The Android RC on `release/android-1.0.0` includes StyleChat, Dressing Rooms, Google OAuth, Apple OAuth, and account deletion lifecycle work. Use the current QA release notes instead.

## Current Release Scope

- Mobile candidate: earlier Apple candidate; not the current Android RC source of truth
- App version: `1.0.1`
- iOS bundle ID: `com.kscanai.app`
- iOS build number in repo: `13`
- EAS project: `@ams2dad/kscan`
- Current Android RC includes: Google OAuth, Apple OAuth, StyleChat, Dressing Rooms, Share by Link, photo library inspiration upload, privacy controls, data export/correction request entry points, and account deletion lifecycle work.
- Included for this release: photo-library inspiration upload, StyleChat, Dressing Rooms, shared rooms, Google Sign-In, Sign in with Apple, and coarse foreground location for weather-aware StyleChat.
- Still not included for this release: microphone, tracking, push notifications, ads, subscriptions, or in-app purchases.

## Local Submission Readiness

- `app.json` contains App Store bundle metadata, camera purpose text, `ios.buildNumber`, `ios.supportsTablet: false`, export encryption config, and privacy manifest declarations.
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
- App name: `K Scan`
- Subtitle: `AI fashion discovery`
- Primary category: Shopping
- Secondary category: Lifestyle
- Privacy URL: `https://kscan.app/legal/privacy`
- Support URL: `https://kscan.app/support`
- Release option: manual release after approval
- Age rating: not Made for Kids. EAS Metadata currently supports `NONE`, `SEVENTEEN_PLUS`, and `UNRATED` for `ageRatingOverride`; it does not encode a 13+ override. Leave `ageRatingOverride: "NONE"` unless App Store Connect review requires a manual higher rating.

If App Store Connect already has build number `13` for version `1.0.1`, bump `ios.buildNumber` before building again.

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
- Confirming opens a prefilled email to `support@kscan.app` and hides the message locally on the device using the key `kscan.hidden_content_ids.v1`.
- No server-side report log, moderation queue, or user block list exists in this build.
- Full server-side moderation, reporting storage, and user blocking remain future enhancements.

## App Privacy Defaults

Use these as the App Store Connect App Privacy baseline for the current build:

- Email address: collected, linked to user, app functionality/account management
- User ID: collected, linked to user, app functionality/account management
- Photos or videos: collected for user-submitted scan analysis, linked to user if associated with an authenticated account, app functionality
- Diagnostics: declare only if retained in production logs
- Tracking: no
- Data used for tracking: no
- Approximate/When-In-Use location: yes for weather-aware StyleChat only (coarse, transient, optional, not stored or linked to user)
- Contacts, audio, payment, purchases, health, fitness, sensitive info, browsing history, search history, advertising data: no for this build

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
Users can request account deletion in the app from Privacy > Delete Account. The request is recorded server-side, the account is marked pending deletion, and pending-deletion accounts are blocked from normal app use. K Scan processes deletion requests manually using a service-role Supabase operator script and completes eligible requests within 30 days.
```

## Final QA Before App Review

- Install the TestFlight build on a physical iPhone.
- Sign in with a pre-verified reviewer account.
- Allow camera permission and complete one scan.
- Save and delete a local library item.
- Verify no microphone, photo library, location, push, ATT, or payment prompts appear.
- Submit export/correction requests from Privacy controls.
- Submit account deletion and verify the confirmation appears before sign-out.
- Re-login to a pending-deletion account and verify access is limited to Privacy controls.
- In a shared room with chat enabled, post a room message, tap **Report**, confirm **Report & Hide**, and verify the message is hidden locally and a prefilled email to `support@kscan.app` is offered.
- Confirm live pages return 200:
  - `https://kscan.app/legal/privacy`
  - `https://kscan.app/privacy`
  - `https://kscan.app/legal/delete-account`
  - `https://kscan.app/support`
