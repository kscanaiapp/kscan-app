# Master/staging provenance map

Snapshot date: 2026-08-09. Repository: `kscanaiapp/kscan-app`.

This map distinguishes history divergence from release-content divergence. The machine-readable companion records every divergent commit and its first-parent change surface; this document groups those entries by functional purpose so the 543 divergent commits are not mistaken for 543 independent reconciliation operations.

## Snapshot

| Field | Value |
| --- | --- |
| Master | `4a9594acdd7ce81211e2d0ff379e2f04467e4968` |
| Staging | `571f6492bd7e9acfb7d6a556801d56f737cbaf7b` |
| Merge base | `a601adfa607a2a0c592f9dae07e448b5968aaddf` |
| Master-only commits | 41 |
| Staging-only commits | 502 |
| Master-only changed paths from merge base | 26 |
| Staging-only changed paths from merge base | 1,254 |
| Open PRs targeting master/staging at snapshot | 0 / 0 |

The current heads have different whole-tree identities (`a391d9d551946195980754d8b0d4098a1bbc413f` and `4849c54f924b0aeaff06d6d10d349b31a561b293`). A broad merge, rebase, or cherry-pick series is therefore not justified.

## Provenance clusters

| Cluster | Commits / evidence | Surface and equivalence | Build 2.5 / quarantine | Disposition |
| --- | --- | --- | --- | --- |
| Shared release governance | Master `3cc31ed`, `749a59d`, `e3cf869`, `cda5eaf` plus merge commits; staging PR 75/77/81/82 line | `configure-staging-auth-security.yml`, `master-promotion-validation.yml`, `promote-certified-staging.yml`, `validate-promotion-request.js`, and `constants/qaFixtures.js` have identical current blobs. `master-required-checks.yml` is intentionally master-only. | None | `ALREADY_EQUIVALENT` for identical blobs; `CONTROL_PLANE_ONLY` for master-only governance |
| Master scan gateway | `fc7fa00`, `2376dad`, `d07adea`, `2891215`, `7aff81d`, `18b0d78`, `51aef6f` | Master has a small gateway adapter/contract/validation layer. Staging has a much newer 3,500+ line scan-identify route and commerce/provider modules. Normalized behavior/security equivalence is not proven. | Product-match remote lines remain separate; no source was imported. | `REQUIRES_OWNER_DECISION` |
| Demo catalog default | `3a345a9` | Both heads default `INCLUDE_DEMO_CATALOG` to false and filter demo products; implementation arrived through different history. | None | `DUPLICATE_IMPLEMENTATION` (no port) |
| Legacy Render analysis retirement | `260219c` | Master returns 410 for `/api/analyze`; staging still has active callers and handler logic alongside scan-identify. This is content divergence with product impact. | None | `REQUIRES_OWNER_DECISION` |
| Transactional email/restoration | `22cf6d8`, `5846dfb`, `9bb0b57` | Master adds Render/Resend waitlist and deletion-restoration delivery. Staging does not contain `services/transactionalEmail.js`; current repository documentation also says the public website is external. Deployment authority/equivalence is unresolved. | Privacy/account behavior is security-relevant, but this is not Issue #46 source. | `REQUIRES_OWNER_DECISION` |
| QA fixture production gate | `08f0d0e` | `constants/qaFixtures.js` is blob-identical at both heads. | None | `ALREADY_EQUIVALENT` |
| Build 2.5 Maestro launcher | `19688e1`, `915e7dc`, `969d44a`, `2efee7c`, `813309d`, `39946ea` | Master workflow explicitly checks out `test/ios-build25-maestro-runtime` and runs `.maestro/flows/ios-build25/*`. It is not a branch-neutral native release runner. | Direct Build 2.5 dependency | `BUILD25_EXCLUDE` |
| Staging Build 2.5 contribution | Merge `d5ccc29`, its 20 second-parent contributions ending at `08015e7`, plus activation `1f9b452` | These commits are already ancestors of staging. This task neither removes nor promotes them. They remain in the runtime release tree, so a future runtime certification cannot hide them through projection. | Direct Build 2.5 | `BUILD25_EXCLUDE`; owner must resolve the staging-line provenance before promotion |
| Issue #46 quarantine | Staging quarantine manifests/policies and related commits including `4059439`, `1f3a76d`, `25e970d` | `privacy-controls` and `public-sale-share-opt-out` remain tracked and excluded from deployment. The control records are retained; quarantined source is not restored. | Direct Issue #46 control | `QUARANTINE_EXCLUDE` |
| Product-match / Issue #72 | `origin/product-match/foundation-v1` and `origin/product-match/foundation-v1-ios`; sample commits `de1bfc8`, `b2df581` | Neither sample commit is an ancestor of master or staging. Staging contains quarantine metadata, not this remote feature line. | Direct Issue #72 | `QUARANTINE_EXCLUDE` |
| Staging security/release control plane | Staging PR 58/70/71/73/75/77/81/82 families and per-commit entries in the companion | Staging-only workflows, security scripts, tests, and evidence documents are intentional release controls. Shared master files require explicit control-plane sync, not history rewriting. | Quarantine-touching entries are separately excluded. | `CONTROL_PLANE_ONLY` / `KEEP_FROM_STAGING` |
| Remaining staging runtime | Per-commit entries in the companion across app, server, Supabase, native modules, configuration, and dependencies | This is the current staging release line. It must pass exact-SHA deployment, native evidence, security, and runtime-release-tree equivalence as a unit. Individual history ports would discard dependencies. | Direct Build 2.5 entries are flagged separately and remain a blocker. | `KEEP_FROM_STAGING` pending certification |

## Content-equivalence evidence

Current-head blob identity proves history-only divergence for these shared files:

- `.github/workflows/configure-staging-auth-security.yml`
- `.github/workflows/master-promotion-validation.yml`
- `.github/workflows/promote-certified-staging.yml`
- `constants/qaFixtures.js`
- `security/scripts/validate-promotion-request.js`

Tree identity does not hold for either the repository as a whole or the runtime release surface. No manifest has been edited to normalize that fact.

## Release conclusion

Master can remain the governed downstream mirror of certified staging runtime content plus intentional master-only governance. Whole-tree equality is structurally wrong because master owns branch-specific required-check governance. The replacement is a tight `RUNTIME_RELEASE_TREE` projection that includes all app/server/native/Supabase runtime, migrations, runtime manifests, lockfiles, and security-sensitive runtime configuration. The projection cannot exclude Build 2.5 or quarantined runtime merely to obtain a pass.

Current state: history is understood, shared control-plane equivalence is proven, and runtime convergence remains blocked by ambiguous master-only runtime behavior plus Build 2.5 already present on staging.

Machine-readable traceability: `security/release/master-staging-provenance-map.json`.
