# K Scan AI — Build 35 Android Pre-Build Certification

**Date:** 2026-10-09  
**Scope:** Source/native/configuration certification only. No APK/AAB/EAS build, emulator certification, physical-device testing, Play upload, backend mutation, or production mutation was performed.

## 1. Authority

| Item | Authority |
| --- | --- |
| Mobile candidate | `integration/build35-v1-convergence @ f2f94e8bb9ca758d45f0d7db6e3206c3d0903bf4` |
| Backend authority | `rebuild/backend-authority-v2 @ fe25ee5b1e1e2a48920835d9134a97ace9af6ff6` |
| Historical Android line | `release/kscan-pre-freeze-v1 @ e97de30eab67691b91f9d68ffbb5ef2635aa0741` |
| Historical relationship | Integration is 230 commits ahead, 0 behind the historical Android line |
| Android native authority | `NATIVE_AUTHORITATIVE` |
| Package | `com.kscanai.app` |
| Marketing version seed | `1.0.1` |
| Checked-in versionCode seed | `23` |
| EAS version authority | Remote + autoIncrement |
| Future build profile | `production` |
| Future artifact | Android App Bundle |

The candidate branch remained at the same SHA at the start, during, and immediately before this record was created.

## 2. Binary pre-build certification matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| AND-01 Source authority | **PASS** | Live GitHub authority reads matched the handoff for mobile, backend, and historical Android branches. |
| AND-02 Historical Android hardening reconciled | **PASS** | Candidate descends from historical Android authority; native containment and regression tests remain present and green. |
| AND-03 Gradle / SDK / native source | **PASS** | Source-only Gradle configuration probe resolved compileSdk=36, targetSdk=36, minSdk=24, package/namespace=com.kscanai.app, R8=true. |
| AND-04 Manifest / permissions / capability gating | **PASS** | Android focused suite + native parity; production selects `src/release`, Voice=false, remote push=false, microphone/notification grants suppressed by default. |
| AND-05 Auth / onboarding / deep-link contracts | **PASS** | Full exact-head CI, auth/privacy tests, OAuth origin/callback/session source review, Android intent-filter review. |
| AND-06 Play Billing client / entitlement contracts | **PASS** | Native RevenueCat adapter tests, paywall/lifecycle contracts, live RC app/catalog/key reconciliation. External Play service-account credential remains a runtime/store dependency. |
| AND-07 Scanner / camera / Photo Picker | **PASS** | Android focused suites green, including camera Settings recovery, permission refresh, Photo Picker access, Scanner certification guards. Shared B35-SCAN-014 remains held behind multi-image OFF. |
| AND-08 Navigation / Elise / Closet / Dressing Rooms | **PASS** | Focused Android UI/inset suites, exact-head full suite, shared feature containment suites. |
| AND-09 Firebase / push / Voice release posture | **PASS** | Production source resolves Voice OFF and remote push OFF; default release does not require Google Services. Capability matrix remains intact. |
| AND-10 Privacy / deletion entry / Play source compliance | **PASS** | In-app deletion entry exists; public external deletion resource exists; privacy/auth-privacy/security suites green; current Play policy requirements reviewed. |
| AND-11 Enabled/disabled release contract | **PASS** | Release-profile guard + held-surface reachability: 225/225. Held features remain dark through route/surface containment, not only raw env values. |
| AND-12 Android P0–P3 / shared blocker disposition | **PASS** | No Android-specific P0–P3 found. Shared/backend defects are documented and contained or owner-routed. |
| AND-13 Required tests / exact-head CI | **PASS** | Exact candidate push CI green; focused Android run 412/412; security 71/71; auth-privacy 37/37; privacy 5/5; TypeScript/parity/reachability pass. |
| AND-14 No iOS regression / unauthorized shared repair | **PASS** | No product source was modified by this Android campaign. Shared defects repaired by Android agent = 0. |
| AND-15 Production EAS profile source safety | **PASS** | `production` is store/AAB/remote-versioned; release guard validates production and build35-release identities and feature holds. |
| AND-16 Final authority / ledger / dependencies reconciled | **PASS** | Candidate frozen; required handoff records created; external runtime/store dependencies explicitly separated from source certification. |

## 3. Native source result

A source-only Gradle probe used `:app:help`; it did not assemble, bundle, sign, or emit an Android artifact.

Resolved values:

- compileSdk: **36**
- targetSdk: **36**
- minSdk: **24**
- namespace: **com.kscanai.app**
- applicationId: **com.kscanai.app**
- source versionCode: **23**
- versionName: **1.0.1**
- release minification: **enabled**
- resource shrinking: **disabled**
- production release capability manifest: `src/release/AndroidManifest.xml`
- Voice native capability: **false**
- remote push capability: **false**
- Google Services requirement in ordinary production: **false**

