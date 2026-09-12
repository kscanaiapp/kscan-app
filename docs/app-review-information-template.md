# K Scan AI Store Review Information Template

Last updated: 2026-09-08

> Release-scope warning: This reviewer template is not the Google Play/Data Safety source of truth. For Android Data Safety, use `docs/play-store-readiness-notes.md`.

Use this template when filling store reviewer instructions. Do not commit real reviewer passwords or store account secrets to this repository.

Every claim below is derived from the production build configuration
(`eas.json` → `build.production`) and `app.json` on the current release
authority. A capability that exists in the binary is described as such even
when the feature that would use it is disabled — never as "the app cannot do
this".

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
Sign-in offers three options: email/password, Sign in with Apple, and Google. Any one of them reaches the same app. Use the reviewer email/password above unless testing a specific provider.

This build includes camera-based scan analysis, TextScan, retailer-neutral commerce discovery, the Closet (including saved scans and batch review), Signature Style, StyleChat with Elise, Dressing Rooms with room chat and shared rooms, Mirror Selfie, privacy controls, data export/correction request entry points, and in-app account deletion.

Permissions you may see, and where:
- Camera — when you start a scan.
- Photo library — when you choose an existing photo for a scan, Closet item, or Mirror Selfie.
- Notifications — optional toggle on the onboarding Permissions step. It is off unless you turn it on, and nothing in this production configuration sends a push, because the Smart Watchlist feature that produces alerts is disabled.
- Approximate location (When In Use) — only for weather-aware StyleChat suggestions, after a prominent in-app disclosure. Optional; raw coordinates are not stored.

Microphone and Speech Recognition purpose strings are present in the binary because the VoiceScan feature is built into the codebase. VoiceScan is DISABLED in this production configuration, so no microphone or speech-recognition prompt should appear during review, and no audio is captured. The TextScan feature row shows an inactive "Coming Soon" placeholder in its place. The app performs no background listening, no screen-off recording, and no biometric voice identification.

The app does not request App Tracking Transparency, show ads, or present any purchase or subscription surface in this configuration.

Shared Dressing Rooms and room chat contain user-generated content. Each room message includes a Report action. Confirming Report & Hide immediately hides the content on the device and filters content from that reported user locally when the sender is known. Full admin dashboard and server-side cross-device blocking remain future enhancements.

To review the app:
1. Sign in with the reviewer email/password above (or with Apple/Google).
2. Allow camera access when prompted.
3. Capture a clothing item or outfit for scan analysis.
4. Save a result to the Closet, then delete it.
5. Open a Dressing Room message, use Report, and confirm the message hides locally.
6. Open Privacy controls to review privacy settings, export/correction request entry points, and Delete Account.

No microphone or speech prompt should appear at any point in the above flow.

Account deletion: from Privacy > Delete Account. Submitting the request deactivates the account immediately and starts a 30-day restoration window during which the user can restore it. If it is not restored, the account and associated data are permanently deleted after that window, subject to required legal retention. A deactivated account is limited to Privacy controls and a clear sign-out path.

Intentionally unavailable in this production configuration (built but disabled, so they must not be exercised during review): VoiceScan, Virtual Try-On, K+ (the premium boundary), Packing Intelligence, Wardrobe Concierge, Smart Watchlist, and Today with Elise.
```

## Production Feature State (source of truth for the notes above)

Derived from `eas.json` → `build.production`. A flag absent from that profile
resolves to `false` (`constants/featureFlags.ts` resolvers compare against the
literal string `'true'`), so "not declared" means "off".

| Enabled in production | Disabled in production |
|---|---|
| Scanner, TextScan (+ backend) | VoiceScan (`EXPO_PUBLIC_VOICESCAN_ENABLED` not declared) |
| Retailer-neutral commerce discovery | Virtual Try-On (`EXPO_PUBLIC_VTO_UI_ENABLED` not declared) |
| Closet, batch review, candidate staging, direct intake | K+ premium boundary (`EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED` not declared) |
| Signature Style (profile, context, reason feedback) | Packing Intelligence (`EXPO_PUBLIC_PACKING_INTELLIGENCE_V1` not declared) |
| StyleChat / Elise, attachments, identification V2 | Wardrobe Concierge (`EXPO_PUBLIC_ELISE_CONCIERGE_V1` not declared) |
| Dressing Rooms, room chat, shared rooms, private rooms | Smart Watchlist (`EXPO_PUBLIC_SMART_WATCHLIST_V1` not declared) |
| Mirror Selfie (iOS-supported platform) | Today with Elise (`EXPO_PUBLIC_TODAY_WITH_ELISE_V1=false`) |
| Weather-aware approximate location | |
| Sign in with Apple, Google, email/password | |
| Account deletion + restoration lifecycle | |

## Pre-Submission Checks

- [ ] Reviewer account can sign in on the exact TestFlight build.
- [ ] Reviewer account has completed email confirmation if Supabase requires it.
- [ ] Reviewer account is not already deactivated/pending deletion.
- [ ] Camera permission prompt appears with the expected purpose text.
- [ ] Microphone and speech-recognition prompts do NOT appear — VoiceScan is disabled in production. (The purpose strings still ship in the binary; that is expected.)
- [ ] No ATT, ad, payment, or subscription prompt appears.
- [ ] Camera, photo library, and coarse foreground location prompts may appear at their feature boundaries; purpose strings are in `app.json`.
- [ ] The notifications toggle on the onboarding Permissions step is optional and defaults off.
- [ ] Privacy URL works: `https://kscan.app/legal/privacy`.
- [ ] Support URL works: `https://kscan.app/support`.
- [ ] Account deletion URL works: `https://kscan.app/legal/delete-account`.
- [ ] UGC report action is visible on room messages and hides content locally.
- [ ] Deletion request deactivates immediately and presents the 30-day restoration window.
