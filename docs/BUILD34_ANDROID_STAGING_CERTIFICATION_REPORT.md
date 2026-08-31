# K SCAN AI — BUILD 34 ANDROID
# GOOGLE PLAY STAGING CERTIFICATION REPORT

Audit date: 2026-08-31
Audit branch: `claude/build34-android-staging-audit-jz3h7v`
Artifact class: STAGING_CERTIFICATION_ARTIFACT = TRUE / PRODUCTION_SUBMISSION_ARTIFACT = FALSE

> **Scope honesty.** This audit ran in a remote container with **no EAS
> credentials, no Android SDK/bundletool, no Play Console access, no
> Firebase, no physical devices, and egress blocked to `kscan.app`**. Every
> gate that requires the exact AAB, Play processing, or a device is recorded
> below as **NOT EXECUTABLE THIS ENVIRONMENT** with the strongest available
> source-level evidence noted instead. Nothing in those sections is
> certified by inference.

---

## A. SOURCE

| Field | Value |
|---|---|
| ANDROID SOURCE BRANCH | `integration/backend-kplus-complimentary-staging-v1` (proven cumulative Build 34 Android authority — not assumed: the Android Google Play compliance repair #253 and every later certification repair merged into it; no Build 34 branch is newer) |
| FROZEN SOURCE SHA | `02b59c3aed5f93bf85a9ecb73b13c897d9f25560` (merge of PR #262, 2026-08-31 17:24 -0400) |
| REMOTE SHA | matches `origin/integration/backend-kplus-complimentary-staging-v1` at audit time |
| WORKTREE CLEAN | YES at freeze (audit/repair commits are stacked on top on the audit branch) |
| AHEAD_BEHIND vs remote authority | 0 / 0 at freeze |

**REQUIRED PR ANCESTRY** (verified against live GitHub + `git log` merge ancestry of `02b59c3a`):

| PR | Status in candidate | Merge commit |
|---|---|---|
| #253 Android Google Play compliance repair | ANCESTOR ✅ | `74750668` |
| #259 concierge absence adverb (CON-ABSENCE-006) | ANCESTOR ✅ | `bcd7b994` |
| #260 K+ revoked-mirror (SEC-KPLUS-008) | ANCESTOR ✅ | `fcb9799c` |
| #261 K+ client revocation truth (CERT-CLIENT-001/002) | ANCESTOR ✅ | `8361793d` |
| #262 K+ guard test polarity (CERT-MUT-M1b/M5) | ANCESTOR ✅ (tip) | `02b59c3a` |
| #236 CI+security convergence | ANCESTOR ✅ | `cb8d9f23` |
| #242 Closet ownership (INT-KPLUS-001) | ANCESTOR ✅ | `668f4a43` |
| #243 actor-scope authority (INT-KPLUS-002/003/009) | ANCESTOR ✅ | `6a8a7331` |
| #244 self-expiring entitlement | ANCESTOR ✅ | `91c8aaa4` |
| #245 Watchlist device ownership | ANCESTOR ✅ | `d63b6a78` |
| #249, #250 CI closure | ANCESTORS ✅ | `981c1206`, `46e060b1` |
| #251 K+ convergence, #252 packing actor epoch | ANCESTORS ✅ | `6bdcf09e`, `c1240619` |
| #254–#258 (VTO quota/reach, concierge prose/census, K+ shell) | ANCESTORS ✅ | `e5ab6ce5`…`bc4ecd60` |

ANDROID COMPLIANCE REPAIR (#253): **SURVIVES IN CANDIDATE** — proven directly
against the frozen tree, not the PR description:
- `MainActivity` has **no** `android:screenOrientation` and keeps
  `configChanges="keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode"`.
- `app.json` `orientation: "default"` (no portrait lock).
- No `statusBarColor` item anywhere in `android/app/src/main/res/`.
- Single `edgeToEdgeEnabled=true` in `gradle.properties` (deprecated
  `expo.edgeToEdgeEnabled` duplicate is gone).
- `GmsBarcodeScanningDelegateActivity` removed via `tools:node="remove"`.
- `__tests__/androidGooglePlayComplianceV1.test.js`: **11/11 pass** on the
  frozen candidate (negative controls included in the suite).

Source authority note per §3: `integration/backend-kplus-complimentary-staging-v1`
was **not** chosen because it is a backend branch — it was chosen because
merge ancestry proves it is where every accepted Build 34 Android repair
(including the Android-only #253) cumulatively landed. The authority did not
move during the audit (tip re-verified before push).

## B. ARTIFACT

| Field | Value |
|---|---|
| EAS BUILD ID | **NOT PRODUCED** — no EAS credentials in this environment |
| PROFILE | Intended: release-shaped AAB against staging. **P1 finding repaired**: no governed profile could produce it (see Q/R); new `staging-certification` profile added (store / app-bundle / staging env via `extends: staging`) |
| ENVIRONMENT | staging (`yzqjvdfgefveprobvvyw`) via the new profile; **`--profile production` must NOT be used for tonight's artifact — it bakes the production Supabase project** |
| AAB | NOT BUILT THIS ENVIRONMENT |
| AAB SHA-256 | N/A — must be captured at owner build time; every subsequent test must cite it |
| BUILD DATE | N/A |

## C. VERSION

| Field | Value |
|---|---|
| PACKAGE | `com.kscanai.app` (app.json = build.gradle applicationId; parity gate PASS) |
| VERSION NAME | `1.0.1` (android/app/build.gradle) |
| VERSION CODE | Checked-in `23` is **not authoritative** — `appVersionSource: remote` + `autoIncrement: true`; final value derivable only from the EAS build / AAB / Play processing. NOT DERIVABLE THIS ENVIRONMENT |
| CURRENT PLAY PRODUCTION CODE | Not readable here (no Play Console access). Play Console reported recommendations against "release 31 (1.0.1)" per PR #253 |
| NEXT PRODUCTION BUILD MUST EXCEED | The versionCode consumed by this staging-certification upload. **The staging AAB's versionCode is burned once uploaded; the production-backend rebuild must use a strictly higher one. Never reuse it.** |
| MIN SDK | 24 |
| TARGET SDK | **36** |
| COMPILE SDK | **36** |

**API 36 hard gate**: PASS at toolchain level — `targetSdk = 36` proven from
the governed resolution chain (`android/app/build.gradle` →
`rootProject.ext` → `expo-root-project` plugin → RN 0.81.5
`gradle/libs.versions.toml`: `targetSdk = "36"`), with **no** overriding
`android.targetSdkVersion` gradle property in the tree. Final confirmation
must still be read from the AAB manifest (not executable here).

## D. TOOLCHAIN (re-resolved from the frozen tree, not history)

| Component | Version |
|---|---|
| Node (audit env) | v22.x (container) |
| Expo SDK | 54.0.37 |
| React Native | 0.81.5 |
| React | 19.1.0 |
| Gradle | 8.14.3 (wrapper) |
| AGP | 8.11.0 (RN catalog) |
| Kotlin | 2.1.20 |
| Build Tools | 36.0.0 |
| NDK | 27.1.12297006 |
| Hermes | ENABLED |
| New Architecture | ENABLED |

## E. SIGNING

NOT EXECUTABLE THIS ENVIRONMENT — no EAS credentials, no Play Console.
Upload cert / Play App Signing cert SHA-1/SHA-256, lineage, and App
Integrity must be recorded at owner build/upload time. No signing authority
was rotated by this audit. No credential material appears in the tree
(secret scan: clean).

## F. BUNDLE

| Field | Value |
|---|---|
| VALID / 64-BIT / 16 KB / ABIS / SIZE | NOT EXECUTABLE — requires the AAB + bundletool. Source evidence: `reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64` (64-bit ABIs included); RN 0.81/AGP 8.11 toolchain builds 16 KB-aligned `.so` by default, but **every packaged third-party `.so` must be verified on the real AAB — this gate is NOT certified** |
| DEBUGGABLE | Source: `debuggableVariants = []`; no `android:debuggable` in manifest. AAB check pending |
| TEST_ONLY | No `android:testOnly` in source. AAB check pending |
| DEV CLIENT | Not in dependencies; `developmentClient` only in the internal `development` profile |
| EXPO UPDATES | **DISABLED** — `expo.modules.updates.ENABLED=false` in the committed manifest. **No OTA deployment/rollback path exists; do not plan one** |
| Metro/localhost | No runtime endpoint references; only dev-doc comments and a `commerceDestination` guard that *rejects* localhost URLs |

## G. ENVIRONMENT

| Field | Value |
|---|---|
| EXPECTED BACKEND | staging `yzqjvdfgefveprobvvyw` |
| ACTUAL BACKEND (governed config) | `staging` profile and new `staging-certification` profile: `https://yzqjvdfgefveprobvvyw.supabase.co` ✅. `production` profile: `https://wyyuqfdxucjksghsmhry.supabase.co` (production — must not be used tonight) |
| STAGING REF PRESENT | YES — EXPECTED, not a defect (per §6) |
| PRODUCTION BACKEND REF PRESENT | Only in the untouched `production`/`preview`/`development` profiles, not in the certification path |
| SECRETS FOUND | **NONE.** No service-role key, RevenueCat secret, worker/admin/API secret, or test passwords. Supabase anon keys in eas.json decode to `role: "anon"` (asserted by governed test). Public mobile config only |
| PRODUCTION ROLLOUT BLOCK | **ABSOLUTE.** This artifact class may reach only owner-authorized internal/closed test tracks. `submit` config contains no Android auto-submit lane |

## H. MANIFEST (committed source manifest; **merged AAB manifest is the authority and was not derivable here**)

- **uses-permission**: CAMERA, INTERNET, VIBRATE, ACCESS_COARSE_LOCATION.
  Explicitly removed via `tools:node="remove"`: RECORD_AUDIO,
  ACCESS_FINE_LOCATION, READ/WRITE_EXTERNAL_STORAGE. POST_NOTIFICATIONS is
  expected to merge in from expo-notifications (applicable, §15).
- **activities**: `.MainActivity` (MAIN/LAUNCHER + `kscan://` +
  `https://kscan.app/rooms` autoVerify); GmsBarcode delegate removed.
- **services/receivers/providers/FGS**: none first-party declared;
  merge-level enumeration pending AAB dump.
- **queries**: VIEW/BROWSABLE https (outbound retailer links).
- **application**: `allowBackup=false`, `dataExtractionRules` exclude root
  for cloud-backup AND device-transfer, `enableOnBackInvokedCallback=false`
  (predictive back compat state recorded — do not change absent a defect).
- **UNEXPECTED**: none in committed source; final judgment requires the
  merged AAB manifest.

## I. ANDROID 15/16 (edge-to-edge, large screen)

NOT EXECUTABLE — device/emulator testing unavailable. Source evidence only:
edge-to-edge enabled, no portrait lock, `softwareKeyboardLayoutMode:
resize`, `adjustResize`, safe-area architecture via
react-native-safe-area-context, compliance suite green. **Not certified
from static source (per §12/§13). Required on the Play-generated build:**
gesture/3-button nav, cutout, keyboard open/closed, camera full-screen,
sheets/dialogs, phone/tablet/foldable, split-screen/multi-window, rotation.

## J. AUTH / ACTOR

NOT EXECUTABLE at runtime here. Source/test evidence: actor-scope authority
(#243, #252), device/push ownership (#245), K+ revocation truth (#260,
#261), guard polarity (#262) all in ancestry; full governed suite green
(13 known baseline failures, 0 unexpected). Play-signed Google OAuth,
A→B→A, process death, deactivated/deleted account must run on the
Play-distributed build (certificate fingerprints affect OAuth).

## K. LINKS

- `kscan://` scheme + `https://kscan.app/rooms` autoVerify present in both
  app.json and native manifest (parity gate covers this pair).
- `assetlinks.json` LIVE CHECK NOT EXECUTABLE (egress to kscan.app blocked).
  Must be verified against the **Play App Signing** SHA-256, not the EAS
  upload cert, once Play processes the AAB.

## L. PERMISSIONS

| Surface | Posture |
|---|---|
| CAMERA | Declared; JIT |
| PHOTO PICKER | System picker via expo-image-picker; **no READ_MEDIA_IMAGES/VIDEO declared or expected**; broad media permissions removed. Merged-manifest confirmation pending |
| COARSE LOCATION | Declared (weather styling); FINE + BACKGROUND removed. Scanner does not require location (degrades) |
| MIC | **ABSENT and must remain absent**: `VOICESCAN_ENABLED = false` hardcoded; RECORD_AUDIO `tools:node="remove"`; flag and native posture agree (§18). JIT request code exists but is unreachable while flag is false |
| NOTIFICATIONS | expo-notifications plugin; POST_NOTIFICATIONS runtime-requested where applicable |
| Background execution | No FGS/WAKE_LOCK/exact-alarm/boot declarations in first-party source; merged-manifest check pending |

## M. POLICY

| Item | State |
|---|---|
| PRIVACY / DATA SAFETY | Console-side review NOT EXECUTABLE. Client-side: staging ref expected; approximate-location-only behavior matches expected disclosure. **Owner must reconcile Data Safety against eventual production flag state, not tonight's staging state** (§33/§34) |
| DELETE IN APP | PRESENT — privacy surface: immediate deactivation + 30-day restore window + permanent deletion with legal-retention disclosure |
| DELETE WEB | Console URL check NOT EXECUTABLE |
| AI REPORTING | **WAS A P1 BLOCKER — REPAIRED.** Candidate had regressed to mailto-only AI-output reporting (exits the app). In-app, server-persisted report path restored (see R). Dressing-room UGC reporting was already in-app + server-persisted with local hide |
| UGC | Dressing Rooms: report content, report user, local hide + sender filter, server `content_reports` with auth.uid() binding and duplicate idempotency. Membership/owner controls exist. Console UGC declaration review pending |
| TARGET AUDIENCE / CONTENT RATING / ADS / APP ACCESS | Console checks NOT EXECUTABLE. No advertising SDK in dependencies (retailer/affiliate links are not an ads SDK). Review-account validity must be confirmed by owner |

## N. BUILD 34 FEATURE MATRIX (client build-time flags; server remains authority)

| Feature | Source | Staging-certification effective (governed eas.json) | Eventual production plan |
|---|---|---|---|
| Scanner | ✅ | ON | ON |
| Text Scan | ✅ | ON (backend-enabled, demo off) | ON |
| Commerce | ✅ | ON | ON |
| Elise | ✅ | ON (incl. visual attachments, identification V2) | ON |
| Closet | ✅ | ON (separation, direct intake, staging, batch review) | ON |
| Dressing Rooms | ✅ | ON (collab, messages, reactions, private rooms, saved looks) | ON |
| K+ Early Access | ✅ | **OFF** — `EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED` not set in any profile; defaults off | Owner decision; complimentary contract (no charge wording verified in `KPlusEarlyAccessSheet`) |
| Voice | ✅ (module) | **OFF** — `VOICESCAN_ENABLED=false` hardcoded; no mic permission | OFF until deliberately integrated |
| VTO | ✅ | **OFF** (`EXPO_PUBLIC_VTO_UI_ENABLED` unset) + server kill switch | Owner decision |
| Watchlist | ✅ | **OFF** (`EXPO_PUBLIC_SMART_WATCHLIST_V1` unset) | Owner decision |
| Packing | ✅ | **OFF** (`EXPO_PUBLIC_PACKING_INTELLIGENCE_V1` unset) | Owner decision |
| Wardrobe Concierge | ✅ | **OFF** (`EXPO_PUBLIC_ELISE_CONCIERGE_V1` unset) | Owner decision |

⚠️ **Owner decision required before building (P2-EAS-FLAGS)**: the governed
staging(-certification) env does **not** enable the Build 34 K+ client
flags. As configured, tonight's AAB will not render K+, VTO, Watchlist,
Packing, or Concierge surfaces, so device certification of those features
cannot happen from this artifact. If they are in scope, the owner must add
those `EXPO_PUBLIC_*` values to the staging profile (a deliberate flag
change this audit does not make on its own, per §43). Do not copy staging
values to production.

Billing: **no Play Billing, RevenueCat purchasing SDK, or Stripe in
dependencies** — no unexpected digital monetization surface.

## O. STABILITY

PRE-LAUNCH / FIREBASE / CRASH / ANR / VITALS / UPGRADE: NOT EXECUTABLE —
all require the Play-processed artifact and devices. The upgrade test
(§54: install published build → create state → update to this AAB via the
test track) is called out to the owner as the highest-value remaining
physical test. OFFLINE matrix likewise pending device testing.

## P. SECURITY

| Item | State |
|---|---|
| STAGING AUTHORITY | Anon-key-only client; entitlement authority server-side (`has_active_k_plus()` enforced per request per flag docs) |
| SECRET SCAN | CLEAN (see G) |
| ACTOR ISOLATION | Repairs #242/#243/#245/#252 in ancestry; governed tests green. Runtime A→B→A pending device |
| K+ PROCESS DEATH | Client revocation-truth + guard-polarity tests (#261/#262) green; runtime matrix pending device |
| TOKEN OWNERSHIP | #245 in ancestry; runtime pending device |
| BACKUP | allowBackup=false + full extraction exclusion — no cloud-restore leak surface |

## Q. FINDINGS

**P1-GENAI-001 (REPAIRED)** — Covered generative-AI surfaces (Elise
StyleChat, Scan Results analysis) had **mailto-only** reporting in the
frozen candidate: `services/reportAiOutput.ts` opened the external mail
client, failing Play's requirement to report/flag offensive AI output
without leaving the app. The accepted in-app repair
(`hotfix/android-build28-gp006-ai-reporting`, commit `03ee0003`) was proven
absent from this line's ancestry while staging/production DBs already carry
its schema (`20260815233457_content_reports_ai_output.sql`). **Fixed** —
see R. Evidence: git follow history; migration provenance comments; ported
tests.

**P1-EAS-001 (REPAIRED)** — The certification artifact ("production-shaped
AAB connected to staging") was **not producible from governed config**:
`production` profile bakes the production Supabase project;
`staging` profile builds an internal APK. Building `--profile production`
tonight would have produced a production-backend AAB in violation of the
cycle's premise. **Fixed** with the `staging-certification` profile — see R.

**P2-EAS-FLAGS (RECORDED, owner decision)** — K+/VTO/Watchlist/Packing/
Concierge client flags are unset in the staging env, so the certification
AAB will not carry those surfaces (see N). Deliberate flag enablement is
the owner's call, not this audit's.

**P3-ENV-GATES (RECORDED)** — All artifact-, Play-, and device-level gates
(sections B, E, F, I–L runtime, M console, O) are unexecuted in this
environment. The certification cannot be closed until an owner-authorized
build/upload/device pass runs them against the exact AAB hash.

**P4–P10 (LEDGER, no repair):**
- P4: `enableOnBackInvokedCallback=false` opts out of predictive back;
  Android 16 predictive-back behavior should be observed on device before
  any change (do not rewrite absent a defect).
- P4: `services/api.js` legacy path fails lazily when
  `EXPO_PUBLIC_API_URL` is unset; confirm no release surface reaches it.
- P5: `content_reports` CHECK admits `target_type='ai_output'` with NULL
  context at the DB level (client refuses pre-send); deliberately
  reproduced from production per migration notes — belongs to its own
  governed DB change.
- P5: `preview`/`development` profiles point at production Supabase with
  broad flag sets; consider whether internal preview builds should target
  staging instead (governance question, not a Play blocker).

## R. REPAIRS (both on the audit branch, owner merge required — no self-merge)

1. **`c9cfd46c` — fix(android): restore in-app AI-output reporting (GP-006)**
   - Port of accepted `03ee0003` onto the frozen candidate: in-app report
     sheet (`contexts/AiOutputReportingContext.tsx`), server-persisted
     `ai_output` reports (identifiers only — never model text or media),
     double-tap gate, StyleChatBubble + AnalysisCard wired, provider in
     `app/_layout.tsx`. No DB migration ported (schema already reconciled
     on staging and production).
   - Tests: ported `aiOutputReporting.test.js` + reachability +
     contentReports updates — 24/24; `tsc --noEmit` clean; full governed
     suite: 13 failures, all in the known baseline of 21, **0 unexpected**.
2. **`99fb88b6` — build(eas): staging-certification profile**
   - `extends: staging` (env inherited verbatim — cannot drift onto another
     backend), `distribution: store`, `android.buildType: app-bundle`,
     `autoIncrement: true`. Production profile untouched.
   - Proving tests added to `easConfigIntegrity.test.js` (11/11);
     **negative control executed**: with `buildType` flipped to `apk` the
     new test fails.
   - Regression: full governed suite re-run over both commits (result
     recorded in PR).

No test was weakened. No feature added. No flag flipped. No backend or
production Supabase change. Scanner semantics untouched.

---

## VERDICT

**BUILD 34 ANDROID STAGING CERTIFICATION — CONDITIONAL**
**FIX REQUIRED BEFORE PRODUCTION-CONFIG REBUILD**

The frozen source authority is sound: required PR ancestry proven, Android
compliance repair intact with green negative-controlled tests, API 36 and
toolchain gates pass at source level, permission/backup/secret posture
clean, and the two P1 Play blockers found (GenAI in-app reporting
regression; no governed staging-AAB profile) are repaired on this branch
awaiting owner merge.

The certification **cannot be a PASS** because the artifact-level chain has
not run: no AAB was built or inspected, no Play processing, no
Play-generated APK, no physical/upgrade/edge-to-edge/large-screen testing,
no signing lineage, no 16 KB / 64-bit verification on packaged libraries.

**Conditions to close (owner-driven):**
1. Merge the two repair commits (owner authorization required).
2. Build with `eas build --platform android --profile staging-certification`
   (decide K+ flag enablement first — P2-EAS-FLAGS).
3. Capture AAB SHA-256, versionCode, signing certs; run bundletool
   validation, merged-manifest dump, 16 KB + 64-bit checks.
4. Owner-authorized internal/closed test track upload; verify Play
   processing, pre-launch report, assetlinks against the Play signing cert.
5. Physical matrix incl. the §54 upgrade test, edge-to-edge/large-screen,
   auth (Play-signed OAuth), actor A→B→A, offline matrix, TalkBack.
6. Record that the consumed versionCode is burned; the production-backend
   rebuild must exceed it and must repeat the §61 rebuild checklist
   (environment diff, manifest/version/signing verification, smoke, secret
   scan, hash capture, Play processing check).

**PRODUCTION ROLLOUT OF THIS STAGING-BACKED AAB REMAINS FORBIDDEN.** This
verdict never becomes "READY FOR PRODUCTION ROLLOUT"; the ceiling for this
artifact class is staging certification plus readiness for a
production-config rebuild.
