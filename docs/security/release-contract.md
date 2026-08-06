# Staging-to-production release contract

This is a contract for a **future** step. No production deployment,
production scan, or production credential use happens as part of this
document or the pass that wrote it — see "Safety" in the accompanying final
report for what was and wasn't touched.

## The contract

```
exact SHA validated in staging
  → exact SHA passes the Pre-Publish Release Security Gate
    → owner approval recorded
      → the SAME exact SHA becomes production eligible
        → production deployment handled separately (not by this funnel)
          → production health verification only
```

**No source, dependency, configuration, migration, environment, or artifact
change may occur between staging approval and production promotion.** Any
change — however small — creates a new candidate. A new candidate requires
the full chain again: static/secret/dependency scans, candidate artifact
exposure scan, staging deployment, staging health, synthetic auth,
authorization-negative tests, ZAP Baseline + API, exact-SHA evidence, and a
fresh Pre-Publish Release Security Gate run. There is no partial-credit path
— a re-tagged or rebuilt artifact of "the same" commit is not the same
candidate unless the SHA is bit-for-bit identical.

## What "exact SHA validated in staging" means operationally

A candidate SHA is validated in staging when, for that **exact** SHA:

1. All `ALWAYS_REQUIRED_CHECKS` and `DEPLOYMENT_REQUIRED_CHECKS` in
   `security/scripts/evaluate-promotion-gate.js` report `success` or a
   legitimate `skipped` (see `docs/security/staging-security-pipeline-map.md`
   for the exact list — 9 always-required including the Candidate Artifact
   Exposure Gate, 4 deployment-required).
2. `Security - Promotion Gate` records `finalVerdict: PASS` or
   `PASS WITH REPORT-ONLY FINDINGS` for that SHA.
3. `Security - ZAP Baseline Staging` and `Security - ZAP API Staging` both
   ran operationally successfully AND recorded `sha_match: true` in their
   diagnostics — i.e. the dynamic scan actually validated what's deployed on
   staging, not an unrelated SHA (see `docs/security/staging-security-pipeline-map.md`
   "Repairs made in this pass" for why this binding didn't exist before).

## What "passes the Pre-Publish Release Security Gate" means

`security/scripts/build-security-evidence.js` assembles the exact-SHA
evidence bundle from the above, and
`security/scripts/build-pre-publish-verdict.js` derives one of `PASS`,
`PASS WITH REPORT-ONLY FINDINGS`, `BLOCKED`, or `OPERATIONAL FAILURE` from
it. Only the first two make `promotion_eligible: true`. See
`.github/workflows/pre-publish-release-security-gate.yml` — it is
`workflow_dispatch`-only, run deliberately by a human naming the exact
`candidate_sha`, never automatically for arbitrary pushes.

**Current honest limitation:** `rls_and_grants` is reported as `NOT_WIRED`
(no CI job collects the live RLS/grant snapshot `anon-grant-guard.js` and
`rls-storage-guard.js` need — see the pipeline map's capability-gap table),
and `authorization_negative_tests` is reported as `PARTIAL_COVERAGE` (the
existing `synthetic-staging-tests.js` covers several but not all of Phase
11's required negative-test categories — see the same doc). Both are
treated as blocker-tier dimensions in `build-pre-publish-verdict.js`, so
`promotion_eligible` will not read `true` until they're closed. This is
intentional fail-closed behavior, not a bug: an unproven claim must not
count as a passed check.

## What "owner approval recorded" means

Nothing in this pass automates approval. A human owner reviews the
Pre-Publish verdict artifacts (`pre-publish-security-verdict.json/.md` and
the linked evidence bundle) and records approval through whatever
out-of-band mechanism the team already uses (PR approval, a signed-off
issue comment, a deploy ticket) — `promotion_eligible: true` is a
precondition for approval, not the approval itself.

## What happens after approval

Production deployment and production health verification are explicitly
**out of scope for this funnel and this pass**. They are a separate,
not-yet-built pipeline this contract reserves space for. When that pipeline
exists, it must consume the exact `candidate_sha` this contract validated —
never rebuild, never re-tag, never substitute a "close enough" commit.
