# K Scan AI — Android Google Play metadata package (Build 35 source)

**Prepared:** 2026-10-12  
**Source reviewed:** `integration/build35-v1-convergence` @ `ca5c13611543ebc8faff873160182974ae0d408b` (merged PR #564)  
**Scope:** Android-only store-facing copy, declarations and submission checklist. Internal build number **must not appear in customer-facing copy**.  
**Status:** READY FOR PLAY CONSOLE ENTRY / **NOT** proof that Play Console was updated; no store, build or backend mutation authorized by this document. Reconcile any later source/profile change before copying.

## A. Main store listing — English (United States)

**App name (≤30 characters):** K Scan AI

**Short description (≤80 characters):**

Turn fashion inspiration into AI style ideas, shopping finds and saved looks.

**Full description (≤4,000 characters):**

See a look you love? K Scan AI helps you identify fashion details, explore shopping options and make inspiration part of your wardrobe.

SCAN AND DISCOVER
Photograph clothing or select images from your gallery. Explore fashion-specific details such as garment category, color, print, texture, silhouette and styling context. Where available, select and review more than one garment or photo and compare retailer-neutral shopping options. Results may be similar styles rather than exact products; prices, stock and links depend on third-party retailers.

STYLE WITH ELISE
Ask Elise, K Scan AI's AI fashion assistant, for styling ideas and ways to wear your finds. Use optional fashion preferences and authorized clothing context to make suggestions more relevant.

SAVE, ORGANIZE AND SHARE
Save scans and fashion inspiration, organize your Closet and looks, and use Dressing Rooms to plan or share outfits. Supported Closet content can synchronize through your account when enabled. Recent Scans and some other content may remain local to your device rather than synchronizing.

PLAN AND EXPLORE
Use Packing Intelligence and supported Watchlist tools to organize upcoming looks and follow fashion items. Features and alerts depend on account eligibility, supported services, and notification settings.

TRY A LOOK
Where available, explore AI-assisted photo virtual try-on and styling previews. These are visualizations, not measurements, fit guarantees or authentic product photography.

VOICE SCAN
On supported Android devices, speak a fashion search using a user-initiated on-device speech recognition flow. Microphone access is requested only when you choose a voice feature; no background listening is intended. Availability depends on your device's on-device speech recognition capabilities.

K+ MEMBERSHIP
Core fashion discovery remains accessible without a K+ subscription. Certain advanced experiences may require optional K+ membership; available plans, localized prices and renewal details are shown by Google Play before purchase.

PRIVACY AND CONTROL
Choose what to scan or upload. Photos and styling requests may be processed by K Scan AI cloud services and authorized AI providers. Optional approximate location can support weather-aware styling. Manage your privacy preferences and request account deletion within the app.

K Scan AI is a fashion discovery and shopping-assistance service, not a retailer or authentication authority. Product identities, AI recommendations, availability, prices and virtual try-on results are not guaranteed.

**Important publishing notes:** The listing is written conservatively because the current source enables the features, but individual cloud services, paid billing, Voice availability and notifications still require runtime/store evidence. Remove or qualify any feature proven unavailable in the final signed release; do not describe a source flag as a verified successful purchase, alert or AI provider transaction.

## B. What's new — en-US (≤500 characters)

Discover more ways to turn fashion inspiration into action. Explore multi-image fashion scans, Closet sync, Packing Intelligence, Watchlist tools, Voice Scan on supported Android devices, and photo-based virtual try-on where available. Enjoy enhanced Elise styling and Dressing Room experiences, plus optional K+ membership. Availability depends on device, account eligibility and supported services.

This is an **update**, not an initial release. Do not expose the internal build number in Play release notes.

## C. Play Console identity / assets

| Item | Desired entry / constraint | Evidence state |
| --- | --- | --- |
| Package | `com.kscanai.app` | Source verified; cannot change |
| Name | `K Scan AI` | Draft store listing; native launcher label is currently `K Scan`, confirm that shortened device label is intended |
| Category | **Shopping** as proposed primary category; owner verifies Console availability and final choice | PROPOSED, not console-verified |
| Short/full description | Paste Section A | PREPARED only |
| Release notes | Paste Section B | PREPARED only |
| Privacy policy | https://kscan.app/legal/privacy | Public page observed; exact release-scope disclosure still requires legal review |
| Account deletion URL | https://kscan.app/legal/delete-account | Public page observed; verify submission field and operational request processing |
| Support | https://kscan.app/support | Public endpoint; support/contact response needs owner verification |
| Screenshots | Capture from the actual approved **Android** version; only show enabled, tested features | NOT VERIFIED |
| Icon / feature graphic | Use owner-approved K Scan AI brand assets and Play sizes | Play Console status UNKNOWN |
| Store AI-asset labels | Individually declare AI-generated listing graphics/screenshots when applicable | Owner action |
| App access | Provide durable reviewer login/test instructions for gated flows, no personal credentials | Owner action |
| App release status | Internal/closed testing before public production release | Owner decision |
| Version | Source marketing 1.0.1, checked-in versionCode 23 (seed only); EAS remotely increments | Final AAB/Play maximum UNKNOWN |
| Audience | Live privacy policy states intended 18+ / not Families | Owner must confirm Console target-audience answers and content rating |

## D. Android source-facing declarations for Data Safety / App Content review

**Never copy this matrix as an unverified yes/no questionnaire.** Play defines “collected” and “shared” in terms of actual off-device handling and recognized service-provider exceptions. The owner must inventory final SDK/network/storage behavior and answer every declaration accordingly. Separate **permission present**, **feature used**, **data leaves device**, **third-party processing**, and **data stored**.

| Data category | Expected Build 35 capability and review action |
| --- | --- |
| Name, email, user ID, auth/session identifiers | Account/login, personalization, membership and deletion. Declare applicable personal-info/account categories. |
| Photos/images | Camera/gallery scans, Closet, Dressing Rooms, attachments and VTO. Cloud AI/provider processing possible. Mirror Selfie is explicitly unavailable on Android despite its shared source flag. Do not claim cloud-free or universal face masking. |
| User-generated content | Dressing Room messages, reactions, shared images/looks and relevant saved content. Confirm reporting, blocking, moderation and user policy terms. |
| AI prompts / style messages | Elise text and authorized fashion context processed server-side; AI-output in-app reporting must be reachable. |
| Approximate location | Optional foreground coarse/rounded weather context. Do not declare precise/background collection without evidence. |
| Audio / Voice Scan | Android `RECORD_AUDIO` capability now ships for user-initiated Voice Scan; on-device recognizer required. Confirm whether raw audio ever leaves the device through the recognizer/service before answering Audio category. Recognized text may be sent for fashion search. Elise spoken responses (ElevenLabs) remain OFF in release config at this snapshot. |
| Watchlist device identifiers / notifications | Smart Watchlist/push source capability ON. Confirm FCM/Expo push token handling and actual notification opt-in, account isolation and server enablement. `POST_NOTIFICATIONS` permission posture must be checked in final merged AAB. |
| App interactions/diagnostics | Inventory PostHog activation, crash SDKs, ML Kit, Firebase, RevenueCat and Supabase telemetry; no assumptions from package presence alone. |
| Purchases/entitlements | Google Play/RevenueCat K+ monthly and annual catalog source exists; payment-related data handling must be matched to actual service and live transaction flow. |
| Encryption / deletion | Validate network TLS, user deletion process/grace period, retention/erasure, backups and relevant declarations; do not claim instant irreversible erase. |
| Advertising ID | Current source posture excludes AD_ID; verify merged manifest and SDK use before “No” confirmation. |
| AI / UGC policy | Play requires in-app reporting of offensive generated output and appropriate UGC report/block mechanisms. Verify every enabled production surface, not only Elise chat. |

**Strict truth constraints:** Do not claim device-only scanning, guaranteed exact matches, guaranteed retailer inventory, universal PII masking, background Voice recording, always-on price alerts, no cloud processing, or that an unavailable billing product can be purchased.

## E. Build 35 release-scope authority

From `eas.json` and `scripts/check-build35-release-profile.js` at the source SHA above, **both `production` and `build35-release`** intend the following:

| Release surface | Source status | Notes |
| --- | --- | --- |
| Core single-item + multi-image Scanner | ON | Product result accuracy and multi-item shopping hydration require runtime evidence |
| Text Scan and Elise text/visual | ON | AI output/moderation and backend readiness still checked |
| Signature Style, Closet cloud sync/restore, Dressing Rooms | ON | Account lifecycle and cross-device media require signed-device testing |
| Packing Intelligence, Smart Watchlist | ON | Watchlist worker/provider push enablement separate from app flag |
| Voice Scan native | ON | PR #564 includes recognition-service package visibility; requires `RECORD_AUDIO` in authorized native capability |
| VTO user interface | ON | Actual generation depends on governed backend/provider; don't promise perfect fit |
| Elise Concierge/Elise V10/Avatar Motion flags | ON | Separate visibility and service proof |
| K+ paid membership | Native commerce present | Store availability, Play products/base plans and sandbox purchase remain uncertified (see owner dependencies) |
| Mirror Selfie | OFF on Android | Native extraction is Apple-only; `mirrorSelfieAndroidGating.test.js` asserts Android unavailability despite the shared flag |
| Elise spoken replies | OFF | Do not promise audible Elise replies in this release; source disclosure approval is not active rollout |
| Today With Elise parent and children | HARD OFF | Do not show as released |
| Complimentary K+ Early Access | OFF | Do not describe as available promotion |
| Live VTO / demo or debug harness flags | OFF/unset | Do not advertise live AR or development features |

## F. Actions that remain outside GitHub metadata

1. In Play Console, update the **actual** Main Store Listing (title, short/full text, assets), release notes, App Content questionnaires, Data Safety and account-deletion URL. This GitHub document does **not** publish them.
2. Verify final AAB source SHA, profile=production, `com.kscanai.app`, versionCode beyond previously consumed Play maximum, signing, SDK 36 and manifest capabilities.
3. Verify Play subscriptions/base plans, RevenueCat Play service account/RTDN, sandbox purchase/restore, canonical K+ entitlement lifecycle. Do not assume the active RevenueCat catalog proves store purchase readiness.
4. Verify Play App Signing certificate fingerprint vs `assetlinks.json` and test room links/OAuth.
5. Review public privacy policy against current Voice Scan, Closet sync, cloud AI, push, VTO, AI reporting and UGC claims; the site currently says no universal device-side face/plate masking, which must not be contradicted.
6. Run runtime Android 15/16 and 3-button/gesture QA; test Voice recognizer presence, mic denial, Scanner, multi-image, Dressing Room, push, VTO, user switching and deletion.
7. Confirm in-app AI reporting and UGC controls across all relevant enabled output types before public rollout; resolve any gaps in the proper owner lane.

## Official policy references

- [Google Play store listing field limits](https://support.google.com/googleplay/android-developer/answer/9859152)
- [Target API requirement](https://support.google.com/googleplay/android-developer/answer/11926878)
- [User data / account deletion](https://support.google.com/googleplay/android-developer/answer/10144311)
- [Data Safety](https://support.google.com/googleplay/android-developer/answer/10787469)
- [UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937)
- [AI-generated content policy](https://support.google.com/googleplay/android-developer/answer/13985936)
- [16 KB compatibility](https://developer.android.com/guide/practices/page-sizes)
