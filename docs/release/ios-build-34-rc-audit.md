# K Scan AI — iOS Build 34 App Store Submission Readiness Audit

Audit date: 2026-08-31
Audit environment: remote sandbox (source + Supabase read access only; no EAS, App Store Connect, TestFlight, or physical-device access)
Auditor role: Apple App Store Release-Candidate Auditor (read-only certification; no builds, no submissions, no fixes)

---

## A. Executive verdict

**IOS BUILD 34 RC — NOT READY — PRODUCTION ARTIFACT REQUIRED**

No production Build 34 `.ipa`, EAS build record, or TestFlight evidence was supplied or reachable from this audit environment (the EAS CLI is unauthenticated and no Apple/ASC credentials exist here), so the chain of custody required by Phase 0 cannot be established and every artifact-authority phase (toolchain, IPA forensics, signing, binary hygiene, TestFlight, physical device, App Store Connect) is unverified. The audit therefore stops at the pre-build gate per the mandated stop condition. On the release integration line — `staging/production-parity` at `2bb44552e1709ce411307d8cc776b11245f8e591`, the only line in the repository matching the Build 34 baseline (1.0.1, `appVersionSource: remote`, `autoIncrement`, tablet support, Apple gates) — both Apple readiness/submission gates pass cleanly, TypeScript for app code is clean, and 5,832 of 5,898 regression tests pass, with all 7 failures confined to backend/release-tooling contract tests, none touching the iOS submission surface. Two reconciliation items must be resolved by the owner before or alongside supplying the artifact: the audit was commissioned against a branch cut from `master`, which is **not** the release line, and the parity line's production env sets `EXPO_PUBLIC_TODAY_WITH_ELISE_V1=true` where the handoff expects `false` — so the exact frozen Build 34 source SHA must be named and its EAS build record produced. Source-level posture is otherwise consistent with the handoff: correct bundle ID, no microphone permission, no background location, no tracking/ATT/ads SDKs, no RevenueCat client SDK or IAP surface, encryption-exempt flag present, and the production Supabase project is confirmed as "KScan App Production".

---

## B. Chain of custody

