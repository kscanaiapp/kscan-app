# K Scan release approval model

This repository is operated by a single owner. GitHub does not allow a pull
request author to approve their own PR, so a "1 required approving review"
branch rule is not a security control here — it is an unusable merge gate
that only a second human account could satisfy. This document defines what
replaces it, and is deliberately explicit that **"approved to merge into
staging"** and **"approved for production"** are two different things,
decided by two different mechanisms.

Applied by [`security/scripts/apply-staging-branch-ruleset.js`](scripts/apply-staging-branch-ruleset.js)
via GitHub repository rulesets on `staging/production-parity`.

## STAGING MERGE APPROVAL

Merging a PR into `staging/production-parity` requires:

- an open pull request (direct pushes to the branch are blocked)
- **0 mandatory human approving reviews** — self-approval is not required,
  and none is asked for
- the required automated checks below passing at the PR's exact head SHA
- all review conversations resolved
- the PR branch up to date with `staging/production-parity` (required status
  checks use the strict/"up to date" policy)
- force pushes and branch deletion blocked

The repository owner still manually clicks Merge — automation never merges
on its own — but the owner's click is a deploy decision, not a substitute
code review. Required automated checks are the actual review authority.

### Agent review (optional, non-gating)

`required_approving_review_count` is 0, so no review — human or agent — is
required to merge. An agent review (e.g. via `/code-review`) MAY be used as
an optional quality practice on top of the required automated checks, but it
is never a substitute for them and it never bypasses a required check. If
used, it only carries weight when:

- the reviewer identity differs from the PR author
- all required PR checks (the table below) are green
- no unresolved Blocker/P0/P1 findings remain
- security evidence is present in the PR
- the reviewer records its reasoning in the review body
- the agent cannot bypass required checks
- production promotion remains owner-controlled regardless of any review

Because reviews are not required, an agent review is documentation of
diligence, not a gate — the ruleset does not check for its presence, and
its absence never blocks a merge.

### Required staging checks (PR merge gate)

Every name below is a real GitHub check-run `name:` as emitted by these
workflows — not the workflow title, and not the informal names GitHub
Actions once used before job renames. All of them are static/source/
security/configuration checks: they finish without requiring a live staging
deployment, so none of them make the merge gate depend on something that can
only happen *after* the merge (a deployment, a health probe, a dynamic scan).

| Check name | Source workflow | What it validates |
| --- | --- | --- |
| `Project checks` | Security - Code and Dependencies | Existing privacy/auth/contract/security unit test suites |
| `Gitleaks` | Security - Code and Dependencies | Secret scanning |
| `Semgrep Community Edition` | Security - Code and Dependencies | Static analysis (custom + community rulesets) |
| `OSV-Scanner` | Security - Code and Dependencies | Dependency vulnerability scanning |
| `Trivy filesystem` | Security - Code and Dependencies | Filesystem vuln/secret/misconfig scanning |
| `npm audit` | Security - Code and Dependencies | Dependency vulnerability scanning |
| `Migration validation` | K Scan Staging Security Gate | SQL syntax + destructive-operation checks on changed migrations |
| `Contract tests` | K Scan Staging Security Gate | Mobile privacy/auth/contract test suites |

This list is intentionally identical to `ALWAYS_REQUIRED_CHECKS` in
[`security/scripts/evaluate-promotion-gate.js`](scripts/evaluate-promotion-gate.js),
which documents its own independent verification of these exact names —
two separate reviews converging on the same list is a useful cross-check,
not a coincidence to simplify away.

### Explicitly NOT required to merge into staging

- `Staging health checks`, `Synthetic auth tests` — only meaningful once a
  real deploy has happened; they are post-merge staging certification.
- `ZAP Baseline (staging)`, `ZAP API staging` — dynamic scans against the
  live staging target for the deployed SHA, not the PR's source.
- `Security promotion gate` — an aggregate job that itself waits on the ZAP
  and deployment checks above. Requiring it at PR-merge time would
  transitively require ZAP/deployment to merge, which is exactly the
  coupling this policy avoids. (Confirmed live: on
  `staging/production-parity` @ `da3a4f4`, `Security promotion gate` is
  currently `failure` because `ZAP Baseline (staging)` and
  `Deploy staging candidate` failed — neither is a source-code defect in
  that commit.)
- `Candidate Artifact Exposure Gate` — carried in the previous branch
  ruleset's required-checks list but produced by no job in any workflow file
  and absent from every real check-run observed on this branch. Dropped as a
  stale/fictional name rather than preserved.
- Native Android/iOS release evidence and the Pre-Publish Release Security Gate
  — mobile certification and pre-publish gating belong to the production
  promotion decision below, not the staging PR merge.

## PRODUCTION RELEASE APPROVAL

A staging merge does **not** authorize production. Production eligibility
for a given commit SHA requires all of the following to be true for that
**exact** SHA:

- the candidate SHA equals the SHA actually deployed to staging (no
  substituting results from a different commit)
- full staging security evidence passes (the static checks above, re-run
  against the merged SHA, plus staging health)
- `ZAP Baseline (staging)` and `ZAP API staging` pass against the deployed
  SHA
- native release evidence passes for Android at the exact candidate SHA
- native release evidence passes for iOS at the exact candidate SHA
- the Pre-Publish Release Security Gate passes
- no unresolved blocking security findings exist for that SHA

Only when every item above is true is the SHA `promotion_eligible`. Reaching
`promotion_eligible = true` is still not production approval — the
repository owner must explicitly approve production promotion for that SHA.
No automation promotes to production on its own, and a staging merge never
implies it.

```
PR checks pass (staging required checks, above)
  -> owner merges to staging
  -> exact SHA deploys to staging
  -> automated security + mobile certification runs against that exact SHA
  -> promotion_eligible = true
  -> owner explicitly approves production promotion
  -> the exact same SHA may be promoted
```

Native mobile evidence and the Pre-Publish Release Security Gate are part of this
funnel once their workflows are merged (tracked separately; not yet present
on `staging/production-parity` as of this document). Until then, production
eligibility is governed by the staging security/health/ZAP evidence above —
absence of a not-yet-merged gate is not treated as automatic passing
evidence for anything it would have covered.

## Scope note

This policy applies only to `staging/production-parity`. Production
protections (`master`) and the other branches still covered by the
`K Scan pre-merge security gate` ruleset (`ios/full-submission-readiness-v2`,
`integration/ios-v18-release-candidate`,
`integration/android-v27-closet-release-candidate`) are unchanged by this
document or by `apply-staging-branch-ruleset.js` — they keep their existing
1-required-approving-review rule.
