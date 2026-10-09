# Android Post-Build Test Handoff — Build 35

This handoff begins **after** the pre-build source certification passes and an authorized production AAB is created.

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

For ordinary production, confirm the final AAB does **not** regain held capabilities through transitive manifests.

Expected absent unless an owner-approved release change explicitly supersedes this handoff:

- RECORD_AUDIO
- POST_NOTIFICATIONS
- RECEIVE_BOOT_COMPLETED
- ACCESS_FINE_LOCATION
- ACCESS_BACKGROUND_LOCATION
- broad READ_MEDIA permissions
- READ_EXTERNAL_STORAGE
- WRITE_EXTERNAL_STORAGE
- MANAGE_EXTERNAL_STORAGE
- FOREGROUND_SERVICE_MICROPHONE
- CAPTURE_AUDIO_OUTPUT
- unnecessary foreground-service declarations
- Advertising ID
- contacts / SMS / phone / Bluetooth restricted capability

Expected intended permissions include camera, Internet, vibration and approximate foreground location.

Verify the cropper activity remains non-exported and no new externally invokable component appears unexpectedly.

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

Ordinary production currently holds Smart Watchlist/remote push OFF.

For the actual AAB:

- prove POST_NOTIFICATIONS remains absent;
- prove no accidental push capability was materialized;
- confirm no staging Firebase configuration is packaged;
- if product governance intentionally enables push before the build, stop and use the push-capable artifact matrix instead of this default-dark checklist;
- if push is enabled, verify the governed Google Services file matches `com.kscanai.app`, final Firebase resources, FCM token registration, account isolation and real delivery.

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

Held features should remain unavailable: multi-image Scanner, Packing, Watchlist, generative VTO, cloud Closet sync, Stylist Speech, Voice Scan, Today with Elise, K+ Early Access.

## 7. Android lifecycle / UI device targets

Where emulator evidence is insufficient, transfer to optional/physical QA:

- Android 15/16 edge-to-edge
- gesture navigation and 3-button navigation
- Scanner camera denial → Settings → return
- keyboard avoidance in auth, Dressing Room and report/note sheets
- process death during Google OAuth
- activity recreation during picker/camera flows
- rapid repeated taps / double-navigation protection
- large image memory pressure
- tablet/large-screen behavior where supported
- predictive Back behavior under the current opt-out posture

Do not repair a source risk until runtime evidence establishes a defect.

## 8. Google Play Billing sandbox gate

Before billing runtime certification:

**Owner dependency:** configure the RevenueCat Google Play service-account credentials for the K Scan AI Play app.

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
- Data Safety matches final app + SDK behavior;
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
