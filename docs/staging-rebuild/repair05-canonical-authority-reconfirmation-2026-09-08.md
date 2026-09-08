# Repair 05 — canonical backend deployment authority reconfirmation

**As of 2026-09-08.** Independent re-verification of GOV-KPLUS-001, run against
`release/kscan-pre-freeze-v1` @ `0ebc86a0359fc76b6ab08d50768ba12b816a436d` — one
day after, and starting from a fresh `git fetch`, not from RP-108's own working
tree. **Conclusion unchanged: outcome C, no trustworthy canonical backend
source exists.** No canonicalBranch value was changed. No deployment, no
migration, no secret, no iOS build.

## What this lane checked that RP-108 (2026-09-07) had not

RP-108 established that `rebuild/staging-v2-backend` resolves on neither
`origin` nor any checkout it could reach, and declined to re-point
`canonicalBranch` at another ref for lack of evidence any published branch
holds that authority. This lane re-ran that same resolution search from
scratch and additionally **enumerated every branch that currently
self-declares `role: "backend-deployment-authority"`** — the one signal that
could have surfaced a live, still-current authority checkout under a
different name.

### 1. `rebuild/staging-v2-backend` — still unresolvable

```
git branch -r --list "*staging-v2-backend*"   → (empty)
git branch    --list "*staging-v2-backend*"   → (empty)
git ls-remote origin                          → no matching ref, head or tag
git reflog show --all | grep staging-v2-backend → (empty)
```

Not a local branch in this checkout, not another remote ref or tag, not a
stale local worktree reachable from here. `f799cdf5` — the commit
`docs/staging-rebuild/backend-authority-manifest.md` names as the branch's own
base (`branched from staging/production-parity @ f799cdf`) — does exist in
this repository's history, but no ref currently points at, or descends
uniquely from, that base as a distinct "backend-only" tree; it is simply an
ordinary ancestor commit shared by virtually the entire repository.

### 2. Twelve branches self-declare the authority role — all stale or absorbed

Searching every remote branch tip's `config/backend-authority.json` for
`role: "backend-deployment-authority"` (not just its `canonicalBranch` field,
which every branch below still leaves pointed at the same unresolvable name)
returned twelve matches, all frozen 2026-08-29 – 2026-08-31, all with
`governedFunctionCount` 19 or 20 against today's correct 23:

| Branch | HEAD | Date | Status against current release |
|---|---|---|---|
| `claude/k-scan-build34-track-b-audit-cj5hir` | `9a2816b0` | 08-30 | ancestor (absorbed) |
| `feature/backend-build34-closet-facts-v1` | `daf4a2e4` | 08-29 | ancestor (absorbed) |
| `feature/backend-build34-closet-media-v1` | `2b28cd8a` | 08-29 | ancestor (absorbed) |
| `feature/backend-build34-elise-wardrobe-context-v1` | `75442d96` | 08-30 | ancestor (absorbed) |
| `feature/backend-build34-style-dna-v1` | `c40165bf` | 08-30 | ancestor (absorbed) |
| `feature/backend-build34-vto-generate-v1` | `2d036e27` | 08-31 | ancestor (absorbed) |
| `feature/backend-kplus-complimentary-v1` | `3aa6716a` | 08-29 | ancestor (absorbed) |
| `fix/build34-vto-paid-boundary-v1` | `0b21963c` | 08-31 | ancestor (absorbed) |
| `maintenance/b34-def001-backend-authority` | `ca2d781f` | 08-29 | ancestor (absorbed) |
| `repair/backend-build34-closet-deletion-v1` | `36ad6bb3` | 08-29 | ancestor (absorbed) |
| `repair/backend-build34-scan-identify-quota-v1` | `bf444d63` | 08-29 | ancestor (absorbed) |
| `maintenance/staging-migration-authority-reconciliation` | `e8ae6fb9` | 08-29 | **not** an ancestor — diverges |

Eleven of twelve are already ancestors of the current release SHA: their
content reached mainline through the normal Build 34 Track B convergence and
is fully present in `release/kscan-pre-freeze-v1` today. None is a live,
independently-maintained "backend-only" tree distinct from the mobile
integration line — they are Build 34 feature/repair branches that happened to
carry `role: "backend-deployment-authority"` at the time they were cut, never
updated since, and superseded.

