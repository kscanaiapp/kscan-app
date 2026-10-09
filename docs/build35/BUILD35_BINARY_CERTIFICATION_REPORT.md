# FAIL

# Build 35 binary certification report

Recorded 2026-10-08/09 ET. Verdict rule: `OVERALL = PASS` iff G01–G13 are all PASS; unknown, blocked, not tested, skipped-required, missing evidence and not authorized all resolve to FAIL. Public-safe: live-environment detail is in the private owner report.

## Candidate authority
| | |
|---|---|
| Mobile integration SHA | `5311818f846ce1fd953528a143482d0ed0f0cb76` (`integration/build35-v1-convergence`; product source last changed by #521 merge `b791ce0f`; later merges are CI/tests only) |
| Backend authority SHA | `cfe64d131f5e5c8e858ef61e1b64712bbd18f66e` (`rebuild/backend-authority-v2`; function bundles identical to `5f54104c`) |
| iOS release SHA | none — no iOS production build exists (EAS remote build number 35; next 36) |
| Android release SHA | none — no Android production build exists (remote versionCode 33; next 34) |
| Staging deployment identity | `kplus-activate` v26, `commerce-watch-refresh` v17, `vto-generate` v19, `stylechat-generate` v133, `kplus-revenuecat-webhook` / `kplus-offer-redeem` / `kplus-revenuecat-pull-reconcile` / `purchase-import-extract` v1 — see the backend deployment ledger |
| Production deployment identity | withheld from this public file (private owner report) |

## Certification matrix

| Gate | Result | Evidence |
|---|---|---|
| G01 Authority | **PASS** | Live SHAs, merge commits, head-pinned merges and ancestry of the Build 34 final line and iOS v18 RC recorded in `BUILD35_AUTHORITY_LEDGER.md`. Note: four older lines (`master`, `android-v27`, `staging/production-parity`, `ios/full-submission-readiness-v2`) hold patch-unique commits not in Build 35 (70 / 91 / 143 / 53); that they are superseded was not audited and is an owner confirmation (it does not change provenance of this candidate) |
| G02 Source convergence | **PASS** | #520 (`059d1bdf`) and #521 (`b791ce0f`) merged on top of Scanner #526, release safeguards #525 and #527; owner-listed shared files reconciled; four cross-lane defects that per-lane CI could not see were found and repaired (B35-INT-001..004); combined `tsc` exit 0; no source discarded (`BUILD35_INTEGRATION_LEDGER.md`). Consequence recorded, not a loss: Packing's runtime proof stops authorizing (B35-INT-003) |
| G03 CI | **PASS** (for the two tips named above) | Mobile tip `5311818f`: all 8 push workflows `success` — [Promotion Gate 37876725343](https://github.com/kscanaiapp/kscan-app/actions/runs/37876725343), [Code and Dependencies 37876725341](https://github.com/kscanaiapp/kscan-app/actions/runs/37876725341) (Project checks: `Observed failures: 13; known: 13; unexpected: 0`, includes `tsc`, governed Deno tests, manifest parity), ZAP Baseline 37876725301, ZAP API 37876725335, Staging Security Gate 37876725364, Dependency Reachability 37876725333, VTO Backend E2E 37876725307, Release Profile Guard 37876725330. A newer tip would need its own run. Backend tip `cfe64d13`: Promotion Gate, Code and Dependencies, ZAP Baseline, ZAP API, Staging Security Gate, VTO Backend E2E, Dependency Reachability all `success`. Merged PR heads: Linux regression `unexpected: 0` each (#520, #521, #530, #531; open #529/#532 also 0) |
| G04 Backend | **PASS** | Required Staging functions deployed through the governed workflow and verified: `kplus-activate` v26, `commerce-watch-refresh` v17 (16/16 byte-identical), `vto-generate` v19 (18/18) and `stylechat-generate` v133 (52/52) unchanged and identical, plus the four K+ money-path functions at v1 (fail-closed `503 not_configured` / 401). `BUILD35_BACKEND_DEPLOYMENT_LEDGER.md`. Limit: the four are parity, not lifecycle certification (G06) |
| G05 Security | **FAIL** | Open P0–P3 items remain: see the OPEN rows of `BUILD35_REPAIR_LEDGER.md` (live-environment leg of SEC-B35-KPLUS-001 awaiting owner approval; DEL-01/DEL-02 deletion lifecycle P1s; K-02/K-03 purchase P1s; K-06 pending). Repaired and runtime-proven on Staging: the K+ Early Access hold (probe run 37852548431) and the Watchlist dispatch guard (13 of 13 mutants killed; live worker `claimed: 0`) |
| G06 Premium | **FAIL** | No K+ purchase / restore / lapse evidence on any device or store sandbox; store products lacked required metadata and Play credentials were not connected (earlier read-only snapshots); webhook and offer redemption not configured on Staging; Packing proof invalidated and its one remaining invocation is owner-gated; Watchlist active-K+ dispatch not run (would spend the held allowance). Holds themselves are implemented and verified (`production` and `build35-release` guard) |
| G07 Scanner | **FAIL** | 20-point matrix executed at unit level (640 tests, 11/11 mutants, 4 defects fixed) but every device-only item is unexecuted, and B35-SCAN-014 (P2, owner decision on provider spend) is open. Feature is held dark in the release profiles |
| G08 Elise/VTO | **FAIL** | Backend and zero-spend Staging controls pass (22 + 12 controls; hostile review: no P0–P3), but the mandatory paid generation (0 of 1) is not authorized and the consent/garment/person-photo journey was not executed on a device |
| G09 Cross-feature | **FAIL** | Journeys A–F not executed end to end on a device (`BUILD35_CUSTOMER_JOURNEY_MATRIX.md`) |
| G10 Platforms | **FAIL** | No physical iOS or Android device evidence (`BUILD35_NATIVE_DEVICE_REPORT.md`) |
| G11 Production safety | **FAIL** | Items not resolved or safely dispositioned: the account-deletion backlog (owner disposition and a closure path), the pending live deployment of the K+ hold, deletion lifecycle P1s. The Watchlist worker hold was verified at the flag and source level (details private) |
| G12 Artifacts | **FAIL** | No signed iOS (`eas build --platform ios --profile production`) or Android production artifact exists; no build authorization or expenditure approval was given |
| G13 Release integrity | **FAIL** | No binary exists to agree with the backend deployment and feature configuration; live backend deployment parity is incomplete |

# Work completed
- **PRs created:** #529 (K+ hold live probe), #530 (behavioural tests), #531 (ZAP retry), #532 (Scanner executed proof), #533 (this documentation record), draft #534 (DEL-01 repair), draft #535 (K-06 repair).
- **PRs repaired / refreshed:** #525 (production-profile guard), #520 (Today-row pin), #521 (shared-file reconciliation + governance fixups).
- **PRs merged by this session (head-pinned, after exact-head verification):** #527, #520, #521, #530, #531. #525 and #526 were merged outside this session's context; their exact-head state was re-verified as part of the integration tip's CI. Merging #532 was blocked by the auto-mode classifier and is left for the owner; #529 is deliberately held (see the deployment ledger).
- **Deployments completed (Staging, governed):** `kplus-activate`, `commerce-watch-refresh`, and four K+ functions. No Production deployment completed.
- **Tests completed:** probe 9, behavioural 10 (13/13 mutants), guard 66, ZAP retry contract 11 (9 negative controls), Scanner 640, shared-surface suites; independent hostile reviews of K+ lifecycle, deletion lifecycle, backend invariants and Scanner.

# Smallest sequence to PASS (owner authorization marked ⚑)
1. ⚑ Approve the pending governed live deployment of the K+ hold, then verify version and hash; only then merge #529.
2. ⚑ Disposition the deletion backlog (private report §4) and approve the closure path; repair DEL-01/DEL-02 (a migration is needed for the reconcile branch ⚑) and prove them on Staging.
3. ⚑ Decide K-02 (sandbox purchases / release-profile intent) and implement K-03; configure Staging RevenueCat secrets and run the purchase / renewal / lapse / refund / restore lifecycle with sandbox accounts.
4. ⚑ Complete App Store product metadata, connect the Play service account, and attach the K+ products.
5. ⚑ Reconcile provider accounts, then authorize the single Packing re-proof, the single paid VTO generation and the single active-K+ Watchlist dispatch — or explicitly declare those features out of the Build 35 launch scope (then G06–G08 become "hold verified end to end").
6. ⚑ Decide B35-SCAN-014.
7. Merge the remaining green PRs (#532, docs) and freeze the candidate SHA.
8. ⚑ Authorize and run `eas build --platform ios --profile production` and the Android production profile; validate the resolved environment with `--effective-env-json`; record build IDs and artifact hashes.
9. Execute the iOS and Android device matrices; attach evidence per row.
10. Re-read Production read-only, re-run this certification.

# Already repaired — do not repeat
Guard for the mandated `production` profile; Today-row pin; five-digest governance refresh; Packing pin; shared-file reconciliation; ZAP health-target repair (#527) and bounded retry (#531); K+ hold (#528) with Staging deployment, live probe and behavioural tests; Watchlist dispatch guard with Staging deployment, 16/16 readback and live worker proof; Staging parity of the four K+ functions; Scanner quota-pause, duplicate-asset, partial-save and detection-notice repairs (#526).
