# RP-06A — account-deletion lifecycle source reconciliation

**As of 2026-09-08.** Canonical backend authority `rebuild/backend-authority-v2`
@ `c1870e321a2cd55d009ddd25d131a0347f39ba65`. Source reconciliation only — no
deployment, no migration, no secret, no lifecycle policy change, and no
terminal-status receipt (that remains Repair 06).

## Why this was needed

Repair 06 stopped on a proven stop condition. The canonical authority carried a
**pre-Build-29** `handle-user-deletion` while both deployed environments run the
restorable 30-day lifecycle. Deploying canonical as-is would have regressed
staging and production.

The canonical tree was **internally inconsistent**, not uniformly stale:

| Canonical component | State |
|---|---|
| `_shared/deletion/common.ts` | **Newest of all lineages** — carries `isAnonymous` / `isEligibleAccountActor` (SEC-KPLUS-005) that `staging/production-parity` does not |
| `process-account-deletions`, `restore-account`, `resend-restoration-email` | Current, using that shared module |
| `handle-user-deletion` | **Orphaned on the retired path** — did not import the shared deletion module at all |

### The coupling this actually broke

`process-account-deletions` claims work with:

```js
if (row.status !== 'deactivated') return `skipped_status_${String(row.status)}`;
```

The retired canonical intake wrote `status: 'pending'`. Rows it created were
therefore **permanently unpurgeable** (`skipped_status_pending` on every worker
pass) *and* unrestorable (no `restoration_token_hash` was ever minted). This was
not merely stale source — canonical intake was functionally incompatible with
canonical's own purge worker.

## Three-way behavioural matrix

A = canonical `rebuild/backend-authority-v2` (before this change)
B = staging deployed v75 (2026-08-13)
C = production deployed v84 (2026-07-23)
D = `staging/production-parity` @ `abe2d69b` — the git source of B

| Behaviour | A (canonical, old) | B / D (staging) | C (production) | Reconciled |
|---|---|---|---|---|
| Files | 1 | 4 (`index`+`handler`+2 shared) | 2 | 4 (+ test) |
| Request status written | `pending` | `deactivated` | `deactivated` | `deactivated` |
| Grace-period creation | none | 30 days | 30 days | 30 days |
| Restoration token issued | none | yes | yes | yes |
| Token hashing (SHA-256, hash-only persisted) | n/a | yes | yes | yes |
| Hash durable **before** email | n/a | yes | yes | yes |
| `subject_ref` | none | DB default | client `randomUUID()` | **DB default** |
| Transition ledger | none | yes | yes | yes |
| Profile → `pending_deletion` | yes | yes (non-blocking) | yes (**blocking**) | **blocking** |
| Compensating `failed` write | none | none | yes | **yes** |
| Session revocation | none | **none** | yes | **yes** |
| Auth ban | none | **none** | `720h` | **yes, `720h`** |
| Restoration unban | n/a | via `restore-account` | via `restore-account` | via `restore-account` |
| Legacy `pending` upgrade | n/a | none (reports only) | yes | **yes** |
| Duplicate lifecycle handling | `pending,processing` only | 23505 → re-read winner | loose `duplicate` match | 23505 → re-read winner |
| `request_source` fallback | 2 sources × 3 notes | narrow constraint detection | `notes` only | narrow detection |
| Email-failure semantics | n/a | accepted, `queued:false` | accepted, `queued:false` | accepted, `queued:false` |
| Legal hold | not modelled | in active set | in active set | in active set |
| Terminal purge | not modelled | worker-owned | worker-owned | worker-owned (unchanged) |
| Apple revocation / RevenueCat | not reachable from intake | worker-owned | worker-owned | worker-owned (unchanged) |

## Section 3 — security posture adjudication

**Decision: preserve the production controls. Staging was NOT adopted by default.**

Verified from the production source before deciding:

- **Session revocation** — `revokeAllSessions(user.id, user.accessToken)` after
  the profile transition. Best-effort (does not reject the request) but its
  outcome is returned as `sessionRevocationOk` rather than assumed.
- **Auth ban** — `updateUserById(user.id, { ban_duration: '720h' })`. 720h = 30
  days = **exactly** the grace window. Best-effort; production swallows the
  failure.
- **Reversal** — canonical `restore-account` already unbans with
  `ban_duration: 'none'`, retries twice, and on failure returns
  `restored_pending_unban` (202) plus an alertable log rather than claiming
  success. The ban is therefore coherent with restoration, which is the
  condition the mission set for preserving it.
- **Failure semantics** — production *blocks* acceptance when the profile
  cannot be deactivated: it marks the row `failed` /
  `PROFILE_DEACTIVATION_FAILED`, clears the restoration token hash, and returns
  500. Staging only logged and continued. The stricter production behaviour is
  preserved: accepting a deletion whose account was never deactivated would
  leave a row the purge worker eventually acts on for an apparently-active
  account.

`AUTH_BAN_DURATION` is now derived as `${GRACE_PERIOD_DAYS * 24}h` so the ban
and the grace window cannot drift apart. It evaluates to the deployed `720h` —
no policy change.

### One production inconsistency, flagged not silently "fixed"

Production's **legacy-upgrade** path revokes sessions but does **not** apply the
Auth ban, while its fresh-request path does. The reconciled source preserves
production exactly (upgrade revokes, does not ban) rather than inventing a
stronger behaviour, because adding a ban there would change the lockout
experience for legacy-row holders. Recorded here for an owner decision; not a
hole (the data plane is already fail-closed via `pending_deletion` +
`assertAccountActive`).

