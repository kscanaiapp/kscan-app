# Build 35 VTO post-Kimi defect ledger

Scope: PR #499 after convergence with `integration/build35-v1-convergence` at
`de75f643fac91a91d60e82b8748601dfc1760a4c`. This ledger records only findings
from the offer-code, K+, VTO result-loop, and adjacent Commerce integration
audit. It does not broaden the audit into unrelated repository work.

## P0-P3 repair ledger

### B35-OC-001

- **Severity:** P1
- **Location:** `components/kplus/KPlusRedeemOfferPanel.tsx`, default redemption
  port; `services/kplus/kplusOfferRedemption.ts`, presentation contract
- **Type:** BACKEND_WIRING / AUTHORIZATION / ENTITLEMENT
- **Root cause:** the polished redemption panel ended at a default
  `UNAVAILABLE` presentation seam. There was no authenticated ingestion
  endpoint, server-owned offer policy, code-secret boundary, atomic ledger, or
  canonical K+ grant transaction behind it.
- **Impact:** offer redemption could not ship. Implementing it in the client
  would have created an entitlement-authority and code-secrecy violation.
- **Repair:** added the `kplus-offer-redeem` authenticated Edge Function, an
  HMAC-only code contract, the atomic `redeem_kplus_offer_code` service-role
  RPC, server-owned offer/code/attempt/redemption tables, actor throttling,
  idempotent replay, advisory/row locks, usage limits, canonical
  `grant_kplus_complimentary` integration, fail-closed store-native handling,
  deletion governance, and the bounded mobile adapter. The client refreshes
  canonical K+ after server success and cannot grant K+ itself.
- **Files changed:**
  `supabase/migrations/20261004184118_kplus_offer_code_redemption_authority.sql`,
  `supabase/functions/kplus-offer-redeem/*`, `supabase/config.toml`,
  `services/kplus/kplusOfferRedemptionClient.ts`,
  `services/kplus/kplusOfferRedemption.ts`,
  `components/kplus/KPlusRedeemOfferPanel.tsx`,
  `components/kplus/KPlusMembershipStep.tsx`, deletion registries, and Edge
  governance manifests.
- **Test added or updated:** `__tests__/kplusOfferRedemptionAuthority.test.js`,
  `supabase/functions/kplus-offer-redeem/offerCodeContract.test.ts`, K+ panel,
  activation, Edge parity, deletion, and orphan-sweep contract tests.
- **Negative control:** OC-NC-01 through OC-NC-15 cover hardcoded client codes,
  local grants, actor substitution, inactive/expired offers, double/concurrent
  redemption, actor/global limits, raw-code egress, missing secrets, canonical
  refresh, billing bypass, and anonymous access.
- **Regression result:** focused K+ fence passed 187 tests with 32 disposable-DB
  tests skipped; offer authority tests passed; Deno contract tests passed 4/4;
  TypeScript, Edge parity, migration provenance, dependency reachability, and
  source security checks passed. Runtime SQL application still requires an
  approved disposable/staging database and configured secret.
- **Status:** SOURCE_REPAIR_COMPLETE_EXTERNAL_ACTION_REQUIRED
- **External action required:** apply the migration and deploy the Edge
  Function in an approved environment, configure a fresh
  `KPLUS_OFFER_CODE_HMAC_SECRET_B64` (base64 encoding at least 32 random bytes),
  seed approved offers/codes by digest, and execute the skipped transactional
  concurrency tests there.

### B35-VTO-001

- **Severity:** P2
- **Location:** `components/vto/VirtualTryOnSheet.tsx`, result action footer;
  `services/vto/vtoDecisionLoop.ts`, result identity policy
- **Type:** DATA_INTEGRITY / VTO / STATE_MANAGEMENT
- **Root cause:** success status alone was sufficient to expose result actions;
  the presentation did not prove that the result still belonged to the current
  request and product after an actor/product/request transition.
- **Impact:** stale result controls could act on the wrong garment or request.
- **Repair:** result controls now require exact current request and product
  identity. A mismatch exposes no result actions.
- **Files changed:** `services/vto/vtoDecisionLoop.ts`,
  `components/vto/VirtualTryOnSheet.tsx`, `types/vto.ts`.
- **Test added or updated:** `__tests__/vtoDecisionLoop.test.js` and
  `__tests__/vtoUxPolish.test.js`.
- **Negative control:** a result with a mismatched request or product identity
  cannot produce the action plan.
- **Regression result:** focused VTO fence passed 262/262.
- **Status:** FIXED

### B35-VTO-002

