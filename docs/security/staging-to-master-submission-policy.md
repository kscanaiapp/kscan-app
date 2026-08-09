# Staging-to-master submission policy

The governed staging branch is `staging/production-parity`; master is protected by live ruleset `20579400` (`K Scan Master Merge Gate (solo-owner)`). It requires a pull request, zero approvals, resolved conversations, strict current checks, no force push, no deletion, and has no bypass actors.

The existing master check contexts are real jobs emitted by the security workflows on a promotion PR: `Project checks`, `Gitleaks`, `Semgrep Community Edition`, `OSV-Scanner`, `Trivy filesystem`, `npm audit`, `Migration validation`, and `Contract tests`. `Security - Promotion Gate` is not a master required check.

`Staging Release Certification` records whether a candidate is promotion-eligible, but it does not create a branch, open a master PR, request auto-merge, or promote staging. A future, separately reviewed promotion pass must create any `promotion/staging-<short-sha>` branch from the recorded immutable SHA and use normal GitHub protection.

`Master Promotion Validation` calculates the predicted merge tree and fails unless it equals the certified promotion-branch tree. Before making that check required, run one promotion PR and confirm the exact emitted check name. This avoids adding an unproven required context. Until then, the promotion workflow refuses to enable auto-merge unless an automation owner has confirmed the master policy update.

No promotion credential is consumed by this certification workflow. Promotion credentials and master automation remain out of scope until the master tree-equivalence check has been independently bootstrapped and reviewed.

No workflow in this policy deploys production, applies production migrations, deploys production Edge Functions, or submits mobile builds.