## Target design adopted

Staging's **structure** (thin `index.ts` + `handler.ts` with dependency-injected
seams, so ordering and absence invariants are testable) carrying production's
**security semantics** — the accepted superset, not staging-by-default.

Every symbol `handler.ts` imports was verified to exist in canonical's shared
modules before adoption, so no shared file needed to change. Canonical's newer
`common.ts` is retained; adopting D's copy wholesale would have **regressed**
the anonymous-actor gating.

## Files changed

| File | Change |
|---|---|
| `supabase/functions/handle-user-deletion/index.ts` | Replaced with the thin serve wrapper |
| `supabase/functions/handle-user-deletion/handler.ts` | **New** — reconciled superset |
| `supabase/functions/handle-user-deletion/handler.test.ts` | **New** — Deno suite ported from D, adapted |
| `__tests__/handleUserDeletionEdge.test.js` | Source-text assertions → 31 behavioural tests |
| `__tests__/privacyRequestRateLimitContract.test.js` | 2 assertions retargeted to the new file layout |
| `config/edge-function-manifest.json` | Regenerated via governed tooling |

**Not modified:** `process-account-deletions`, `restore-account`,
`resend-restoration-email`, `_shared/deletion/**`, any migration. Reconciliation
proved canonical intake is *compatible* with them once it writes `deactivated`,
so Section 7's broadening trigger was never reached.

## Section 6 — 23-function parity sweep status

**PARTIAL — completed for the deletion subsystem, open for 13 commodity
functions.** Reported honestly because this gates *future deployment*, and no
deployment occurs in this lane.

A structural fact discovered while sweeping: **each Edge Function deployment
snapshots `_shared/**` at its own deploy time.** Staging's `restore-account`
(v55, 2026-08-31) bundles the *newer* `common.ts` with `isAnonymous`, while
staging's `handle-user-deletion` (v75, 2026-08-13) bundles the older one. A
shared-module comparison is therefore only meaningful **per function**, never
project-wide — the trap that makes timestamp triage unsafe.

| Tier | Functions | Evidence | Result |
|---|---|---|---|
| A — byte-compared | `scan-identify`, `commerce-watch-refresh`, `kplus-activate`, `kplus-reconcile-revenuecat`, `stylechat-generate`, `vto-generate`, `apple-credential-link`, `apple-revoke-credential` | RP-108 SHA-256 per mapped file, on a baseline proven identical to canonical for `supabase/functions/**` | 4 STAGING BEHIND CANONICAL, 4 PARITY |
| B — content-compared this lane | `handle-user-deletion` | full three-way source read | **THREE-WAY DIVERGENCE → reconciled** |
| B | `restore-account` | full staging source read vs canonical | PARITY (all behavioural markers present) |
| B | `_shared/deletion/common.ts` | full staging source read vs canonical | **CANONICAL NEWER / ACCEPTED** |
| B | `process-account-deletions` | canonical read; coupling to intake row shape verified | compatible; byte comparison still open |
| C — **NOT yet content-compared** | `style-outfit-generate`, `stylist-speech`, `privacy-correction-request`, `privacy-data-export`, `resend-restoration-email`, `kickscrew-sneaker-description`, `nike-shoe-details`, `product-search-deals`, `search-vinted-secondhand`, `shared-room-image-url`, `tryon-clothes-pro`, `staging-health`, `process-account-deletions` (bytes) | none beyond RP-108 timestamp triage | **OPEN — must be closed before any backend deployment** |

No P0/P1 divergence was found in anything compared. Tier C remains the
outstanding certification gate; it is exactly the group that concealed
`handle-user-deletion`, so it must not be closed by timestamp again.

## Validation

- `__tests__/handleUserDeletionEdge.test.js` → **31/31**
- Deletion-subsystem suites (10 files) → **204/204**
- `verify-backend-authority.js --json` → `ok: true`, zero findings, governed/source 23/23
- `generate-edge-function-manifest.js --check` → PASS (after governed regeneration)
- `check-edge-function-parity.js` → PASS
- `npx tsc --noEmit` → exit 0
- Deno `deno check` / Deno test suite → **not runnable in this environment**
  (`deno: command not found`, pre-existing; `run-backend-tests.js` reports it and
  exits 0). CI runs it via `denoland/setup-deno`. All three changed `.ts` files
  were parse-verified with the TypeScript compiler as the strongest local proxy.

### Mutation testing

Each mutation was applied to `handler.ts`, the suite run, and the file restored:

| Mutation | Suite |
|---|---|
| grace period 30 → 29 days | **2 failures** |
| drop the compensating `failed` write | **2 failures** |
| remove session revocation | **1 failure** |
| remove the Auth ban | **2 failures** |
| persist the raw token instead of its hash | **1 failure** |

Restored file byte-identical, 31/31 green.

## Known non-regressions

The full governed suite reports 3 unexpected failures on this branch
(`the verifier reports no ERROR-level discrepancy on this checkout` is
dirty-tree-only and clears once committed):

- `an unpublished canonical branch never blocks a NON-authoritative checkout`
- `this integration checkout is still explicitly NON-authoritative`
- `deploy guard: this checkout itself is correctly marked non-authoritative`

These are **pre-existing on `rebuild/backend-authority-v2`**, established and
documented by Repair 05A: they assert the checkout is *non-authoritative*, which
is the deliberate opposite of this branch's purpose. This lane adds none and
alters no baseline.
