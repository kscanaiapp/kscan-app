# Staging security pipeline map

Snapshot date: 2026-08-06. Authoritative branch: `staging/production-parity`.
Starting SHA for this pass: `da3a4f468515494fe9008ce938c067cbc36d4087` (was the
exact HEAD of `origin/staging/production-parity` at the time this pass
started — no drift to reconcile).

This document is the source of truth for what each security workflow does,
what it emits, and how the pieces connect. Update it whenever a workflow's
trigger, job names, or check-run names change — `evaluate-promotion-gate.js`
and `apply-branch-ruleset.sh` both depend on check-run names matching exactly,
and mismatches here are exactly the "static check-name drift" failure mode
this funnel exists to prevent.

## Graph: event → workflow → job/check → candidate SHA → deployed SHA → artifact → consumer

```
push/PR to staging/production-parity
  └─ Security - Code and Dependencies (security-code.yml)
       candidate SHA: github.sha / PR head SHA (no staging deploy involved)
       jobs → check-run names:
         project-checks   → "Project checks"
         gitleaks         → "Gitleaks"
         semgrep          → "Semgrep Community Edition"
         osv              → "OSV-Scanner"
         trivy             → "Trivy filesystem"
         npm-audit        → "npm audit"
         security-summary → "Security summary" (aggregate only, NOT in
                             evaluate-promotion-gate.js's required list —
                             each scanner is required individually instead)
       artifacts: gitleaks/semgrep/osv/trivy/npm-audit report-<run_number>
       consumer: Security promotion gate (per-check, by name)

push/PR to staging/production-parity
  └─ K Scan Staging Security Gate (security-staging-gate.yml)
       candidate SHA: recorded per job, fail-closed if base branch
                       unresolvable
       deployed SHA: THIS WORKFLOW IS THE STAGING DEPLOYER for automatic
                      staging/production-parity pushes/PRs — deploy-staging
                      applies candidate migrations + deploys changed Edge
                      Functions to project yzqjvdfgefveprobvvyw, so
                      candidate SHA == deployed SHA for this run by
                      construction (both come from the same checkout).
       jobs → check-run names:
         classify-changes    → "Classify changed surfaces"
         migration-validation→ "Migration validation" (only if a migration
                                classification is present)
         deploy-staging       → "Deploy staging candidate" (environment:
                                staging; gated to staging/production-parity
                                push, PRs targeting it, or an explicitly
                                confirmed workflow_dispatch — never an
                                arbitrary branch)
         staging-health       → "Staging health checks"
         synthetic-tests       → "Synthetic auth tests"
         contract-tests        → "Contract tests" (runs regardless of deploy)
         staging-security-gate → "Staging security gate" (aggregate only,
                                 deliberately dropped from
                                 evaluate-promotion-gate.js's required list —
                                 its real children are required individually)
       artifacts: synthetic-staging-tests-<run_number>, staging deploy/
                  migration evidence under artifacts/staging-*/
       consumer: Security promotion gate; GitHub Deployments API records
                 this job's `environment: staging` run, which is now the
                 source of truth resolve-deployed-staging-sha.js reads for
                 ZAP's SHA binding (see below)

workflow_dispatch only (manual, one function at a time)
  └─ K Scan Staging Controlled Deploy (staging-controlled-deploy.yml)
       Independent, human-triggered staging deploy path — does not run
       automatically on push/PR. preflight → migration-plan →
       approved-single-migration → source-validation → deploy-one-function
       → health-check → synthetic-tests → rollback-on-failure →
       publish-deployment-artifact. Also runs under `environment: staging`,
       so it too contributes to the GitHub Deployments history
       resolve-deployed-staging-sha.js reads.

push/PR to staging/production-parity  (2026-08-06: branch-restricted; used
  to run for ANY branch — see "Repairs" below)
  └─ Security - ZAP Baseline Staging (zap-baseline-staging.yml)
       candidate SHA: PR head SHA / github.sha (or workflow_dispatch input)
       deployed SHA: resolved live via
                     security/scripts/resolve-deployed-staging-sha.js
                     (queries GitHub Deployments API for the latest
                     successful `staging` environment deployment) and
                     recorded in zap-out/diagnostics/run-context.json as
                     sha_match: candidate_sha === deployed_staging_sha.
                     A mismatch does not fail this report-only scan (it is
                     still validly probing whatever is live) but the run
                     cannot count as exact-SHA evidence when it disagrees —
                     downstream evidence/pre-publish logic enforces that.
       check-run name: "ZAP Baseline (staging)" — parens are load-bearing,
                        evaluate-promotion-gate.js matches on the literal
                        string.
       artifacts: zap-baseline-report-<run_number> (5 mandatory reports),
                  zap-baseline-diagnostics-<run_number> (always uploaded,
                  even when the report artifact is missing)
       consumer: Security promotion gate (deployment-required — legitimately
                 "skipped" when ZAP_STAGING_URL/ZAP_ALLOWED_HOST aren't
                 configured)

push/PR to staging/production-parity  (2026-08-06: branch-restricted; used
  to run for ANY branch with an unenforced protected_pr check — see
  "Repairs" below)
  └─ Security - ZAP API Staging (zap-api-staging.yml)
       Same candidate/deployed SHA resolution and diagnostics pattern as
       ZAP Baseline, against security/openapi/staging-api.yaml (9 Edge
       Function paths, single server = staging host only).
       check-run name: "ZAP API staging"
       artifacts: zap-api-report-<run_number>, zap-api-diagnostics-<run_number>
       consumer: Security promotion gate (deployment-required)

push/PR to any branch / workflow_run (four upstream workflows)
  └─ Security - Promotion Gate (security-promotion-gate.yml)
       Aggregates 12 required checks via
       security/scripts/evaluate-promotion-gate.js against one candidate
       SHA (fetched from the GitHub Checks API, not re-derived). Verdict:
       PASS / PASS WITH REPORT-ONLY FINDINGS / PENDING / BLOCKED /
       OPERATIONAL FAILURE. Runs on push/pull_request (workflow_run is kept
       for forward compatibility but has never once fired it — see the
       file's own header comment; master carries no .github/workflows so
       GitHub never evaluates workflow_run triggers defined only on other
       branches).
       artifacts: promotion-verdict-<run_number> (security/reports/
                  promotion-verdict.json + .md)
       consumer: humans, and (as of this pass) the Candidate Artifact
                 Exposure Gate / exact-SHA evidence bundle / Pre-Publish
                 Release Security Gate added below
```

