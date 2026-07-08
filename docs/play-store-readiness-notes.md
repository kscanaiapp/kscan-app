# K Scan AI — Play Store Readiness Notes

_Last updated: 2026-07-08 (integration/free-tier-beta-into-style-dna)_

This document is the current source of truth for Google Play Console entries and Data Safety declarations. It reflects the code/config on this branch as of the date above.

## 1. Current Release Scope

The shipping build includes:

- Email/password authentication, anonymous/guest sign-in
- Google Sign-In, Sign in with Apple
- Camera-based fashion scan analysis
- StyleChat (AI style advice)
- Dressing Rooms + shared rooms + room messages/reactions
- Photo-library inspiration upload to Style Closet
- Local saved scan library
- Privacy controls, data export/correction request entry points
- In-app account deletion request intake
- Weather-aware StyleChat using coarse foreground location
- VoiceScan placeholder only (planned / coming soon; no active microphone use, recording, upload, or backend processing in this release)

## 2. Location / Data Safety

### What the app requests

- **Android permission:** `android.permission.ACCESS_COARSE_LOCATION` only.
- Fine location is explicitly blocked in Expo Android config to keep Play Data Safety coarse-only.
- **iOS purpose string:** `NSLocationWhenInUseUsageDescription` — "K Scan AI uses your approximate location while you use the app to tailor StyleChat suggestions to your local weather. Your raw coordinates are not stored."
- **No fine location**, no background location, no continuous tracking.

### How location is used

- `components/style-chat/StyleChatWeatherPrompt.tsx` shows a prominent in-app disclosure before any OS permission request.
- `services/weather/weatherStylingContext.ts` requests foreground permission only inside the disclosure primary-button callback.
- `Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low })` returns a city-scale fix.
- Raw latitude/longitude are rounded immediately; only rounded coordinates are sent to the `stylechat-generate` Edge Function for weather context.
- GPS coordinates are not stored, logged, or linked to the user account.

### Play Console / Data Safety answers

| Data type | Collected? | Shared? | Purpose |
|---|---|---|---|
| Camera | Yes | No | Camera scan capture |
| Approximate location | Yes | No | Weather-aware style advice (coarse, foreground, transient) |
| Precise location | No | No | Fine location is not requested |
| Photos and videos | Yes (user-submitted scans and inspiration uploads) | Yes — images are sent to Google Gemini for AI analysis | App functionality |
| Audio / microphone | No | No | VoiceScan is a visible "Coming Soon" placeholder only; no microphone access, recording, collection, transmission, storage, or processing in this release |
| Email address | Yes | No | Account management |
| User ID | Yes | No | Account management / app functionality |
| Style chats / messages | Yes | No | App functionality (Dressing Rooms, StyleChat) |
| User-generated content (rooms, messages, reactions) | Yes | No | App functionality |
| App interactions / usage | Yes | No | App functionality, security, abuse prevention, and usage limits |
| Device or other IDs | Yes | No | Auth/session/security identifiers where required by platform services |
| Diagnostics / crash data | Only if retained in production logs | No | App functionality / security |
| Tracking / Advertising ID | No | No | — |

**Play Console / Data Safety disclosure wording:**

```text
K Scan AI requests approximate location for weather-aware styling suggestions. A prominent in-app disclosure is shown before the OS permission prompt. Location is optional, used only while the app is in use, and raw coordinates are not stored or shared for advertising.
```

## 3. Microphone / VoiceScan / Wearables

- **VoiceScan status:** Planned but inactive for the current launch. The onboarding permissions screen shows a **Microphone** card labeled **Coming Soon** with the description **"VoiceScan is coming soon."** The toggle is disabled and visually off; tapping it is a no-op.
- **Android permission:** `android.permission.RECORD_AUDIO` is **not requested** in this release. It is removed from `app.json` `android.permissions`, removed from `AndroidManifest.xml`, and added to `android.blockedPermissions`.
- **Expo camera plugin:** `recordAudioAndroid` is `false` and `microphonePermission` is disabled so the plugin does not inject microphone permission declarations.
- **No audio collection, transmission, storage, or processing.** There is no active VoiceScan flow, no wearable audio input, no background listening, no screen-off recording, no biometric voice identification, no targeted advertising use, and no ad measurement use of audio.
- **Runtime path:** There is no user-initiated microphone permission prompt in this release. The `requestMicrophonePermission()` helper is gated behind `VOICESCAN_ENABLED === true` and returns `granted: false` while VoiceScan remains inactive.

