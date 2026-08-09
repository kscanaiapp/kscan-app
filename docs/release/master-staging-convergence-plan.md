# Master/staging convergence plan

Status: internally consistent, fail-closed, and limited to staging/release automation. Production, Build 2.5 source, and quarantined functions are outside the authorized write set.

## Target model

Master is the governed downstream mirror of certified staging runtime content plus explicit master-only governance. Promotion compares a documented `RUNTIME_RELEASE_TREE`, not whole-tree history. Runtime source is never excluded merely because it differs.

## Safe to reconcile

| Source | Destination | Commit / file | Reason | Risk | Test | Rollback |
| --- | --- | --- | --- | --- | --- | --- |
| Current staging release controls | Staging PR, then master control-plane PR | Native evidence parser, certification builder/workflow, promotion validator | Remove unsupported mobile TestSprite assumptions and require actual native Android/iOS run evidence bound to the candidate SHA. | Medium: could block releases; fails closed by design. | Certification matrix, native parser, promotion tests, control-plane fixture. | Revert the control-plane PRs; no runtime or staging data changes. |
| Current shared promotion control | Staging PR, then master control-plane PR | Runtime release-tree projector and `master-promotion-validation.yml` | Preserve intentional master-only governance without ignoring any runtime surface. | Medium: projection omission could weaken the gate. | Inclusion/exclusion fixtures, unsafe divergence blocks, safe projection passes. | Revert both workflow/script commits; whole-tree check remains the prior fallback. |
| Existing documented Auth policy | Staging release policy | `security/staging/password-security-policy.json` | Record leaked-password screening as `REQUIRED_BLOCKING`; do not retry the plan-limited setting. | Low; preserves the stronger current policy. | Policy schema/certification tests. | Revert policy record; existing certification still blocks while HIBP is disabled. |
| Proven identical blobs | No content port | Five shared control-plane/fixture files listed in the provenance map | Record `ALREADY_EQUIVALENT`; cosmetic history convergence is unnecessary. | None | Blob SHA comparison. | Not applicable. |

## Requires port

No runtime port is autonomously safe in this pass. After the control-plane changes land on staging, the same promotion validator, release-tree script, and master validation workflow must be proposed to master through a separate protected PR so both sides enforce the same contract.

## Keep master-only

- `.github/workflows/master-required-checks.yml` and its master-governance regression coverage.
- Any other governance file whose trigger/permissions are specifically scoped to protected master.

## Keep staging-only

- Staging deployment, parity, synthetic-auth, ZAP, certification, and staging evidence controls.
- Current staging runtime until it satisfies the complete release contract. Keeping it on staging is not approval to promote it.

## Build 2.5 exclude

- Merge `d5ccc29`, its 20 direct second-parent contributions, and activation commit `1f9b452`.
- Master commits `19688e1`, `915e7dc`, `969d44a`, `2efee7c`, `813309d`, `39946ea` because their workflow is hard-pinned to `test/ios-build25-maestro-runtime`.
- All remote Build 2.5 branches. No branch is merged, rebased, cherry-picked, deleted, or modified.

These files remain included in runtime-tree computation where they are already present. “Exclude” means no reconciliation operation, not hiding them from certification.

## Quarantine exclude

- `privacy-controls` and `public-sale-share-opt-out` (Issue #46).
- `origin/product-match/foundation-v1`, `origin/product-match/foundation-v1-ios`, and product-match Issue #72.
- Quarantine manifests remain enforced. No function is deployed or restored.

## Owner-decision items

1. Decide whether the master scan gateway contract is obsolete, must be ported semantically into staging, or is superseded by reviewed staging behavior. Required evidence: contract-level tests against identical fixtures and security/privacy fields.
2. Decide whether master’s `/api/analyze` retirement is authoritative for the staging runtime. Staging currently retains callers and active behavior.
3. Establish deployment provenance and ownership for master’s Render/Resend waitlist and deletion-restoration email routes before any staging port.
4. Resolve the fact that Build 2.5 contribution and global EAS activation are already ancestors of the current staging head. This task cannot remove or certify that release line.
5. Provide/approve a complete maintained native Android and iOS runner covering the required implemented critical flows. The branch-neutral Maestro suite is incomplete; the only fuller iOS launcher is Build 2.5-specific and excluded.

## Execution sequence

1. Generate and regression-test the commit-level provenance snapshot.
2. Add exact native evidence semantics (`PASS`, `BLOCKED`, `PENDING`, `NOT_APPLICABLE`, `OPERATIONAL_FAILURE`) and required critical-flow inventory.
3. Replace TestSprite Android/iOS fields in certification and promotion validation with `native_android` / `native_ios`.
4. Add a tight runtime release-tree model and change the master check to compare that projection.
5. Run deterministic local security/release tests and workflow lint.
6. Open a protected staging PR. If green, open a separate protected master control-plane PR for the shared validator/tree contract. Do not enable bypass or direct-push.
7. A runtime certification remains blocked until both native platforms have completed exact-candidate runs, HIBP is enabled under the existing policy, runtime-tree convergence is proven, and owner provenance items are closed.