## Required check-run name inventory (exact strings, per `evaluate-promotion-gate.js`)

**Always required** (must exist + conclude `success`/`skipped` on every push/PR):
`Project checks`, `Gitleaks`, `Semgrep Community Edition`, `OSV-Scanner`,
`Trivy filesystem`, `npm audit`, `Migration validation`, `Contract tests`.

**Deployment required** (must exist, but legitimately `skipped` when no live
staging deploy occurred in this run): `Staging health checks`,
`Synthetic auth tests`, `ZAP Baseline (staging)`, `ZAP API staging`.

**Deliberately dropped** (no job has ever produced these names —
requiring them would permanently block promotion): `Security baseline
comparison`, `Static security gate`, `Staging security gate`.

`apply-branch-ruleset.sh` previously listed a different, stale set of names
(`Project security checks`, `ZAP Baseline staging` without parens, both
dropped names, etc.) and never targeted `staging/production-parity` at all.
Fixed in this pass — see "Repairs" below.

## Repairs made in this pass

1. **ZAP Baseline operational failure (PRIMARY, the literal first blocker).**
   The health-check step curled `ZAP_STAGING_URL` verbatim — the bare
   Supabase project root — which Supabase serves as HTTP 404 by default.
   `security/scripts/validate-zap-target.js` already exported the correct
   fix (`deriveHealthCheckUrl` → `/auth/v1/health` when the path is bare
   root; `isAcceptableHealthStatus`) but the workflow never called it. Fixed
   by wiring both functions into the health-check step. The prior "no files
   were found" artifact-upload warning on the same run was a SECONDARY
   symptom (ZAP never started, so it never wrote report files) — not a
   separate root cause.
2. **Unbounded ZAP triggers.** Both ZAP workflows ran on every push to every
   branch (`zap-api-staging.yml` even computed a `protected_pr` flag that was
   never actually used to gate anything). Restricted both to
   `staging/production-parity` only (plus `workflow_dispatch` for manual
   use), and removed the dead `protected_pr`/`PROTECTED_BASE_BRANCHES` logic
   from `zap-api-staging.yml` since the trigger filter now does that job
   natively and correctly.
3. **No exact-SHA binding.** Neither ZAP workflow recorded what SHA was
   actually deployed to staging vs. what SHA triggered the scan. Added
   `security/scripts/resolve-deployed-staging-sha.js` (reads the GitHub
   Deployments API for the latest successful `staging` environment
   deployment) and wired both ZAP workflows to record `candidate_sha`,
   `deployed_staging_sha`, and `sha_match` in
   `zap-*-out/diagnostics/run-context.json` and the job summary.
4. **No mandatory diagnostics.** Neither ZAP workflow wrote the
   `zap-out/diagnostics/*` files required for a scan to be classified
   operationally successful independent of findings. Added `run-context.json`,
   `target-validation.txt`, `health-check.txt`, `docker-version.txt`,
   `zap-image.txt`, `zap-stdout.log`, `zap-stderr.log`, `zap-exit-code.txt`,
   `report-validation.txt` to both workflows, uploaded unconditionally
   (`if: always()`) in a separate artifact from the report bundle so
   diagnostics survive even when reports don't.
5. **No explicit report-validation step.** Added one to both workflows:
   checks every mandatory report file exists and, for the JSON report,
   parses. Failure here is classified distinctly from a missing-vars skip or
   an upstream ZAP exit-code failure.
6. **Stale branch ruleset.** `apply-branch-ruleset.sh` required 8+ status
   checks whose names no job has ever produced, and never targeted
   `staging/production-parity`. Fixed to the real check-run names and added
   the staging branch to the ruleset's ref list.