## 4. Account Deletion

- Users request deletion from **Privacy > Delete Account**.
- The `handle-user-deletion` Edge Function validates the caller, creates a pending `deletion_requests` row, and marks the profile `pending_deletion`.
- Final erasure is performed manually with `scripts/process-deletion-request.js` using a service-role key.
- Target SLA: within 30 days, subject to legal/security exceptions.
- Confirm-delete E2E passed on this branch; the deletion backend is operationally proven.

**Play risk:** Deletion remains operator-processed rather than instant automatic erasure. Keep reviewer copy clear that requests are handled through the guarded internal erasure workflow, generally within 30 days, subject to legal/security exceptions.

## 5. UGC / Shared Rooms

- Dressing Rooms can be shared via public share links.
- Room members can post messages and reactions.
- Share links enforce `max_redemptions` and expiry.
- In room chat, each message shows a **Report** action. Tapping it opens a confirmation with **Report & Hide**; confirming immediately hides the content on the device and filters content from that reported user locally when the sender is known.
- Hidden content IDs are stored device-locally (`kscan.hidden_content_ids.v1`). Hidden user IDs are also stored device-locally (`kscan.hidden_user_ids.v1`) so blocked-sender filtering survives a cold app restart.
- A server-side `content_reports` moderation migration has been added for internal review and is pending deployment if not yet applied. Full admin dashboard and server-side cross-device blocking remain future enhancements.

Data Safety note: `content_reports` contains user IDs and content references for app safety, abuse prevention, and moderation. It is not shared with third parties.

**Play risk:** User-generated content with sharing is a common Play review friction point. This build provides report + local hide/block plus a prepared server-side report log. Before public launch, deploy the `content_reports` migration, implement an admin moderation dashboard, and add server-side cross-device blocking to fully satisfy Play policy expectations.

## 6. Production/Staging Project Naming

- All `eas.json` profiles (including `production`) point to Supabase project ref `wyyuqfdxucjksghsmhry`.
- The Supabase Dashboard currently displays this project as **"KScan App Production"**.
- The project ref, keys, and data are production-grade.
- The project ref does not change.
- Before public launch, create true staging/production separation.

## 7. Privacy Policy Website Handoff

Live legal/support URLs were reachable on 2026-07-08:

- `https://kscan.app/legal/privacy`
- `https://kscan.app/legal/delete-account`
- `https://kscan.app/support`

Before Play submission, publish website/legal copy that matches this Android branch and the Play Data Safety form:

- Camera scans, user-submitted photos/videos, and optional photo-library inspiration uploads.
- Google Gemini / AI-provider image processing for app functionality.
- VoiceScan is a visible "Coming Soon" placeholder only; no microphone/audio collection, recording, transmission, storage, or processing in this release.
- No background listening, no biometric voice identification, no Advertising ID, no targeted ads.
- Coarse foreground location for weather-aware StyleChat only.
- Auth/account identifiers, email, privacy settings, deletion/export/correction requests, StyleChat, Dressing Rooms, shared rooms, messages, reactions, and other UGC.
- Account deletion request workflow with the 30-day manual processing window and legal/security exceptions.
- AI/product-match limitations: results may be incomplete, similar rather than exact, unavailable, or dependent on third-party retailer sites.

Known live mismatch to fix: the privacy page still references the older iOS submission build and must be refreshed for the Android release scope before Play upload.

## 8. Remaining Play Blockers Checklist

- [x] In-app prominent location disclosure
- [ ] Data Safety form matches the table above, including camera, microphone/audio, coarse location, photos/videos, UGC, app interactions, and identifiers
- [x] Public account deletion URL verified
- [x] Minimum UGC report/local-hide path (no DB schema)
- [x] Supabase production project renamed
- [ ] VoiceScan "Coming Soon" placeholder verified on onboarding permissions screen and home screen
- [ ] Confirm no Android microphone permission prompt appears anywhere in the release build
- [x] `RECORD_AUDIO` removed/blocked from Android manifest and Expo config
- [ ] Live privacy/legal/support pages updated to match the Android Data Safety scope
- [ ] Production AAB built and uploaded
