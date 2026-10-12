# Android Post-Build Test Handoff — Build 35

**Updated for the Build 35 full-feature Android source matrix on 2026-10-12 at `ca5c13611543ebc8faff873160182974ae0d408b`, after merged PR #564.** Earlier October 9 source certificate assumed Voice, Watchlist, multi-image, VTO UI and Cloud Closet were OFF; those assumptions are now stale.

This handoff begins **after** the current source candidate is frozen and an authorized production AAB is created. This document does not certify that artifact or authorize the build. Current Play listing and App Content draft: [GOOGLE_PLAY_METADATA_BUILD35_20261012.md](GOOGLE_PLAY_METADATA_BUILD35_20261012.md).

It does not authorize the build itself.

```
ANDROID_ARTIFACT_REVIEW=OUT_OF_SCOPE_PRE_BUILD
FIREBASE_ARTIFACT_TEST=POST_BUILD
ANDROID_EMULATOR_SMOKE=POST_BUILD
PHYSICAL_ANDROID_TESTING=DEFERRED
```

## 1. Artifact authority

Record before any runtime test:

- exact release source SHA used by EAS
- EAS build ID
- profile = `production`
- package = `com.kscanai.app`
- marketing version
- final remote versionCode
- artifact SHA-256
- upload signing certificate SHA-256
- creation timestamp
- proof that the artifact source SHA is the certified candidate or an explicitly reviewed descendant

FAIL artifact certification on provenance mismatch.

## 2. AAB structural inspection

Inspect the actual AAB, not source assumptions.

Required:

- package / applicationId
- versionName / versionCode
- compileSdk / targetSdk / minSdk
- debuggable=false
- release signing
- R8/minification state
- ABIs
- compressed/uncompressed native-library packaging
- final resources
- final merged manifest
- final exported component inventory
- final intent filters
- source/profile provenance markers where available

## 3. Final merged permission posture

Build 35 production has **Voice Scan ON** and **Smart Watchlist client/push capability ON**, subject to final Gradle selector resolution. Do not reuse the earlier ordinary-production “microphone/notifications absent” assumption.

Expected **present when the governed capability selection materializes them**:
- `RECORD_AUDIO` for user-initiated native on-device Voice Scan.
- `POST_NOTIFICATIONS` for approved Smart Watchlist remote notifications, requested at runtime on supported Android versions.
- Camera, Internet, vibration and optional approximate foreground location.

Expected **absent**:
- `RECEIVE_BOOT_COMPLETED`;
- `ACCESS_FINE_LOCATION` or `ACCESS_BACKGROUND_LOCATION`;
- broad `READ_MEDIA_*`, legacy `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` or `MANAGE_EXTERNAL_STORAGE`;
- `FOREGROUND_SERVICE_MICROPHONE`, `CAPTURE_AUDIO_OUTPUT` and unused foreground-service capabilities;
- Advertising ID or unrelated SMS/contacts/phone/Bluetooth permissions.

Prove the source `src/voicePush` overlay or actual equivalent used by the resolved `production` profile; do not infer it from a JS flag. Record the complete merged permissions and exported components. Verify the cropper remains non-exported, and PR #564's `android.speech.RecognitionService` visibility query survives manifest merging without broad package visibility.

## 4. 16 KB / ABI verification

The source phase does not certify ELF alignment.

For the final AAB and Play-generated APKs:

1. enumerate every packaged native `.so` by ABI;
2. confirm required 64-bit ABI support, at minimum arm64-v8a;
3. verify 16 KB page-size/ELF LOAD alignment for 64-bit libraries;
4. run Android/Play alignment tooling appropriate to the final package;
5. record every failing library and owning dependency.

Any proven incompatible shipped native library is a release blocker.

## 5. Firebase / notification artifact check

Smart Watchlist is part of the **Build 35 ship-target source**. Separate the client flag, native FCM capability, production worker switch and actual delivery.

For the actual AAB:
- confirm the selected native capability manifest matches the production profile and grants only required push/voice permissions;
- verify the governed `GOOGLE_SERVICES_JSON` EAS production secret was materialized from the correct Firebase app (`com.kscanai.app`) and is not a staging file;
- verify the Google Services plugin, FCM/Expo token registration and account-scoped revocation on logout;
- verify `RECEIVE_BOOT_COMPLETED` remains absent;
- verify notifications work in foreground/background and after app process death, including token registration, refresh and tap routing;
- independently verify Production `commerce-watch-refresh` entitlement guard and `watchlist_worker_enabled` state. Do not automatically enable an autonomous worker or authorize paid calls merely because the client ships Watchlist UI.

If push is not actually functional, report it explicitly as a held/unavailable shipping capability or release blocker. Do not silently claim PASS.

## 6. Emulator smoke