- **Severity:** P2
- **Location:** `supabase/functions/vto-generate/vtoHandler.ts`, request
  admission; `supabase/functions/vto-generate/providers/aiLabToolsProvider.ts`,
  provider response mapping; `services/vto/vtoClient.ts` and
  `services/vto/vtoFailures.ts`, failure transport/presentation
- **Type:** API_CONTRACT / RETRY_BEHAVIOR / IDEMPOTENCY
- **Root cause:** quota exhaustion, a duplicate request already in flight, and
  provider throttling collapsed into an undifferentiated retry response. The
  provider's bounded `Retry-After` guidance was not preserved.
- **Impact:** the client could invite a new paid intent while the original was
  still running, or retry too early during provider throttling.
- **Repair:** introduced separate `quota_exhausted`, `request_in_flight`, and
  `provider_busy` outcomes; made in-flight duplication non-retryable; parsed
  delta/date `Retry-After` values; bounded guidance to 1-3600 seconds; and gated
  retry UI on the resulting failure policy.
- **Files changed:** `types/vto.ts`, `services/vto/vtoClient.ts`,
  `services/vto/vtoFailures.ts`, `services/vto/vtoPhotorealHandoff.ts`,
  `services/vto/vtoRequestStore.ts`, `services/vto/vtoDecisionLoop.ts`,
  `supabase/functions/vto-generate/vtoContract.ts`, `vtoHandler.ts`, and
  `providers/aiLabToolsProvider.ts`.
- **Test added or updated:** VTO decision-loop, E2E harness, customer-activation,
  privacy/wiring, and consent controls.
- **Negative control:** request-in-flight produces no retry action; invalid or
  unbounded retry guidance is discarded.
- **Regression result:** focused VTO fence passed 262/262; Deno check passed.
- **Status:** FIXED

### B35-VTO-003

- **Severity:** P2
- **Location:** `components/vto/VtoSaveToDressingRoom.tsx`, exported-result
  lifecycle; `components/AddScanToDressingRoomModal.tsx`, durable save receipt
- **Type:** PRIVACY / DATA_INTEGRITY / STATE_MANAGEMENT
- **Root cause:** the save bridge lacked a complete result-scoped cleanup and
  stale-async boundary, while the outer result flow could not distinguish an
  opened modal from a confirmed Dressing Room write.
- **Impact:** a superseded temporary result export could survive or be attached
  to the wrong result, and success telemetry/UI could precede durable save.
- **Repair:** temporary exports are scoped to the exact result, discarded on
  result change/unmount/abandonment, and stale async completions are ignored.
  `onSaved` fires only after the durable room write; navigation is announced
  separately through `onBeforeNavigate`.
- **Files changed:** `components/vto/VtoSaveToDressingRoom.tsx`,
  `components/AddScanToDressingRoomModal.tsx`,
  `components/vto/VirtualTryOnSheet.tsx`.
- **Test added or updated:** VTO UX/source controls and Add-to-Dressing-Room
  modal flow controls.
- **Negative control:** replacing a result or leaving before confirmation
  cannot reuse a stale export or report a save.
- **Regression result:** VTO fence passed 262/262; modal flow passed 29/29 in
  the focused repair run.
- **Status:** FIXED

### B35-VTO-004

- **Severity:** P3
- **Location:** `services/vto/vtoProgressStages.ts` and
  `components/vto/VirtualTryOnSheet.tsx`, generation progress presentation
- **Type:** UX / STATE_MANAGEMENT
- **Root cause:** elapsed time advanced the visible generation stage even
  though the provider exposes no completion fraction or stage telemetry.
- **Impact:** the UI could imply work had advanced when only time had passed.
- **Repair:** status alone determines the minimum stage. Elapsed time can add a
  neutral “still working” note but cannot advance or complete progress.
- **Files changed:** `services/vto/vtoProgressStages.ts`,
  `components/vto/VirtualTryOnSheet.tsx`.
- **Test added or updated:** `__tests__/vtoUxPolish.test.js`.
- **Negative control:** arbitrarily large elapsed time cannot produce a later
  stage or completion.
- **Regression result:** focused VTO fence passed 262/262.
- **Status:** FIXED

### B35-VTO-005

- **Severity:** P3
- **Location:** `components/vto/VirtualTryOnSheet.tsx`, result action hierarchy;
  `components/vto/TryItOnEntry.tsx`, handoff; ProductShelf and Scan Results
  purchase-option hosts
- **Type:** COMMERCE / UX / TELEMETRY
- **Root cause:** the result loop did not expose a truthful Watch handoff or
  Try-another action, and could leave the nested sheet visible during host
  navigation. Shop availability was not expressed as a strict callback truth.
