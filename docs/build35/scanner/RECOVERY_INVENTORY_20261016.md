# Scanner Phase 2 recovery inventory (2026-10-16)

Written by the recovery agent after reading `PHASE2_STOP_WORK_STATUS_20261016.md`
and `PARALLEL_EXECUTION_REPORT.md`. All four worktrees belong to
`https://github.com/kscanaiapp/kscan-app.git`.

## Order of operations (honest record)

1. Read the stop-work report, then `git worktree list --porcelain`.
2. For each worktree, BEFORE any edit: captured `git diff` (tracked) to a patch
   file and copied every untracked file to a backup directory outside the
   repository (agent scratchpad `scn-backup/`: `A..D.tracked.patch`,
   `A..D-untracked/`, `A..D.untracked.txt`).
3. Made non-destructive checkpoint commits on each isolated branch so nothing
   stayed uncommitted. No reset, clean, force-push, rebase, stash or deletion was
   run. The untracked temporary `.scanner-contract-harness.cjs` in worktree D was
   deliberately NOT committed and still sits untracked.

The state below is the state at recovery, before the checkpoint commits.

## A. Scanner mobile

- Path: `.scanner-worktree-20261016`
- Branch: `repair/scanner-intelligence-commerce-20261016`
- HEAD at recovery: `9a7d067ac2e275847b82bb1c59d344fb2ccc16a8`
  (local; PR #621 remote head still `6e073a1a`)
- Committed since base: `57193272` (visual-evidence producer interface and tests),
  `9a7d067a` (bounded evidence normalizer + tests; the title mentions adapters
  but only `services/scannerVisualEvidence.ts` and its test changed).
- Uncommitted: `services/scannerScanRequest.ts` (evidence-builder wiring).
- Untracked: `__tests__/scannerArchivedRetailerReplay.test.js`,
  `docs/build35/scanner/PHASE2_STOP_WORK_STATUS_20261016.md`,
  `docs/build35/scanner/evidence/PHASE2-archived-retailer-replay.json`,
  `security/release/scanner-live-certification/lib/archivedReplay.js`,
  `security/release/scanner-live-certification/replay-archives.js`.
- Intent: produce a bounded, digest-bound visual-evidence envelope on the
  request; replay archived retailer responses offline.
- Status: evidence module COMPLETE and tested (4); request wiring PARTIAL
  (untested after edit); replay PARTIAL (tests not rerun after provenance helper).
- Recovery action: checkpoint-commit (done, `879025cc`), keep the stop-work
  report, retest wiring in the combined candidate.

## B. Scanner backend

- Path: `.scanner-backend-worktree-20261016`
- Branch: `repair/scanner-backend-intelligence-20261016`
- HEAD at recovery: `b920d4ee0dafa89631eb23159e21aa6f9de46f51`
  (local; PR #622 remote head `646ce4ad`)
- Committed since base: `b920d4ee` (backend evidence contract, generic brand
  prompt, conflict-safe brand handling, gate/handler integration).
- Uncommitted: `commerceRelevanceAgreement.ts`, `index.ts` (tier annotation),
  `qualityTuneCommerce.ts`, `shoppingProvider.ts`.
- Untracked: `commerceDestinationBoundary.test.ts`, `matchTier.ts`,
  `matchTier.test.ts` (all under `supabase/functions/scan-identify/`).
- Intent: listing-bound match-tier classification and a final destination
  boundary.
- Status: evidence COMPLETE; match tier PARTIAL (no exact-identity producer by
  design); destination repair DEFECTIVE as written (rejected every search-page
  destination, which would have emptied most shelves; see the fix commit).
- Recovery action: checkpoint-commit (`6c6d15b2`), then repair (see handoff).

## C. Scanner local privacy

- Path: `.scanner-privacy-phase2`
- Branch: `repair/scanner-local-privacy-20261016`
- HEAD at recovery: `6e073a1adffce45d6e78725af47ac3098b8de4e5`, nothing committed.
- Uncommitted (12 modified): `hooks/useKScan.js`,
  `modules/kscan-pii-native/expo-module.config.json`,
  `services/privacy/{plateDetection,privacyBoundary}.ts`,
  `services/scannerScanRequest.ts`, `__tests__/helpers/scannerHookHarness.js`,
  and six protocol/commerce tests whose harnesses needed the new guard.
- Untracked (18): `services/privacy/{scannerDispatchGuard,scannerImagePreparation}.ts`,
  `__tests__/scannerLocalPrivacyDispatch.test.js`,
  `__tests__/helpers/scannerPrivacyFixture.js`,
  `modules/kscan-pii-native/android/` (Gradle file + 13 Kotlin files from
  `6efde8bc`; no tests, no build output).
- Intent: mask faces and plate-like regions locally before any Scanner upload,
  bind a proof to the exact encoded bytes, fail closed.
- Status: JS pipeline COMPLETE and component-tested (22); Android native
  PARTIAL (compile never completed: the Gradle wrapper download was blocked in
  Codex's sandbox); native tests had been omitted from the restore.
- Recovery action: checkpoint-commit (`0cde1383`), compile and test natively,
  restore native tests (done, see handoff).

## D. Scanner commerce contract

- Path: `.scanner-contracts-phase2`
- Branch: `repair/scanner-commerce-contract-20261016`
- HEAD at recovery: `6e073a1adffce45d6e78725af47ac3098b8de4e5`, nothing committed.
- Uncommitted (18 modified): `components/ProductShelf.tsx`,
  `components/scan-results/{PurchaseOptionsPanel,types}.ts(x)`,
  `services/{dressingRoomCommerce,scanIdentification,scanIdentificationMapper,scanResultObject}.ts`,
  `types/{canonicalDressingRoomItem,scanIdentification}.ts`, and nine harness
  tests.
- Untracked: `__tests__/commerceMatchTierContract.test.js`,
  `__tests__/helpers/commerceMatchContract.js`,
  `services/scannerVisualEvidence.ts` (identical copy of A's),
  `supabase/functions/scan-identify/matchTier.ts` (identical copy of B's),
  `.scanner-contract-harness.cjs` (temporary, excluded).
- Intent: carry one authoritative listing-bound tier through normalize, map,
  save, reopen, shelf and Dressing Room.
- Status: PARTIAL. The 2 "failing" tests were wrong, not the code: they asserted
  `row.vtoGarment.productUrl`, a field `VtoGarmentInput` has never had
  (`productRef` is the identity; the destination is the option's `productUrl`).
- Recovery action: checkpoint-commit (`0289dbaa`), correct the assertions
  (`bbdeb563`), no VTO change.

## Dependencies between the worktrees

- `scannerScanRequest.ts`: A adds the evidence builder, C adds the privacy
  guard. Complementary edits; merged with one trivial import conflict.
- `scannerVisualEvidence.ts` (A, D) and `matchTier.ts` (B, D) are identical
  copies at canonical paths; keep one implementation per path.
- Strict VM test harnesses must learn each new import (nine in D, further ones
  in C, more found only by running the combined suite).
- Backend manifests (`config/edge-function-manifest.json`, cross-path manifest)
  go stale with any new file under `supabase/functions/`; regenerate on the
  proposal branches, never on the canonical authority.
