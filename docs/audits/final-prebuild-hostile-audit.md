# K Scan AI — Final Pre-Build Hostile Audit

Date: 2026-09-06  
Audit base: `origin/fix/home-avatar-regression-convergence-v1` at `5de80b63c1451fd5559d30cb97092386f9a6d4e1`  
Audit branch: `audit/final-prebuild-hostile-v1`  
Scope: source certification only; no EAS production build and no staging or production mutation.

## Authority and outcome

- Remote authority matched the owner handoff SHA and the isolated audit worktree started clean and 0 ahead / 0 behind.
- The accepted Home, stylist/avatar, AI-processing acknowledgment, notification, VoiceScan, K+, PostHog, icon, migration-governance, Apple/backend-authority, and functional photo-VTO source is present.
- PR #308 and the native/live VTO R&D lane remain open/draft and unmerged. No N1 diagnostic route, MediaPipe/PoseLandmarker model, native mesh module, or R&D-only model asset is in the shipping authority.
- Android emulator evidence: `sdk_gphone16k_x86_64`, Android 17 / API 37, x86_64. Cold launch, onboarding navigation, permission absence at launch, deny-state retention, rotation, background/foreground, and crash-free relaunch were executed. Authenticated Home/VTO/K+ scenarios were source/test verified because no audit fixture credentials were authorized.
- iOS was source/config/test verified on this Windows host. Simulator/TestFlight behavior, purpose-string presentation, Speech on-device enforcement, push token delivery, camera/photo capture, VTO media flow, deep links, and account deletion remain `PHYSICAL-IOS-VERIFY`.
- Final local regression: 7,808 tests, 7,728 pass, 13 known failures, 0 unexpected failures, 67 skipped, governed exit 0. Backend: 984 pass, 0 fail. TypeScript: pass.
- Source certification is conditional on physical verification and the explicitly recorded environment/release holds. No lower-priority finding below is a build blocker.

## Authorized P0–P3 repair record

| ID | Severity | Defect | Repair | Result |
|----|----------|--------|--------|--------|
| AUD-P1-R01 | P1 | Legacy local onboarding boolean could bypass the versioned AI-processing acknowledgment. | Accept only the current versioned marker; legacy state must reconcile with backend truth. | Repaired and regression-tested. |
| AUD-P1-R02 | P1 | First anonymous PostHog sync was treated as already synchronized, permitting a restored prior SDK identity. | Use an uninitialized sentinel so the first anonymous sync always resets. | Repaired and regression-tested. |
| AUD-P2-R01 | P2 | Push-token refresh listener existed but was never attached by the app root. | Attach/dispose it in `_layout.tsx`, including async-disposal and fail-soft handling. | Repaired and regression-tested. |
| AUD-P2-R02 | P2 | PostHog client did not explicitly disable GeoIP. | Set `disableGeoip: true` in the sole SDK boundary. | Repaired and regression-tested. |
| AUD-P3-R01 | P3 | Dependency-reachability gate could not spawn npm on Windows. | Resolve npm through the current Node/npm CLI on Windows; retain shell-free bounded execution. | Repaired and regression-tested. |
| AUD-P3-R02 | P3 | Two Bash-only VTO semantic controls failed on Windows because the host WSL relay is broken. | Skip only those two controls on Windows; retain the cross-platform structural control. | Repaired; 58 pass / 2 platform skips. |

Remaining higher-priority holds:

- `SCAN-002` (P2): `docs/BUILD34_SCANNER_SCAN_RESULTS_DEEP_AUDIT.md:287-307,470-477` — measured identification time is 6.2–14.0 seconds against the five-second curiosity target. A model/prompt/schema change requires a governed accuracy corpus and owner decision; no speculative repair was made. Literal build blocker: NO. Release decision required: YES.
- `VTO-MIG-001` (P3): `config/migration-authority-manifest.json:604-607`, `supabase/functions/vto-generate/vtoReservation.ts:115-139`, `supabase/migrations/20260902150000_vto_non_billable_attempt_release.sql:36-99` — staging does not yet have `release_vto_generation`; provably non-billable provider failures can remain counted against a daily limit. Source includes the forward migration, but applying it would mutate staging and was not authorized. Literal build blocker: NO. Staging certification hold: YES.

P0 FOUND: 0  
P0 REPAIRED: 0  
P0 REMAINING: 0  
P1 FOUND: 2  
P1 REPAIRED: 2  
P1 REMAINING: 0  
P2 FOUND: 3  
P2 REPAIRED: 2  
P2 REMAINING: 1  
P3 FOUND: 3  
P3 REPAIRED: 2  
P3 REMAINING: 1

## Platform parity matrix

| Feature | iOS source/runtime path | Android source/runtime path | Native config / permission | Verdict |
|---------|-------------------------|-----------------------------|----------------------------|---------|
| VoiceScan | Shared Home → `useVoiceScan`; native Speech path requires on-device recognition | Shared Home → `useVoiceScan`; Android native recognizer is foreground-bounded/on-device-preferred | iOS microphone + speech strings present; Android `RECORD_AUDIO` only in governed certification manifest | PASS source; iOS and certification artifact physical verify |
| Notifications | Shared registration, navigation gates, actor-bound token lifecycle | Same; emulator showed no launch prompt and denied state was safe | iOS notifications capability/config; Android `POST_NOTIFICATIONS` | PASS source; delivery physical verify |
| Camera/photo | Shared Scanner and functional photo-VTO | Same routes/components | iOS camera/photo strings; Android camera + system picker, no broad media permission | PASS source; physical capture verify |
| Auth/deep links | Shared Expo Router callback and actor reset | Same | `kscanai` scheme; platform native declarations parity-gated | PASS |
| Account deletion | Shared request/deactivation flow | Same | No special permission | PASS server flow; local terminal-purge debt recorded below |
| PostHog | Sole governed wrapper, shared identity sync | Same | No platform permission; autocapture/replay/error capture/flags/surveys off, GeoIP disabled | PASS with consent decision recorded |
| K+ | Shared RevenueCat/server entitlement authority; fail closed | Same | No platform permission | PASS source |
| Home | Canonical shared route and hierarchy | Same; authenticated rendering source/test verified | Portrait policy intentionally differs on iPhone vs Android rotation | PASS |
| Functional VTO | Shared photo-VTO route/request store | Same | Camera/photo only; no R&D native runtime | PASS source; staging migration hold |
| Icons/splash/metadata | Native iOS assets/config inspected | Native Android assets/config inspected | Bundle/package `com.kscanai.app`; version 1.0.1; builds 26/23 | PASS source; artifact verify |
| Legal/privacy | Shared in-app privacy surfaces and hosted policy links | Same | No platform permission | PASS; metadata drift recorded |
| Feature flags | Same shared selectors | Same | `staging-certification` intentionally enables K+/VTO/Watchlist/Packing/Voice; production promotion remains owner-controlled | INTENTIONAL EXCEPTION |

## Permission inventory

| Permission | Platform | Why / trigger | Timing | Required? / denial | Native authority / purpose | Parity |
|------------|----------|---------------|--------|--------------------|----------------------------|--------|
| Microphone | iOS | Entitled VoiceScan tap | JIT | Optional; locked/error state | `NSMicrophoneUsageDescription` | PASS source |
| Speech recognition | iOS | Entitled VoiceScan tap | JIT | Optional; locked/error state | `NSSpeechRecognitionUsageDescription`; native Speech | PASS source |
| Record audio | Android certification only | Entitled VoiceScan tap | JIT | Optional; denied state | Governed certification manifest adds `RECORD_AUDIO`; default manifest blocks it | PASS source / artifact verify |
| Camera | Both | Scanner or person-photo capture | JIT | Optional; denial copy/retry | iOS camera purpose; Android `CAMERA` | PASS |
| Photo library/media | iOS / Android picker | User chooses an image | JIT | Optional; cancellation safe | iOS photo-library purpose; Android system picker, broad media permissions blocked | PASS |
| Notifications | Both | User enters notification-enabling product flow | JIT | Optional; registration fails soft | iOS notification config; Android `POST_NOTIFICATIONS` | PASS |
| Approximate location | Both | Weather-aware styling after disclosure | JIT | Optional; weather omitted | iOS When-In-Use purpose; Android `ACCESS_COARSE_LOCATION`; fine location blocked | PASS |
| Tracking | Neither | Not used | N/A | N/A | No ATT permission/string | PASS |
| Bluetooth | Neither | Not used | N/A | N/A | Not declared | PASS |
| Contacts | Neither | Not used | N/A | N/A | Not declared | PASS |

## Third-party processor / network sink inventory

| Service | Purpose | Data sent | PII/media/auth possible? | Platform difference | Config authority |
|---------|---------|-----------|--------------------------|---------------------|------------------|
| Supabase | Auth, database, storage, Edge Functions | Auth/session data, account records, governed scan/VTO/attachment media | Yes / yes / yes | None | EAS environment + backend authority manifests |
| PostHog | Allowlisted product analytics | Bounded event enums/counts only | No intended PII/media/auth | None | `services/analytics/posthogClient.core.ts` env-only wrapper |
| RevenueCat | K+ purchase/entitlement reconciliation | App user/entitlement and purchase identifiers | Identifier yes; media no; auth data no | Store platform differs | RevenueCat SDK/server authority |
| Gemini / configured model routes | Fashion analysis and StyleChat | Governed images or prompts required by the invoked feature | PII avoided by contract; media yes for image flows; no bearer token | None | Edge Function environment/model allowlists |
| AI Lab Tools | Functional photo-VTO generation | Person and garment image inputs required for VTO | Media yes; auth token stays at K Scan edge | None | `vto-generate` provider adapter/env |
| Serper / Brave | Retailer-neutral commerce discovery | Derived search query | No raw PII/media/auth | None | `scan-identify/shoppingProvider.ts` env |
| Open-Meteo | Weather-aware styling/packing | Location query/geocode-derived destination and dates | Location/destination possible; no media/auth | None | weather modules |
| Expo/Apple/Google push transport | Push delivery | Push token and notification payload | Device token yes; no media | Platform provider differs | notifications service + native config |
| Resend | Deletion/restoration transactional email | Account email and recovery/deletion content | PII yes; no media; signed recovery material possible | None | backend Edge Function env |
| Sentry | Not present in this source | None | No | None | Documentation-only reference; finding below |
| Render | No reachable SDK/endpoint found in shipping source | None | No | None | Not used by current source |

## P4–P10 counts

P4 FOUND: 33  
P5 FOUND: 12  
P6 FOUND: 11  
P7 FOUND: 5  
P8 FOUND: 2  
P9 FOUND: 0  
P10 FOUND: 1  
TOTAL P4-P10: 64

## P4–P10 summary

