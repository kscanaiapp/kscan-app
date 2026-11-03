# Build 35 customer activation verification — 2026-10-16

Status: source verification and executable current-artifact Samsung smoke complete; bounded follow-ups listed below.

## Scope and source identity

- Dedicated worktree: `C:/b35cas`.
- Branch: `build35/customer-activation-smoke-20261016`.
- Verified mobile source: `1e5918852c948759d2dbdd954daea0b44b475d1f`, the live head of `integration/build35-v1-convergence` at preflight and subsequent readbacks.
- Backend authority: `54e9c27d9e39df99b167126382fe8ed9f5f01edb`, the live head of `rebuild/backend-authority-v2` at the same readbacks.
- No application source repair or backend deployment has been made in this campaign. Existing integration and backend authority branches were not changed.
- Release policy: Today with Elise and account deletion were explicitly excluded. No inspection or edits of those features were undertaken. Live Camera VTO remains outside this campaign; its concurrent worktrees and implementation files were not opened or changed.

APK 38 (`fc04deb7207db30db1c3cbabde418504755b81f4`) was initially installed from an existing local artifact. That was the wrong artifact for proving today's repairs. The owner identified this mismatch, the old smoke campaign was stopped, and **none of its device results count as verification of the repaired source**. The owner removed that installation. It predates today's Scanner repair merges and differs in other in-scope surfaces too.

The replacement is a full-app build of the integration head, not a selective repair build. Merged-history/ancestry readbacks account for Elise's keyboard/image transitions (#614), app-open welcome and cancellation (#598), greeting race recovery (#597), approved asset preparation (#594), playback-driven animation (#590); Photo VTO garment pin (#611), actor-boundary close (#619), contextual K+ disclosure (#615), permanent Studio entry (#610), attribution (#608) and recovery (#601); Packing/Watchlist entry restoration (#599), hosted K+ acquisition (#579), owned-Closet utilities (#573), and Scanner brand/match-state/privacy/persistence work (#621 and its merged predecessors). Compiling committed dependencies does not reopen the separate Live VTO lane.

## Source verification

All commands below ran against the pinned mobile source. Logs are local under `C:/b35cas/artifacts/customer-activation/`; no raw device captures, account identifiers, credentials, or downloaded deployment sources are included in this document or committed.

| Command / group | Result | Local evidence |
| --- | --- | --- |
| `node scripts/check-build35-release-profile.js` | PASS, production and build35-release | `profile.log` |
| `node scripts/check-native-config-parity.js` | PASS | `native-parity-final.log` |
| Required four K+ test files | 142 PASS | `kplus.log` |
| Required two Packing test files | 59 PASS | `packing.log` |
| Required four Watchlist test files | 83 PASS | `watchlist.log` |
| Required four Android Voice / Speech test files | 46 PASS | `voice-speech.log` |
| Adjacent K+, Watchlist, Voice, Speech regressions (19 files) | 348 PASS, 27 SKIP | `adjacent.log`, `adjacent-files.txt` |
| Scan utility surfaces, Photo VTO garment identity pin, ProductShelf UX | 31 PASS | `scanner-photo.log` |
| Closet initial load, Android Scanner permission refresh/settings, Dressing Rooms UX | 34 PASS | `closet-navigation.log` |
| Scanner Edge contract, result activation/actions, VTO consent, multi-image controls/orchestration | 171 PASS | `scanner-contract.log` |
| Changed Scanner regression test files since APK 38 (19 files) | 293 PASS | `today-scanner-tests.log`, `today-scanner-test-files.txt` |
| Elise mouth preparation/registration, keyboard, interruption/session boundary; Photo VTO contextual offer, Studio, entry attribution (8 files) | 162 PASS | `elise-vto-today.log` |
| `node node_modules/typescript/lib/tsc.js --noEmit --pretty false` | PASS | `typescript-clean.log` |

Totals: **1,369 passing test executions, 27 skipped, zero failing** across these groups. Some test files overlap between groups; these are execution totals, not unique-test counts. The 27 skips require an explicitly configured disposable Supabase database container; no Production database was substituted.

The first functional test attempt preceded dependency installation and failed to resolve TypeScript. After `npm ci --ignore-scripts --no-audit --no-fund` completed, the required groups passed. An initial TypeScript run also included downloaded Deno deployment sources placed under the worktree; those sources were moved to `C:/b35cas-evidence`, and the unchanged repository TypeScript configuration then passed. Neither setup error was treated as a product defect.