## 4. Test evidence

### Exact candidate CI
At `f2f94e8bb9ca758d45f0d7db6e3206c3d0903bf4`, the governed push workflows completed successfully, including Security Code and Dependencies, Security Promotion Gate, Staging Security Gate, ZAP Baseline/API, Dependency Reachability, VTO Backend E2E, and the Build 35 release-profile guard.

### Explicit Android pre-build suite
A source-only Linux audit run executed the named Android suites required by the handoff.

- Android/native/K+/notification/voice focused tests: **412/412 pass**
- security: **71/71 pass**
- auth-privacy: **37/37 pass**
- privacy: **5/5 pass**
- native config parity: **PASS**
- dependency reachability: **PASS**
- release profile guard: **PASS**
- TypeScript: **PASS**

### Held-feature reachability
A second source-only Linux run executed release/route/surface containment suites.

- **225/225 pass**
- Multi-image Scanner held OFF
- Packing held OFF
- Watchlist and autonomous push held OFF
- Generative VTO held OFF
- cloud Closet sync/restore/migration held OFF
- Stylist Speech held OFF
- Voice Scan held OFF
- Today With Elise parent hard-held OFF
- K+ Early Access held OFF

## 5. Billing and K+ source readiness

Build 35 includes native RevenueCat commerce.

Verified source invariants:

- Android uses the Play-app public SDK key.
- The source key exactly matches the live RevenueCat Play app public key.
- RevenueCat identity is bound to the authenticated K Scan actor.
- Purchase and restore re-check actor identity before/after async store operations.
- Store-native pricing/period/introductory-offer data drives the UI.
- Purchase/restore never directly grants canonical K+.
- Canonical entitlement is re-read from backend authority.
- Monthly and annual purchase paths, cancellation, pending/error states, restore, rapid taps, and actor switches have regression coverage.
- Lifetime purchase remains excluded from launch.

Live RevenueCat configuration confirms:
- Play app package: `com.kscanai.app`
- current offering: `default`
- active Android monthly and annual products
- both attached to entitlement `k_plus`

**External dependency:** RevenueCat reports that Google Play service-account credentials are **not configured** for the Play app. This does not invalidate Android source readiness and does not require a new binary after configuration, but it blocks meaningful Play Billing sandbox/lifecycle certification and must be resolved before paid Android K+ rollout.

## 6. Shared/backend findings carried forward

No shared implementation was changed.

- **B35-SCAN-014 / Issue #536 — P2 shared:** multi-image + deferred commerce can lose expected shopping matches. Contained because multi-image Scanner is held OFF for release.
- **DEL-01 / PR #534 — P1 backend:** post-Auth-delete worker failure can strand a deletion ledger state. Android request UI/external deletion path remain available; broader lifecycle work is owner-deferred to Build 36. Android agent did not modify it.
- **K-06 / PR #535 — P3 backend:** webhook secret hardening exists as source-only backend work; deployed secret strength is not readable from this lane. Android client entitlement authority remains fail-closed to canonical backend state.
- **RevenueCat Play credentials — external configuration dependency:** Google Play service-account credentials are not configured in RevenueCat.

Production Supabase was inspected read-only. The K+ activation/reconciliation/webhook/pull-reconcile functions are present and active. No production mutation was performed.

## 7. Current Google Play policy source posture

Source certification used the current policy baseline:
- Android updates must target API 36 or higher for the current submission window.
- Apps with account creation require both an in-app deletion path and an external deletion-request resource.
- Paid digital subscriptions/features use Google Play Billing unless an allowed exception applies.
- Data Safety must reflect app and third-party SDK data handling.
- 16 KB native-library compatibility is an artifact/native-library validation item and remains post-build.

Live Play Console metadata, Data Safety answers, reviewer credentials, signing/app-link fingerprint, final versionCode, and generated APK/AAB properties are outside this pre-build source certificate.

## 8. Verdict

```
ANDROID_PREBUILD_SUBMISSION_READINESS=PASS
```

This PASS certifies the frozen Android source candidate to enter the production-build and submission-validation pipeline.

It does **not** certify an AAB, emulator/device runtime, Play Billing sandbox purchase, Firebase artifact, Play Console metadata, or production rollout.

Required next stage: create the governed Android production build from the frozen authority, then perform the post-build checks in `ANDROID_POSTBUILD_TEST_HANDOFF.md`.