| ID | Severity | Location | Platform | Defect Type | Summary | Suggested Fix | Build Blocker |
|----|----------|----------|----------|-------------|---------|---------------|---------------|
| AUD-P4-001 | P4 | `package-lock.json`; dependency graph | Shared | dependency/configuration | npm audit reports 35 advisories (0 critical, 13 high, 21 moderate, 1 low). | Upgrade only through an Expo/RN-compatible dependency campaign and rerun reachability/device tests. | NO |
| AUD-P4-002 | P4 | `app.json`, `ios/`, `android/`; native authority | Both | config drift | Expo Doctor flags hybrid native/CNG synchronization ambiguity. | Formally declare native folders authoritative and keep/generated parity coverage for every app-config field. | NO |
| AUD-P4-003 | P4 | `config/backend-authority.json:3-6,33` | Backend | release process | Canonical backend branch is documented as local-only/unpublished. | Publish the canonical branch or repoint to a remote immutable ref. | NO |
| AUD-P4-004 | P4 | Supabase production Auth settings | Backend | security hardening | Leaked-password protection is disabled in production. | Enable breached-password checking through an approved Auth change. | NO |
| AUD-P4-005 | P4 | Supabase staging Auth settings | Backend | security hardening | Leaked-password protection is disabled in staging. | Enable it in staging, validate UX, then promote deliberately. | NO |
| AUD-P4-006 | P4 | `20260829120000_kplus_entitlements.sql:77-90`; staging | Backend | privilege hardening | Trigger function retains direct anon/authenticated EXECUTE grants. | Forward migration revoking anon and authenticated explicitly. | NO |
| AUD-P4-007 | P4 | `20260830060000_user_style_profiles.sql:85-98`; staging | Backend | privilege hardening | Style-profile trigger function retains direct anon/authenticated EXECUTE grants. | Forward migration revoking anon and authenticated explicitly. | NO |
| AUD-P4-008 | P4 | `scripts/smoke-scan-identify.js:24,53` | Backend | tooling hazard | Scan smoke defaults to production when URL is omitted. | Default to staging and require explicit production opt-in. | NO |
| AUD-P4-009 | P4 | `services/analytics/posthogClient.core.ts:31-42,86-89` | Shared | privacy governance | Configured PostHog opts in without a dedicated analytics-consent authority. | Obtain legal sign-off or add a real analytics consent preference and wire it only here. | NO |
| AUD-P4-010 | P4 | `commerceRelevanceColorMaterial.ts:90-94,246-284` | Backend | commerce relevance | Visually uncertain fibers can become hard search terms. | Downgrade rarely verifiable fibers to likely/soft evidence. | NO |
| AUD-P4-011 | P4 | `shoppingProvider.ts:351-376`; `types.ts:135-140` | Shared/Backend | price truth | Serper mapping omits currency and numeric fallback formats USD. | Carry provider currency; show unavailable/neutral when absent. | NO |
| AUD-P4-012 | P4 | `commerceFunnelConfig.ts:41-45` | Backend | performance | 1.9s commerce deadline cut off 4/13 measured provider responses. | Measure p95 and test a bounded ~2.4s budget. | NO |
| AUD-P4-013 | P4 | `app.js:513-525` | Shared | stale-state/persistence | Multi-item commerce attachment dedupe key ignores content. | Fingerprint canonical content like the single-item path. | NO |
| AUD-P4-014 | P4 | `scan-identify/index.ts:667-714` | Backend | commerce relevance | Multi-item first pass omits pattern/silhouette/fit/material. | Add only measured high-value attributes after latency/accuracy A/B testing. | NO |
| AUD-P4-015 | P4 | `scanHelpers.ts:135+`; `scanCommerceRouter.ts:511-550` | Backend | taxonomy gap | Shared normalizer lacks mappings for 29 probed garment nouns. | Extend shared taxonomy with cross-feature fixtures. | NO |
| AUD-P4-016 | P4 | `shoppingProvider.ts:429-452` | Backend | UX/commerce | Provider can fall back to an aggregator when no merchant URL exists. | Add a provider/plan that supplies merchant offer links. | NO |
| AUD-P4-017 | P4 | `services/closetLibrary.js:1178-1197` | Shared | error handling | Closet delete returns false for both not-found and write failure. | Return a typed result distinguishing idempotent absence from failure. | NO |
| AUD-P4-018 | P4 | `eas.json:126-198`; `easProfileParity.test.js:58-80` | Both | config drift | Staging omits three production free-tier flags. | Mirror production flags or add an owner-approved exception. | NO |
| AUD-P4-019 | P4 | `eas.json:154,233`; `easProfileParity.test.js:84-100` | Both | platform/environment parity | Today with Elise is on in staging and off in production without an exception. | Align values or encode the product-authorized exception. | NO |
| AUD-P4-020 | P4 | `cross-path-parity-manifest.json:12,24` | Backend | config drift | Two governed source hashes are stale. | Regenerate the manifest from the selected backend authority. | NO |
| AUD-P4-021 | P4 | `services/library.js:958-970` | Shared | privacy/account deletion | Recent Scan owner purge exists but has no production caller. | Invoke only after confirmed terminal server purge. | NO |
| AUD-P4-022 | P4 | `services/closetLibrary.js:1516-1535` | Shared | privacy/account deletion | Local Closet purge primitive is unwired. | Add confirmed-terminal-purge completion orchestration. | NO |
| AUD-P4-023 | P4 | `services/closetCandidateLibrary.js:1616-1635` | Shared | privacy/account deletion | Closet-candidate purge primitive is unwired. | Wire it to the same terminal purge completion event. | NO |
| AUD-P4-024 | P4 | `services/closet/closetSyncStore.ts:299-307` | Shared | privacy/account deletion | Closet sync sidecar purge primitive is unwired. | Wire owner-scoped purge after terminal server confirmation. | NO |
| AUD-P4-025 | P4 | `services/closet/closetRestoreMedia.ts:141-151` | Shared | privacy/account deletion | Restored-media cache purge primitive is unwired. | Wire it to terminal deletion completion. | NO |
| AUD-P4-026 | P4 | `localStyleDnaProfile.ts:154-159`; account-deletion flow | Shared | privacy/account deletion | Style DNA feedback/reasons clear only on user reset, not terminal account purge. | Call the owner-scoped reset after terminal deletion confirmation. | NO |
| AUD-P4-027 | P4 | `AndroidManifest.xml:41` | Android | UX/native config | Predictive back is explicitly disabled. | Device-test Android predictive back, then enable with route regression coverage. | NO |
| AUD-P4-028 | P4 | `services/api.js:43-59` | Shared | dependency/configuration | Legacy API path fails only when invoked if `EXPO_PUBLIC_API_URL` is absent. | Prove no release caller or add an explicit governed endpoint authority. | NO |
| AUD-P4-029 | P4 | `packingWeather.ts:221-268` | Backend | performance/error handling | Trips beyond 16 days spend geocode/forecast work that can only return unavailable. | Validate horizon before network calls. | NO |
| AUD-P4-030 | P4 | `packingWeather.ts:198-208` | Backend | UX/localization | Packing weather always requests Fahrenheit. | Select units from a governed locale/preference. | NO |
| AUD-P4-031 | P4 | `packingContract.ts:209-281` | Backend | validation | Past-dated trips are accepted. | Reject or explicitly label historical dates before weather work. | NO |
| AUD-P4-032 | P4 | `packingWeather.ts:74-86,245-258` | Backend | performance | Task-local weather cache never evicts expired keys. | Delete expired entries or enforce an LRU/size cap. | NO |
| AUD-P4-033 | P4 | `closetSyncStore.ts`; B2B ledger 129-130 | Shared | maintainability/performance | Closet sync sidecar never compacts old item entries. | Compact terminal entries under a versioned bounded policy. | NO |
| AUD-P5-001 | P5 | `eas.json:239-244`; `store.config.json` | iOS | release metadata | App Store ID and reviewer contact/demo metadata are not encoded. | Complete metadata securely before submission. | NO |
| AUD-P5-002 | P5 | `.testsprite/` / TestSprite CLI project state | Shared | test coverage gap | No repo-linked TestSprite project; client changes are undeployed. | Link a project and run the broad suite against the exact reachable candidate. | NO |
| AUD-P5-003 | P5 | `privacyImageSanitizer.js:5-38`; `savedScanMedia.ts:144-161` | Both | privacy hardening | Sanitizer is passthrough; no face/plate masking. | Product/legal decision; add native redaction only with quality/device validation. | NO |
| AUD-P5-004 | P5 | `app/onboarding/index.tsx:476-510` | Both | accessibility | Password Show/Hide controls have no explicit role, label, or state. | Use an accessible button with label and expanded/selected state. | NO |
| AUD-P5-005 | P5 | `enforce_minor_privacy_defaults`; production | Backend | privilege hardening | Trigger-only SECURITY DEFINER function remains anon executable. | Promote the reviewed explicit revoke migration. | NO |
| AUD-P5-006 | P5 | `content_reports_ai_output.sql:61-114` | Backend | data integrity | SQL CHECK accepts AI-output rows with NULL context via three-valued logic. | Make the predicate explicitly reject NULL for `ai_output`. | NO |
| AUD-P5-007 | P5 | `eas.json:7-115` | Both | environment safety | Preview/development profiles point at production Supabase. | Move internal profiles to staging or require explicit production selection. | NO |
| AUD-P5-008 | P5 | `set_profiles_updated_at`; production | Backend | function hardening | Mutable search_path remains live. | Promote `ALTER FUNCTION ... SET search_path`. | NO |
| AUD-P5-009 | P5 | `set_updated_at`; production | Backend | function hardening | Mutable search_path remains live. | Promote the reviewed hardening migration. | NO |
| AUD-P5-010 | P5 | `set_style_objects_updated_at`; production | Backend | function hardening | Mutable search_path remains live. | Promote the reviewed hardening migration. | NO |
| AUD-P5-011 | P5 | `normalize_dressing_room_note`; production | Backend | function hardening | Mutable search_path remains live. | Promote the reviewed hardening migration. | NO |
| AUD-P5-012 | P5 | `multiItemCommerceCriticalPath.test.js:163-174` | Shared | stale test | Critical-path fixture self-seeds `commerceDeferred: true`. | Reframe as latency-only and add a real mapper/emission assertion. | NO |
| AUD-P6-001 | P6 | `app-review-information-template.md:27,50` | iOS | documentation drift | Reviewer copy says VoiceScan coming soon and no push. | Update only when the promoted artifact is frozen. | NO |
| AUD-P6-002 | P6 | `play-store-readiness-notes.md:21,66-70,131-133` | Android | documentation drift | Play notes describe inactive VoiceScan/no microphone. | Refresh from exact AAB manifest and runtime evidence. | NO |
| AUD-P6-003 | P6 | `store.config.json:33-45` | iOS | documentation drift | Description/release notes omit major current surfaces. | Rewrite metadata after final promotion scope is approved. | NO |
| AUD-P6-004 | P6 | `closetCloudMediaContract.test.js:269-275` | Shared | stale test | Dimension assertion freezes older local-image assumptions. | Assert current cloud thumbnail contract separately from local media. | NO |
| AUD-P6-005 | P6 | `dressingRoomBlockingUi.test.js:528-543` | Backend | stale test | Internal-schema guard scans prose/dependencies and yields a false positive. | Parse SQL statements or strip comments first. | NO |
| AUD-P6-006 | P6 | `rpcHardeningMigration.test.js:62-65` | Backend | stale test | Regex expects literal revokes and misses catalog-loop hardening. | Test the explicit catalog allowlist and effective privilege result. | NO |
| AUD-P6-007 | P6 | `llmModelRoutingParity.test.js:325-328` | Backend | stale test/config drift | Test assumes two config blocks while current authority differs. | Generate assertions from backend authority and governed functions. | NO |
| AUD-P6-008 | P6 | `scanIdentifyEdgeContract.test.js:641-689` | Backend | stale test | Tests expect quota fail-open/log text after implementation moved fail-closed. | Update assertions to approved fail-closed semantics. | NO |
| AUD-P6-009 | P6 | `stylechat-generate/index.ts:808-836` | Backend | UX/localization | General StyleChat weather defaults to Fahrenheit. | Carry user locale/preference and preserve provider-native value. | NO |
| AUD-P6-010 | P6 | `run-security-validation.js:37,42` | Shared | test reporting | Expected localhost rejection is labeled a failed check although exit is success. | Model expected failure as a passing negative-control result. | NO |
| AUD-P6-011 | P6 | `posthogClient.core.ts:18-19`; `package.json` | Shared | documentation/observability drift | Comment says Sentry remains, but no Sentry integration exists. | Correct the comment or add separately governed error observability. | NO |
| AUD-P7-001 | P7 | Android CMake/Ninja build in long audit path | Android | build tooling | Local native build hits `build.ninja still dirty` after path-length warnings. | Use a genuinely short checkout or shorten generated CMake object paths. | NO |
| AUD-P7-002 | P7 | `android/app/build.gradle:371-473` | Android | deprecated config | Project-owned Gradle DSL emits deprecation warnings. | Update DSL in a dedicated Android toolchain change. | NO |
| AUD-P7-003 | P7 | Expo/RN Gradle plugins during configure | Android | dependency/configuration | Upstream plugin deprecations remain. | Resolve through a compatible Expo/RN upgrade. | NO |
| AUD-P7-004 | P7 | `package-lock.json` | Shared | dependency debt | Deprecated transitive inflight/rimraf/glob/uuid packages remain. | Remove through controlled parent upgrades. | NO |
| AUD-P7-005 | P7 | `localStyleDnaFeedbackStore.ts:201-210` | Shared | analytics gap | Feedback always records `contextSource=style_chat`. | Pass bounded source metadata through the handoff. | NO |
| AUD-P8-001 | P8 | `services/supabasePrivacy.js:11-17` | Shared | dead code | Deprecated `isPrivacyBackendConfigured` helper remains unused. | Remove after a reachability check in a cleanup-only change. | NO |
| AUD-P8-002 | P8 | `package.json`; ES-module `.js` tests/services | Shared | configuration/maintainability | Missing module type causes repeated reparsing warnings. | Migrate files deliberately or use `.mjs`/`.cjs`; do not flip globally without compatibility work. | NO |
| AUD-P10-001 | P10 | `avatarEnginePackages.ts:32-40,113-116` | Shared | future optimization | Blink/brow/gaze/body channels remain intentionally deferred. | Add calibrated versioned assets one channel at a time with device profiling. | NO |

