# K Scan AI Store Review Information Template

Last updated: 2026-10-11. Build 35 pre-build draft; not evidence about a live or signed artifact.

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
- Notifications — optional toggle on the onboarding Permissions step. It defaults off. Smart Watchlist is enabled in the approved Build 35 source profile; worker/scheduling readiness and actual device delivery must be certified separately.
- Approximate location (When In Use) — only for weather-aware StyleChat suggestions, after a prominent in-app disclosure. Optional; raw coordinates are not stored.

VoiceScan is enabled in the Build 35 source configuration. Microphone and Speech Recognition permission prompts appear when the user starts Voice Scan. Recognition requires on-device support; raw Voice Scan audio is not sent to K Scan's backend. The resulting transcript uses the Text Scan commerce flow. The app performs no background listening, no screen-off recording, and no biometric voice identification. Native permission and recognition behavior are post-build checks.

The app does not request App Tracking Transparency or show ads. K+ purchase and restore use RevenueCat and the platform store; verify them with authorized sandbox actors on the exact release artifact.

Shared Dressing Rooms and room chat contain user-generated content. Each room message includes a Report action. Confirming Report & Hide immediately hides the content on the device and filters content from that reported user locally when the sender is known. Full admin dashboard and server-side cross-device blocking remain future enhancements.

To review the app:
1. Sign in with the reviewer email/password above (or with Apple/Google).
2. Allow camera access when prompted.
3. Capture a clothing item or outfit for scan analysis.
4. Save a result to the Closet, then delete it.
5. Open a Dressing Room message, use Report, and confirm the message hides locally.
6. Open Privacy controls to review privacy settings, export/correction request entry points, and Delete Account.

Exercise Voice Scan separately to check contextual permission prompts, denial and unavailable on-device recognition. Written Text Scan remains available.

Account deletion: from Privacy > Delete Account. Submitting the request deactivates the account immediately and starts a 30-day restoration window during which the user can restore it. If it is not restored, the account and associated data are permanently deleted after that window, subject to required legal retention. A deactivated account is limited to Privacy controls and a clear sign-out path.

Today with Elise is intentionally OFF and excluded from Build 35. Legacy complimentary K+ Early Access acquisition is OFF; paid K+ purchase/restore remains in scope. Elise Speech is an approved opt-in release feature and its store-profile flag is ON, with the exact owner-approved per-device disclosure. However, spoken playback is NOT operational while the independent Production provider kill switch is OFF and its character budget is zero. The new K+ enforcement migration and Edge handler must be separately promoted, approved daily character allocation must be set, and signed-device audio/consent/paid-plan verification must pass. Do not submit this draft as final review instructions until those backend and post-build requirements are resolved.
```

## Production Feature State (source of truth for the notes above)

Derived from `eas.json` → `build.production`. A flag absent from that profile
resolves to `false` (`constants/featureFlags.ts` resolvers compare against the
literal string `'true'`), so "not declared" means "off".

| Enabled in Build 35 store-profile source | OFF in current candidate source |
|---|---|
| Scanner, TextScan (+ backend), VoiceScan (`EXPO_PUBLIC_VOICESCAN_ENABLED=true`) | Elise Speech (`EXPO_PUBLIC_ELISE_SPEECH=true` in build; Production provider spending OFF pending approved limits and backend promotion) |
| Retailer-neutral commerce discovery, Virtual Try-On (`EXPO_PUBLIC_VTO_UI_ENABLED=true`) | |
| Closet, batch review, candidate staging, direct intake and Cloud Closet | K+ complimentary Early Access acquisition (`EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED=false`) |
| Signature Style and Packing Intelligence (`EXPO_PUBLIC_PACKING_INTELLIGENCE_V1=true`) | |
| StyleChat / Elise and Wardrobe Concierge (`EXPO_PUBLIC_ELISE_CONCIERGE_V1=true`) | |
| Dressing Rooms and Smart Watchlist (`EXPO_PUBLIC_SMART_WATCHLIST_V1=true`) | |
| Mirror Selfie (iOS-supported platform) | Today with Elise (`EXPO_PUBLIC_TODAY_WITH_ELISE_V1=false`) |
| Weather-aware approximate location | |
| Sign in with Apple, Google, email/password | |
| Account deletion + restoration lifecycle | |

## Pre-Submission Checks

- [ ] Reviewer account can sign in on the exact TestFlight build.
- [ ] Reviewer account has completed email confirmation if Supabase requires it.
- [ ] Reviewer account is not already deactivated/pending deletion.
- [ ] Camera permission prompt appears with the expected purpose text.
- [ ] Microphone and speech-recognition prompts appear only at an authorized Voice Scan start; denial and unavailable on-device recognition fall back gracefully.
- [ ] No ATT or ad prompt appears. Verify K+ store purchase/restore separately with an authorized sandbox actor.
- [ ] Camera, photo library, and coarse foreground location prompts may appear at their feature boundaries; purpose strings are in `app.json`.
- [ ] The notifications toggle on the onboarding Permissions step is optional and defaults off.
- [ ] Privacy URL works: `https://kscan.app/legal/privacy`.
- [ ] Support URL works: `https://kscan.app/support`.
- [ ] Account deletion URL works: `https://kscan.app/legal/delete-account`.
- [ ] UGC report action is visible on room messages and hides content locally.
- [ ] Deletion request deactivates immediately and presents the 30-day restoration window.

Source profile/native wiring evidence is PREBUILD_VERIFIED only. Speech server
deployment and Watchlist worker readiness remain UNVERIFIED until their own
checks pass. Exact artifact permissions, microphone/audio, push receipt and
store purchase/restore are POSTBUILD_REQUIRED. This draft certifies no delivery.
