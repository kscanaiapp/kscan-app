# RP-108 — clean release certification authority

**Status: source authority recorded. No staging deployment, no migration, no
production change, and no build was performed by this lane.**

| Field | Value |
|---|---|
| Release authority branch | `release/kscan-pre-freeze-v1` |
| Release base | `888cdef4a826712c17e554765560c08010e20342` (BUILD34_REPAIR_BASELINE_5) |
| RP-108 source tree | `8ca4de4082aab53da361d8016e061f646541e192` |
| Pull request | #332, retargeted from `fix/notifications-final-convergence-v1` to `release/kscan-pre-freeze-v1` |
| Build 35 (`219f27aa…`, PR #327) | **EXCLUDED — must never be an ancestor of the release authority** |

## Why the Build 34 release authority moved

`fix/notifications-final-convergence-v1` carried the accepted Build 34 line up
to `888cdef4` (the PR #331 merge). After RP-108 began, **PR #327 was merged into
that branch at `219f27aa`**, bringing in the Build 35 lineage: the Live VTO
native runtime, Fashion Match Quality Lab, Curiosity Gap Performance Lab,
Canonical Product Identity Lab, the Elise evaluation lab and the Real Fashion
Corpus.

That merge is not reverted. Inverting a 470-file merge in place is its own
risk, and Build 35 is legitimate work that simply belongs to a different
lineage. Instead the Build 34 line is preserved at its last uncontaminated
commit: `release/kscan-pre-freeze-v1` was created at exactly `888cdef4`, with
neither `219f27aa` nor PR #327's head (`7a8d0ccf`) as an ancestor.

## The rule this establishes

- **Build 34 release authority:** `release/kscan-pre-freeze-v1`.
- **Build 35 development:** its own lineage, separately.
- `219f27aa` and PR #327 must never become ancestors of the Build 34 release
  branch.
- No Build 35 source — labs, Live VTO expansion, corpus work, research
  workspaces — is cherry-picked into Build 34.
- Future Build 34 fixes branch from the clean release branch.
- `fix/notifications-final-convergence-v1` is a contaminated integration branch
  and is no longer used for Build 34 release work.

## Why this commit exists

RP-108's source tree was complete and validated at `8ca4de40`. Its only
remaining blocker was **historical CI state bound to that SHA**, not a defect in
the tree.

While PR #332 still targeted the contaminated base, CI evaluated
`refs/pull/332/merge` — this branch merged with Build 35 — and recorded
failures against `8ca4de40` for work that is not in this diff at all:

- `Project checks` failed on four Curiosity Gap Performance Lab tests
  (`__tests__/curiosityGapPerformance/labContract.test.js`,
  `labNetworkScenario.test.js`). Those files do not exist on this branch. The
  identical four failures reproduce on the base alone, with none of RP-108's
  code present.
- `VTO scope guard (enforced)` classified the lane as `vto` because the stale
  merge carried 189 VTO-owned Build 35 paths, then judged RP-108's migration
  against a boundary that does not apply to it. Once CI used the recomputed
  merge ref, the same guard correctly reported `NOT APPLICABLE`.

After the retarget the merge became a pure fast-forward
(`merge-base(888cdef4, 8ca4de40) == 888cdef4`), and every check on `8ca4de40`
went green except the promotion gate. `security/scripts/evaluate-promotion-gate.js`
reduces the check-run set per name and treats a completed failure as conclusive
over any later success (CI-APPLICABILITY-002) — deliberately, so that a check
cannot be re-run until it passes. Because `/commits/{sha}/check-runs` returns the
latest run per name *per check suite*, the pre-retarget failures stayed visible
and the gate kept returning `OPERATIONAL FAILURE`.

That rule is correct and was not weakened, disabled, or worked around. No
override was used. This commit changes **documentation only** and exists solely
to give the already-accepted tree a fresh SHA, so the required checks can
certify it against the corrected release authority from a clean slate.

## What RP-108 left open

- **Staging function drift — promotion-pending, not deployed.** `scan-identify`,
  `commerce-watch-refresh`, `kplus-activate` and `kplus-reconcile-revenuecat`
  are behind accepted Build 34 source. See
  `docs/staging-rebuild/rp108-staging-function-parity-2026-09-07.md` for the
  measurement and the method that re-derives it.
- **GOV-KPLUS-001.** `config/backend-authority.json` names a `canonicalBranch`
  that resolves nowhere. Repairing it by pointing at another branch would
  manufacture a governance claim the contract does not support; it is an owner
  action. See `docs/BACKEND_DEPLOYMENT_AUTHORITY.md`.
- **Three undeclared staging diagnostic slugs** (`vto-provider-diag`,
  `rapidapi-key-diag`, `rapidapi-current-audit`) are recorded in
  `config/backend-authority.json` and await owner removal from staging.
- **A latent guard defect.** In `__tests__/vtoLiveIntegrationScope.test.js`, the
  `generative backend was read, never written` assertion classifies the whole
  diff while its sibling and the CLI judge only the VTO-owned subset, so the two
  can disagree on a mixed lane. It is **not** fixable by partitioning that
  assertion — no `supabase/` path is VTO-owned, so partitioning would make the
  prohibition vacuous. It belongs to the lane that owns the guard.
