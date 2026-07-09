# K Scan App Review Information Template

Last updated: 2026-07-08

> Release-scope warning: This template contains Apple/App Store review notes from an earlier candidate and must not be reused as Google Play/Data Safety source-of-truth. The Android RC on `release/android-1.0.0` includes StyleChat, Dressing Rooms, Google OAuth, Apple OAuth, and account deletion lifecycle work. Use the current QA release notes instead.

Use this template when filling App Store Connect App Review Information. Do not commit real reviewer passwords or Apple account secrets to this repository.

## Contact Information

- First name:
- Last name:
- Phone number:
- Email:

## Reviewer Account

- Username or email:
- Password: enter directly in App Store Connect only
- Account status: active, email-confirmed, not pending deletion
- Region/country:
- Notes:

## Review Notes

```text
The current iOS build includes the restored welcome/onboarding flow, email/password account access, onboarding Google OAuth, onboarding Apple Sign-In, camera scan, photo-library upload, local library, privacy controls, data export/correction request entry points, and in-app account deletion request intake. StyleChat, Dressing Rooms, subscriptions, in-app purchases, ads, tracking, push notifications, location, and microphone access are not active in this build. VoiceScan is visible on the home screen as an inactive "Coming Soon" placeholder only; it does not request microphone permission or record audio. StyleChat/weather-aware styling is guarded off on iOS and does not request or collect location.

Audio/Microphone collection: No. No microphone permission is requested in this build. Voice input is not available.

Welcome / onboarding flow: New users are presented with a full welcome/onboarding tree (Welcome, Auth Choice, Account Setup, Terms + Privacy, Permissions, and a completion/home handoff state). The Permissions page includes Camera and Photos preference choices. Microphone and Notifications are disabled and show only "Coming Soon"; tapping either does not request a native permission. Location is not requested on this page.

Shared Dressing Rooms and room chat are not exposed from the iOS home surface in this branch. If a reviewer reaches an existing UGC route, each room message includes a Report action. Confirming Report & Hide immediately hides the content on the device and filters content from that reported user locally when the sender is known. A server-side content_reports moderation migration has been added for internal review and is pending deployment if not yet applied. Full admin moderation remains a future enhancement.

To review the app:
1. Sign in with the reviewer email/password above.
2. Allow camera access when prompted.
3. Capture a clothing item or outfit for scan analysis.
4. Observe the VoiceScan "Coming Soon" placeholder on the home screen; confirm it is inactive and does not request microphone access.
5. Save a result to the local library, then delete it from the library.
6. Open Privacy controls to review privacy settings, export/correction request entry points, and Delete Account.

Users can request account deletion in the app from Privacy > Delete Account. Once a request is submitted, the app marks the account as pending deletion, limits normal app access, and provides a clear sign-out path. Requests are processed through our account lifecycle workflow, generally within 30 days, subject to legal, security, and operational requirements.
```

## Pre-Submission Checks

- [ ] Reviewer account can sign in on the exact TestFlight build.
- [ ] Reviewer account has completed email confirmation if Supabase requires it.
- [ ] Reviewer account is not already in `pending_deletion`.
- [ ] Camera permission prompt appears with the expected purpose text.
- [ ] No location, microphone, ATT, push, payment, subscription, or ad prompt appears. VoiceScan displays "Coming Soon" on the home screen and does not trigger a microphone prompt.
- [ ] Privacy URL works: `https://kscan.app/legal/privacy`.
- [ ] Support URL works: `https://kscan.app/support`.
- [ ] Account deletion URL works: `https://kscan.app/legal/delete-account`.
- [ ] If UGC routes are included in the reviewed build, the report action is visible on room messages and hides content locally.