## Detailed P4 findings

### AUD-P4-001
ID: AUD-P4-001  
SEVERITY: P4  
TITLE: Governed dependency advisory backlog  
LOCATION: `package-lock.json`; npm dependency graph; Shared; build/test/runtime packages  
TYPE OF DEFECT / BUG: dependency/configuration issue; security hardening opportunity  
EXPECTED BEHAVIOR: Release dependencies have no unexplained actionable advisories.  
OBSERVED BEHAVIOR: `npm audit` reports 0 critical, 13 high, 21 moderate, and 1 low advisories.  
ROOT CAUSE: Current Expo/RN transitive graph; the reachability gate classifies all high paths as approved build/development-only and found no app-source drift.  
USER / RELEASE IMPACT: No production exploit path was proven; maintenance and toolchain risk remains.  
REPRODUCTION / EVIDENCE: `npm audit --json`; `node scripts/check-dependency-reachability.js`.  
SUGGESTED FIX: Upgrade only through an Expo/RN-compatible dependency campaign and rerun source reachability, full regression, native builds, and device QA.  
ESTIMATED REPAIR SCOPE: `package.json`, lockfile, native projects, broad tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: after physical build

### AUD-P4-002
ID: AUD-P4-002  
SEVERITY: P4  
TITLE: Hybrid native/CNG configuration authority remains ambiguous  
LOCATION: `app.json`, `ios/`, `android/`; native configuration; iOS/Android build surfaces  
TYPE OF DEFECT / BUG: config drift; release-process issue  
EXPECTED BEHAVIOR: A maintainer can tell which source controls every native field.  
OBSERVED BEHAVIOR: Expo Doctor passes 17/18 and warns that app-config fields are not synchronized when native folders are committed.  
ROOT CAUSE: The project keeps native folders while retaining prebuild-style fields in `app.json`.  
USER / RELEASE IMPACT: Current parity gates found no mismatch, but a future app-config-only edit may not reach the binary.  
REPRODUCTION / EVIDENCE: `npx expo-doctor`; native-config parity gate passed 14 checks.  
SUGGESTED FIX: Declare native folders authoritative in release documentation and expand generated/native parity assertions for every retained field.  
ESTIMATED REPAIR SCOPE: build docs, config scripts, native parity tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: after physical build

### AUD-P4-003
ID: AUD-P4-003  
SEVERITY: P4  
TITLE: Canonical backend branch is not remotely resolvable  
LOCATION: `config/backend-authority.json:3-6,33`; backend authority verifier; Backend  
TYPE OF DEFECT / BUG: release-process/configuration issue  
EXPECTED BEHAVIOR: Canonical deployment authority resolves from a fresh clone.  
OBSERVED BEHAVIOR: The manifest records `rebuild/staging-v2-backend` as local-only in some checkouts.  
ROOT CAUSE: Backend convergence history was not published as a stable remote ref.  
USER / RELEASE IMPACT: No live defect; future deployers could select stale mobile-tree copies.  
REPRODUCTION / EVIDENCE: Source manifest note and backend-authority gate warning.  
SUGGESTED FIX: Publish the canonical branch or repoint the manifest to an immutable remote ref after owner review.  
ESTIMATED REPAIR SCOPE: Git/backend release authority and one manifest.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P4-004
ID: AUD-P4-004  
SEVERITY: P4  
TITLE: Production leaked-password protection disabled  
LOCATION: Supabase production Auth settings; Backend; sign-up/password-change surfaces  
TYPE OF DEFECT / BUG: privacy/security hardening opportunity  
EXPECTED BEHAVIOR: Known-breached passwords are rejected when the provider supports it.  
OBSERVED BEHAVIOR: Production security advisor reports leaked-password protection disabled.  
ROOT CAUSE: Auth project setting has not been enabled.  
USER / RELEASE IMPACT: Users may choose credentials present in breach corpora.  
REPRODUCTION / EVIDENCE: Read-only Supabase production security-advisor inspection.  
SUGGESTED FIX: Enable in a reviewed Auth change, verify error copy and recovery, then document promotion.  
ESTIMATED REPAIR SCOPE: Supabase Auth setting and auth UX verification.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P4-005
ID: AUD-P4-005  
SEVERITY: P4  
TITLE: Staging leaked-password protection disabled  
LOCATION: Supabase staging Auth settings; Backend; sign-up/password-change surfaces  
TYPE OF DEFECT / BUG: privacy/security hardening opportunity  
EXPECTED BEHAVIOR: Staging exercises the intended breached-password policy before production.  
OBSERVED BEHAVIOR: Staging security advisor reports leaked-password protection disabled.  
ROOT CAUSE: Auth project setting has not been enabled.  
USER / RELEASE IMPACT: Staging cannot validate the hardened password UX.  
REPRODUCTION / EVIDENCE: Read-only Supabase staging security-advisor inspection.  
SUGGESTED FIX: Enable in staging first, validate flows, then promote separately.  
ESTIMATED REPAIR SCOPE: Supabase Auth setting and auth tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P4-006
ID: AUD-P4-006  
SEVERITY: P4  
TITLE: Entitlement trigger function keeps client EXECUTE grants  
LOCATION: `supabase/migrations/20260829120000_kplus_entitlements.sql:77-90`; `set_user_entitlements_updated_at`; Backend/staging  
TYPE OF DEFECT / BUG: privilege-hardening defect  
EXPECTED BEHAVIOR: Trigger-only functions are not executable by anon or authenticated roles.  
OBSERVED BEHAVIOR: The migration revokes PUBLIC only; staging advisor shows direct anon/authenticated grants inherited from default privileges.  
ROOT CAUSE: Project default privileges grant function EXECUTE directly; PUBLIC revoke does not remove direct grants.  
USER / RELEASE IMPACT: PostgREST does not expose RETURNS trigger here, so no working exploit was proven; privilege posture is broader than intended.  
REPRODUCTION / EVIDENCE: Read-only advisor plus source comparison with `20260808115735_enforce_rpc_privilege_boundary.sql:17-18`.  
SUGGESTED FIX: Add a forward migration explicitly revoking anon and authenticated from this signature.  
ESTIMATED REPAIR SCOPE: One migration, advisor recheck, privilege tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P4-007
ID: AUD-P4-007  
SEVERITY: P4  
TITLE: Style-profile trigger function keeps client EXECUTE grants  
LOCATION: `supabase/migrations/20260830060000_user_style_profiles.sql:85-98`; `set_user_style_profiles_updated_at`; Backend/staging  
TYPE OF DEFECT / BUG: privilege-hardening defect  
EXPECTED BEHAVIOR: Trigger-only functions are not executable by client roles.  
OBSERVED BEHAVIOR: PUBLIC is revoked but direct anon/authenticated EXECUTE grants remain on staging.  
ROOT CAUSE: Default privileges create direct grants that the migration did not individually revoke.  
USER / RELEASE IMPACT: No direct exploit was reproduced; least-privilege posture is incomplete.  
REPRODUCTION / EVIDENCE: Read-only staging advisor and migration source.  
SUGGESTED FIX: Forward migration revoking anon and authenticated explicitly; assert effective privileges.  
ESTIMATED REPAIR SCOPE: One migration and security tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P4-008
ID: AUD-P4-008  
SEVERITY: P4  
TITLE: Scanner smoke tool defaults to production  
LOCATION: `scripts/smoke-scan-identify.js:24,53`; scanner smoke CLI; Backend  
TYPE OF DEFECT / BUG: tooling hazard  
EXPECTED BEHAVIOR: Omitted configuration cannot send audit traffic to production.  
OBSERVED BEHAVIOR: Missing `EXPO_PUBLIC_SUPABASE_URL` selects the production project URL.  
ROOT CAUSE: Production is hardcoded as `DEFAULT_URL`.  
USER / RELEASE IMPACT: An operator can unintentionally create production traffic or records.  
REPRODUCTION / EVIDENCE: Static source inspection.  
SUGGESTED FIX: Default to staging and require an explicit production acknowledgement flag.  
ESTIMATED REPAIR SCOPE: One script and CLI tests/docs.  
PLATFORM PARITY IMPACT: NONE  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P4-009
ID: AUD-P4-009  
SEVERITY: P4  
TITLE: PostHog has no dedicated analytics-consent authority  
LOCATION: `services/analytics/posthogClient.core.ts:31-42,86-89`; shared analytics initialization  
TYPE OF DEFECT / BUG: privacy-governance opportunity  
EXPECTED BEHAVIOR: The first-party analytics posture has explicit legal authority or a dedicated user preference.  
OBSERVED BEHAVIOR: Once configured, `defaultOptIn` is true and no analytics/telemetry consent field exists.  
ROOT CAUSE: V1 intentionally avoided reinterpreting the separate sale opt-out preference.  
USER / RELEASE IMPACT: Bounded allowlisted telemetry is captured without an in-app analytics opt-in/out control.  
REPRODUCTION / EVIDENCE: Wrapper comments, schema/source search, PostHog governance tests.  
SUGGESTED FIX: Obtain explicit legal sign-off or add a dedicated consent authority wired only at the SDK boundary.  
ESTIMATED REPAIR SCOPE: privacy UX/schema, wrapper, policy copy, tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: before build

