# K Scan AI — Play Store Readiness Notes

_Last updated: 2026-07-07 (integration/free-tier-beta-into-style-dna)_

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

## 2. Location / Data Safety

### What the app requests

- **Android permission:** `android.permission.ACCESS_COARSE_LOCATION` only.
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
| Approximate location | Yes | No | Weather-aware style advice (coarse, foreground, transient) |
| Photos and videos | Yes (user-submitted scans and inspiration uploads) | Yes — images are sent to Google Gemini for AI analysis | App functionality |
| Email address | Yes | No | Account management |
| User ID | Yes | No | Account management / app functionality |
| Style chats / messages | Yes | No | App functionality (Dressing Rooms, StyleChat) |
| User-generated content (rooms, messages, reactions) | Yes | No | App functionality |
| Diagnostics / crash data | Only if retained in production logs | No | App functionality / security |
| Tracking / Advertising ID | No | No | — |

**Play Console / Data Safety disclosure wording:**

```text
K Scan AI requests approximate location for weather-aware styling suggestions. A prominent in-app disclosure is shown before the OS permission prompt. Location is optional, used only while the app is in use, and raw coordinates are not stored or shared for advertising.
```

## 3. Account Deletion

- Users request deletion from **Privacy > Delete Account**.
- The `handle-user-deletion` Edge Function validates the caller, creates a pending `deletion_requests` row, and marks the profile `pending_deletion`.
- Final erasure is performed manually with `scripts/process-deletion-request.js` using a service-role key.
- Target SLA: within 30 days, subject to legal/security exceptions.
- Dry-run E2E passed on this branch. Confirm-delete still requires owner review and approval.

**Play risk:** If Google Play reviewers test deletion and re-sign-in, they will still see data because erasure is manual/operator-gated. Consider adding automated erasure or a clear web deletion form before public production submission.

## 4. UGC / Shared Rooms

- Dressing Rooms can be shared via public share links.
- Room members can post messages and reactions.
- Share links enforce `max_redemptions` and expiry.
- In room chat, each message shows a **Report** action. Tapping it opens a confirmation with **Report & Hide**; confirming opens a prefilled email to `support@kscan.app` and hides the message locally on the device.
- Hidden content IDs are stored device-locally (`kscan.hidden_content_ids.v1`); no server-side report log, block list, or moderation table exists yet.
- Full server-side moderation and user blocking remain future enhancements.

**Play risk:** User-generated content with sharing is a common Play review friction point. This build provides the minimum no-DB report + local-hide path. Before public launch, implement server-side moderation, reporting storage, and user blocking to fully satisfy Play policy expectations.

## 5. Production/Staging Project Naming

- All `eas.json` profiles (including `production`) point to Supabase project ref `wyyuqfdxucjksghsmhry`.
- The Supabase Dashboard currently displays this project as **"KScan App Staging"**.
- The project ref, keys, and data are production-grade; only the display name is misleading.
- **Owner action:** Rename the project to **"K Scan AI Production"** in Supabase Dashboard (Project Settings → General → Project Name). The ref does not change.
- Before public launch, create true staging/production separation.

## 6. Remaining Play Blockers Checklist

- [x] In-app prominent location disclosure
- [ ] Data Safety form matches the table above
- [ ] Automated account erasure or compliant web deletion flow
- [x] Minimum UGC report/local-hide path (no DB schema)
- [ ] Rename Supabase production project or create true production project
- [ ] Production AAB built and uploaded
