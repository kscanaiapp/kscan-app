# `rebuild/backend-authority-v2` — provenance

**BACKEND-AUTHORITY-RECOVERY-05A, 2026-09-08.** This branch is a deliberately
reconstituted canonical backend deployment authority, created after Repair 05
exhaustively proved the former canonical branch, `rebuild/staging-v2-backend`,
unrecoverable.

## Why this branch exists

GOV-KPLUS-001 (first raised alongside `config/backend-authority.json` itself,
re-confirmed by RP-108 on 2026-09-07, and independently re-confirmed with a
broader search by Repair 05 on 2026-09-08 —
`docs/staging-rebuild/repair05-canonical-authority-reconfirmation-2026-09-08.md`)
established that `rebuild/staging-v2-backend` resolves nowhere: not on
`origin`, not as a local branch, not in reflog, not as any other ref or tag in
this repository. Repair 05 additionally enumerated every branch that then
self-declared `role: "backend-deployment-authority"` (12 found) and confirmed
none was both current and held proven, exclusive backend lineage — 11 were
already absorbed as ancestors of `release/kscan-pre-freeze-v1`, and the 12th
was a stale merge 605 commits behind.

Repair 05 declined to repair the gap by re-pointing `canonicalBranch` at any
of those candidates, since none carried the lineage proof the governance
contract requires — doing so would have manufactured a governance claim
instead of stating one. Its recorded next action was: either recover the
original branch's post-2026-08-05 history from wherever it still lives outside
this repository's reachable refs, or bootstrap a fresh authority from the
current, already-certified backend snapshot. This branch is that second path.

## What this branch is

`rebuild/backend-authority-v2` branches from `release/kscan-pre-freeze-v1` at
the exact commit `e1bc60565678bcdaa216b76a3ceea437f003e35f` — the Repair 05
merge, itself unchanged from the RP-108-certified governed backend snapshot at
`888cdef4a826712c17e554765560c08010e20342`. Confirmed immediately before
branching:

- `git diff --stat 888cdef4 e1bc6056 -- supabase/functions/` → **empty**. No
  governed function's source changed between RP-108's certification and this
  branch's base commit.
- `node scripts/verify-backend-authority.js --json` on that base → governed
  count `23/23`, no missing/ungoverned source directories, manifest current.
- `node scripts/generate-edge-function-manifest.js --check` → PASS.
- All nine functions named in the BACKEND-AUTHORITY-RECOVERY-05A mission
  (`scan-identify`, `commerce-watch-refresh`, `kplus-activate`,
  `kplus-reconcile-revenuecat`, `stylechat-generate`, `vto-generate`,
  `apple-credential-link`, `apple-revoke-credential`, `handle-user-deletion`)
  confirmed present in `GOVERNED_FUNCTIONS`.
- No commit touches `supabase/` between the Repair 05 merge and this branch's
  base — they are the identical commit.

**This branch's `supabase/functions/**`, `supabase/migrations/`, and
`config/edge-function-manifest.json` are therefore byte-identical to the
already-certified snapshot at the moment of branching.** No backend function
behavior was created, altered, or deployed to produce this authority — only
`config/backend-authority.json` and this documentation were changed, on this
branch, after branching.

## What changed, and nothing else

`config/backend-authority.json` on this branch (only):

| Field | Before (inherited from release line) | After (this branch) |
|---|---|---|
| `role` | `integration-convergence-non-authoritative` | `backend-deployment-authority` |
| `canonicalBranch` | `rebuild/staging-v2-backend` (unresolvable) | `rebuild/backend-authority-v2` (this branch, self-resolving) |
| `approvedProjectRef` | `yzqjvdfgefveprobvvyw` | **unchanged** |
| `governedFunctionCount` | `23` | **unchanged** |
| `notGoverned` (full governed/ungoverned function inventory) | — | **unchanged, byte-identical** |
| `note`, `canonicalBranchNote` | described the old non-authoritative / unresolvable state | rewritten to describe this branch's role and cite this document — the old prose was no longer true and leaving it would have been actively misleading, not neutral |

Nothing under `supabase/functions/**` was touched. No migration was touched.
`config/edge-function-manifest.json` was **not** regenerated: the manifest's
own recorded provenance field is explicitly documented as "informational
only. Excluded from every parity comparison because it differs per branch" —
the governance tooling itself proves a metadata-only authority transition
(this one) does not require a manifest regeneration, because the manifest's
content hash is derived from `supabase/functions/**`, which is unchanged. That
was confirmed, not assumed, before deciding not to touch the manifest.

## Verification run on this branch after the bootstrap commit

- `node scripts/verify-backend-authority.js --json` → `role:
  backend-deployment-authority`, `canonicalBranch: rebuild/backend-authority-v2`,
  canonical branch resolves locally (and on `origin` once pushed), HEAD
  descends from it (self-referential — the branch's own HEAD is its own
  canonical tip), governed/source `23/23`, working tree clean, **no
  findings**.
- `node scripts/deploy-edge-functions.js` (no `--confirm-deploy`, dry run
  only) → Step 1/7 **PASS** — this checkout is recognized as the deployment
  authority. No later step was allowed to reach the Supabase CLI; nothing was
  deployed.
- `node scripts/generate-edge-function-manifest.js --check` → PASS, unchanged.
- Backend governance and Edge Function source-parity test suites: see the
  PR description for the exact pass counts.

## What this branch does not do

- Does not deploy anything, to staging or production.
- Does not touch any secret or environment variable.
- Does not implement terminal account-deletion status.
- Does not build iOS.
- Does not make `release/kscan-pre-freeze-v1` authoritative — that branch's
  `role` remains `integration-convergence-non-authoritative` and its own
  `scripts/deploy-edge-functions.js` Step 1 was re-verified to still refuse.

## Going forward

This branch is now the governance boundary for backend deployment. Future
backend work that needs to reach staging or production is made here (or on
its own maintenance branches, following its established convention), verified
with `scripts/verify-backend-authority.js` and the governed test suites, and
deployed only through `scripts/deploy-edge-functions.js`'s guarded path. It is
not a mobile integration branch and should not accumulate iOS/Android
application code.