The full local `npm run test:all` was not repeated during native compilation on this memory-constrained host or used to expand the excluded feature audit. The exact source SHA already has successful [Project checks and security jobs](https://github.com/kscanaiapp/kscan-app/actions/runs/38943070538), [release-profile guard](https://github.com/kscanaiapp/kscan-app/actions/runs/38943070542), and [promotion gate](https://github.com/kscanaiapp/kscan-app/actions/runs/38943070502). These are existing exact-source CI runs, not new device evidence.

## Itemized source ledger

| ID | Classification | Entry / flag / entitlement / service traced | Evidence and limits |
| --- | --- | --- | --- |
| S01 | PASS — SOURCE | Contextual `KPlusGate` → `KPlusMembershipSheet` → shared membership step; canonical actor-scoped entitlement; native RevenueCat offering/purchase/restore bridge | Required K+ tests plus lifecycle/resolving/core-free regressions. Store billing, current provider readback, free/entitled account switching remain separate checks. |
| S02 | PASS — SOURCE | `/watchlist`, `/watchlist/[watchId]`; `watchlist-home-screen`, `watch-detail-screen`; Smart Watchlist flag; commerce Watch entry and K+ gate; Watchlist client and notification routing | 83 required tests plus shipped-surface, authority, push-receipt and observability regressions. Scheduler success does not establish delivery. |
| S03 | PASS — SOURCE | `/packing`; `packing-screen`, `packing-trip-form`, `packing-submit`, `packing-retry`, refinement controls; Packing flag and shared K+ gate; `requestPackingPlan` → `stylechat-generate` | Request discriminator `packing-plan-v1`; response validation rejects unusable success, parses general mode, preserves retry/refinement behavior. 59 tests. No authenticated remote generation claim. |
| S04 | PASS — SOURCE | Home Voice entry → `/text-scan`; `text-scan-voice-button`, `voice-scan-stop`, `voice-scan-cancel`; Voice flag, native-capability selector, K+ gate; native speech recognition bridge | Permission/session guards and actual native wiring tested. Native recognition requires artifact and device evidence, not the JS flag alone. |
| S05 | PASS — SOURCE | Customer StyleChat entry → session route/header; Speech flag, speech consent/preference, request/player lifecycle, actor and navigation interruption | Required lifecycle tests plus consent/reliability/profile regressions. Provider and avatar engines were not refactored; playback/motion need current-artifact device evidence. |
| S06 | PASS — SOURCE | `/scan`, commerce result actions, Photo VTO entry/consent; Scanner backend and Photo VTO flags; selected garment identity and actor boundary; `scan-identify` / `vto-generate` clients | Scanner contracts and today's changed regressions pass; no new provider or Live VTO implementation work. Fresh scan-to-result and pinned-garment device checks remain artifact-specific. |
| S07 | PASS — SOURCE | `/library?section=closet`, `/dressing-rooms`; Closet load state and existing saved-content navigation | Focused Closet load and Dressing Rooms regressions pass. No expanded audit. |

Both checked store-like profiles resolve Scanner backend, Photo VTO, Packing, Smart Watchlist, Speech, Voice Scan, and the Voice native capability ON. These source flags are not an installed-artifact certificate.

## Remote backend readbacks

Read-only Supabase CLI access worked. The connected Supabase and RevenueCat app tools required an unavailable connection `link_id`; this was not treated as a provider defect.

| Function | Staging | Production | Readback |
| --- | --- | --- | --- |
| scan-identify | v82 | v174 | ACTIVE / ACTIVE |
| vto-generate | v20 | v14 | ACTIVE / ACTIVE |
| stylist-speech | v78 | v53 | ACTIVE / ACTIVE |
| commerce-watch-refresh | v18 | v11 | ACTIVE / ACTIVE |
| stylechat-generate | v133 | v112 | ACTIVE / ACTIVE |

| ID | Classification | Evidence |
| --- | --- | --- |
| R01 | PASS — REMOTE BACKEND | Actual deployment metadata readback for the five functions above. This confirms deployment state, not a customer request/response. Local `staging-functions.json`, `production-functions.json`. |
| R02 | PASS — REMOTE BACKEND | Actual deployed StyleChat bundles downloaded read-only: 52 files in each environment, 52 byte-identical, zero differences, including Packing modules. Local `stylechat-parity.json`; deployment sources kept outside the TypeScript project. No redeploy of identical bundles. |
| R03 | PASS — REMOTE BACKEND | Existing [Staging scheduled sweep 38967412713](https://github.com/kscanaiapp/kscan-app/actions/runs/38967412713) completed successfully. No new sweep or push delivery was claimed. |
| N01 | NOT RUN — ENVIRONMENT/ACCESS | Current `app_config.watchlist_worker_enabled` query could not execute: this CLI path required IPv6 unavailable on the host. Prior true values were not promoted to a current PASS. |
| N02 | NOT RUN — ENVIRONMENT/ACCESS | Current RevenueCat offering/entitlement/paywall readback could not run through the connector without its connection ID. Supplied pre-pass configuration remains historical evidence only. |
| N03 | NOT RUN — ENVIRONMENT/ACCESS | Authenticated bounded Staging Packing/Closet/refinement contract request: owner confirmed no non-production test actor and explicitly deferred authenticated checks. No actor was created or borrowed. |

[Production sweep 38967063765](https://github.com/kscanaiapp/kscan-app/actions/runs/38967063765) was still pending with zero jobs on readback. An older [run 38269743575](https://github.com/kscanaiapp/kscan-app/actions/runs/38269743575/job/114984901795) is waiting for the Production environment's required owner review, ahead of the concurrency queue. Its pending deployment lists the required reviewer. No review was approved, concurrency bypassed, security reduced, or sweep manually invoked. This is an approval dependency, not a reproduced customer regression.

## Current native artifact

Build target: local `:app:assembleDebug`, arm64-v8a, from clean tracked source at the pinned SHA, using the existing build35-release public client feature matrix and Production public client configuration. This is a debug artifact, not an EAS, release, store, or submission artifact.

The optional Scanner Identification V2 flag remains unset/false exactly as in that source profile; Scanner backend, multi-image, Scan Room V2 and Scan Results V2 remain enabled. Source inclusion is not a claim that every optional path is activated.

The initial full-feature native preflight correctly refused to proceed without Firebase materialization. The matching Android Firebase client file was subsequently found locally and validated without printing values. A temporary Gradle init script applies the existing governed Voice + Push overlay to the debug source set and limits Metro workers. This is necessary because the committed capability selector chooses the overlay for release, while the default debug overlay does not grant those capabilities. No committed native/configuration file was modified. A local Android debug signing key is used.

The existing checked-in `repair-elise-mouth-alpha.cjs` build hook is also run before Metro, matching the normal asset preparation step. It deterministically prepares two generated PNG inputs with preserved RGB; target alpha coverage becomes 0.8184743368 for both states. The build record captures those generated outputs separately from the source commit. This is execution of the approved build pipeline, not a new avatar-engine repair; generated asset changes will not be committed as new source work.

The full local debug build completed successfully (334 Gradle tasks, 14m52s in the final invocation). The candidate is `C:/b35cas/artifacts/customer-activation/KScan-Build35-1e591885-debug.apk`, 238,385,639 bytes, SHA-256 `f9b488e6359780d7c5e6674af8ed33c84035a01dd1227c80fba2c8f06d94290b`. It retains the checked-in native version code 23 / version name 1.0.1; that number is not a store build number or the earlier APK 38.

Artifact verification passed: embedded `kscan_source_commit` is the pinned full SHA, profile is `local`, package is `com.kscanai.app`, ARM64/debug artifact, CAMERA / RECORD_AUDIO / POST_NOTIFICATIONS present, Firebase app/sender resources match the approved configuration, both packaged Elise mouth overlays have target alpha coverage 0.8184743368 and preserve their RGB digests. The owner reconnected the Samsung (SM-S936U, Android 17), installation succeeded, and the APK pulled back from the device has the identical SHA-256. The owner signed into the current candidate for the device smoke pass.

Local evidence: `current-debug-build.json`, `current-debug-build.log`, `native-manifest-assets.json`, `current-apk-verification.json`, `current-installed-verification.json`, `current-samsung-install.txt`, `current-samsung-package.txt`, and current-build device captures. Both generated source PNG changes were verified against the deterministic hook output and restored after packaging; committed application source is unchanged.

## Device checklist and boundaries

The historical Maestro camera flow assumes launch opens a legacy camera and waits for `scan-button`; the actual installed V2 UI opens Home/Scan landing. Its run failed at that selector. The run also overlapped manual navigation during this initial attempt, so it is **not a clean app-regression reproduction**. It provides no basis for a customer P1. Other supplied flows were inspected: critical-path has the same legacy start assumption, and avatar flows assume a specific saved stylist/name and can invoke session creation. No paid Production request was made to force those flows through.

The owner explicitly authorized the signed-in Samsung session and later made the device available for automation. The installed candidate uses the Production public client configuration, not Staging. Bounded normal UI requests were limited to one Packing generation, one refinement, and one StyleChat message. No credential or session token was extracted. Automated shoes recognition was stopped at the owner's request: the owner had already tested shoes. That owner report is not counted as an automated PASS.

| ID | Classification | Actual route, decision, result and local evidence |
| --- | --- | --- |
| D01 | PASS — PHYSICAL DEVICE | Verified APK installed and pulled-back digest matches; launch with retained signed-in session reaches `home-luxury-tech-v1-screen`. `current-installed-verification.json`, `current-navigation-ready.log`. |
| D02 | PASS — PHYSICAL DEVICE | `/privacy` → Membership → `kplus-paywall-sheet`; canonical presentation says complimentary K+ membership is active; Close returns successfully. This explains premium entry access, not a paid purchase. `current-kplus.log`, `current-kplus-shots/screenshots/current-kplus-membership.png`. |
| D03 | PASS — PHYSICAL DEVICE | `/watchlist`, `watchlist-home-screen`: actual empty list, clear K+ tracking explanation and commerce Watch guidance. No existing watch detail or push receipt claimed. `current-navigation-ready.log`, local `current-watchlist.png`. |
| D04 | PASS — PHYSICAL DEVICE | `/packing`, `packing-trip-form`: K+ permits entry. Miami, Oct 20–23, travel/casual activities submitted to the configured Packing/StyleChat client. Validated `packing-plan`, `packing-weather`, `packing-message` render four Closet pieces and two looks. This is UI request/response evidence, without a separate server trace. `current-packing.log`, `current-packing-response.json`, `current-packing-refine-shots/screenshots/current-packing-plan.png`. |
| D05 | PASS — PHYSICAL DEVICE | Packing refinement input and `packing-refine-submit`: bounded casual-outfit refinement submitted; the plan returns, input clears, and outfit/assumption controls render. `current-packing-refine.log`, `current-packing-refine-shots/screenshots/current-packing-refined.png`. No forced error/retry or general-mode result claimed. |
| D06 | PASS — PHYSICAL DEVICE | Home selected-stylist Start Chat → `style-chat-header` / `style-chat-input`; neutral navy-blazer prompt entered. Send remains visible above the open keyboard, submission succeeds, and a new assistant styling reply renders via the configured StyleChat client. `current-stylechat.log`, `current-stylechat-response.json`, `current-stylechat-shots/screenshots/current-stylechat-keyboard.png`. Selected stylist is account-specific; no hardcoded name assumption. |
| D07 | PASS — PHYSICAL DEVICE | `/text-scan`, `text-scan-voice-button`: reachable with active K+; tap leaves a usable manual text composer. Manifest includes RECORD_AUDIO and actual permission is granted. Conditional stop/cancel/transcript steps did not execute; this row certifies entry/manual fallback only. `current-voice.log`, `current-voice-after-start.png`, `current-voice-recovered.png`. |
| D08 | PASS — PHYSICAL DEVICE | `/library?section=closet`, `library-section-closet`: existing Closet cards load; `/dressing-rooms` opens; `/try-on-studio`, `try-on-studio-content` opens. Brief navigation only. `current-navigation-ready.log`, corresponding `current-closet.png`, `current-dressing-rooms.png`, `current-try-on-studio.png`. |
| D09 | PASS — PHYSICAL DEVICE | `/scan`: `scan-room-upload-image` and `scan-room-open-camera` present; Upload opens the Android Google Photos picker. No recognition request sent during automation. `current-scan-entry.log`, `current-scan-shots`. |
| D10 | PASS — PHYSICAL DEVICE | Closet `closet-try-on-action` → `/closet/try-on`: selected item lacks synced garment media, so the explicit missing-photo guard renders. Try again preserves the accurate guard; Studio and Home remain reachable. `current-closet-photo.log`, `current-photo-recovery.log`, their screenshots. This is graceful prerequisite handling, not successful Photo VTO generation. |

The phone remained in an ongoing call (`MODE_IN_COMMUNICATION` readback). Its call and audio settings were left alone. Temporary USB stay-awake was used to prevent automation sleeping; the original setting was restored after the pass. Early stale selectors, device sleep, and manual app switching were harness/session conditions, not reproduced app defects. Picker timestamp selectors became stale as newer images appeared; that attempt stopped before submission. Raw device evidence remains local and is not included in Git.

## Remaining device and access checklist

| ID | Classification | Exact remaining check / prerequisite |
| --- | --- | --- |
| F01 | DEFERRED — STORE/DEVICE | Free versus entitled account boundary; store-returned offering/prices/trial wording; sandbox purchase, cancellation, restore and entitlement refresh. Current account has complimentary access; no confirmed Store test eligibility. No live transaction performed. |
| F02 | DEFERRED — STORE/DEVICE | Watch creation from eligible commerce product, detail/manual refresh, notification permission/token registration, authorized notification tap routing and actual FCM receipt. Current list is empty; Firebase resource presence and scheduler success do not certify delivery. |
| F03 | DEFERRED — STORE/DEVICE | Native Voice actual transcript/start/stop/cancel plus denied/no-speech/service-error states, on a device free of the ongoing call. Source/native wiring and manual fallback passed separately. |
| F04 | DEFERRED — STORE/DEVICE | Customer Speech consent, audible response, playback-driven avatar motion, interruption and recovery, with clean audio ownership. Text reply/keyboard and packaged repaired mouth assets passed separately. |
| F05 | DEFERRED — STORE/DEVICE | Photo VTO from an eligible garment with synced media: photo consent, generation/result, selected-garment pin through navigation and Shop/Watch actions. Existing tested Closet item has no synced photo; no personal photo uploaded or provider request forced. |
| F06 | DEFERRED — STORE/DEVICE | Packing general-mode/empty-Closet response and forced network-failure retry, with suitable test fixtures. Normal owned-Closet generation and refinement passed; error/general-mode contracts passed source tests. |
| O01 | NOT RUN — OWNER REQUEST | Additional automated shoes scan/result, camera capture, non-fashion/no-match and result commerce traversal stopped when owner said to skip scan because shoes were already tested. No blanket automation PASS inferred. |

N01–N03 above remain access/environment limitations. These bounded follow-ups are not automatically P1 defects or release blockers.

## Changes, CI and recommendation

No in-scope application defect was reproduced on the current artifact; no P0/P1 was established by this campaign. No safe repair was necessary, and no backend deployment occurred. Source tests and source CI are passing. Environment/setup failures are recorded separately and guards were not weakened.

Only this closeout document is intended for the focused branch's review. Build scripts, native outputs, credentials, deployment bundles and raw device evidence remain local. TestSprite is not required for a docs-only change; no feature/fix is being claimed complete without its required verification.

Ledger totals: **7 PASS — SOURCE; 10 PASS — PHYSICAL DEVICE; 3 PASS — REMOTE BACKEND; 3 NOT RUN — ENVIRONMENT/ACCESS; 6 DEFERRED — STORE/DEVICE; 1 NOT RUN — OWNER REQUEST; 0 FAIL — REPRODUCED; 0 FIXED + RETESTED; 0 emulator PASS**. A ledger row certifies only the specific steps described, not the entire feature.

Recommendation: Build 35 source verification passes at `1e5918852c948759d2dbdd954daea0b44b475d1f`, with verified current-source APK correspondence and the physical-device results above. Retain the listed Store, push, audio and eligible-media checks as explicit follow-ups; this campaign provides neither a blanket native release certificate nor evidence of a new release blocker. Preserve governed Production sweep approval. No EAS build, store upload, chargeable purchase, new paid API or customer-wide activation was started.

Review delivery: [PR #627](https://github.com/kscanaiapp/kscan-app/pull/627), focused branch `build35/customer-activation-smoke-20261016`. Initial report-only commit: `eaf14e98a0edfe01cb36c0b8ba8bb9f73f45bdee`; subsequent documentation metadata does not change the application source SHA or APK digest. The PR head is the current report revision and the final handoff records its full SHA.

Exact-report-head CI was queued/in progress at publication; it is not represented as green. Initial report-revision runs include [Project/security checks](https://github.com/kscanaiapp/kscan-app/actions/runs/38984395824), [release-profile guard](https://github.com/kscanaiapp/kscan-app/actions/runs/38984395805), and [promotion gate](https://github.com/kscanaiapp/kscan-app/actions/runs/38984395883). Use the PR's current checks for later documentation revisions. The PR remains open and unmerged; no governed check or approval was bypassed. The passing application-source CI cited earlier applies to the exact source packaged in the APK.