- **Impact:** customers could hit dead or duplicated commerce actions and lose
  product-context continuity.
- **Repair:** Shop renders only with a real host callback, Watch delegates to
  the existing host watch authority, Try another closes the current intent,
  the sheet collapses before host navigation, and bounded result-action
  telemetry records only action facts.
- **Files changed:** VTO sheet/entry/pill/telemetry components and services,
  `components/ProductShelf.tsx`, and
  `components/scan-results/PurchaseOptionsPanel.tsx`.
- **Test added or updated:** VTO decision-loop, VTO customer-activation,
  Commerce shelf wiring, and accessibility controls.
- **Negative control:** no Shop callback means no invented Shop action; Watch
  cannot become VTO-owned persistence.
- **Regression result:** VTO fence passed 262/262; adjacent deletion/actor/
  Commerce/accessibility fence passed 102/102.
- **Status:** FIXED

### P0-P3 totals

```text
P0_FOUND=0
P0_FIXED=0
P1_FOUND=1
P1_FIXED=0
P2_FOUND=3
P2_FIXED=3
P3_FOUND=2
P3_FIXED=2
UNRESOLVED_P0_P3=1_EXTERNAL_ACTION_ONLY
```

The P1 source repair is complete; it is intentionally not marked fully fixed
until the prohibited deployment/configuration and environment-level database
proof are performed.

## P4-P10 defect ledger

### B35-CFG-001

- **Severity:** P4
- **Location:**
  - **File:** `supabase/migrations/20261004184118_kplus_offer_code_redemption_authority.sql`
  - **Component/function/endpoint/screen:** `redeem_kplus_offer_code`,
    `store_native` result-action branch
  - **Line/region:** store-native action dispatch / `store_path_unconfigured`
- **Type:** CONFIGURATION / COMMERCE
- **Description:** the source model can classify a store-native offer, but the
  repository does not contain verified Apple/Google/RevenueCat promotional
  product configuration that can safely launch it.
- **Impact:** commercial offer codes fail closed as `UNAVAILABLE`; no discount
  checkout is fabricated and no store billing is bypassed.
- **Reproduction or evidence:** the atomic RPC records the internal
  `store_path_unconfigured` reason and returns the bounded unavailable result.
- **Suggested fix:** after product-owner/store approval, add an allowlisted
  server-to-store-product mapping and launch only the verified native purchase
  mechanism supported by the installed RevenueCat SDK. Keep price/trial terms
  store-derived and require canonical K+ reconciliation after purchase.
- **Suggested test:** sandbox Apple and Google tests proving the mapped product
  exists, the native purchase sheet opens, cancellation grants nothing, and a
  verified lifecycle event alone grants canonical K+.
- **Dependencies/prerequisites:** Apple/Google product setup, RevenueCat
  offering/product mapping, sandbox accounts, and owner approval.
- **Recommended future lane:** K+ store-native promotional-offer enablement.
- **Status:** DOCUMENTED_NOT_REPAIRED

### B35-DEP-001

- **Severity:** P6
- **Location:**
  - **File:** `package-lock.json`
  - **Component/function/endpoint/screen:** Expo/React Native/Metro build and
    development dependency graph
  - **Line/region:** transitive dependency lock entries reported by `npm audit`
- **Type:** DEPENDENCY
- **Description:** the existing lockfile reports 28 high, 16 moderate, and one
  low advisory (zero critical). The governed reachability gate classifies all
  28 high findings as approved build/dev-only or transitive build/dev-only.
- **Impact:** no advisory is newly introduced by or directly reachable through
  this lane, but the repository retains dependency maintenance debt.
- **Reproduction or evidence:** `npm audit --omit=dev` / governed dependency
  report and `npm run verify:dependency-reachability`.
- **Suggested fix:** update Expo/React Native and their Metro/tooling graph in a
  dedicated compatibility lane, preserve the reachability classifications,
  and remove exceptions only when the vulnerable transitives leave the lock.
- **Suggested test:** full governed suite, native iOS/Android builds, dependency
  reachability gate, and scan/VTO device smoke after each upgrade batch.
- **Dependencies/prerequisites:** coordinated Expo/RN compatibility matrix and
  native build capacity.
- **Recommended future lane:** dependency security maintenance.
- **Status:** DOCUMENTED_NOT_REPAIRED

### B35-TEST-001

