# K Scan AI — Android Google Play metadata package (Build 35 source)

**Prepared:** 2026-10-12; updated 2026-10-16 for current Android Live VTO and Speech source  
**Source reviewed:** `integration/build35-v1-convergence` @ `1dbddcf2dcc0e7ed2d80ad2f0dcad7c6b74e989a` (merged PR #626)  
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
Ask Elise, K Scan AI's AI fashion assistant, for styling ideas and ways to wear your finds. Use optional fashion preferences and authorized clothing context to make suggestions more relevant. Supported sessions may include optional spoken replies, depending on consent, device settings and service availability.

SAVE, ORGANIZE AND SHARE
Save scans and fashion inspiration, organize your Closet and looks, and use Dressing Rooms to plan or share outfits. Supported Closet content can synchronize through your account when enabled. Recent Scans and some other content may remain local to your device rather than synchronizing.

PLAN AND EXPLORE
Use Packing Intelligence and supported Watchlist tools to organize upcoming looks and follow fashion items. Features and alerts depend on account eligibility, supported services, and notification settings.

TRY A LOOK
Explore AI-assisted photo virtual try-on and styling previews where available. K+ members with a supported Android device can also try the Live Camera VTO pilot with one eligible black tee, using an interactive camera preview. Other garments may use photo try-on where supported. Previews are visualizations, not measurements, fit guarantees or authentic product photography.

VOICE SCAN
On supported Android devices, speak a fashion search using a user-initiated on-device speech recognition flow. Microphone access is requested only when you choose a voice feature; no background listening is intended. Availability depends on your device's on-device speech recognition capabilities.

K+ MEMBERSHIP
Core fashion discovery remains accessible without a K+ subscription. Certain advanced experiences may require optional K+ membership; available plans, localized prices and renewal details are shown by Google Play before purchase.

PRIVACY AND CONTROL
Choose what to scan or upload. Photos and styling requests may be processed by K Scan AI cloud services and authorized AI providers. Optional approximate location can support weather-aware styling. Manage your privacy preferences and request account deletion within the app.

K Scan AI is a fashion discovery and shopping-assistance service, not a retailer or authentication authority. Product identities, AI recommendations, availability, prices and virtual try-on results are not guaranteed.

**Important publishing notes:** The listing is written conservatively because the current source enables the features, but individual cloud services, paid billing, Voice availability and notifications still require runtime/store evidence. Remove or qualify any feature proven unavailable in the final signed release; do not describe a source flag as a verified successful purchase, alert or AI provider transaction.

## B. What's new — en-US (≤500 characters)

Turn fashion inspiration into action with multi-image scans, Closet sync, Packing Intelligence, Watchlist tools and Voice Scan. Explore photo virtual try-on and a limited Live Camera VTO pilot on supported Android devices. Elise gains optional spoken styling replies. K+ membership, device capabilities and service availability govern access.

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
| Audio / Voice Scan | Android `RECORD_AUDIO` capability now ships for user-initiated Voice Scan; on-device recognizer required. Confirm whether raw audio ever leaves the device through the recognizer/service before answering Audio category. Recognized text may be sent for fashion search. Elise spoken responses are ON in the current release source, subject to consent, provider availability and runtime verification. |
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
| Elise spoken replies | ON in production/build35-release source | Optional, consent-gated spoken replies. Provider and actual customer playback still require Android artifact/device verification; do not guarantee availability |
| Today With Elise parent and children | HARD OFF | Do not show as released |
| Complimentary K+ Early Access | OFF | Do not describe as available promotion |
| Native Live Camera VTO | ON in production/build35-release source; Production operator `vto_generation.live.enabled=true` for `top` | K+-gated limited real-product pilot (AS Colour Staple Tee 5001 Black); actual camera/pose/preview on physical Android remains unverified. Development/demo fixture and harness experiences remain OFF |

## F.1 Live Android subscription verification (2026-10-12 UTC)

Read-only RevenueCat validation for `com.kscanai.app` returned **VALID** Google Play service-account credentials, including subscription-purchase, in-app-product and monetization/catalog API checks. This resolves the previous *credential missing* claim.

However, a fresh Play Store state read returned `store_status=not_found`, `base_plans={}`, no territory prices and no localizations for **both** active RevenueCat catalog mappings:

- `kscan.kplus.monthly:monthly`
- `kscan.kplus.annual:annual`

**K+ Android purchase readiness is NOT certified, but it is a POST-AAB / pre-publication gate, not an Android source or EAS build-creation blocker.** `not_found` could mean the composite product/base-plan identifiers are not the actual Play entries or that the intended subscriptions have not been created/published correctly. Owner must inspect Google Play Console **Monetize → Products → Subscriptions**, confirm subscription ID, active base-plan ID, status, pricing/territory and test visibility, then reconcile RevenueCat mappings. Do not invent identifiers or publish a price not returned by Play.

## F.2 Android pre-AAB boundary and live backend reconciliation (2026-10-12)

**Pre-AAB scope:** The Android release candidate must pass exact-head source/CI, native-profile integrity, Google Services credential-presence checks (without exposing secrets), manifest/permission contract, package identity, signing/remote versioning readiness and truthful listing copy. Google Play subscription visibility, Play-managed artifact analysis, purchase sandbox, device QA and Play Console publishing declarations are **post-AAB**. No EAS build is authorized by this document.

**Backend evidence (Production, read-only):**
- `scan-identify` v173 is ACTIVE and has deployed bundle hash `79678f229c9fa8adcebaef238ee28d0b2cc4751bca0dd8c748de9df9d152d5fb`, identical to Staging `scan-identify` v81. This is function-byte parity, not proof of garment accuracy or paid commerce.
- `commerce-watch-refresh` v11 is ACTIVE, `watchlist_worker_enabled=true`, and its deployed hash matches Staging. Separate recurring scheduler approvals and populated-watch delivery are **post-artifact operational QA**, not reasons to withhold Android AAB creation.
- `vto-generate` is ACTIVE and Production `app_config.vto_generation.enabled=true`. The UI flag does not certify provider output, fit accuracy, account entitlements or paid provider calls.
- `kplus-activate` v11 is ACTIVE but its server campaign-guard deployment trails the governed backend authority. Emergency containment is **verified**: `grant_kplus_early_access(uuid)` is not executable by `anon`, `authenticated`, or `service_role`. The follow-up source promotion is a **shared backend change** requiring the separate protected deployment authority. Do not modify this backend from an Android-only PR or claim a new production deployment occurred.
- `kplus-reconcile-revenuecat`, `kplus-revenuecat-webhook` and `kplus-revenuecat-pull-reconcile` are deployed and ACTIVE. Their presence is not a purchase-lifecycle PASS.

**Excluded from Android pre-AAB readiness:** iOS/App Store work; RevenueCat/Play subscription publication and sandbox lifecycle; device and Play-generated APK QA; automated account-deletion worker and orphan ledger reconciliation (Build 36). Preserve working account-deletion entry points and accurate Play policy disclosure. A public rollout still requires the later checks.

## F. Actions that remain outside GitHub metadata

1. In Play Console, update the **actual** Main Store Listing (title, short/full text, assets), release notes, App Content questionnaires, Data Safety and account-deletion URL. This GitHub document does **not** publish them.
2. Verify final AAB source SHA, profile=production, `com.kscanai.app`, versionCode beyond previously consumed Play maximum, signing, SDK 36 and manifest capabilities.
3. **After the signed AAB is uploaded/processed on the approved Play testing track**, reconcile Play subscription IDs/base plans, RevenueCat catalog retrieval/RTDN and sandbox purchase/restore with canonical K+ entitlement lifecycle. The service-account checks are already valid, but the product store lookup is still `not_found`; upload alone does not guarantee it resolves. This is NOT a pre-AAB build blocker.
4. Verify Play App Signing certificate fingerprint vs `assetlinks.json` and test room links/OAuth.
5. Review public privacy policy against current Voice Scan, Closet sync, cloud AI, push, VTO, AI reporting and UGC claims; the site currently says no universal device-side face/plate masking, which must not be contradicted.
6. **After the real AAB exists**, run runtime Android 15/16 and gesture/3-button QA; test Voice recognizer presence, mic denial, Scanner, multi-image, Dressing Room, push, VTO and user switching. This physical/artifact QA is NOT a prerequisite for producing the first AAB.
7. Confirm in-app AI reporting and UGC controls across all relevant enabled output types before public rollout; resolve any Android-specific gaps in the Android lane and refer shared gaps to their owners. Account deletion **request intake and external URL** must remain truthful for Play disclosures; the broader deletion worker/purge lifecycle is deferred to Build 36 and is NOT a Build 35 Android AAB blocker.

## Official policy references

- [Google Play store listing field limits](https://support.google.com/googleplay/android-developer/answer/9859152)
- [Target API requirement](https://support.google.com/googleplay/android-developer/answer/11926878)
- [User data / account deletion](https://support.google.com/googleplay/android-developer/answer/10144311)
- [Data Safety](https://support.google.com/googleplay/android-developer/answer/10787469)
- [UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937)
- [AI-generated content policy](https://support.google.com/googleplay/android-developer/answer/13985936)
- [16 KB compatibility](https://developer.android.com/guide/practices/page-sizes)
