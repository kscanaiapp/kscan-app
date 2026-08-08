# Promotion gate audit — 2026-08-08

## Scope and evidence

The audit used the current staging head `cf117f6e4d72ae58e27ccacc124f8075d2ab9226` and GitHub Actions run metadata/logs. The old gate is not authoritative for release eligibility: it inferred state from concurrently-started workflows and check-run names.

| Run | Workflow | Result | Classification | Evidence |
| --- | --- | --- | --- | --- |
| 31258368922 | K Scan Staging Security Gate | failure | REAL_STAGING_FAILURE | `Deploy staging candidate` matched its own grep guard at workflow line 252 before any deployment write. |
| 31258368949 | Security - ZAP Baseline Staging | failure | SCANNER_OPERATIONAL_FAILURE | The approved staging host returned HTTP 404 at `/`; the workflow treated a reachable HTTP response as unreachable, then failed artifact upload because no report existed. |
| 31258368916 | Security - Promotion Gate | failure | WORKFLOW_RACE / CHECK_NAME_DRIFT | It polled independently-triggered checks and converted the ZAP operational failure into a gate failure rather than evaluating candidate-scoped evidence. |
| 31236369479 | K Scan Staging Security Gate | failure | REAL_STAGING_FAILURE | Same self-matching deployment guard signature. |
| 31236369500 | Security - Promotion Gate | failure | WORKFLOW_RACE | Same asynchronous check-run aggregation pattern. |
| 31063647022 | Security - Promotion Gate | failure | CHECK_NAME_DRIFT / WORKFLOW_RACE | Historical run retained the same aggregate-gate failure shape. |

The final two labels are based on the workflow source and check-run inventory, not a claim that a scanner found a vulnerability.

## Decision

`Staging Release Certification` is the sole promotion decision on a merged staging candidate. Its jobs have explicit `needs` dependencies, emit one candidate-scoped JSON contract, and classify every component as `PASS`, `PASS_WITH_REPORT_ONLY_FINDINGS`, `PENDING`, `NOT_APPLICABLE`, `BLOCKED`, or `OPERATIONAL_FAILURE`.

The legacy `Security - Promotion Gate` is retained only for legacy/manual use and is no longer a staging push release authority. Missing and pending independent check-runs cannot substitute for exact candidate evidence.
