# Targeted Scanner source validation

Run date: 2026-10-08. Platform: Windows/Node; this is not Linux CI or device proof.

```powershell
node --test `
  __tests__/useKScanDuplicateGuard.test.js `
  __tests__/multiImageScan.test.js `
  __tests__/scanResultMultiItemActionBinding.test.js `
  __tests__/scannerSavedIdPersistenceRace.test.js `
  __tests__/addScanToDressingRoomModalFlow.test.js `
  __tests__/iosScanResultSheetNesting.test.js `
  __tests__/recentScanAccountIsolation.test.js `
  __tests__/multiImageSelectedQueue.test.js `
  __tests__/multiImageResultPersistence.test.js `
  __tests__/multiItemResultNavigator.test.js `
  __tests__/scannerIdentificationV2Migration.test.js `
  __tests__/scanIdentifyV2Wiring.test.js `
  __tests__/scanIdentifyV2Activation.test.js `
  __tests__/scanCommerceStateTruth.test.js `
  __tests__/recentScanReopenNetworkIsolation.test.js `
  __tests__/recentScanCommercePreservation.test.js `
  __tests__/recentScansCommerceActualRoundTrip.test.js `
  __tests__/scanResultReportReachability.test.js `
  __tests__/scanResultActivation.test.js
```

Observed final result:

```text
tests 393
suites 0
pass 393
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 25041.6175
exit_code 0
```

```text
tsc --noEmit: exit_code 0
git diff --check: exit_code 0
```

Important executed assertions:

- Single-photo multiple garments share the original evidence and process in
  deliberate selection order; duplicate IDs do not dispatch twice.
- Two-photo selection uses distinct evidence/source URIs; source mismatch is
  rejected before dispatch.
- Quota preserves completed items and resumes only remaining IDs.
- Late responses after actor switch/cancellation do not publish results or
  dispatch remaining siblings.
- A real source mutation removing actor checks publishes stale results and is
  detected; another mutation binding image 2 to image 1 is detected.
- The real screen persistence callbacks bind source URI, snapshot, provenance,
  original actor and session generation; repeated Save All is idempotent.
- The real library writes distinct image bytes for two sources, reopens correct
  per-item metadata and excludes another actor.
- Real room component bulk writes preserve per-item media and result snapshots,
  stop on actor changes and report partial counts while preserving existing
  single-item error/retry behavior.
- Real navigator freezes processing selection, announces image identity,
  disables pending chips and requires explicit quota/partial retry presses.
- Existing V2 request/fallback rules, Recent Scan commerce/reopen isolation,
  report identity and nested iOS sheet contracts remain covered.

TestSprite preflight: CLI version `0.5.0`; authentication valid; only the existing
Staging backend API project was listed. No local client build was deployed or
tunneled. `TESTSPRITE_MOBILE=UNVERIFIED_BECAUSE_UNDEPLOYED`.

## Initial exact-head CI follow-up

After inspection of Project checks run `37809112969` / job `113421047098`, the
restored pinned review CTA was made fully opaque and two fixture contracts were
updated for active-item analysis and batch-safe aggregate commerce isolation.

```powershell
node --test __tests__/liveCommerceSurfaceStateContract.test.js `
  __tests__/scanResultActionSurface.test.js `
  __tests__/vtoShippedSurfaceReach.test.js `
  __tests__/multiImageResultPersistence.test.js `
  __tests__/multiItemResultNavigator.test.js
```

Observed: 44 tests, 44 passed, 0 failed/skipped/cancelled, exit 0.
`git diff --check` passed. Baseline unchanged. No new Linux CI result is claimed
until the follow-up patch has been published and run against its exact head.

Expanded independent-review validation:

```powershell
node --test __tests__/scannerRouteActorReset.test.js `
  __tests__/multiItemResultNavigator.test.js `
  __tests__/multiImageSelectedQueue.test.js `
  __tests__/multiImageResultPersistence.test.js `
  __tests__/liveCommerceSurfaceStateContract.test.js `
  __tests__/scanResultActionSurface.test.js `
  __tests__/vtoShippedSurfaceReach.test.js
