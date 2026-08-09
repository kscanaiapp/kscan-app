# Staging-to-master submission policy

The governed staging branch is `staging/production-parity`; master is protected by live ruleset `20579400` (`K Scan Master Merge Gate (solo-owner)`). It requires a pull request, zero approvals, resolved conversations, current required checks, no force push, no deletion, and has no bypass actors.

`Staging Release Certification` is read-only and emits the candidate-bound certification artifact. It classifies candidates as `RUNTIME_RELEASE` or `CONTROL_PLANE_CHANGE`. Runtime candidates require deployment, staging security validation, leaked-password protection, and actual native Android/iOS run evidence whose independently attested `tested_sha` equals the candidate. TestSprite frontend/backend evidence cannot satisfy the native requirement. Control-plane candidates may use `NOT_APPLICABLE` for runtime-only controls and may sync to master, but are never represented as production-certified runtime code.

`Promote certified staging` is the only workflow allowed to turn an agent `APPROVE` decision into a repository write. Before creating a branch, it downloads the named certification artifact and independently verifies the run, candidate identity, current staging head, tree, verdict, findings, quarantine result, and—on runtime releases—both mobile run identities and exact SHA evidence. Every invocation uploads a sanitized `release-decision.json`; rejected invocations create no branch or pull request.

An authorized candidate is written to the immutable `promotion/staging-<short-sha>` branch, opened as a pull request to master, and placed into normal auto-merge. No bypass or direct master push is used.

`Master Promotion Validation` emits the exact check name `Master promotion tree equivalence`. It compares the promotion branch tree with Git's predicted master merge tree. The check must be proven on a controlled bootstrap pull request and against an intentional mismatch before ruleset `20579400` is updated to require it.

The existing master check contexts are `Project checks`, `Gitleaks`, `Semgrep Community Edition`, `OSV-Scanner`, `Trivy filesystem`, `npm audit`, `Migration validation`, and `Contract tests`. A check is added to the ruleset only after GitHub has emitted and passed it under its exact name.

No workflow in this policy deploys production, applies production migrations, deploys production Edge Functions, runs EAS, or submits mobile builds.