### AUD-P4-010
ID: AUD-P4-010  
SEVERITY: P4  
TITLE: Visually uncertain fibers can harden commerce queries  
LOCATION: `supabase/functions/scan-identify/commerceRelevanceColorMaterial.ts:90-94,246-284`; material resolver; Backend  
TYPE OF DEFECT / BUG: commerce relevance defect  
EXPECTED BEHAVIOR: Unverifiable material guesses remain soft evidence.  
OBSERVED BEHAVIOR: Silk, linen, cashmere and similar terms are in the supported vocabulary and can become hard query terms.  
ROOT CAUSE: Vocabulary certainty is based on token support rather than visual verifiability.  
USER / RELEASE IMPACT: Search results may be over-constrained by a guessed fiber.  
REPRODUCTION / EVIDENCE: Source inspection and prior live ablation evidence in the scanner deep audit.  
SUGGESTED FIX: Move rarely verifiable fibers to `likely` and compare relevance on a governed corpus.  
ESTIMATED REPAIR SCOPE: resolver vocabulary, query tests, measurement corpus.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: post-release

### AUD-P4-011
ID: AUD-P4-011  
SEVERITY: P4  
TITLE: Missing currency can be rendered as USD  
LOCATION: `supabase/functions/scan-identify/shoppingProvider.ts:351-376`; `components/scan-results/types.ts:135-140`; Shared/Backend product cards  
TYPE OF DEFECT / BUG: price-truth/UI defect  
EXPECTED BEHAVIOR: Currency is preserved when known and never inferred when absent.  
OBSERVED BEHAVIOR: Serper mapping omits currency; numeric client fallback uses `USD`.  
ROOT CAUSE: Provider shape and client formatter have different currency assumptions.  
USER / RELEASE IMPACT: A non-US offer could display the wrong currency symbol.  
REPRODUCTION / EVIDENCE: Static source inspection and scanner audit evidence.  
SUGGESTED FIX: Carry normalized provider currency and render neutral/unavailable when absent.  
ESTIMATED REPAIR SCOPE: provider contract, client types/cards, fixtures.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: before build

### AUD-P4-012
ID: AUD-P4-012  
SEVERITY: P4  
TITLE: Fast-commerce deadline is marginal  
LOCATION: `supabase/functions/scan-identify/commerceFunnelConfig.ts:41-45`; commerce discovery; Backend  
TYPE OF DEFECT / BUG: performance/relevance issue  
EXPECTED BEHAVIOR: Deadline balances user latency with stable provider completion.  
OBSERVED BEHAVIOR: 1,900 ms cut off 4 of 13 measured requests landing near the boundary.  
ROOT CAUSE: Fixed deadline is below observed tail latency.  
USER / RELEASE IMPACT: Product shelves can be empty despite a near-complete provider response.  
REPRODUCTION / EVIDENCE: Prior live timing table in `BUILD34_SCANNER_SCAN_RESULTS_DEEP_AUDIT.md:170-178`.  
SUGGESTED FIX: Measure p95 and A/B a bounded ~2,400 ms budget.  
ESTIMATED REPAIR SCOPE: one config constant plus latency/relevance measurement.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: post-release

### AUD-P4-013
ID: AUD-P4-013  
SEVERITY: P4  
TITLE: Multi-item commerce attach key is content-insensitive  
LOCATION: `app.js:513-525`; multi-item result persistence effect; Shared scanner route  
TYPE OF DEFECT / BUG: stale-state/persistence defect  
EXPECTED BEHAVIOR: Changed commerce content produces a distinct persisted attachment.  
OBSERVED BEHAVIOR: Dedupe key uses only saved ID, array length, and status.  
ROOT CAUSE: Multi-item path did not adopt the single-item content fingerprint.  
USER / RELEASE IMPACT: Same-length refreshed results can be skipped and leave stale saved commerce.  
REPRODUCTION / EVIDENCE: Static effect inspection.  
SUGGESTED FIX: Fingerprint bounded canonical content and add same-length-change regression coverage.  
ESTIMATED REPAIR SCOPE: `app.js`, persistence helper/test.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: after physical build

### AUD-P4-014
ID: AUD-P4-014  
SEVERITY: P4  
TITLE: Multi-item identification omits high-value appearance attributes  
LOCATION: `supabase/functions/scan-identify/index.ts:667-714`; multi-item prompt/schema; Backend  
TYPE OF DEFECT / BUG: commerce relevance gap  
EXPECTED BEHAVIOR: First-pass metadata carries measured attributes needed for useful retrieval without violating latency.  
OBSERVED BEHAVIOR: Candidates contain category, subtype and color but no pattern, silhouette, fit, or material.  
ROOT CAUSE: Compact schema intentionally prioritizes detection latency.  
USER / RELEASE IMPACT: Multi-item shelves can be less specific than single-item shelves.  
REPRODUCTION / EVIDENCE: Prompt/schema inspection and prior 0/13 attribute evidence.  
SUGGESTED FIX: A/B pattern and silhouette first against the scanner latency/accuracy corpus.  
ESTIMATED REPAIR SCOPE: Edge prompt/schema, parsing, commerce tests, benchmark.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: post-release

### AUD-P4-015
ID: AUD-P4-015  
SEVERITY: P4  
TITLE: Shared taxonomy leaves garment nouns unmapped  
LOCATION: `supabase/functions/_shared/scanHelpers.ts:135+`; `scanCommerceRouter.ts:511-550`; Backend  
TYPE OF DEFECT / BUG: taxonomy/configuration issue  
EXPECTED BEHAVIOR: Common garment nouns normalize consistently across Scanner, TextScan, Elise, Closet and commerce.  
OBSERVED BEHAVIOR: The source documents an unmapped set including skirt, romper, jumpsuit and others; prior probe found 29/69.  
ROOT CAUSE: Canonical taxonomy has not expanded with product vocabulary.  
USER / RELEASE IMPACT: Misclassification or weaker cross-feature retrieval can occur.  
REPRODUCTION / EVIDENCE: Static unmapped set and prior live denim-skirt misclassification.  
SUGGESTED FIX: Extend the single shared normalizer with cross-feature fixtures and measured rollout.  
ESTIMATED REPAIR SCOPE: shared helper, all dependent edge tests, accuracy corpus.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: post-release

### AUD-P4-016
ID: AUD-P4-016  
SEVERITY: P4  
TITLE: Commerce destination can remain an aggregator  
LOCATION: `supabase/functions/scan-identify/shoppingProvider.ts:429-452`; destination selector; Backend  
TYPE OF DEFECT / BUG: UX/commerce limitation  
EXPECTED BEHAVIOR: Prefer a merchant product page and label fallbacks honestly.  
OBSERVED BEHAVIOR: Selector correctly prefers merchants but retains an aggregator if it is the only URL; prior sample was 28/33 aggregator.  
ROOT CAUSE: Current provider plan often does not return merchant offer links.  
USER / RELEASE IMPACT: “View Options” may open a search intermediary instead of a retailer.  
REPRODUCTION / EVIDENCE: Source selector and prior live provider sample.  
SUGGESTED FIX: Adopt/provider-plan merchant links while retaining retailer-neutral fallback copy.  
ESTIMATED REPAIR SCOPE: provider configuration/adapter and live commerce validation.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: post-release

### AUD-P4-017
ID: AUD-P4-017  
SEVERITY: P4  
TITLE: Closet delete result conflates absence and failure  
LOCATION: `services/closetLibrary.js:1178-1197`; `deleteClosetItem`; Shared Library  
TYPE OF DEFECT / BUG: error-handling defect  
EXPECTED BEHAVIOR: Callers distinguish idempotent not-found from a failed write.  
OBSERVED BEHAVIOR: Both paths return `false`.  
ROOT CAUSE: Boolean legacy API lacks a typed outcome.  
USER / RELEASE IMPACT: A future retry/UI flow could treat a persistence failure as successful absence.  
REPRODUCTION / EVIDENCE: Static function inspection; current B2B revert path safely treats both alike.  
SUGGESTED FIX: Return a typed result and update callers/tests atomically.  
ESTIMATED REPAIR SCOPE: Closet library, hook/callers, tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: backlog

### AUD-P4-018
ID: AUD-P4-018  
SEVERITY: P4  
TITLE: Staging omits production free-tier flags  
LOCATION: `eas.json:126-198,201-237`; `__tests__/staging/easProfileParity.test.js:58-80`; Both  
TYPE OF DEFECT / BUG: config drift  
EXPECTED BEHAVIOR: Staging exercises every production client feature flag or has an explicit exception.  
OBSERVED BEHAVIOR: Staging lacks utility, wishlist-intent, and outfit-generator flags present in production.  
ROOT CAUSE: Profiles evolved independently.  
USER / RELEASE IMPACT: Staging does not cover three released free-tier surfaces.  
REPRODUCTION / EVIDENCE: Focused test fails with the exact three-key set; counted as known failure.  
SUGGESTED FIX: Mirror the keys or encode an owner-approved environment exception.  
ESTIMATED REPAIR SCOPE: `eas.json`, parity test, staging smoke.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: before build