```

Observed: 59 tests, 59 passed, 0 failed/skipped/cancelled, exit 0. The real route
uses a simulated Scanner stateful child to prove actor-key remount/reset;
removing the real route key preserves the previous private result and is caught.
Real selected-queue callback execution proves a failed provider item lacking
optional detection attributes can retry while a ready sibling is not dispatched
again. Missing or mismatched media still rejects before provider dispatch.

## Phase F: multi-image matrix certification

Branch `repair/build35-scanner-controls-20261008`, cut from integration
`509924ae` (PR #526 merged). Windows/Node 24. Source-level evidence only: this
is not Linux CI, Staging or device proof.

Harness: `__tests__/helpers/scannerHookHarness.js` executes the real
`hooks/useKScan.js` with the real transport, normaliser, Scanner adapter and
mapper; only device edges and the Supabase `scan-identify` invoke (raw edge
payloads) are simulated. `multiImageScannerBatchOrchestration.test.js` extracts
real `app.js` regions by marker and runs them over the real hook and the real
`services/library.js` (in-memory filesystem, shared actor context).

Failing first (before the repairs): 5 tests in
`multiImageScannerHookMatrix.test.js` (B35-SCAN-010, 011, 013 x3) and 1 in
`multiImageScannerBatchOrchestration.test.js` (B35-SCAN-012). All pass after.

Real-source mutation proof (each reversal applied to the working tree, tests run,
file restored from git, tree verified clean): 11 of 11 reversals turned the
guarding tests red: actor-boundary key, failed-item retry control, replay filter,
normaliser quota flag, hook quota check, detection notice, real-cause rethrow,
asset de-duplication, partial auto-save guard, Add-image bound, Remove target.

```powershell
node --test __tests__/multiImageScannerControls.test.js `
  __tests__/multiImageScannerHookMatrix.test.js `
  __tests__/multiImageScannerBatchOrchestration.test.js `
  __tests__/scannerRouteActorReset.test.js __tests__/multiItemResultNavigator.test.js `
  __tests__/multiImageSelectedQueue.test.js __tests__/multiImageResultPersistence.test.js `
  __tests__/multiImageScan.test.js __tests__/scanIdentification.test.js `
  __tests__/useKScanDuplicateGuard.test.js __tests__/addScanToDressingRoomModalFlow.test.js `
  __tests__/recentScanAccountIsolation.test.js  # plus 23 sibling Scanner, V2, commerce, reopen, Elise and nesting files (35 total)
```

Observed: 640 tests, 640 passed, 0 failed/skipped/cancelled. `tsc --noEmit`
exit 0; `git diff --check` exit 0.

Full suite (`node scripts/run-all-tests.js`, which can exit 0 or 1 irrespective of
failures, so the identity sets were compared by name):

| Tree | Files | Tests | Pass | Fail (known 13 / unexpected) | Skipped |
|---|---|---|---|---|---|
| Pristine integration `509924ae` | 564 | 10504 | 10372 | 33 (13 / 20) | 99 |
| Branch at `479e407a` | 565 | 10508 | 10378 | 31 (13 / 18) | 99 |
| Branch at `f68f1930` (code identical to `479e407a`; adds 3 tests) | 565 | 10511 | 10380 | 32 (13 / 19) | 99 |

The branch differs from integration by two test files only (no production
delta). New-versus-baseline failing identities: none attributable to this work.
The pristine run additionally failed two load-sensitive timing tests
(`PERF - deriving the frame ...`, `RESTART: pending work is rediscovered ...`);
the final branch run failed one other timing test
(`closetPromotionCoordinator`: "a deadline that elapses DURING the committed
write still recovers as success", a 5 ms deadline against a 25 ms write). It
passes 3 of 3 in isolation on both the branch and the pristine tree. The 18
Windows path-separator identities are identical on both sides.

No Production or Staging access, deploy, paid provider call or EAS build was made.