| Field | Value |
|---|---|
| FROZEN SOURCE SHA | **NOT ESTABLISHED.** Audit branch `claude/ios-build-34-app-store-audit-4flx6q` = `688dc35e5bc19bed603eea9835d3f8f12afba3be` (identical to `origin/master`) — this is **not** the release line. Best-available release-line candidate: `origin/staging/production-parity` @ `2bb44552e1709ce411307d8cc776b11245f8e591` (2026-08-30, PR #238 merge). Owner must confirm the exact SHA Build 34 was/will be built from. |
| SOURCE BRANCH | `staging/production-parity` (release line); audit commissioned from `master`-derived branch — mismatch recorded as finding P1-1 |
| GIT STATUS AT FREEZE | Clean working tree at both examined SHAs |
| EAS BUILD ID | UNVERIFIED — EAS CLI not authenticated in audit environment (`eas whoami` → "Not logged in") |
| EAS PROFILE | Expected `production` (per `eas.json`: store distribution, Release configuration) — actual build record unverified |
| EAS PROJECT | `a075728d-bd77-446f-843d-0f63fd54cc2e` (from `app.json` extra.eas.projectId; identical on both lines) |
| BUILD START SOURCE SHA | UNVERIFIED — no EAS build record accessible |
| IPA FILE / BYTE SIZE / SHA-256 | NOT SUPPLIED — no `.ipa` in the repository or environment |
| BUILD DATE | UNVERIFIED |
| TESTFLIGHT BUILD | UNVERIFIED — no App Store Connect access |

Phase 0 required conditions are **not met**. Per the stop condition, only the source/pre-build portion of this audit is completed below.

## C. Artifact identity

All artifact fields UNVERIFIED (no `.ipa`, no EAS build log). Source-declared expectations from the parity line for later reconciliation against the real artifact:

| Field | Value |
|---|---|
| XCODE VERSION / BUILD, IOS SDK, EAS BUILD IMAGE, MACOS IMAGE | UNVERIFIED — must be read from the actual EAS build log (do not infer Xcode 26 from Expo SDK 54 defaults) |
| BUNDLE ID (source) | `com.kscanai.app` ✓ matches expected |
| MARKETING VERSION (source) | `1.0.1` ✓ matches expected |
| ACTUAL BUILD NUMBER | UNVERIFIED — `cli.appVersionSource=remote` + `production.autoIncrement=true`, so CFBundleVersion is EAS-assigned; the local `ios.buildNumber: "29"` field is not authority. "34" must be proven from the EAS/ASC record |
| MINIMUM IOS | Not pinned in parity `app.json` (no `deploymentTarget`); artifact value must be captured from Info.plist |
| DEVICE FAMILIES (source) | iPhone + iPad (`supportsTablet: true`; iPhone portrait-only, iPad all four orientations, `UIRequiresFullScreen` not set) ✓ matches expected |
| Expo SDK (source) | `expo ~54.0.36` (handoff states ~54.0.37 — minor drift, see P3-4); RN `0.81.5` ✓, React `19.1.0` ✓, expo-router `~6.0.24` ✓, TypeScript `~5.9.2` ✓, Node `>=20` ✓ |

## D. Signing

Entirely UNVERIFIED — requires the signed archive. SIGNING TEAM / CERTIFICATE / EXPIRATIONS / PROVISIONING PROFILE / PROFILE TYPE / GET-TASK-ALLOW / SIGNED ENTITLEMENTS: no evidence available in this environment. Gate output notes "EAS iOS credentials still require interactive Apple Developer validation" (WARN from `verify:apple-readiness`).

## E. Permissions / privacy (source-level, parity line)

| Field | Finding |
|---|---|
| PRIVACY MANIFEST (first-party, app.json) | `NSPrivacyTracking: false`, `NSPrivacyTrackingDomains: []`. Collected types: Name, EmailAddress, UserID, PhotosorVideos, OtherUserContent, SearchHistory, ProductInteraction, CoarseLocation, **PerformanceData** (9 types — the handoff table lists 8; PerformanceData is the extra, consistent with the embedded Sentry SDK; reconcile with the ASC nutrition label — P3-3). Required-reason APIs: UserDefaults CA92.1 ✓, FileTimestamp C617.1 ✓ |
| THIRD-PARTY MANIFESTS | UNVERIFIED — requires IPA extraction. Known third-party native SDK from source: `@sentry/react-native ^8.22.0` (ships its own PrivacyInfo.xcprivacy) |
| CAMERA | `NSCameraUsageDescription`: "K Scan uses your camera to photograph your outfit for style analysis." Present and scoped ✓ (text says "K Scan", handoff says "K Scan AI" — cosmetic drift, P4) |
| PHOTOS | `NSPhotoLibraryUsageDescription`: "K Scan uses your photo library to let you upload style inspiration images to your Style Closet and Dressing Rooms." ✓ (same "K Scan"/"K Scan AI" drift) |
| LOCATION | `NSLocationWhenInUseUsageDescription` matches the expected text verbatim ✓. `expo-location` plugin: `locationAlwaysPermission: false`, background location disabled (`isIosBackgroundLocationEnabled: false`) |
| BACKGROUND LOCATION | None configured ✓ — no Always keys, no background mode in source |
| MICROPHONE | None ✓ — `expo-camera` `microphonePermission: false`, `expo-audio` `microphonePermission: false`, no `NSMicrophoneUsageDescription` anywhere in source; Elise speech is playback-only. Artifact Info.plist must confirm |
| TRACKING/ATT | No `expo-tracking-transparency`, no ad SDK, no tracking SDK in dependencies ✓; gates PASS "No App Tracking Transparency dependency" / "No ads dependency" |
| ENCRYPTION | `ITSAppUsesNonExemptEncryption: false` present in source ✓; artifact value must be confirmed |

## F. Production authority (source-level)

| Field | Finding |
|---|---|
| PRODUCTION BACKEND | `eas.json` production env → `https://wyyuqfdxucjksghsmhry.supabase.co`, confirmed via Supabase management API as project **"KScan App Production"** (ACTIVE_HEALTHY) ✓ |
| STAGING REFERENCES | None in the production profile. Note: `master`'s `eas.json` production profile points at `yzqjvdfgefveprobvvyw` = "K Scan AI Staging" — one more reason `master` must not be the build source (P4 record) |
| SECRETS SCAN | Client source and build config carry only the Supabase **anon** (public client) key — legitimate. No service-role, provider, RevenueCat, RapidAPI, worker, or signing secrets found in client code or `eas.json`/`app.json`. `localhost`/`10.0.2.2` appear only in comments and dead code (`config.js` is documented dead code). Binary-level hostile search UNVERIFIED until the IPA exists |
| REVENUECAT CLIENT SDK | ABSENT ✓ — no `react-native-purchases`/RevenueCat/StoreKit/expo-in-app-purchases in dependencies or source |
| APPLE IAP | ABSENT ✓ — no purchase UI, no IAP surface in source |
| K+ PRODUCTION STATUS | No K+ activation UI or purchase semantics found in client source; no K+ env flag in the production profile. K+ SOURCE EXISTS: not found in mobile client at parity HEAD; K+ PRODUCTION ENABLED: no; REVIEWER REACHABLE: expected no (artifact confirmation pending) |

### Effective production feature matrix (from frozen-source env × source; artifact/TestFlight confirmation pending)

PRODUCTION ENABLED (per `eas.json` production env, all `true`): Scanner + Scan Results V2, Text Scan (backend-enabled, demo results off), backend scan identification, Elise / AI Stylist (+ backend), Elise visual attachments, StyleChat attachments, Closet (separation, direct intake, candidate staging, batch review V2), Dressing Rooms (collaboration, messages, reactions, room chat), private dressing rooms (+ Elise, interactions, saved looks), Mirror Selfie V1, weather styling context, Style DNA, onboarding framework, Home navigation V2, **Today with Elise V1 + weather + generated greeting — `true`, contradicting the handoff's expected `false` (finding P2-1)**.
PRODUCTION DISABLED: observability/Sentry (`EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED=false`; init policy nulls the DSN), TextScan demo results.
ABSENT FROM SOURCE (mobile client): K+ Early Access UI, RevenueCat, VTO, Watchlist, Packing, Concierge, voice recording, push notifications (no `expo-notifications`).

## G. Apple capabilities (source-level)

| Field | Finding |
|---|---|
| SIGN IN WITH APPLE | `expo-apple-authentication ~8.x` + `usesAppleSignIn: true` + plugin present ✓ (gates PASS). Signed entitlement + live flows UNVERIFIED |
| ASSOCIATED DOMAINS | `applinks:kscan.app` declared ✓. Signed entitlement + AASA + live routing UNVERIFIED |
| CUSTOM SCHEME | `kscan` ✓ |
| PUSH/APNS | No notification SDK in dependencies; no push token flow found. Whether EAS provisioning adds an `aps-environment` entitlement anyway must be checked in the signed artifact |
| ROUTING APP | No `MKDirectionsApplicationSupportedModes`, no routing capability in source ✓. The ASC Routing App Coverage File (Build 32's ITMS-90118 fix) must be re-verified in ASC before submission — UNVERIFIED here |

## H. App Store Connect

All UNVERIFIED — no ASC access from this environment: APP ID, SELECTED BUILD, ROUTING COVERAGE, AGE RATING questionnaire (messaging/chat, UGC, social media, unrestricted web), CONTENT RIGHTS, PRIVACY ANSWERS, REVIEWER ACCESS, SCREENSHOTS, RELEASE MODE.
In-repo `store.config.json` (used only if `eas metadata:push` were run — it must not be): version 1.0.1, title "K Scan", subtitle "AI fashion discovery", categories SHOPPING/LIFESTYLE, manual release, phased off, all four URLs match the expected set, `unrestrictedWebAccess: false`, no kids band. **Its description/release notes describe only "email/password account access, camera scan analysis, local saved scans, privacy controls, account deletion" — materially narrower than the effective production feature matrix (Sign in with Apple, Elise, Dressing Rooms, cloud closet, Today with Elise). If curated ASC metadata resembles this text, it must be reconciled (P3-2).** `eas-cli metadata:lint`: ✅ valid.

## I. Automated gates

All commands run at `staging/production-parity` @ `2bb4455` with `npm ci` from the lockfile (Node 22 runner):

| Gate | Result |
|---|---|
| TYPESCRIPT (`npx tsc --noEmit`) | **FAIL overall, exit 2 — 33 errors, ALL confined to `security/release/*.mjs`** (release-orchestration tooling: `run-bootstrap-activation.mjs` 18, `staging-deploy-core.mjs` 6, `activation-runtime-adapters.mjs` 5, `persist-verified-release-package.mjs` 3, `set-staging-release-metadata.mjs` 1). Zero errors in `app/`, `components/`, `hooks/`, `services/`, `contexts/` — the shipped bundle typechecks clean. Classification: KNOWN BASELINE / release-tooling drift; not run by CI; not an App Store blocker (P3-1a) |
| FULL TEST SUITE (`npm run test:all`) | exit 1 — **5,898 tests: 5,832 pass, 7 fail, 59 skipped** (102s). Failures below |
| APPLE READINESS GATE (`npm run verify:apple-readiness`) | **PASS (exit 0)** — all checks PASS; 3 WARNs: ASC app ID not configured in eas.json; App Review contact/demo account not encoded in store.config.json; EAS iOS credentials require interactive Apple Developer validation |
| APPLE SUBMISSION GATE (`npm run verify:apple-submission`) | **PASS (exit 0)** — same WARN set; explicitly defers external gates: EAS credentials, ASC app ID, TestFlight/device QA, manual submission |
| METADATA LINT (`eas-cli metadata:lint`) | ✅ "Store configuration is valid." |
| NEW REGRESSIONS | None attributable to the iOS submission surface |
| KNOWN BASELINE / classification of the 7 failures | (1) `__tests__/phase7ClothingTypeContract.test.js` — 3 failures: the test reconstructs a certified prompt via `git show 2eb30df8…:supabase/functions/scan-identify/index.ts` and that path does not exist at that commit in this clone → ENVIRONMENT / git-history-dependent; backend scanner prompt contract, not App Store surface. (2) `__tests__/sharedRoomCollaborationHotfix.test.js` — 3 failures: expects migration `supabase/migrations/20260725100000_shared_room_item_contributions.sql`, which is absent from the parity line → deterministic at this SHA; STALE TEST vs. migration set; backend RLS contract for room contributions — owner should confirm the intended contributions policy state (P3-1c). (3) `__tests__/staging/stagingBranchAuthority.test.js` — 1 failure ("expected the gate to declare its diff-base fallbacks"): stale vs. PR #238 gate rationalization → KNOWN BASELINE / release-tooling. Additionally recorded from the `master` line (not the release line): `stagingReleaseBootstrapRegistration.test.js` fails there because the workflow gained a third `certification_run_id` input the test doesn't expect — STALE METADATA ASSUMPTION, master-only. No test was modified or weakened during this audit |

## J. TestFlight / physical validation

TESTFLIGHT PROCESSING, PHYSICAL IPHONE, PHYSICAL IPAD, SIGN IN WITH APPLE (live flows incl. Hide My Email), SCANNER, ELISE, CLOSET, DRESSING ROOMS, ACCOUNT DELETION (in-app path), APPLE TOKEN REVOCATION contract, DEEP LINKS (AASA/cold/warm/signed-out), NOTIFICATIONS, ACCESSIBILITY, CRASH/DIAGNOSTICS: **ALL NOT RUN — no artifact, no TestFlight build, no device.** No physical test is claimed. Source-level notes only: the account-deletion and Apple-revocation contract has passing unit coverage (`accountDeletion.test.js`, `authPrivacy.test.js` — 38 tests pass), which is evidence, not certification.

## K. Open findings

**OPEN P0:** none recorded (a P0 cannot be excluded until the artifact phases run).

**OPEN P1:**
1. **Chain of custody not establishable — production artifact and EAS build record missing.** Evidence: no `.ipa` in repo/environment; `eas whoami` → "Not logged in"; no ASC credentials. Affected build: Build 34 (all phases 5, 7–10, and 18–31). Reproducible: yes (environment state). Release impact: submission certification impossible. Minimum correction: owner supplies the exact production `.ipa` (or EAS build ID + access) built from a named frozen SHA via `eas build --platform ios --profile production`, plus the TestFlight record; audit then resumes at Phase 0.
2. **Audit line ≠ release line.** Evidence: audit branch `claude/ios-build-34-app-store-audit-4flx6q` was cut from `master` (`688dc35`), which lacks the Apple gates, is versioned 1.0.0/buildNumber 2, `appVersionSource: local`, `supportsTablet: false`, and points its production profile at the **staging** Supabase project. The Build 34 baseline lives on `staging/production-parity` (`2bb4455`). Reproducible: yes. Release impact: any build cut from master would be a materially wrong artifact (wrong backend = hard blocker). Minimum correction: owner names the frozen Build 34 SHA on the parity line and confirms the EAS build starts from it.

**OPEN P2:**
1. **`EXPO_PUBLIC_TODAY_WITH_ELISE_V1=true` (plus `…_WEATHER_V1=true`, `…_GENERATED_GREETING_V1=true`) in the production build env at parity HEAD, where the handoff states the expected condition is `false`.** Evidence: `eas.json` production env at `2bb4455`. Reproducible: yes. Release impact: changes the reviewer-visible product surface and the feature matrix the metadata/privacy answers must describe; a build cut from this SHA ships Today with Elise enabled. Minimum correction: owner states which posture is intended for Build 34 (and if `false`, identifies the actual frozen SHA carrying that value) — no source change was made by this audit.

**OPEN P3:**
1. Pre-build gate failures at the candidate SHA, all backend/release-tooling: (a) 33 TypeScript errors confined to `security/release/*.mjs`; (b) `stagingBranchAuthority` gate-shape test stale vs. PR #238; (c) `sharedRoomCollaborationHotfix` expects a room-contributions migration absent from the line — owner should confirm whether the contributions RLS hotfix is meant to be on the release line (only item (c) could conceivably map to runtime behavior, in Dressing Rooms sharing). None block the Apple submission surface; none were "fixed" to pass.
2. In-repo `store.config.json` description/release notes describe a far narrower product (email/password only, local saved scans) than the effective production feature matrix; title "K Scan" vs. product name "K Scan AI". ASC curated metadata is the authority and is unverified — owner must confirm the live ASC listing matches actual Build 34 behavior before submission. Do not run `eas metadata:push`.
3. First-party privacy manifest declares **PerformanceData** (9th category, beyond the handoff's 8-row table), consistent with the embedded Sentry SDK even though observability is env-disabled. The ASC Privacy Nutrition Label and privacy policy must match the artifact's aggregate manifests (third-party manifests inspectable only in the IPA).
4. Gate WARNs to close before submission: ASC app ID not in `eas.json` submit profile; reviewer contact/demo account not encoded (must exist in ASC directly); EAS iOS credential validation outstanding. Expo `~54.0.36` vs. handoff's `~54.0.37` — confirm intended pin at freeze.

**P4+ RECORD:** permission-string branding drift ("K Scan …" in camera/photos strings vs. "K Scan AI …" in the location string); `master`'s production eas profile targets the staging Supabase project (dangerous only if master is ever built); dead-code `config.js` retains a LAN IP; Sentry SDK ships in the binary while disabled by policy (binary-size/manifest footprint only); `useKScanDuplicateGuard` and bootstrap-registration tests failing on the master line only.

---

## Verdict

**IOS BUILD 34 RC — NOT READY — PRODUCTION ARTIFACT REQUIRED**

Resume point once the owner supplies the exact frozen SHA and the production `.ipa`/EAS build record: Phase 0 (chain of custody) → Phase 7+ (toolchain, IPA forensics, signing, TestFlight, physical matrix). No EAS build was run, no source was modified, no test was weakened, and no App Store Connect state was touched by this audit.