### AUD-P4-019
ID: AUD-P4-019  
SEVERITY: P4  
TITLE: Today with Elise differs between staging and production  
LOCATION: `eas.json:154,233`; `__tests__/staging/easProfileParity.test.js:84-100`; Both/Home  
TYPE OF DEFECT / BUG: platform/environment parity defect  
EXPECTED BEHAVIOR: Shared flags match unless the difference is explicitly governed.  
OBSERVED BEHAVIOR: Today with Elise is true in staging and false in production, with no allowlisted reason.  
ROOT CAUSE: Product rollout decision is not represented in parity authority.  
USER / RELEASE IMPACT: The promoted production Home can differ from the certified staging Home.  
REPRODUCTION / EVIDENCE: Focused parity test failure; counted as known.  
SUGGESTED FIX: Align the value or record the exact rollout exception in the test/config authority.  
ESTIMATED REPAIR SCOPE: `eas.json`, release decision, Home staging/production smoke.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: before build

### AUD-P4-020
ID: AUD-P4-020  
SEVERITY: P4  
TITLE: Cross-path parity manifest has two stale hashes  
LOCATION: `config/cross-path-parity-manifest.json:12,24`; `scan-identify/index.ts`, `stylechat-generate/index.ts`; Backend  
TYPE OF DEFECT / BUG: config drift  
EXPECTED BEHAVIOR: The generated manifest exactly fingerprints governed source.  
OBSERVED BEHAVIOR: `node scripts/generate-cross-path-parity-manifest.js --check` reports both index entries stale.  
ROOT CAUSE: Backend source changed after the manifest was last generated.  
USER / RELEASE IMPACT: The guard produces known noise and cannot serve as clean release evidence.  
REPRODUCTION / EVIDENCE: Generator check and full-suite known failures.  
SUGGESTED FIX: Regenerate only after selecting the canonical backend authority, then verify cross-branch parity.  
ESTIMATED REPAIR SCOPE: one generated manifest plus backend authority review.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P4-021
ID: AUD-P4-021  
SEVERITY: P4  
TITLE: Recent Scan terminal local purge is unwired  
LOCATION: `services/library.js:958-970`; `purgeLocalScansForOwner`; Shared account deletion  
TYPE OF DEFECT / BUG: privacy/account-deletion gap  
EXPECTED BEHAVIOR: Owner-scoped local scans are removed after confirmed permanent server purge.  
OBSERVED BEHAVIOR: The primitive is test-only/unwired; deletion submission intentionally does not purge during the restoration window.  
ROOT CAUSE: No client completion worker consumes terminal purge confirmation.  
USER / RELEASE IMPACT: Permanently deleted-account media can remain on that device.  
REPRODUCTION / EVIDENCE: Call-site search; `accountDeletionV69Contract` asserts no submission-time purge.  
SUGGESTED FIX: Add idempotent owner-scoped terminal-purge completion orchestration, never at submission.  
ESTIMATED REPAIR SCOPE: deletion lifecycle, local library, background/foreground reconciliation, tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: after physical build

### AUD-P4-022
ID: AUD-P4-022  
SEVERITY: P4  
TITLE: Local Closet terminal purge is unwired  
LOCATION: `services/closetLibrary.js:1516-1535`; `purgeLocalClosetForOwner`; Shared account deletion  
TYPE OF DEFECT / BUG: privacy/account-deletion gap  
EXPECTED BEHAVIOR: Confirmed permanent account purge removes that owner's local Closet manifest/media.  
OBSERVED BEHAVIOR: The owner-scoped primitive exists but has no production caller.  
ROOT CAUSE: Terminal server-purge client reconciliation is not implemented.  
USER / RELEASE IMPACT: Deleted-account Closet content can persist locally.  
REPRODUCTION / EVIDENCE: Source comments and repository-wide call-site search.  
SUGGESTED FIX: Invoke after durable terminal confirmation with cross-owner and crash-retry tests.  
ESTIMATED REPAIR SCOPE: deletion lifecycle, Closet store/media, tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: after physical build

### AUD-P4-023
ID: AUD-P4-023  
SEVERITY: P4  
TITLE: Closet candidate terminal purge is unwired  
LOCATION: `services/closetCandidateLibrary.js:1616-1635`; `purgeLocalClosetCandidatesForOwner`; Shared account deletion  
TYPE OF DEFECT / BUG: privacy/account-deletion gap  
EXPECTED BEHAVIOR: Confirmed terminal deletion removes staged candidate media/state for that owner.  
OBSERVED BEHAVIOR: Primitive exists and is intentionally unwired.  
ROOT CAUSE: Same absent terminal-purge completion worker.  
USER / RELEASE IMPACT: Candidate images/state can remain after permanent deletion.  
REPRODUCTION / EVIDENCE: Function comment and call-site search (tests only).  
SUGGESTED FIX: Add it to one idempotent terminal completion sequence.  
ESTIMATED REPAIR SCOPE: deletion lifecycle, candidate store/media, tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: after physical build

### AUD-P4-024
ID: AUD-P4-024  
SEVERITY: P4  
TITLE: Closet sync sidecar terminal purge is unwired  
LOCATION: `services/closet/closetSyncStore.ts:299-307`; `purgeClosetSyncStateForOwner`; Shared account deletion  
TYPE OF DEFECT / BUG: privacy/account-deletion gap  
EXPECTED BEHAVIOR: Terminal deletion removes the owner's sync metadata.  
OBSERVED BEHAVIOR: Purge primitive has no production caller.  
ROOT CAUSE: Terminal completion orchestration is absent.  
USER / RELEASE IMPACT: Non-media sync history persists locally after permanent deletion.  
REPRODUCTION / EVIDENCE: Source and call-site search.  
SUGGESTED FIX: Wire to confirmed terminal purge with owner-isolation tests.  
ESTIMATED REPAIR SCOPE: deletion lifecycle and Closet sync store.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: after physical build

### AUD-P4-025
ID: AUD-P4-025  
SEVERITY: P4  
TITLE: Restored Closet media terminal purge is unwired  
LOCATION: `services/closet/closetRestoreMedia.ts:141-151`; `purgeClosetRestoreMediaCacheForOwner`; Shared account deletion  
TYPE OF DEFECT / BUG: privacy/account-deletion gap  
EXPECTED BEHAVIOR: Confirmed terminal deletion removes restored-media cache for that owner.  
OBSERVED BEHAVIOR: Owner-scoped primitive exists but is deliberately unwired.  
ROOT CAUSE: No terminal deletion completion worker.  
USER / RELEASE IMPACT: Restored image cache can persist after permanent deletion.  
REPRODUCTION / EVIDENCE: B2C restore ledger lines 89 and 156 plus call-site search.  
SUGGESTED FIX: Wire into the shared idempotent terminal purge sequence.  
ESTIMATED REPAIR SCOPE: deletion lifecycle, restore cache, tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: after physical build

### AUD-P4-026
ID: AUD-P4-026  
SEVERITY: P4  
TITLE: Local Style DNA data is not tied to terminal deletion  
LOCATION: `services/style-dna/localStyleDnaProfile.ts:154-159`; account deletion; Shared  
TYPE OF DEFECT / BUG: privacy/account-deletion gap  
EXPECTED BEHAVIOR: Terminal account deletion removes local feedback and reason records for that owner.  
OBSERVED BEHAVIOR: `resetLocalStyleDnaProfile` clears them only from explicit Style DNA UI actions; no deletion caller exists.  
ROOT CAUSE: Style DNA predates a terminal-purge client coordinator.  
USER / RELEASE IMPACT: Preference-derived feedback may remain on-device after permanent deletion.  
REPRODUCTION / EVIDENCE: Call-site search finds UI and tests only.  
SUGGESTED FIX: Call the owner-scoped reset from terminal deletion completion, preserving restoration-window behavior.  
ESTIMATED REPAIR SCOPE: deletion lifecycle, Style DNA store/reasons, tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: after physical build

### AUD-P4-027
ID: AUD-P4-027  
SEVERITY: P4  
TITLE: Android predictive back is disabled  
LOCATION: `android/app/src/main/AndroidManifest.xml:41`; application config; Android  
TYPE OF DEFECT / BUG: native-config/UX issue  
EXPECTED BEHAVIOR: Modern Android back navigation participates in predictive-back behavior when safe.  
OBSERVED BEHAVIOR: `android:enableOnBackInvokedCallback="false"`.  
ROOT CAUSE: Compatibility opt-out retained during earlier certification.  
USER / RELEASE IMPACT: Android users do not receive predictive back; no navigation failure was reproduced.  
REPRODUCTION / EVIDENCE: Manifest inspection and emulator navigation smoke.  
SUGGESTED FIX: Enable only after device tests across modal, auth, Scanner, room, and VTO routes.  
ESTIMATED REPAIR SCOPE: manifest plus Android navigation/device suite.  
PLATFORM PARITY IMPACT: Android  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: post-release

### AUD-P4-028
ID: AUD-P4-028  
SEVERITY: P4  
TITLE: Legacy API endpoint fails lazily when unconfigured  
LOCATION: `services/api.js:43-59`; legacy API requests; Shared  
TYPE OF DEFECT / BUG: dependency/configuration issue  
EXPECTED BEHAVIOR: Release-reachable network paths have explicit endpoint authority or are proven dead.  
OBSERVED BEHAVIOR: Missing `EXPO_PUBLIC_API_URL` is tolerated at import and throws only when a legacy call executes.  
ROOT CAUSE: Compatibility path remains while Supabase Edge Functions are canonical.  
USER / RELEASE IMPACT: An unexpected caller could fail at runtime; no current release caller was proven.  
REPRODUCTION / EVIDENCE: Static implementation/reachability search.  
SUGGESTED FIX: Remove after proving dead, or add governed endpoint configuration and route tests.  
ESTIMATED REPAIR SCOPE: legacy callers/service/config/tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: backlog

### AUD-P4-029
ID: AUD-P4-029  
SEVERITY: P4  
TITLE: Out-of-horizon packing trips spend avoidable network work  
LOCATION: `supabase/functions/stylechat-generate/packingWeather.ts:221-268`; packing weather; Backend  
TYPE OF DEFECT / BUG: performance/error-handling defect  
EXPECTED BEHAVIOR: A trip outside the 16-day provider horizon is rejected before geocode/forecast calls.  
OBSERVED BEHAVIOR: Horizon validation occurs after the function enters the weather resolution path.  
ROOT CAUSE: Date eligibility is not the first guard.  
USER / RELEASE IMPACT: Extra latency and provider requests for a result that must be unavailable.  
REPRODUCTION / EVIDENCE: Source control-flow inspection and prior packing audit.  
SUGGESTED FIX: Validate dates/horizon before network dependencies.  
ESTIMATED REPAIR SCOPE: packing weather function and tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: post-release

