# Post-merge exact-SHA validation runbook

PR #56 cannot produce matching staging evidence while its SHA has not been
deployed — `sha_match` was confirmed `false` for every ZAP run against this
PR during this pass (candidate SHA `b7d3795...`, deployed SHA was whatever
staging already had live from an earlier commit). This is expected, not a
bug: the fix is to run the real chain below **once the PR merges**, not to
fake a match now.

This document is the exact sequence to run immediately after PR #56 (or any
future PR into `staging/production-parity`) merges. No step here has been
run for real yet — it is a runbook, not a report of completed work.

## Sequence

| # | Step | Workflow / script | Required inputs | Expected artifact |
| --- | --- | --- | --- | --- |
| 1 | Resolve the new merge SHA | `git rev-parse origin/staging/production-parity` after the merge lands | none | merge commit SHA |
| 2 | Treat that merge SHA as the candidate SHA | — | merge SHA from step 1 | `candidate_sha` |
| 3 | Deploy that exact SHA | `K Scan Staging Security Gate` (`security-staging-gate.yml`, `deploy-staging` job) — fires automatically on push to `staging/production-parity`, or `K Scan Staging Controlled Deploy` (`staging-controlled-deploy.yml`) for a single-function manual deploy | `staging/production-parity` push event, or `workflow_dispatch` with `function_name` | `staging-deploy-<run>` / deployment manifest artifact |
| 4 | Record the deployed SHA | GitHub Deployments API (`environment: staging`), read by `security/scripts/resolve-deployed-staging-sha.js` | none — automatic | `deployedSha` in every downstream diagnostics file |
| 5 | Verify candidate SHA equals deployed SHA | `security/scripts/resolve-deployed-staging-sha.js`, consumed by both ZAP workflows' "Resolve candidate and deployed staging SHA" step | candidate SHA, `GITHUB_TOKEN` | `sha_match: true` in `zap-out/diagnostics/run-context.json` and `zap-api-out/diagnostics/run-context.json` |
| 6 | Run staging health | `Staging health checks` job (`security-staging-gate.yml`) | staging deploy success | check-run `Staging health checks` |
| 7 | Run synthetic authentication | `Synthetic auth tests` job → `security/scripts/synthetic-staging-tests.js` | `STAGING_SYNTHETIC_*` secrets | `synthetic-report.json` |
| 8 | Verify permission persistence and onboarding completion | Covered by `synthetic-staging-tests.js`'s "active-user request succeeds" + `security-staging-gate.yml`'s contract-tests job (`test:privacy`, `test:auth-privacy`) | same as step 7 | same artifacts |
| 9 | Run authorization-negative tests | `Authorization-negative tests` job (`security-staging-gate.yml`) → `security/scripts/authorization-negative-tests.js` | `STAGING_SYNTHETIC_*` secrets | `authorization-negative-report.json`; `coverage` must read `PASS`, not `PARTIAL_COVERAGE` |
| 10 | Run live RLS and grant verification | `Security - Live Staging Verification` (`live-staging-security-verification.yml`) → `security/scripts/verify-live-staging-security.js` | `SUPABASE_ACCESS_TOKEN` secret | `live-staging-verification-report.json`; `overall` must read `PASS` — this is the run that proves `supabase/migrations/20260806140000_close_unintended_anon_rpc_surface.sql` actually took effect |
| 11 | Run ZAP Baseline | `Security - ZAP Baseline Staging` (`zap-baseline-staging.yml`) | `ZAP_STAGING_URL`/`ZAP_ALLOWED_HOST` vars | `zap-baseline-report-<run>`, `zap-baseline-diagnostics-<run>` |
| 12 | Run ZAP API safe scan | `Security - ZAP API Staging` (`zap-api-staging.yml`) | `security/openapi/staging-api.yaml` | `zap-api-report-<run>`, `zap-api-diagnostics-<run>` |
| 13 | Validate mandatory reports | Built into both ZAP workflows' "Validate mandatory reports" step | steps 11–12 | `report-validation.txt` in each diagnostics artifact |
| 14 | Generate exact-SHA evidence | `security/scripts/build-security-evidence.js`, given `--promotion-verdict`, both ZAP `run-context.json`/report files, and the artifact-exposure report for this exact SHA | outputs of steps 5, 9–13, 15 | `security-evidence.json`, `security-evidence.md`, `security-evidence-manifest.json` |
| 15 | Run the Candidate Artifact Exposure Gate against the same SHA | `Security - Candidate Artifact Exposure Gate` (`candidate-artifact-exposure-gate.yml`) — already runs on every push, including the merge commit | none beyond checkout | `candidate-artifact-exposure-report-<run>` |
| 16 | Run the Pre-Publish Release Security Gate | `Security - Pre-Publish Release Security Gate` (`pre-publish-release-security-gate.yml`), `workflow_dispatch` with `candidate_sha` = the merge SHA from step 1 | `candidate_sha` input; steps 1–15 all completed for that exact SHA | `pre-publish-verdict-<run>` (verdict json/md + 6 category summaries) |
| 17 | Establish the initial ZAP findings baseline — **only after the full chain above succeeds** | Manual: follow `docs/security/zap-baseline-record.md` | steps 11–13 operationally successful AND `sha_match: true` for that exact run | `security/zap/zap-findings-baseline.json` updated, `baseline_established: true` |