The program has explicitly moved emulator smoke to post-build.

Run against a Play-like/release artifact when installation tooling permits.

Minimum flow:

1. cold launch;
2. welcome/onboarding;
3. email/password sign-in;
4. Google OAuth return;
5. Home;
6. single-image Scanner camera permission and capture;
7. gallery/Photo Picker import;
8. Scan results;
9. save to Closet / Recent Scans;
10. Ask Elise from an enabled core path;
11. Dressing Room add/share navigation;
12. logout;
13. login as another actor;
14. verify no previous actor state leaks;
15. account deletion entry opens and accurately describes request/grace period;
16. app relaunch/session restoration;
17. Android Back from core routes/modal surfaces.

**Build 35 enabled test additions:** multi-image Scanner selection and per-item commerce, Cloud Closet cross-device restore, Packing Intelligence, Smart Watchlist, Voice Scan with on-device recognition, VTO UI, K+ paywall and purchase/restore (when Play credentials are ready), and Concierge. **Held/unavailable:** Today With Elise, complimentary K+ Early Access and Elise spoken replies. Do not equate an enabled JS flag with successful provider delivery.

## 7. Android lifecycle / UI device targets

Where emulator evidence is insufficient, transfer to optional/physical QA:

- Android 15/16 edge-to-edge
- gesture navigation and 3-button navigation
- Scanner camera denial → Settings → return; multi-image item selection and commerce hydration
- keyboard avoidance in auth, Dressing Room and report/note sheets
- process death during Google OAuth
- activity recreation during picker/camera flows
- rapid repeated taps / double-navigation protection
- on-device SpeechRecognizer service discovery (including Android 11+ package visibility from PR #564), microphone denial, interruption, no background audio and no cloud ASR fallback
- Smart Watchlist FCM real token and delivery flow
- Cloud Closet cross-device sync/media restore and account isolation
- VTO enabled UI, protected photo handling and provider success/failure
- large image memory pressure
- tablet/large-screen behavior where supported
- predictive Back behavior under the current opt-out posture

Do not repair a source risk until runtime evidence establishes a defect.

## 8. Google Play Billing sandbox gate

Before billing runtime certification:

**Owner dependency:** independently confirm the current RevenueCat Google Play service-account credentials, Play monthly/annual subscription + base plans, real offering availability and RTDN. The 2026-10-12 owner dependency ledger reports ambiguous live Play product state even where RevenueCat catalog links exist. Do not assert readiness from catalog entries alone.

Then validate on a Play-distributed test build:

- offering loads for Android
- monthly product
- annual product
- store-derived localized prices
- free/intro offer only when the store says eligible
- purchase launch
- cancellation
- pending purchase
- already-owned path
- purchase completion → canonical entitlement refresh
- Restore Purchases
- account A → B isolation
- subscription lapse / expiration
- refund/revocation when testable
- no local provider success directly grants K+
- paywall legal/billing links
- Free path remains available as intended

Record the Play product/base-plan/offer identifiers observed from the store; do not infer them from source strings alone.

## 9. App Links / OAuth

After Play signing is known:

- obtain the Play App Signing certificate fingerprint;
- verify `https://kscan.app/.well-known/assetlinks.json` contains the correct package/signing relationship;
- test `https://kscan.app/rooms/*` from cold and warm launches;
- test Google OAuth callback cold/warm/process-death recovery;
- test custom `kscan://` callback rejection of unsolicited/stale token injection.

## 10. Account deletion

Do not reopen the Build 36 backend deletion overhaul in artifact QA.

Verify the shipped Android UI:

- deletion entry is discoverable;
- confirmation is required;
- accepted request produces truthful deactivation/grace-period language;
- sign-out/session cleanup occurs;
- external web deletion URL is reachable.

Carry DEL-01/backend lifecycle risk to the Build Manager until the backend campaign closes it.

## 11. Play submission validation after artifact pass

Before production rollout, confirm directly in Play Console:

- versionCode is higher than every previously consumed versionCode;
- upload key accepted;
- Play App Signing active/correct;
- Data Safety matches final app + SDK behavior, including Voice Scan microphone, cloud image analysis, AI/VTO and push identifiers;
- target audience/Families declarations;
- content rating;
- AI/UGC declarations where applicable;
- account deletion URL;
- privacy policy URL;
- subscription/payments disclosures;
- reviewer app-access credentials/instructions;
- ads/Advertising ID declaration;
- screenshots/store claims match the actual release;
- staged/internal/closed track chosen intentionally.

## 12. Post-build verdict boundary

The pre-build PASS does not automatically carry across this handoff.

The build/artifact manager must issue a separate artifact/runtime verdict based on the generated binary.

A source change after the certified SHA invalidates automatic artifact parity and requires explicit delta review before upload.