### AUD-P4-030
ID: AUD-P4-030  
SEVERITY: P4  
TITLE: Packing weather is Fahrenheit-only  
LOCATION: `supabase/functions/stylechat-generate/packingWeather.ts:198-208`; packing context; Backend  
TYPE OF DEFECT / BUG: UX/localization defect  
EXPECTED BEHAVIOR: Temperature units follow a governed user/device preference.  
OBSERVED BEHAVIOR: Provider request hardcodes `temperature_unit=fahrenheit`.  
ROOT CAUSE: V1 contract has no unit preference.  
USER / RELEASE IMPACT: Metric-locale users see unfamiliar values.  
REPRODUCTION / EVIDENCE: Static source inspection and packing audit.  
SUGGESTED FIX: Add a bounded unit enum derived from locale/preference and carry it through presentation.  
ESTIMATED REPAIR SCOPE: client request, Edge contract, prompts/tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: post-release

### AUD-P4-031
ID: AUD-P4-031  
SEVERITY: P4  
TITLE: Past-dated packing trips are accepted  
LOCATION: `supabase/functions/stylechat-generate/packingContract.ts:209-281`; trip validator; Backend  
TYPE OF DEFECT / BUG: validation/UX defect  
EXPECTED BEHAVIOR: Past dates are rejected or deliberately represented as historical.  
OBSERVED BEHAVIOR: Calendar-valid start/end dates can both be in the past; weather later becomes unavailable.  
ROOT CAUSE: Validator checks date shape/order, not relation to current time.  
USER / RELEASE IMPACT: User can submit a plan that cannot receive current forecast context.  
REPRODUCTION / EVIDENCE: Static contract inspection and prior packing test matrix.  
SUGGESTED FIX: Add a clock-injected future-date rule and clear correction copy.  
ESTIMATED REPAIR SCOPE: contract, UI validation, tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: post-release

### AUD-P4-032
ID: AUD-P4-032  
SEVERITY: P4  
TITLE: Packing weather cache has no eviction  
LOCATION: `supabase/functions/stylechat-generate/packingWeather.ts:74-86,245-258`; module cache; Backend  
TYPE OF DEFECT / BUG: performance/maintainability issue  
EXPECTED BEHAVIOR: Expired cache entries are bounded or removed.  
OBSERVED BEHAVIOR: TTL prevents reuse but expired keys remain in the Map.  
ROOT CAUSE: Cache implements expiration-on-read without deletion or size control.  
USER / RELEASE IMPACT: Long-lived instances can accumulate small stale entries; quotas currently bound practical growth.  
REPRODUCTION / EVIDENCE: Static cache inspection and packing audit.  
SUGGESTED FIX: Delete expired entries and add an LRU/maximum key count.  
ESTIMATED REPAIR SCOPE: one backend module and cache tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

### AUD-P4-033
ID: AUD-P4-033  
SEVERITY: P4  
TITLE: Closet sync sidecar does not compact terminal entries  
LOCATION: `services/closet/closetSyncStore.ts`; sync persistence; Shared; Library  
TYPE OF DEFECT / BUG: performance/maintainability issue  
EXPECTED BEHAVIOR: Durable sync metadata remains bounded after items reach terminal states.  
OBSERVED BEHAVIOR: A long-lived account retains one small entry per synced item.  
ROOT CAUSE: Initial design prioritized reconciliation evidence over compaction.  
USER / RELEASE IMPACT: Storage/read cost grows with lifetime Closet churn; current Closet scale bounds impact.  
REPRODUCTION / EVIDENCE: B2B ledger lines 129-130 and store inspection.  
SUGGESTED FIX: Add a versioned compaction policy for terminal, sufficiently old entries.  
ESTIMATED REPAIR SCOPE: sync store/schema, migration-on-read, tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: backlog

## Detailed P5 findings

### AUD-P5-001
ID: AUD-P5-001  
SEVERITY: P5  
TITLE: App Store reviewer metadata is incomplete  
LOCATION: `eas.json:239-244`, `store.config.json`; iOS submission metadata  
TYPE OF DEFECT / BUG: release-process/documentation gap  
EXPECTED BEHAVIOR: App Store ID, reviewer contact, and safe review-access details are complete before submission.  
OBSERVED BEHAVIOR: Local Apple readiness warns that these fields are not encoded.  
ROOT CAUSE: Submission metadata has not been finalized.  
USER / RELEASE IMPACT: Manual App Store submission preparation is required; no runtime impact.  
REPRODUCTION / EVIDENCE: Apple readiness and metadata lint checks.  
SUGGESTED FIX: Complete metadata through the approved submission system without committing credentials.  
ESTIMATED REPAIR SCOPE: App Store Connect/EAS submission metadata.  
PLATFORM PARITY IMPACT: iOS  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P5-002
ID: AUD-P5-002  
SEVERITY: P5  
TITLE: No deployed TestSprite coverage for audit repairs  
LOCATION: TestSprite project linkage and deployed candidate; Shared  
TYPE OF DEFECT / BUG: test-coverage gap  
EXPECTED BEHAVIOR: Changed client flows can be validated against the exact reachable candidate.  
OBSERVED BEHAVIOR: CLI/auth are available, but no repository-linked project exists and the repairs are undeployed.  
ROOT CAUSE: TestSprite requires a public deployed target; this audit intentionally did not deploy.  
USER / RELEASE IMPACT: No additional hosted E2E evidence for the repair branch.  
REPRODUCTION / EVIDENCE: TestSprite preflight and project discovery.  
SUGGESTED FIX: Link the project, deploy an approved preview, then run the broad configured suite against that SHA.  
ESTIMATED REPAIR SCOPE: TestSprite project setup and preview deployment.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: UNKNOWN  
RECOMMENDED TIMING: after physical build

### AUD-P5-003
ID: AUD-P5-003  
SEVERITY: P5  
TITLE: Image privacy sanitizer is passthrough  
LOCATION: `services/privacyImageSanitizer.js:5-38`, `services/savedScanMedia.ts:144-161`; iOS/Android media flows  
TYPE OF DEFECT / BUG: privacy hardening opportunity  
EXPECTED BEHAVIOR: Product claims and processor controls accurately reflect any image redaction behavior.  
OBSERVED BEHAVIOR: Sanitizer passes media through; no local face or plate masking occurs.  
ROOT CAUSE: Redaction is not a current product capability; hosted policy does not claim it is.  
USER / RELEASE IMPACT: User images can contain people/plates when deliberately sent through governed cloud media flows.  
REPRODUCTION / EVIDENCE: Source inspection; hosted privacy policy reviewed.  
SUGGESTED FIX: Make an explicit product/legal decision, then add validated native redaction only if approved.  
ESTIMATED REPAIR SCOPE: native image pipeline, quality testing, policy copy.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: post-release

### AUD-P5-004
ID: AUD-P5-004  
SEVERITY: P5  
TITLE: Onboarding password visibility controls lack accessibility semantics  
LOCATION: `app/onboarding/index.tsx:476-510`; account form; Shared  
TYPE OF DEFECT / BUG: accessibility defect  
EXPECTED BEHAVIOR: Show/Hide controls expose button role, descriptive label, and visibility state.  
OBSERVED BEHAVIOR: Clickable ViewGroups display text but have no explicit role/label/state.  
ROOT CAUSE: Custom touch wrapper did not receive accessibility props.  
USER / RELEASE IMPACT: Screen-reader users cannot reliably identify the purpose or current state.  
REPRODUCTION / EVIDENCE: Android UI hierarchy captured during onboarding; source inspection.  
SUGGESTED FIX: Use accessible buttons with `accessibilityLabel` and state.  
ESTIMATED REPAIR SCOPE: onboarding form and accessibility tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: before build

### AUD-P5-005
ID: AUD-P5-005  
SEVERITY: P5  
TITLE: Production minor-privacy trigger remains anon executable  
LOCATION: `supabase/migrations/202605130002_privacy_settings_schema_parity.sql:48-74`, `20260808115735_enforce_rpc_privilege_boundary.sql:140`; production Backend  
TYPE OF DEFECT / BUG: privilege-hardening defect  
EXPECTED BEHAVIOR: Trigger-only SECURITY DEFINER functions are not executable by client roles.  
OBSERVED BEHAVIOR: Production advisor reports anon EXECUTE for `enforce_minor_privacy_defaults`; direct invocation structurally errors.  
ROOT CAUSE: The reviewed revoke migration exists in source but is absent from production migration history.  
USER / RELEASE IMPACT: No successful direct call was reproduced, but privilege posture is broader than intended.  
REPRODUCTION / EVIDENCE: Read-only production advisor and direct-call behavior inspection.  
SUGGESTED FIX: Promote the existing explicit revoke through approved backend migration governance.  
ESTIMATED REPAIR SCOPE: one migration deployment and advisor recheck.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P5-006
ID: AUD-P5-006  
SEVERITY: P5  
TITLE: AI output context CHECK admits NULL  
LOCATION: `supabase/migrations/20260815233457_content_reports_ai_output.sql:61-114`; `content_reports`; Backend  
TYPE OF DEFECT / BUG: data-integrity defect  
EXPECTED BEHAVIOR: `target_type='ai_output'` requires a valid non-null bounded context object.  
OBSERVED BEHAVIOR: SQL CHECK evaluates NULL as unknown/pass; client blocks it but direct database writes can bypass client validation.  
ROOT CAUSE: PostgreSQL three-valued CHECK semantics.  
USER / RELEASE IMPACT: Incomplete AI report rows can be persisted by a privileged/non-client writer.  
REPRODUCTION / EVIDENCE: Migration predicate inspection and prior production reproduction.  
SUGGESTED FIX: Add explicit `ai_output_context IS NOT NULL` requirement in a forward migration.  
ESTIMATED REPAIR SCOPE: migration, report contract tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P5-007
ID: AUD-P5-007  
SEVERITY: P5  
TITLE: Internal preview and development use production backend  
LOCATION: `eas.json:7-115`; preview/development build profiles; Both  
TYPE OF DEFECT / BUG: environment-safety/configuration issue  
EXPECTED BEHAVIOR: Internal builds target staging unless production intent is explicit and governed.  
OBSERVED BEHAVIOR: Both profiles embed production Supabase configuration and broad feature flags.  
ROOT CAUSE: Legacy internal profile defaults.  
USER / RELEASE IMPACT: Internal testing may create production data or exercise production services unexpectedly.  
REPRODUCTION / EVIDENCE: EAS profile inspection.  
SUGGESTED FIX: Target staging by default or add a conspicuous owner-controlled production opt-in profile.  
ESTIMATED REPAIR SCOPE: `eas.json`, CI/build docs, internal QA.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: before build