## Stop conditions

Do not proceed past the step that fails. In particular:

- If step 5 (`sha_match`) is ever `false` for a run intended to represent
  the merge SHA, stop — something deployed a different commit than
  expected, or the deployment step itself failed. Do not continue to steps
  6+ using that run's evidence.
- If step 9 or step 10 reports anything other than `PASS`
  (`PARTIAL_COVERAGE`, `NOT_CONFIGURED`, `FAIL`, or `OPERATIONAL_FAILURE`),
  stop before step 16 — `build-pre-publish-verdict.js` already treats both
  as blocker-tier dimensions and will correctly compute
  `promotion_eligible: false`, but do not manually override that.
- If step 16's verdict is `BLOCKED` or `OPERATIONAL FAILURE`, do not
  proceed to step 17 (see "Do not baseline" rules in
  `docs/security/zap-baseline-record.md`) and do not treat the candidate as
  production-eligible regardless of how individual steps looked.
- Never substitute a different commit's evidence for a step that failed —
  re-run the SAME step for the SAME SHA, or start a new candidate.

## Rollback behavior

- **Deploy step (3) fails or step 6 (health) / step 9 fails post-deploy:**
  `security-staging-gate.yml` has no automatic rollback path today (that
  exists only in `staging-controlled-deploy.yml`'s `rollback-on-failure`
  job, which is scoped to its own single-function manual-deploy flow, not
  the automatic push-triggered deploy in `security-staging-gate.yml`). If
  the automatic staging deploy leaves staging in a bad state, use
  `staging-controlled-deploy.yml`'s manual path to redeploy a known-good
  prior function version, or revert the merge commit on
  `staging/production-parity` and let the revert redeploy naturally.
- **Any step 11–16 operational failure:** does not require a rollback —
  these are read-only scans/checks against whatever is already deployed.
  Fix the operational issue (see `docs/security/staging-security-pipeline-map.md`
  "Repairs made in this pass" for the ZAP-specific failure modes already
  closed) and re-run that step for the same SHA.
- **A genuine security finding at any step:** do not roll back
  automatically — a finding needs triage (confirmed vulnerability vs. false
  positive, per `docs/security/zap-baseline-record.md`'s classification
  scheme) before deciding whether a revert is warranted. Automatically
  reverting on any report-only finding would make the funnel too noisy to
  trust.

## Explicit non-goals

Nothing in this sequence deploys to production, runs ZAP against
production, or grants production eligibility on its own. Step 16's `PASS`
/ `PASS WITH REPORT-ONLY FINDINGS` verdict means the candidate is *eligible
for owner approval* (see `docs/security/release-contract.md`) — it is not
itself an approval, and no production action follows from it
automatically.
