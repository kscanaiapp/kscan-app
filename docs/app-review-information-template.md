# K Scan Store Review Information Template

Last updated: 2026-07-08

> Release-scope warning: This reviewer template is not the Google Play/Data Safety source of truth. For Android Data Safety, use `docs/play-store-readiness-notes.md`.

Use this template when filling store reviewer instructions. Do not commit real reviewer passwords or store account secrets to this repository.

## Contact Information

- First name:
- Last name:
- Phone number:
- Email:

## Reviewer Account

- Username or email: [OWNER TO PROVIDE BEFORE SUBMISSION]
- Password: enter directly in the store console only
- Account status: active, email-confirmed, not pending deletion
- Region/country:
- Notes:

## Review Notes

```text
The current build includes Google OAuth, Apple OAuth, StyleChat, Dressing Rooms, shared rooms, photo-library inspiration upload, privacy controls, data export/correction request entry points, and in-app account deletion request intake. VoiceScan is visible as an inactive "Coming Soon" placeholder only; it does not request microphone permission, record audio, or call backend services in this release. The app does not perform background listening, screen-off recording, biometric voice identification, targeted advertising, push notifications, ads, subscriptions, or in-app purchases. When-In-Use approximate location is requested only for weather-aware StyleChat suggestions, after a prominent in-app disclosure. Location is optional, and raw coordinates are not stored.

Shared Dressing Rooms and room chat contain user-generated content. Each room message includes a Report action that opens a prefilled email to kscanai.app@gmail.com and hides the message locally on the device. Server-side moderation, reporting storage, and user blocking are not implemented in this build.

To review the app:
1. Sign in with the reviewer email/password above.
2. Allow camera access when prompted.
3. Capture a clothing item or outfit for scan analysis.
4. VoiceScan is inactive in this build and displays "Coming Soon" on the onboarding permissions screen and home screen. No microphone prompt should appear.
5. Save a result to the local library, then delete it from the library.
6. Open a Dressing Room message, use Report, and confirm the message hides locally.
7. Open Privacy controls to review privacy settings, export/correction request entry points, and Delete Account.

Users can request account deletion in the app from Privacy > Delete Account. Once a request is submitted, the app marks the account as pending deletion, limits normal app access, and provides a clear sign-out path. Requests are processed through our account lifecycle workflow, generally within 30 days, subject to legal, security, and operational requirements.
```

## Pre-Submission Checks

- [ ] Reviewer account can sign in on the exact TestFlight build.
- [ ] Reviewer account has completed email confirmation if Supabase requires it.
- [ ] Reviewer account is not already in `pending_deletion`.
- [ ] Camera permission prompt appears with the expected purpose text.
- [ ] Microphone permission does not appear; VoiceScan is inactive and no background listening, biometric voice ID, or ad use exists.
- [ ] No ATT, push, payment, subscription, or ad prompt appears.
- [ ] Camera, photo library, and coarse foreground location prompts may appear; their purpose strings are in `app.json`.
- [ ] Privacy URL works: `https://kscan.app/legal/privacy`.
- [ ] Support URL works: `https://kscan.app/support`.
- [ ] Account deletion URL works: `https://kscan.app/legal/delete-account`.
- [ ] UGC report action is visible on room messages and hides content locally.