### AUD-P5-008
ID: AUD-P5-008  
SEVERITY: P5  
TITLE: Production `set_profiles_updated_at` has mutable search_path  
LOCATION: `supabase/migrations/202605122359_profiles_base.sql:12`; production function; Backend  
TYPE OF DEFECT / BUG: function-hardening defect  
EXPECTED BEHAVIOR: Function search path is pinned.  
OBSERVED BEHAVIOR: Production advisor reports mutable search path.  
ROOT CAUSE: Hardened `ALTER FUNCTION` source migration has not reached production.  
USER / RELEASE IMPACT: Defense-in-depth gap; no exploit reproduced.  
REPRODUCTION / EVIDENCE: Read-only advisor; `20260808115552_harden_trigger_function_search_path.sql:27-30`.  
SUGGESTED FIX: Promote reviewed hardening migration.  
ESTIMATED REPAIR SCOPE: one migration and advisor validation.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P5-009
ID: AUD-P5-009  
SEVERITY: P5  
TITLE: Production `set_updated_at` has mutable search_path  
LOCATION: `supabase/migrations/202605130001_privacy_settings.sql:35`; production function; Backend  
TYPE OF DEFECT / BUG: function-hardening defect  
EXPECTED BEHAVIOR: Function search path is pinned.  
OBSERVED BEHAVIOR: Production advisor reports mutable search path.  
ROOT CAUSE: Existing hardening migration has not reached production.  
USER / RELEASE IMPACT: Defense-in-depth gap; no exploit reproduced.  
REPRODUCTION / EVIDENCE: Read-only advisor; hardening migration lines 27-30.  
SUGGESTED FIX: Promote reviewed hardening migration.  
ESTIMATED REPAIR SCOPE: one migration and advisor validation.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P5-010
ID: AUD-P5-010  
SEVERITY: P5  
TITLE: Production `set_style_objects_updated_at` has mutable search_path  
LOCATION: `supabase/migrations/202605200001_persistent_style_objects.sql:105`; production function; Backend  
TYPE OF DEFECT / BUG: function-hardening defect  
EXPECTED BEHAVIOR: Function search path is pinned.  
OBSERVED BEHAVIOR: Production advisor reports mutable search path.  
ROOT CAUSE: Existing hardening migration has not reached production.  
USER / RELEASE IMPACT: Defense-in-depth gap; no exploit reproduced.  
REPRODUCTION / EVIDENCE: Read-only advisor; hardening migration lines 27-30.  
SUGGESTED FIX: Promote reviewed hardening migration.  
ESTIMATED REPAIR SCOPE: one migration and advisor validation.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P5-011
ID: AUD-P5-011  
SEVERITY: P5  
TITLE: Production dressing-room note trigger has mutable search_path  
LOCATION: `supabase/migrations/202606030001_add_room_note_to_dressing_rooms.sql:4`; production function; Backend  
TYPE OF DEFECT / BUG: function-hardening defect  
EXPECTED BEHAVIOR: Function search path is pinned.  
OBSERVED BEHAVIOR: Production advisor reports mutable search path.  
ROOT CAUSE: Existing hardening migration has not reached production.  
USER / RELEASE IMPACT: Defense-in-depth gap; no exploit reproduced.  
REPRODUCTION / EVIDENCE: Read-only advisor; hardening migration lines 27-30.  
SUGGESTED FIX: Promote reviewed hardening migration.  
ESTIMATED REPAIR SCOPE: one migration and advisor validation.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P5-012
ID: AUD-P5-012  
SEVERITY: P5  
TITLE: Multi-item commerce test self-seeds its critical condition  
LOCATION: `__tests__/multiItemCommerceCriticalPath.test.js:163-174`; scanner commerce test; Shared  
TYPE OF DEFECT / BUG: stale-test/test-coverage gap  
EXPECTED BEHAVIOR: Test proves the real mapper/backend emits `commerceDeferred`.  
OBSERVED BEHAVIOR: Fixture literal supplies `commerceDeferred: true`, so the test cannot detect lost emission.  
ROOT CAUSE: Test was designed around downstream latency behavior only.  
USER / RELEASE IMPACT: A mapper regression can evade this test.  
REPRODUCTION / EVIDENCE: Fixture source inspection.  
SUGGESTED FIX: Retain latency test but add an integration assertion from real result mapping to consumer.  
ESTIMATED REPAIR SCOPE: scanner mapper/integration fixture and test.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

## Detailed P6 findings

### AUD-P6-001
ID: AUD-P6-001  
SEVERITY: P6  
TITLE: App Review template describes retired VoiceScan state  
LOCATION: `docs/app-review-information-template.md:27,50`; iOS reviewer documentation  
TYPE OF DEFECT / BUG: documentation drift  
EXPECTED BEHAVIOR: Reviewer instructions describe the exact promoted build.  
OBSERVED BEHAVIOR: Template says VoiceScan is coming soon and push is absent.  
ROOT CAUSE: Documentation predates merged VoiceScan/notification work.  
USER / RELEASE IMPACT: Reviewer guidance can be inaccurate.  
REPRODUCTION / EVIDENCE: Source document inspection.  
SUGGESTED FIX: Update only when final promoted artifacts and permission behavior are frozen.  
ESTIMATED REPAIR SCOPE: reviewer template.  
PLATFORM PARITY IMPACT: iOS  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P6-002
ID: AUD-P6-002  
SEVERITY: P6  
TITLE: Play readiness notes describe retired VoiceScan state  
LOCATION: `docs/play-store-readiness-notes.md:21,66-70,131-133`; Android store documentation  
TYPE OF DEFECT / BUG: documentation drift  
EXPECTED BEHAVIOR: Play declarations reflect the exact AAB capability/permission state.  
OBSERVED BEHAVIOR: Notes describe inactive VoiceScan and no microphone processing.  
ROOT CAUSE: Documentation predates certification-profile VoiceScan capability.  
USER / RELEASE IMPACT: Data Safety/reviewer preparation can be inaccurate.  
REPRODUCTION / EVIDENCE: Source document inspection.  
SUGGESTED FIX: Refresh from final merged-manifest and device evidence.  
ESTIMATED REPAIR SCOPE: Play readiness notes and artifact verification.  
PLATFORM PARITY IMPACT: Android  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P6-003
ID: AUD-P6-003  
SEVERITY: P6  
TITLE: Store metadata understates current product surfaces  
LOCATION: `store.config.json:33-45`; iOS listing/release notes  
TYPE OF DEFECT / BUG: documentation drift  
EXPECTED BEHAVIOR: Description and release notes match approved release scope.  
OBSERVED BEHAVIOR: They describe initial core scan-only experience and omit later major surfaces.  
ROOT CAUSE: Listing text was not updated with product evolution.  
USER / RELEASE IMPACT: Store listing may under-describe the app.  
REPRODUCTION / EVIDENCE: Metadata inspection.  
SUGGESTED FIX: Rewrite after owner freezes final promotion scope.  
ESTIMATED REPAIR SCOPE: `store.config.json` and submission review.  
PLATFORM PARITY IMPACT: iOS  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: before build

### AUD-P6-004
ID: AUD-P6-004  
SEVERITY: P6  
TITLE: Closet cloud-media dimension test retains older assumption  
LOCATION: `__tests__/closetCloudMediaContract.test.js:269-275`; shared Closet media test  
TYPE OF DEFECT / BUG: stale test  
EXPECTED BEHAVIOR: Tests distinguish current cloud thumbnail dimensions from local full-media assumptions.  
OBSERVED BEHAVIOR: Assertion documents inherited dimensions rather than the current cloud contract.  
ROOT CAUSE: Contract evolved without test wording/fixture refresh.  
USER / RELEASE IMPACT: No demonstrated runtime defect; diagnostic clarity is reduced.  
REPRODUCTION / EVIDENCE: Test and current thumbnail implementation inspection.  
SUGGESTED FIX: Split local-media and cloud-thumbnail assertions.  
ESTIMATED REPAIR SCOPE: one test fixture/assertion.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

### AUD-P6-005
ID: AUD-P6-005  
SEVERITY: P6  
TITLE: Internal-schema guard can false-positive on prose  
LOCATION: `__tests__/dressingRoomBlockingUi.test.js:528-543`; Backend migration guard  
TYPE OF DEFECT / BUG: stale test  
EXPECTED BEHAVIOR: SQL guard analyzes executable SQL, not comments or unrelated prose.  
OBSERVED BEHAVIOR: Regex scans whole migration text and can flag explanatory references.  
ROOT CAUSE: Source-text heuristic lacks SQL/comment parsing.  
USER / RELEASE IMPACT: Future valid migrations can be blocked by guard noise.  
REPRODUCTION / EVIDENCE: Guard implementation and known full-suite failure.  
SUGGESTED FIX: Strip comments or parse statements before detecting schema use.  
ESTIMATED REPAIR SCOPE: one test guard and fixtures.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

### AUD-P6-006
ID: AUD-P6-006  
SEVERITY: P6  
TITLE: RPC-hardening test misses catalog-loop revokes  
LOCATION: `__tests__/security/rpcHardeningMigration.test.js:62-65`; Backend security test  
TYPE OF DEFECT / BUG: stale test  
EXPECTED BEHAVIOR: Test verifies effective revocation policy regardless of SQL implementation style.  
OBSERVED BEHAVIOR: Regex expects literal `revoke` statements and fails on the reviewed catalog-loop migration.  
ROOT CAUSE: Test is coupled to implementation syntax.  
USER / RELEASE IMPACT: False failure obscures valid hardening evidence.  
REPRODUCTION / EVIDENCE: Known full-suite failure and migration source.  
SUGGESTED FIX: Assert explicit catalog target list/effective privilege semantics.  
ESTIMATED REPAIR SCOPE: security test and fixtures.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

### AUD-P6-007
ID: AUD-P6-007  
SEVERITY: P6  
TITLE: Model-routing parity test assumes obsolete config layout  
LOCATION: `__tests__/llmModelRoutingParity.test.js:325-328`; `supabase/config.toml`; Backend  
TYPE OF DEFECT / BUG: stale test/configuration drift  
EXPECTED BEHAVIOR: JWT/model assertions derive from canonical backend authority.  
OBSERVED BEHAVIOR: Test expects static function blocks inconsistent with current governed config.  
ROOT CAUSE: Backend topology evolved independently from the static test.  
USER / RELEASE IMPACT: Known test failure reduces signal; no routing regression proved.  
REPRODUCTION / EVIDENCE: Full-suite known failure.  
SUGGESTED FIX: Generate assertion inputs from authority/manifest.  
ESTIMATED REPAIR SCOPE: routing parity test and authority data.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

### AUD-P6-008
ID: AUD-P6-008  
SEVERITY: P6  
TITLE: Scan quota contract tests expect retired fail-open semantics  
LOCATION: `__tests__/scanIdentifyEdgeContract.test.js:641-689`; scan-identify quota tests; Backend  
TYPE OF DEFECT / BUG: stale test  
EXPECTED BEHAVIOR: Tests assert approved fail-closed quota behavior and safe logs.  
OBSERVED BEHAVIOR: Tests require quota DB/key errors to proceed to Gemini and expect old log markers.  
ROOT CAUSE: Security behavior changed to fail closed without updating legacy contract assertions.  
USER / RELEASE IMPACT: Known failures misrepresent the safer current backend behavior.  
REPRODUCTION / EVIDENCE: Full-suite known failures; source inspection.  
SUGGESTED FIX: Update tests to the approved fail-closed outcomes and privacy-safe logs.  
ESTIMATED REPAIR SCOPE: edge contract tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

