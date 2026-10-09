# Build 35 security certification report

Recorded 2026-10-08 ET. Public-repository safe: contains no Production state, no schema inventory and no advisor detail. Production findings are delivered to the owner privately.

## 1. Exact-head workflows

Mobile integration tip `b791ce0f4027c61bedd384db6bce6415eeca9919` (push events), all `success`:

| Workflow | Run |
|---|---|
| Security - Promotion Gate | [37856550932](https://github.com/kscanaiapp/kscan-app/actions/runs/37856550932) |
| Security - Code and Dependencies (Gitleaks, Semgrep, OSV, Trivy, npm audit) | [37856550943](https://github.com/kscanaiapp/kscan-app/actions/runs/37856550943) |
| Security - ZAP Baseline Staging | [37856550904](https://github.com/kscanaiapp/kscan-app/actions/runs/37856550904) |
| Security - ZAP API Staging | [37856550891](https://github.com/kscanaiapp/kscan-app/actions/runs/37856550891) |
| K Scan Staging Security Gate | [37856550909](https://github.com/kscanaiapp/kscan-app/actions/runs/37856550909) |
| Dependency Reachability Gate | [37856551011](https://github.com/kscanaiapp/kscan-app/actions/runs/37856551011) |
| VTO Backend E2E (contract) | [37856550993](https://github.com/kscanaiapp/kscan-app/actions/runs/37856550993) |
| Build 35 Release Profile Guard | [37856551035](https://github.com/kscanaiapp/kscan-app/actions/runs/37856551035) |

Pull-request heads that were merged: #520 `cfa1c2ba` and #521 `7a1c5f37` each `CLEAN` with `Observed failures: 13; known: 13; unexpected: 0` (Linux regression); #527 `88a52ba3` 28 pass / 0 fail.

Backend authority `5f54104c`: PRs #529 (Staging probe) and #530 (behavioural tests) are open; #530 is fully green (32 pass / 14 skipping, `Observed failures: 7; known: 7; unexpected: 0`). #529 showed one unexpected failure in `migrationReplayConflicts` ("no migration references a schema-qualified object in a schema no migration creates") that passes 15/15 in isolation; recorded as B35-CI-008 (intermittent shared-pool test, no writer of the real migrations tree was found among the obvious candidates, which use temp directories).

## 2. Security controls verified this session

| Control | Evidence | Class |
|---|---|---|
| K+ Early Access is closed by default on the server (#528): two independent exact-`"true"` controls, checked after authentication and the active-account guard and before the grant RPC and any RevenueCat mirror | Staging `kplus-activate` v26 deployed through the governed workflow from `5f54104c`; live probe run 37852548431: controls absent, anonymous 401, invalid token 401, non-POST 405, eligible authenticated account `403 CAMPAIGN_CLOSED` twice, four entitlement tables unchanged (0 → 0), logs show 2 closed denials and 0 completions | STG-RT |
| Same control, behavioural | `campaignHold.test.ts` (3 tests) — 18 off-value combinations => zero grant and zero RevenueCat calls; mutation-checked (6 of 6 killed, including 3 that survived the old source-text test) | UNIT |
| Watchlist provider-dispatch entitlement guard (#524) | Staging `commerce-watch-refresh` v17, **16/16 files byte-identical** to the merged authority; `entitlementDispatch.test.ts` (7 tests): 14 denial shapes (false, null, malformed, HTTP errors with body `true`, non-JSON, truncated, network throw) => zero provider fetches, row writes, events and push lookups; mixed batch decided per user and per row; mid-request lapse; worker-secret gate; mutation-checked (7 of 7 killed) | UNIT, STG-RT |
| Unentitled actor is not claimed by the live Staging worker | run 37853116721: `claimed: 0`; seeded row untouched; 0 events, 0 push receipts; row deleted | STG-RT |
| Contextual VTO backend (#523) | Staging `vto-generate` v19 (18/18) and `stylechat-generate` v133 (52/52) byte-identical to the merged authority; independent hostile review: no model output reaches `vto-generate`; K+ and reservation enforced server-side; hash-bound garment; no automatic retry | UNIT, SRC |
| Store build holds | release guard validates `production` and `build35-release` on every push; remote EAS `production` environment contains only `GOOGLE_SERVICES_JSON` | CI |
| Migration provenance | six October migration versions present in both Staging and Production earlier today; no replay performed | read-only |

## 3. Findings

Open P0–P3 items are listed in `BUILD35_REPAIR_LEDGER.md` (statuses there are authoritative). Items that touch Production configuration are not reproduced in this public document.

Independent hostile reviews were run this session (K+ lifecycle, account-deletion lifecycle, backend invariants, multi-image Scanner). No P0 was found. Their P1–P3 findings are tracked by ID in the repair ledger and the defect register.

## 4. Gaps in this report (each resolves to FAIL for G05/G06/G08 until closed)
- No TestSprite run was made: the deployed-URL loop applies to backend functions, and the runtime probes above are the stronger bound controls; no mobile TestSprite exists.
- Deployed Production versions are not claimed here.
- The ZAP baseline remains a single-endpoint passive scan (B35-CI-004), complemented by the API scan.
- Two ZAP baseline operational failures were observed and repaired/mitigated (#527 merged; #531 open): both failed closed.
