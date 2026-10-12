# Android Google Play compliance matrix — current Build 35 release scope

**Updated 2026-10-12** from `integration/build35-v1-convergence @ ca5c13611543ebc8faff873160182974ae0d408b` after PR #564. Supersedes the **2026-10-09 dark-feature source profile** recorded in earlier Android certification docs. Those earlier reports remain historical evidence only.

**Play Console submission state: UNKNOWN.** See [GOOGLE_PLAY_METADATA_BUILD35_20261012.md](GOOGLE_PLAY_METADATA_BUILD35_20261012.md) for exact proposed English (US) listing, release notes and declaration checklist. This document does not edit the Play Console, produce an AAB, grant approval or assert runtime PASS.

| Requirement | Current Android source/config | Remaining proof/action |
| --- | --- | --- |
| Package | `com.kscanai.app` in committed Gradle and Expo metadata | Verify final AAB + Play app |
| Marketing version | `1.0.1` seed; source versionCode `23` | EAS remote code must exceed highest consumed Play code |
| Release profile | `production`: store distribution, app-bundle, remote versioning, autoIncrement | Verify build ID, exact SHA, EAS profile |
| Target API | Gradle-resolved target/compile SDK 36, min 24 per prior source probe | Inspect final AAB; current update policy API 36+ |
| Launcher/branding | Native launcher graphics governed separately; native home label `K Scan`, Expo/Play name `K Scan AI` | Owner confirm shorter launcher label intentional; do not silently change binary |
| Multi-image Scanner | Source **ON** in both store profiles; PR #564 does not change Scanner | Physical result/commerce hydration accuracy and cross-actor persistence |
| Cloud Closet | Source sync/restore/migration flags **ON** | Verify cross-device restore, image privacy, account isolation, deletions |
| Packing Intelligence | Source **ON** | Confirm production server enablement and actual journey |
| Smart Watchlist / push | Client Smart Watchlist flag **ON**, native push capability needs live-source/binary verification | Verify `POST_NOTIFICATIONS`, EAS Firebase config, worker kill switch/production function and real delivery; don't infer worker activity from flag |
| Voice Scan / microphone | Native Voice flag **ON**, `EXPO_PUBLIC_VOICESCAN_ENABLED=true`; PR #564 adds `android.speech.RecognitionService` query in module manifest | Verify merged `RECORD_AUDIO` grant, user-initiated permission, on-device recognizer, interruption and denial on Android 11+; no background recording |
| Elise spoken replies | **OFF** at both production profiles; owner disclosure approved but runtime rollout not authorized by flag | Do not claim spoken Elise replies ship; validate any future activation via separate controls |
| VTO UI | Source **ON** | Verify provider/live enablement, entitlement and UI; do not promise precise fit |
| Elise Concierge / motion / V10 | Source flags **ON** | Confirm backed capability and device feature truth |
| Today With Elise | Parent, greeting, weather **HARD OFF** | Do not advertise or show content from dormant route |
| K+ Early Access | Complimentary campaign flag **OFF** | Do not promote free early-access activation |
| K+ paid membership | RevenueCat Android native SDK/adapter exists; current source has optional paid acquisition | Play monthly/annual product/base-plan live readiness and RevenueCat billing service-account validation; sandbox purchase/restore |
| User data / Data Safety | Camera, photos, account data, chat, UGC, item/interactions, approximate location, identifiers, payment/entitlement and AI providers are relevant | Final SDK/data map; decide collected/shared/ephemeral/optional accurately in Play Console. No automatic “No audio collected” because Voice is active |
| Audio Data Safety | Voice Scan uses a mic / on-device recognizer intent; Elise speech feature OFF | Prove recognizer raw-audio transport and data retention before declaring Audio category |
| Location | Optional foreground approximate weather context only in source | Final permission + runtime precision + policy consistency |
| Photos/PII | Image uploads may reach cloud AI providers; published privacy policy expressly says local face/plate masking is **not universally active** | No “zero-knowledge”, “cloud-free”, or universal PII-masking claims until independently implemented/verified |
| Android permissions | Native authoritative manifest and five overlays; capability grants differ by production profile | Strict merged-manifest inspection for `RECORD_AUDIO`, `POST_NOTIFICATIONS`, blocked fine/broad media/background storage/boot/FGS permissions |
| Firebase | Push-capable source uses `GOOGLE_SERVICES_JSON` native materialization | Verify EAS production secret, correct package and packaged Firebase resources. Do not expose credential |
| App Links | `kscan://` and https `kscan.app/rooms` in Android authority | Verify Play App Signing fingerprint vs public `assetlinks.json` + OAuth/room behavior |
| Account deletion | In-app request available; external https://kscan.app/legal/delete-account available | Verify request processing and policy wording. Do not claim immediate irreversible purge; backend lifecycle concerns remain owner-managed |
| Privacy policy | https://kscan.app/legal/privacy public | Legal signoff for current Voice/Cloud/AI/VTO/UGC collection, age and SDK details |
| AI generated content | Elise / photo VTO may generate text/image content | Verify in-app reporting for **every** enabled relevant AI output; required by Play AI policy |
| UGC / moderation | Dressing Rooms share messages/media; report/block contracts exist | Validate acceptance of Terms, report/block content and users, actual moderation, content rating and public-room pathways |
| Ads / Advertising ID | Source historically excludes AD_ID and targeted ads SDK | Confirm final manifest and Console ads declaration |
| Audience / Families | Public policy intends age 18+ | Confirm Play audience and content-rating questionnaire; no Families participation claimed |
| Reviewer app access | Login and K+ gate may restrict screens | Supply durable review/test account or detailed access instructions without credentials in Git |
| Listing assets | App title/short/full/release notes prepared | Upload current Android screenshots/feature graphic; declare AI-generated assets when applicable |
| 16 KB pages / R8 / ABIs | Native source previously verified for 64-bit/16 KB and R8 configuration | Reinspect **new** Build 35 AAB + Play-generated APKs; runtime release smoke |
| Store signing | EAS remote keystore references exist in owner ledger | Validate upload signing, Play App Signing, final AAB identity |
| Play submission | **NOT CERTIFIED** | Complete Data Safety, app content, rating, AI/UGC, privacy, deletion, reviewer access, billing/subscriptions and final AAB checks in Play Console |