### AUD-P6-009
ID: AUD-P6-009  
SEVERITY: P6  
TITLE: StyleChat weather defaults to Fahrenheit  
LOCATION: `supabase/functions/stylechat-generate/index.ts:808-836`; weather context; Backend  
TYPE OF DEFECT / BUG: UX/localization defect  
EXPECTED BEHAVIOR: General StyleChat weather follows a governed unit preference.  
OBSERVED BEHAVIOR: Prompt/presentation uses Fahrenheit by default.  
ROOT CAUSE: No unit preference is carried through this older weather path.  
USER / RELEASE IMPACT: Metric-locale users may receive unfamiliar units.  
REPRODUCTION / EVIDENCE: Source inspection.  
SUGGESTED FIX: Carry locale/preference and preserve provider-native values.  
ESTIMATED REPAIR SCOPE: StyleChat contract/prompt/tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: post-release

### AUD-P6-010
ID: AUD-P6-010  
SEVERITY: P6  
TITLE: Security wrapper mislabels an expected negative control  
LOCATION: `security/scripts/run-security-validation.js:37,42`; Shared security validation  
TYPE OF DEFECT / BUG: test-reporting defect  
EXPECTED BEHAVIOR: Expected localhost rejection is represented as a passed negative control.  
OBSERVED BEHAVIOR: JSON reports one failed check while the script correctly exits 0.  
ROOT CAUSE: Runner records the command failure before excluding it from exit status.  
USER / RELEASE IMPACT: Audit readers can mistake the successful security validation for a failure.  
REPRODUCTION / EVIDENCE: `npm run verify:security` output.  
SUGGESTED FIX: Invert/assert the rejection explicitly and record it as pass.  
ESTIMATED REPAIR SCOPE: one validation script/test.  
PLATFORM PARITY IMPACT: NONE  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

### AUD-P6-011
ID: AUD-P6-011  
SEVERITY: P6  
TITLE: PostHog comment claims a missing Sentry channel  
LOCATION: `services/analytics/posthogClient.core.ts:18-19`, `package.json`; Shared analytics  
TYPE OF DEFECT / BUG: documentation/observability drift  
EXPECTED BEHAVIOR: Comments accurately identify installed engineering-observability services.  
OBSERVED BEHAVIOR: Wrapper says Sentry remains, but source/package search finds no Sentry integration.  
ROOT CAUSE: Documentation carried over from an intended architecture.  
USER / RELEASE IMPACT: Incident-observability expectations may be incorrect.  
REPRODUCTION / EVIDENCE: Repository-wide Sentry search.  
SUGGESTED FIX: Correct the comment or separately approve/install error observability.  
ESTIMATED REPAIR SCOPE: one comment or dedicated observability project.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

## Detailed P7 findings

### AUD-P7-001
ID: AUD-P7-001  
SEVERITY: P7  
TITLE: Windows long checkout breaks local CMake/Ninja debug build  
LOCATION: Android Gradle/CMake generated build under `C:\Users\jsmit\KScan-final-prebuild-hostile-v1`; Android  
TYPE OF DEFECT / BUG: build-tooling issue  
EXPECTED BEHAVIOR: Local debug assembly completes from supported Windows checkout paths.  
OBSERVED BEHAVIOR: CMake reports path-length pressure and Ninja ends with `build.ninja still dirty after 100 tries`.  
ROOT CAUSE: Generated native CMake paths exceed reliable Windows toolchain behavior; a `subst` workaround also broke Expo upward package discovery.  
USER / RELEASE IMPACT: Blocks this host/path's local native build, not EAS/source certification.  
REPRODUCTION / EVIDENCE: `:app:assembleDebug --warning-mode all` attempt.  
SUGGESTED FIX: Use a genuinely short real checkout or reduce generated object-path depth; verify with clean Gradle cache.  
ESTIMATED REPAIR SCOPE: Windows build layout/tooling, no product source change necessarily.  
PLATFORM PARITY IMPACT: Android  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: after physical build

### AUD-P7-002
ID: AUD-P7-002  
SEVERITY: P7  
TITLE: Project-owned Gradle DSL emits deprecation warnings  
LOCATION: `android/build.gradle:26`, `android/app/build.gradle:369-427`; Android build  
TYPE OF DEFECT / BUG: dependency/configuration issue  
EXPECTED BEHAVIOR: Project Gradle configuration is compatible with supported Gradle APIs.  
OBSERVED BEHAVIOR: Configure phase emits deprecated DSL warnings for project-owned lines.  
ROOT CAUSE: Android config has not completed the next Gradle API migration.  
USER / RELEASE IMPACT: No current runtime failure; future Gradle upgrades may break builds.  
REPRODUCTION / EVIDENCE: Gradle warning-mode build output.  
SUGGESTED FIX: Update DSL in a separately tested Android toolchain change.  
ESTIMATED REPAIR SCOPE: Gradle files, build matrix.  
PLATFORM PARITY IMPACT: Android  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

### AUD-P7-003
ID: AUD-P7-003  
SEVERITY: P7  
TITLE: Expo/RN Gradle plugins emit upstream deprecation warnings  
LOCATION: Expo/React Native Gradle plugins during Android configure; Android  
TYPE OF DEFECT / BUG: dependency/configuration issue  
EXPECTED BEHAVIOR: Upstream plugin stack is supported by the selected Gradle version.  
OBSERVED BEHAVIOR: Configure output includes upstream deprecation warnings.  
ROOT CAUSE: Current Expo/RN dependency baseline.  
USER / RELEASE IMPACT: No demonstrated product defect; upgrade planning is needed before a future Gradle break.  
REPRODUCTION / EVIDENCE: Gradle warning-mode output.  
SUGGESTED FIX: Resolve through a compatible Expo/RN upgrade rather than local patching.  
ESTIMATED REPAIR SCOPE: dependency/native upgrade and device matrix.  
PLATFORM PARITY IMPACT: Android  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: backlog

### AUD-P7-004
ID: AUD-P7-004  
SEVERITY: P7  
TITLE: Deprecated transitive packages remain  
LOCATION: `package-lock.json`; Shared dependency graph  
TYPE OF DEFECT / BUG: dependency/maintainability issue  
EXPECTED BEHAVIOR: Deprecated transitive packages are removed through supported parent updates.  
OBSERVED BEHAVIOR: `inflight`, `rimraf`, `glob`, and `uuid` deprecation notices remain transitively installed.  
ROOT CAUSE: Parent toolchain dependencies retain them.  
USER / RELEASE IMPACT: No current mobile runtime defect proven.  
REPRODUCTION / EVIDENCE: npm install/audit dependency output.  
SUGGESTED FIX: Upgrade/remove through controlled parent-package upgrades.  
ESTIMATED REPAIR SCOPE: package graph and native/test validation.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: backlog

### AUD-P7-005
ID: AUD-P7-005  
SEVERITY: P7  
TITLE: Style DNA feedback source attribution is fixed to StyleChat  
LOCATION: `services/style-dna/localStyleDnaFeedbackStore.ts:201-210`; Shared Style DNA feedback  
TYPE OF DEFECT / BUG: analytics gap  
EXPECTED BEHAVIOR: Feedback records the bounded originating surface when known.  
OBSERVED BEHAVIOR: `contextSource` is always `style_chat`.  
ROOT CAUSE: Handoff metadata is not yet propagated.  
USER / RELEASE IMPACT: Future attribution analysis is less precise; no user-facing defect.  
REPRODUCTION / EVIDENCE: Source TODO and static store inspection.  
SUGGESTED FIX: Add bounded source metadata through the existing handoff contract.  
ESTIMATED REPAIR SCOPE: handoff contract, feedback store, tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: backlog

## Detailed P8 findings

### AUD-P8-001
ID: AUD-P8-001  
SEVERITY: P8  
TITLE: Deprecated privacy backend helper remains  
LOCATION: `services/supabasePrivacy.js:11-17`; Shared privacy client  
TYPE OF DEFECT / BUG: dead-code/maintainability issue  
EXPECTED BEHAVIOR: Unused deprecated helpers are removed after reachability confirmation.  
OBSERVED BEHAVIOR: `isPrivacyBackendConfigured` remains despite no active caller.  
ROOT CAUSE: Historical compatibility residue.  
USER / RELEASE IMPACT: None demonstrated.  
REPRODUCTION / EVIDENCE: Repository-wide call-site search.  
SUGGESTED FIX: Remove in a cleanup-only change after a final reachability test.  
ESTIMATED REPAIR SCOPE: one helper and focused test.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

### AUD-P8-002
ID: AUD-P8-002  
SEVERITY: P8  
TITLE: Package module mode is unspecified for ESM JavaScript  
LOCATION: `package.json`; ESM `.js` services/tests; Shared  
TYPE OF DEFECT / BUG: configuration/maintainability issue  
EXPECTED BEHAVIOR: Node loads module types without reparsing warnings.  
OBSERVED BEHAVIOR: Full regression emits `MODULE_TYPELESS_PACKAGE_JSON` warnings and reparses ESM files.  
ROOT CAUSE: Mixed CommonJS/ESM repository has no global `type` declaration.  
USER / RELEASE IMPACT: Minor test/runtime startup overhead; global flip may be risky.  
REPRODUCTION / EVIDENCE: Full regression output.  
SUGGESTED FIX: Deliberately migrate boundaries or use `.mjs`/`.cjs`; do not globally flip without compatibility work.  
ESTIMATED REPAIR SCOPE: package/module boundaries and broad tests.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: NO  
RECOMMENDED TIMING: backlog

## Detailed P9 findings

No P9 findings were discovered.

## Detailed P10 findings

### AUD-P10-001
ID: AUD-P10-001  
SEVERITY: P10  
TITLE: Optional avatar expression channels remain deferred  
LOCATION: `services/avatars/avatarEnginePackages.ts:32-40,113-116`; `docs/avatar-engine-v10-integration.md:146-148`; Shared avatar runtime  
TYPE OF DEFECT / BUG: future optimization  
EXPECTED BEHAVIOR: Optional animation channels are introduced only after calibrated assets and profiling exist.  
OBSERVED BEHAVIOR: Blink, brow, gaze, round-mouth expansion, and body channels are intentionally off.  
ROOT CAUSE: Eye/brow regions are not calibrated and no approved body package exists.  
USER / RELEASE IMPACT: Elise uses approved base/mouth animation but lacks optional expression richness.  
REPRODUCTION / EVIDENCE: `EYE_AND_BROW_REGIONS_CALIBRATED = false` and integration documentation.  
SUGGESTED FIX: Add calibrated versioned assets one channel at a time with device performance and fallback tests.  
ESTIMATED REPAIR SCOPE: assets, avatar contract, runtime, device QA.  
PLATFORM PARITY IMPACT: BOTH  
BUILD BLOCKER: NO  
NEW BINARY REQUIRED: YES  
RECOMMENDED TIMING: backlog

## Ledger completion assertion

All 64 P4-P10 findings in the summary table have an individual detailed record above. No P4-P10 finding was repaired in this audit.
