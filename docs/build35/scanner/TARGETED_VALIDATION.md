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