## Release management caveats

- **PR #564** closes only the Android RecognitionService package-visibility P2. It does not certify microphone permission, on-device recognition, system-service availability, build/install, a full Voice Scan session or Play rollout.
- **Older October 9 pre-build PASS documents predate the Build 35 full-feature source matrix**. They must not be reused as proof that production holds Multi-image/Voice/VTO/Watchlist/Cloud Closet OFF.
- RevenueCat catalog presence is not evidence Play has published subscription/base plans. Owner dependency ledger reports unresolved store state; separately verify Google Play service-account credential/RTDN status before paid rollout.
- Backend Speech operational enablement, Watchlist worker and provider allocations are independent from client UI flags. No backend deployment or paid provider calls are authorized by metadata updates.
- Target API requirements: https://support.google.com/googleplay/android-developer/answer/11926878
- AI policy: https://support.google.com/googleplay/android-developer/answer/13985936
- UGC policy: https://support.google.com/googleplay/android-developer/answer/9876937
- Data Safety: https://support.google.com/googleplay/android-developer/answer/10787469

## Status

```text
ANDROID_REPO_METADATA=PREPARED_FOR_REVIEW
ANDROID_PLAY_CONSOLE_METADATA=UNVERIFIED_NOT_UPDATED_BY_THIS_PR
ANDROID_BINARY_ARTIFACT=NOT_BUILT_BY_THIS_PR
ANDROID_STORE_SUBMISSION=NOT_AUTHORIZED
```
