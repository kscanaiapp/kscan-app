# App Store Connect Submission Checklist — K Scan (v1.0.0, build 3)

> Scope: email/password-only release candidate on `feature/beta-account-lifecycle`.
> Prerequisite: an active Apple Developer Program membership and App Store Connect access are required before any item below can be executed. (Not yet active as of 2026-06-10.)

Authentication scope for this release: email/password only.
Because this build does not offer third-party sign-in, Sign in with Apple is not required for this release.
If third-party authentication is added later, Sign in with Apple compliance must be re-evaluated before submission.

## Account & App Record

- [ ] Apple Developer Program membership active.
- [ ] App Store Connect app record created; Bundle ID `com.kscanai.app` registered.
- [ ] EAS iOS credentials configured (`eas credentials -p ios`) — distribution cert + provisioning profile.
- [ ] Verify App Store Connect build-number history; confirm local `buildNumber: "3"` does not collide.

## Build Gates

- [ ] After Apple Developer activation, run the first iOS production EAS cloud build. Do not run local iOS prebuild on Windows for this release packet.
- [ ] On the produced iOS build/artifacts, verify `Info.plist` has no `NSMicrophoneUsageDescription`; `ITSAppUsesNonExemptEncryption` = false; `PrivacyInfo.xcprivacy` is present with declared categories.
- [ ] Production EAS build (`--profile production`) completed and processed in App Store Connect.
- [ ] Correct build selected for the version before submitting.
- [ ] Physical-device smoke test passed (see `ios-physical-device-smoke-test-checklist.md`).

## Review Materials

- [ ] Reviewer credentials (email/password, pre-verified) entered in App Review Information — see `reviewer-demo-account-checklist.md`.
- [ ] App Review Notes pasted from `app-review-notes.md`.
- [ ] TestFlight "What to Test" pasted from `testflight-what-to-test.md`.

## Metadata & Privacy

- [ ] Metadata entered from `app-store-metadata-draft.md` — no third-party login claims, no StyleChat/rooms claims.
- [ ] App Privacy labels filed from `app-privacy-nutrition-label-prep.md`.
- [ ] Screenshots uploaded per `app-store-screenshot-shot-list.md` — features in this build only.
- [ ] Privacy policy URL and support URL live and correct.

## Compliance

- [ ] Export compliance: standard HTTPS only → `ITSAppUsesNonExemptEncryption: false`; answer App Store Connect encryption question accordingly.
- [ ] Content rights: confirm rights to all imagery/branding in app and screenshots; product data sources permit display.
- [ ] Account deletion: in-app deletion path verified working (guideline 5.1.1(v)); beta manual processing documented.
- [ ] Age rating questionnaire completed accurately.

## Backend Checks

- [ ] Render backend reachable; cold-start behavior documented in review notes.
- [ ] Supabase auth and deletion-intake function operational.
- [ ] Rate limits will not block App Review usage.

## Permission Hygiene

- [ ] No unexpected permission prompts on device (microphone, location, push, ATT, photo library) — verified in smoke test.

## If Rejected

See `reference/common-rejections.md` for the top rejection reasons, fixes, and response templates. Most likely categories for this app: 2.1 missing/broken demo account, 4.2 minimum functionality (push-back template applies — native camera + AI processing), 5.1.1 privacy policy URL.

## Intentionally Not Required for This Release

- Sign in with Apple validation — no third-party sign-in exists in this build.
- Google Sign-In validation — not in this build.
- OAuth callback / deep-link sign-in validation — the `kscan://auth/callback` deep link serves Supabase **email** confirmation/reset links only and is covered under email-auth smoke tests, not OAuth.
- Apple private relay email handling — not applicable without Sign in with Apple.
