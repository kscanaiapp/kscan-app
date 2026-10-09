# Build 35 native device report

Recorded 2026-10-08 ET.

## Result: no physical-device evidence exists. Every device gate is FAIL.

| Item | iOS | Android |
|---|---|---|
| Signed build from the certified SHA | not built | not built |
| Physical device available to this campaign | none | none |
| Cold launch + authentication (Apple, Google, email, OAuth callbacks) | not executed | not executed |
| Scanner camera/gallery, multi-image results, Save / Dressing Room | not executed | not executed |
| Elise interactions, Signature Style | not executed | not executed |
| K+ purchase / restore / lapse | not executed (StoreKit) | not executed (Play Billing) |
| VTO eligibility and consent | not executed | not executed |
| Offline, foreground/background, permission denial and recovery | not executed | not executed |
| Android modal sequencing, back navigation, activity interruption | n/a | not executed |
| Account deletion and sign-out | not executed | not executed |
| Accessibility / Dynamic Type / layout | not executed | not executed |

Emulators and source tests were not substituted and are not counted.

## Build prerequisites verified read-only
- EAS remote version source: iOS latest build number **35** (next allocation 36), Android latest versionCode **33** (next 34). The checked-in seeds (iOS 26, Android 23) are ignored. "Build 35" is therefore no longer the iOS build number.
- EAS remote `production` environment variables: only `GOOGLE_SERVICES_JSON` (file). No remote variable can override a release hold.
- Resolved release profiles: `production` and `build35-release` both pass `scripts/check-build35-release-profile.js`.
- `eas build --platform ios --profile production` and the Android production AAB were **not run**: no build authorization or expenditure approval was given, and building before the candidate SHA is final would certify the wrong source.

## Store prerequisites (read-only snapshots from the earlier session, not re-read here)
App Store subscription products `kscan.kplus.monthly` ($0.99/month, 1-month intro trial) and `kscan.kplus.annual` ($9.99/year, 1-month intro trial) existed with `MISSING_METADATA` and no review information; the Google Play service account was not connected (product reads failed with HTTP 422). Neither store state was changed or re-verified in this session.

## Smallest path to PASS for this report
1. Freeze the candidate SHA (see the binary certification report).
2. Authorize `eas build --platform ios --profile production` and the Android production profile; record build IDs, source SHA, bundle/package IDs, remote build numbers, signing identity; run `node scripts/check-build35-release-profile.js --effective-env-json <private file>` on the resolved environment.
3. Complete App Store product metadata and connect the Play service account.
4. Execute the iOS and Android matrices above on physical devices with sandbox purchase accounts; attach evidence per row.
