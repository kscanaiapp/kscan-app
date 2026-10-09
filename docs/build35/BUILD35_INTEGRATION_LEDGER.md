# Build 35 integration ledger

Recorded 2026-10-08 ET. Source/CI evidence only. No physical-device, signed-artifact or store evidence exists for any row.

## Feature coverage on `integration/build35-v1-convergence` @ `b791ce0f`

| Feature | PR | In integration | Release-enabled | Evidence class |
|---|---|---|---|---|
| Multi-image Scanner input foundation | #519 | yes | **no** (hold) | source, CI |
| Scanner selected-item results, per-item save | #526 | yes | **no** (hold) | source, CI, 640 focused tests |
| Release holds + Stylist Speech client gate | #525 | yes | n/a | source, CI, guard (66 tests) |
| ZAP baseline health target | #527 | yes | n/a | CI |
| Premium Value (Packing, Watchlist, K+ membership surfaces) | #520 | yes | **no** (hold) | source, CI |
| Contextual Elise VTO | #521 | yes | **no** (hold) | source, CI |

All held features are dark in both store profiles: `production` (the mandated store command) by absence plus the Today parent explicitly `false`, `build35-release` by explicit `false`. `scripts/check-build35-release-profile.js` validates both on every push; EAS remote `production` environment variables contain only `GOOGLE_SERVICES_JSON`, so no remote override can enable a hold.

## Cross-lane integration defects found only by combining the lanes

Per-lane CI cannot see these: git reports no conflict because the contract lives in separate JSON/registry files.

| ID | Sev | Lanes | Defect | Resolution |
|---|---|---|---|---|
| B35-INT-001 | P2 | #520 × #525 | #520's governance registry pins the Today flags of every EAS profile; #525 adds `build35-release` | pinned at `[false,false,false]` (`cfa1c2ba`) |
| B35-INT-002 | P2 | #520 × #521 | #521 intentionally changes 5 of the 53 protected `vto-generate` sources; the registry's SHA-256 digests drift | exactly those 5 digests refreshed; new `aiLabToolsProvider.ts` digest `8c6d78cf…` equals the backend manifest and the Staging readback (`144e8561`) |
| B35-INT-003 | P2 | #521 × Premium proof | contextual VTO changes the governed `stylechat-generate` source, so the Packing fingerprint moves `7131b140… → c4c643b5…` and the earned Packing runtime proof stops authorizing | fingerprints regenerated; pinned table set `packing = false` with no new evidence; Packing stays dark |
| B35-INT-004 | P2 | #520 × #521 | the two owner-listed shared files conflict: `__tests__/vtoLiveIntegrationScope.test.js`, `config/edge-function-manifest.json` | union of both authorized-path blocks; manifest regenerated from combined source, never hand-merged |
| B35-REL-003 | P3 | #525 | the mandated store command (`eas build --profile production`) was not guarded; only its derivative `build35-release` was | guard now verifies `production` in a semantic mode (holds absent/false, Today parent explicit `false`, Today children dormant only under it); `eas.json` deliberately unchanged because six suites pin production-by-absence and one pins the Today children as owner-authorized |

## Shared-surface reconciliation (owner-listed)
`__tests__/kplusCoreFreeBoundary.test.js` and `__tests__/vtoCustomerActivation.test.js` auto-merged; `__tests__/vtoLiveIntegrationScope.test.js` and `config/edge-function-manifest.json` were the only textual conflicts. Combined-source verification: premiumValueGovernance 37/37, premiumCapabilityFingerprint 21/21, kplusCoreFreeBoundary 5/5, vtoCustomerActivation 72/72, vtoLiveIntegrationScope 8/8, edgeFunctionSourceParity 23/23, vtoLiveFeatureGate 22/22, easConfigIntegrity 19/19, build35ReleaseProfile 66/66; combined `tsc --noEmit` exit 0.

## Exact-head CI at merge
- #520 `cfa1c2ba`: CLEAN, 31 pass / 10 skipping / 0 fail; Project checks `Observed failures: 13; known: 13; unexpected: 0`.
- #521 `7a1c5f37`: CLEAN, 30 pass / 17 skipping / 0 fail; `Observed failures: 13; known: 13; unexpected: 0`. One ZAP Baseline run failed operationally (container wrote no report) and passed on a rerun of that job; see B35-CI-007/008.
- Integration tip `b791ce0f` push CI: ZAP Baseline, ZAP API, Staging Security Gate, Promotion Gate, Code and Dependencies, Dependency Reachability, VTO Backend E2E and Release Profile Guard all `success`.
- Skipped jobs on PRs are only the dispatch-only/deploy jobs (Deploy staging candidate, Staging health, Synthetic auth, the VTO E2E dry-run/paid/cleanup modes), which cannot apply to a pull request.

## Pending PRs that would move the tip (all tests/docs/CI; none touches product source)
#531 ZAP bounded retry (CI), #532 Scanner executed proof (tests + docs), plus this documentation PR.
