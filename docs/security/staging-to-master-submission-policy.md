# Staging-to-master submission policy

The governed staging branch is `staging/production-parity`; master is protected by live ruleset `20579400` (`K Scan Master Merge Gate (solo-owner)`). It requires a pull request, zero approvals, resolved conversations, strict current checks, no force push, no deletion, and has no bypass actors.

The existing master check contexts are real jobs emitted by the security workflows on a promotion PR: `Project checks`, `Gitleaks`, `Semgrep Community Edition`, `OSV-Scanner`, `Trivy filesystem`, `npm audit`, `Migration validation`, and `Contract tests`. `Security - Promotion Gate` is not a master required check.

`Staging Release Certification` creates `promotion/staging-<short-sha>` only after the candidate JSON says `promotion_eligible=true`. The branch is created at the certified SHA, never from the moving staging branch. It opens a PR to master and requests GitHub auto-merge; GitHub still enforces the master ruleset.

`Master Promotion Validation` calculates the predicted merge tree and fails unless it equals the certified promotion-branch tree. Before making that check required, run one promotion PR and confirm the exact emitted check name. This avoids adding an unproven required context. Until then, the promotion workflow refuses to enable auto-merge unless an automation owner has confirmed the master policy update.

The workflow requires a `PROMOTION_GITHUB_TOKEN` secret. It must belong to a GitHub App or automation identity permitted to create branches/PRs and to trigger normal `pull_request` workflows. The default `GITHUB_TOKEN` is deliberately not used for that action because its generated events do not start the required checks.

No workflow in this policy deploys production, applies production migrations, deploys production Edge Functions, or submits mobile builds.
