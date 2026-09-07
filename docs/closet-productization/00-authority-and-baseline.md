# Closet Productization & Intelligence V1 — Authority and Pristine Baseline

## Source authority (section 4)

| Field | Value |
| --- | --- |
| Repository | `kscanaiapp/kscan-app` |
| Worktree | `C:\src\CLOSET-PROD-20260907` |
| Base branch | `fix/notifications-final-convergence-v1` |
| Base SHA | `219f27aa0f2586d3bded1ca02f751a63d1960c48` |
| Remote SHA | `219f27aa` (`origin/fix/notifications-final-convergence-v1`) |
| Clean / dirty | CLEAN at dispatch |
| Ahead / behind | 0 / 0 |
| **#327 ancestor** | **YES** — `219f27aa` *is* PR #327's merge commit (merged 2026-09-07T13:41:04Z) |

`master` does **not** contain `219f27aa`; only `fix/notifications-final-convergence-v1` and the
open, unaccepted `integration/build35-v10-staging-certification-v1` (PR #333) do. PR #333 is
**not** an accepted authority, so this lane branches from the merged #327 commit rather than from
another lane's unmerged branch.

## Pristine governed baseline (section 17)

Command: `npm run test:all` (445 `.test.js` files discovered recursively).

| Metric | Value |
| --- | --- |
| Known-failure baseline identities | 19 (`config/test-failure-baseline.json`) |
| Observed failures | 17 |
| Matching known baseline | 13 |
| **Unexpected failures** | **4 (PRE-EXISTING, before any change in this lane)** |

### The 4 pre-existing unexpected failures

All four live in the Curiosity Gap Performance Lab (PR #315 lane), not in the Closet:

- `__tests__/curiosityGapPerformance/labContract.test.js`
  - `source bindings hash real files and verify clean against the working tree`
  - `a stale binding is detectable — a changed file trips it`
  - `contract mode passes and reports zero network and provider calls`
- `__tests__/curiosityGapPerformance/labNetworkScenario.test.js`
  - `the validator passes the real artifacts and exits zero`

Root cause: `tools/curiosity-gap-performance/authority/source-bindings.json` pins content hashes
for 10 Scanner/commerce files and verifies them against the working tree. At the #327 convergence
commit those files have moved on from the recorded `source_sha`, so the ledger reads stale.

**Bound files (the exact diff-fence exclusion set for this lane):**

```
components/scan-results/PurchaseOptionsPanel.tsx
components/scan-room/AnalyzingScan.tsx
components/scan-room/CaptureReview.tsx
hooks/useKScan.js
services/commerceDestination.ts
services/commerceHydration.ts
services/imageUtils.js
services/privacyImageSanitizer.js
services/scanIdentification.ts
services/scannerScanRequest.ts
```

**Zero overlap with the Closet lane.** This lane must not modify any of those 10 files, so it can
neither repair nor worsen these four failures. Final regression acceptance for this lane is
therefore **0 NEW failures against 17 observed / 4 unexpected**, not "absolute green".

## False-green control caught during baselining (section 76)

`npm run test:all 2>&1 | tail -60` reports **exit code 0 even when the runner exits 1**, because a
shell pipeline returns the exit status of the *last* command (`tail`), not `npm`. The runner
itself is correctly written (it exits 1 on `unexpected_failures`). Every verification run in this
lane must read the runner's own `Observed failures / known / unexpected` summary line, or capture
`PIPESTATUS[0]` — never the pipeline's exit code.

## Environment

- Staging: `yzqjvdfgefveprobvvyw` (the only mutable backend in this lane)
- Production: `wyyuqfdxucjksghsmhry` — **NO-TOUCH**
- `node_modules` installed fresh in this worktree (950 packages). A junction to a sibling
  worktree was rejected: its `package.json` was missing 4 dependencies
  (`expo-application`, `expo-device`, `kscan-live-vto-native`, `posthog-react-native`),
  which would have produced a false baseline.