The twelfth, `maintenance/staging-migration-authority-reconciliation`, is a
single merge commit (PR #208) sitting on a shared ancestor **605 commits**
behind the current release head; diffing it against the release head shows it
missing ~31k lines the release line has since gained (the entire `vto-generate`
provider stack among them) against ~1.6k lines it alone carries. It is a
stale, abandoned integration point, not a currently-maintained authority.

**No branch anywhere in this repository is both current and holds proven,
exclusive backend deployment lineage separate from the mobile release line.**
This reconfirms — with a broader search than RP-108 ran — that the gap is
real, not a search artifact.

### 3. Live parity — RP-108's measurement is still current

`git diff --stat 888cdef4 0ebc86a0 -- supabase/functions/` is **empty**: no
governed function's source changed between RP-108's parity measurement and
today's release SHA. RP-108's byte-comparison table in
`rp108-staging-function-parity-2026-09-07.md` therefore still describes the
live gap accurately without re-measurement: `scan-identify`,
`commerce-watch-refresh`, `kplus-activate` and `kplus-reconcile-revenuecat`
remain behind accepted Build 34 source on staging; `stylechat-generate`,
`vto-generate`, `apple-credential-link` and `apple-revoke-credential` remain
at parity.

Read-only Management API listing (2026-09-08), staging (`yzqjvdfgefveprobvvyw`)
vs. production (`wyyuqfdxucjksghsmhry`), for the mission's nine named
functions:

| Function | Staging version | Production version | On production? |
|---|---|---|---|
| `scan-identify` | 61 | 156 | yes |
| `commerce-watch-refresh` | 6 | — | **no** |
| `kplus-activate` | 15 | — | **no** |
| `kplus-reconcile-revenuecat` | 15 | — | **no** |
| `stylechat-generate` | 122 | 100 | yes |
| `vto-generate` | 9 | — | **no** |
| `apple-credential-link` | 54 | 9 | yes |
| `apple-revoke-credential` | 52 | 9 | yes |
| `handle-user-deletion` | 75 | 84 | yes |

The four absent-from-production functions are exactly K+, Smart Watchlist
commerce, and Virtual Try-On — features Repair 04 independently confirmed are
disabled in the production build (`EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED`,
`EXPO_PUBLIC_SMART_WATCHLIST_V1`, `EXPO_PUBLIC_VTO_UI_ENABLED` all
undeclared). Their absence from production is consistent with intended
release state, not an unnoticed gap. No paid/provider operation was invoked;
this is a read of Management API metadata only.

### 4. Staging diagnostic residue — unchanged, still present, still not deleted

Read-only re-check of the three slugs `config/backend-authority.json` already
records:

| Slug | Present | `verify_jwt` | Matches recorded posture |
|---|---|---|---|
| `vto-provider-diag` | yes (v12) | `true` | yes |
| `rapidapi-key-diag` | yes (v7) | `false` | yes |
| `rapidapi-current-audit` | yes (v9) | `false` | yes |

None was invoked, redeployed, or deleted by this lane. Deletion remains the
recorded owner action.

### 5. Terminal deletion status contract — confirmed absent

Searched `supabase/functions/**` and the mobile client (`app/`, `services/`)
for a client-facing post-auth deletion/purge status mechanism: deletion
status, deletion receipt, purge status, `purged_at`, restoration token,
terminal status.

The **database** contract is fully implemented — `deletion_requests.status`,
`.purged_at`, `.restored_at` are enforced by a check constraint
(`purged_at is not null` iff `status = 'purged'`,
`20260722191013_account_deletion_lifecycle.sql`), and
`process-account-deletions` (the worker) reads and transitions them. But no
governed Edge Function exposes that state to a signed-in client:
`handle-user-deletion` only accepts `POST` (the deletion request itself),
`restore-account` returns a one-shot restoration result rather than a
queryable status, and no dedicated `deletion-status` / `purge-status` /
`deletion-receipt` slug exists in `supabase/functions/` at all. No client code
under `app/` or `services/` references any such endpoint.

**TERMINAL STATUS CONTRACT: NOT IMPLEMENTED.** Not implemented in this lane,
per the mission boundary — recorded as the next repair's baseline.

## Validation run this lane

- `node scripts/verify-backend-authority.js --json` → `ok: true`, one
  `CANONICAL_BRANCH_UNRESOLVABLE` warning (expected — this checkout does not
  claim authority), `governed / source: 23 / 23`, working tree clean.
- `node scripts/deploy-edge-functions.js` (no args, from this checkout) →
  **Step 1/7 FAIL, ABORTED. Nothing was deployed.** The refusal fires exactly
  as designed for a checkout declaring
  `role: "integration-convergence-non-authoritative"`.
- `node scripts/generate-edge-function-manifest.js --check` → PASS, manifest
  current.
- All nine named functions confirmed present in
  `scripts/edge-function-manifest-lib.js`'s `GOVERNED_FUNCTIONS`.

## Verdict

**BLOCKED — outcome C.** No trustworthy canonical backend source exists to
publish or re-point at. `release/kscan-pre-freeze-v1` remains, correctly,
`integration-convergence-non-authoritative`; that role was not changed, and
nothing in this lane's search makes changing it defensible. Closing
GOV-KPLUS-001 requires an owner decision: publish `rebuild/staging-v2-backend`
from wherever its post-2026-08-05 work still lives outside this repository's
reachable refs, or nominate a specific ref the owner can attest actually holds
current, exclusive backend deployment lineage. Re-pointing `canonicalBranch`
without that attestation would manufacture a governance claim the contract
does not support — the same reasoning RP-108 recorded, independently
reconfirmed here.

## Convergence plan (Section 6C)

1. **Owner locates or recreates the source.** Either publish
   `rebuild/staging-v2-backend` (or whatever local/offline checkout still
   holds its post-2026-08-05 history) to `origin`, or designate a specific
   commit the owner can personally attest is the current, exclusive backend
   deployment tree.
2. **Re-run `scripts/verify-backend-authority.js` against that ref.** It must
   resolve on `origin`, its `config/backend-authority.json` must declare
   `role: "backend-deployment-authority"`, and its governed/source counts must
   agree with `scripts/edge-function-manifest-lib.js` (23 today).
3. **Only then** re-point `config/backend-authority.json`'s `canonicalBranch`
   at that ref, in a dedicated governance commit, with the lineage proof
   (ancestry, byte parity against what is actually deployed) recorded
   alongside — not folded into an unrelated feature or repair commit.
4. Once authority is re-established, the four staging functions RP-108 found
   behind (`scan-identify`, `commerce-watch-refresh`, `kplus-activate`,
   `kplus-reconcile-revenuecat`) can be redeployed through the governed path
   from that checkout.
5. Terminal deletion status contract (§8) is separately scoped follow-up work,
   not blocked on this convergence.

No code was modified merely to manufacture authority. No canonicalBranch value
was changed.