- **Severity:** P8
- **Location:**
  - **File:** `__tests__/build34SharedClientConvergence.test.js`
  - **Component/function/endpoint/screen:** four mutation controls around
    owner-scoped storage/deletion
  - **Line/region:** tests beginning near the mutation block around line 781
  - **File:** `__tests__/posthogDisabledStateEgress.test.js`
  - **Component/function/endpoint/screen:** isolated ESM module import harness
  - **Line/region:** disabled-config matrix beginning near line 64
  - **File:** `__tests__/terminalDeletionCleanup.test.js`
  - **Component/function/endpoint/screen:** terminal cleanup mount-point scan
  - **Line/region:** path assertion near line 1563
- **Type:** TEST_COVERAGE / GOVERNANCE
- **Description:** 18 full-suite identities fail on Windows for path/ESM test
  harness reasons. The exact same identities fail on untouched convergence
  commit `45c9c68738b0d2d391f7169b7170358e8ccfe1ad`.
- **Impact:** the governed runner reports 18 “unexpected” failures on Windows
  even though the product behavior and this lane are unchanged.
- **Reproduction or evidence:** run the three files on Windows in both the lane
  worktree and a detached worktree at the convergence commit; identities match.
- **Suggested fix:** convert absolute module paths through `pathToFileURL`,
  normalize scanned paths to POSIX separators before assertions, and make the
  mutation substitutions line-ending/path-format independent.
- **Suggested test:** run the three files on Windows and Linux, then assert the
  mutation controls still fail when the intended defect is injected.
- **Dependencies/prerequisites:** none.
- **Recommended future lane:** cross-platform test-harness portability.
- **Status:** DOCUMENTED_NOT_REPAIRED

### B35-TEST-002

- **Severity:** P9
- **Location:**
  - **File:** `.testsprite/config.json` (absent)
  - **Component/function/endpoint/screen:** TestSprite project/deployment target
  - **Line/region:** repository test integration
- **Type:** TEST_COVERAGE / CONFIGURATION
- **Description:** TestSprite CLI is installed and authenticated, but this
  repository is not linked to a TestSprite project for the changed mobile app
  and the source change has no reachable deployed URL. The only listed project
  is an older staging-backend project.
- **Impact:** TestSprite cannot truthfully verify this local mobile change; a
  run against the old deployment would test the previous build.
- **Reproduction or evidence:** `testsprite --version` returns 0.5.0,
  `testsprite auth status` succeeds, `.testsprite/config.json` is absent, and
  project listing exposes only the prior backend target.
- **Suggested fix:** link the correct project, deploy this exact reviewed commit
  to an approved preview/staging target or use the TestSprite MCP tunnel, then
  seed a broad first suite across VTO acquisition, offer redemption, canonical
  refresh, and result actions.
- **Suggested test:** verify the deployed commit SHA, then run the broad suite
  with observable assertions and retain failure artifacts.
- **Dependencies/prerequisites:** approved deployment/tunnel and TestSprite
  project ownership.
- **Recommended future lane:** post-deployment mobile journey certification.
- **Status:** DOCUMENTED_NOT_REPAIRED

### B35-TEST-003

- **Severity:** P7
- **Location:**
  - **File:** `supabase/migrations/20261004184118_kplus_offer_code_redemption_authority.sql`
  - **Component/function/endpoint/screen:** transactional redemption RPC and
    disposable-database concurrency tests
  - **Line/region:** actor/code locking, limit consumption, and canonical grant
- **Type:** TEST_COVERAGE / CONFIGURATION / CONCURRENCY
- **Description:** no Docker-backed disposable Supabase database is available
  on this host, so runtime SQL replay and true concurrent-redemption execution
  could not be performed locally. The source and mutation controls pass.
- **Impact:** atomic behavior is source-proven but still needs environment-level
  execution before staging convergence.
- **Reproduction or evidence:** `supabase status` cannot reach the Docker Linux
  engine; database tests report the missing
  `KSCAN_DISPOSABLE_SUPABASE_DB_CONTAINER` prerequisite.
- **Suggested fix:** provision a disposable Supabase/Postgres container, replay
  all migrations, seed synthetic offer digests, and race two sessions against
  the RPC while checking the grant and ledger cardinalities.
- **Suggested test:** OC-NC-06 through OC-NC-09 as real concurrent SQL tests,
  plus rollback/cleanup proof and privilege inspection.
- **Dependencies/prerequisites:** Docker or an approved disposable database;
  never production or shared staging.
- **Recommended future lane:** offer-redemption backend runtime certification.
- **Status:** DOCUMENTED_NOT_REPAIRED

### P4-P10 totals

```text
P4_FOUND=1
P5_FOUND=0
P6_FOUND=1
P7_FOUND=1
P8_FOUND=1
P9_FOUND=1
P10_FOUND=0
P4_P10_REPAIRED_BY_EXCEPTION=0
P4_P10_DOCUMENTED_ONLY=5
```
