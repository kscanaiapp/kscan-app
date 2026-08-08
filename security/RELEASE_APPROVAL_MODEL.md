# K Scan release approval model

This repository is operated by a single owner, with authorized build agents
also opening and merging PRs. GitHub does not allow a pull request author to
approve their own PR, so a "1 required approving review" branch rule is not
a security control here — it is an unusable merge gate that only a second
human account could satisfy. This document defines what replaces it, and is
deliberately explicit that **"merged to master"**, **"merged to staging"**,
and **"approved for production"** are three different things, decided by
different mechanisms. Neither `master` nor `staging/production-parity` is
itself "production" — production is a separate deploy target, reached only
through an explicit owner promotion decision, never through a branch merge
alone.

Applied by `security/scripts/apply-master-branch-ruleset.js` (this branch)
and the equivalent `apply-staging-branch-ruleset.js` on
`staging/production-parity` (that branch carries its own copy of this
document and this security tooling — `master` and `staging/production-parity`
are divergent codebases in this repository, not a fast-forward pair) via
GitHub repository rulesets. Both branches use the same operating model.

## MASTER MERGE APPROVAL

Merging a PR into `master` requires:

- an open pull request (direct pushes to the branch are blocked)
- **0 mandatory human approving reviews** — self-approval is not required,
  and none is asked for, so a PR authored by the owner or by an authorized
  agent is not stuck waiting on a reviewer identity that structurally cannot
  approve it
- the required automated checks below passing at the PR's exact head SHA
- all review conversations resolved
- the PR branch up to date with `master` (required status checks use the
  strict/"up to date" policy)
- force pushes and branch deletion blocked

The repository owner (or an authorized agent) still manually decides to
merge — automation never merges on its own — but that decision is not a
substitute code review. Required automated checks are the actual review
authority.

### Agent review (optional, non-gating)

`required_approving_review_count` is 0, so no review — human or agent — is
required to merge. An agent review MAY be used as an optional quality
practice on top of the required automated checks, but it is never a
substitute for them and it never bypasses a required check. If used, it
only carries weight when:

- the reviewer identity differs from the PR author
- all required PR checks (below) are green
- no unresolved Blocker/P0/P1 findings remain
- security evidence is present in the PR
- the reviewer records its reasoning in the review body
- the agent cannot bypass required checks
- production promotion remains owner-controlled regardless of any review

### Required master checks (PR merge gate)

Every name below is a real GitHub check-run `name:` as emitted by K Scan's
security workflows (verified against real check-runs on
`staging/production-parity`, since `master` has no check-run history of its
own — see the structural gap below). All are static/source/security/
configuration checks: they finish without requiring a live staging
deployment, so none of them make the merge gate depend on something that can
only happen after the merge (a deployment, a health probe, a dynamic scan).

| Check name | What it validates |
| --- | --- |
| `Project checks` | Existing privacy/auth/contract/security unit test suites |
| `Gitleaks` | Secret scanning |
| `Semgrep Community Edition` | Static analysis (custom + community rulesets) |
| `OSV-Scanner` | Dependency vulnerability scanning |
| `Trivy filesystem` | Filesystem vuln/secret/misconfig scanning |
| `npm audit` | Dependency vulnerability scanning |
| `Migration validation` | SQL syntax + destructive-operation checks on changed migrations |
| `Contract tests` | Mobile privacy/auth/contract test suites |

### Explicitly NOT required to merge into master

- Dynamic post-deployment checks (staging health, synthetic auth tests, ZAP
  Baseline/API, mobile TestSprite Android/iOS, the Pre-Publish Release
  Security Gate) — these run against an exact SHA once it is deployed to
  staging and govern production promotion eligibility, not a source-code
  merge decision.
- Any aggregate gate that itself waits on the dynamic checks above (e.g. a
  promotion-gate job) — requiring it at PR-merge time would transitively
  require a staging deployment to merge, which defeats the purpose of
  separating the merge gate from post-merge certification.
- Any required-check name not produced by a real, currently-existing job.
  Stale or fictional check names are never carried forward into this
  ruleset.

### Known structural gap: master has no CI history

As of this document, `master` has **no `.github/workflows` directory and no
workflow-run history at all** — every workflow run in this repository's
history has targeted `staging/production-parity` or a branch merging into
it. GitHub only evaluates `pull_request`-triggered workflow definitions from
a repository's *default* branch (`master` here), so none of the checks above
can currently produce a check-run against a PR into `master` until a
workflow-publishing change reaches `master` through some path. This ruleset
does not create that gap and does not weaken any check to work around it —
it requires the real checks so that once workflows exist on `master`, they
are enforced immediately, with no separate follow-up config change needed.
Until then, PRs into `master` will show these checks as outstanding
regardless of review count; that is a pre-existing CI-coverage gap, not a
governance-policy gap, and closing it (e.g. by publishing baseline
workflows to `master`) is a separate decision from this ruleset change.

## STAGING MERGE APPROVAL

`staging/production-parity` uses the same operating model as `master`
above: PR required, 0 mandatory approving reviews, required conversation
resolution, force pushes and branch deletion blocked, and a required-check
list of the same real static/source/security/configuration gates
(`Project checks`, `Gitleaks`, `Semgrep Community Edition`, `OSV-Scanner`,
`Trivy filesystem`, `npm audit`, `Migration validation`, `Contract tests`),
excluding the same dynamic post-deployment checks for the same reason.
Unlike `master`, staging's workflows actually exist and run on every PR, so
its required checks are live today.

## PRODUCTION RELEASE APPROVAL

Neither a `master` merge nor a `staging/production-parity` merge authorizes
production. Production eligibility for a given commit SHA requires all of
the following to be true for that **exact** SHA:

- the candidate SHA equals the SHA actually deployed to staging (no
  substituting results from a different commit)
- full staging security evidence passes (the static checks above, re-run
  against the deployed SHA)
- staging health checks pass
- authentication/permission persistence checks pass
- RLS/grant checks pass
- authorization-negative tests pass
- ZAP Baseline (staging) passes
- ZAP API staging passes
- artifact/exposed-key verification passes
- mobile TestSprite passes for Android
- mobile TestSprite passes for iOS
- the Pre-Publish Release Security Gate passes
- no unresolved blocking security findings exist for that SHA

Only when every item above is true is the SHA `promotion_eligible`. Reaching
`promotion_eligible = true` is still not production approval — the
repository owner must explicitly approve production promotion for that SHA.
No automation promotes to production on its own, and neither a `master` nor
a staging merge ever implies it.

```
PR checks pass (master or staging required checks, above)
  -> owner/authorized agent merges
  -> exact SHA deploys to staging
  -> automated security + mobile certification runs against that exact SHA
  -> promotion_eligible = true
  -> owner explicitly approves production promotion
  -> the exact same SHA may be promoted
```

## Scope note

This policy applies to `master` and `staging/production-parity` only. The
other branches covered by the `K Scan pre-merge security gate` ruleset
(`ios/full-submission-readiness-v2`, `integration/ios-v18-release-candidate`,
`integration/android-v27-closet-release-candidate`) are unchanged by this
document or by either `apply-*-branch-ruleset.js` script — they keep their
existing 1-required-approving-review rule.
