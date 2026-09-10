# Watchlist Backend Readiness 02 — staging scheduler / evaluator certification

**Verdict: BLOCKED — STAGING CANNOT CONVERGE TO RELEASE AUTHORITY.**

The blocker is access, not design. Three independent prerequisites for the
end-to-end path are owner-provisioned or network-gated and cannot be satisfied
from an agent session. What *could* be certified was certified live against
staging and is recorded below; what could not is named exactly, with the
remediation.

Base: `release/kscan-pre-freeze-v1` @ `8d8ceab2ef7ce417c933313178e86ae56ab67225`
(PR #377 N-5, #378 N-6, #380 F-03 all present; PR #379 correctly absent —
it is Build-35 line). Staging: `yzqjvdfgefveprobvvyw` (K Scan AI Staging,
PostgreSQL 17.6.1.155). Production `wyyuqfdxucjksghsmhry` was never targeted.

---

## 1. The blockers, precisely

| # | Prerequisite | Why it cannot be done here | Who can |
|---|---|---|---|
| B1 | `WATCHLIST_WORKER_SECRET` on the staging Supabase project | The Supabase MCP surface exposes no secrets-management tool. `docs/watchlist-tier2-operations.md` already classifies this as **OWNER SECRET REQUIRED** — "cannot be created from a repository". | Owner, via `supabase secrets set` |
| B2 | Same secret as a GitHub **repository secret**, plus repository **variable** `SUPABASE_STAGING_FUNCTIONS_URL` | No tool in this session can create GitHub Actions secrets or variables. | Owner, repo settings |
| B3 | Deploying `commerce-watch-refresh` through the **governed** path | `scripts/deploy-staging-function.mjs` needs the `supabase` CLI and `SUPABASE_ACCESS_TOKEN`; neither is present. Deploying via the MCP tool instead would bypass `assertStagingTarget`, the edge-function manifest check, the `verify_jwt` assertion and the SHA-provenance artifact — and would hand-assemble a cross-directory dependency graph onto a function that also serves the live Tier 1 user surface. Not attempted. | CI, via `staging-controlled-deploy.yml` |

A fourth constraint compounds B1/B2: the environment's network policy returns
`403` on `CONNECT` to `*.functions.supabase.co`, so the sweep endpoint could not
be invoked from here even with a valid secret. (Same policy that blocks the
PGDG repo, noted in the F-03 record.)

Because the Edge Function cannot be deployed, **F-02, F-04, live N-4 receipt
processing and live N-5 observability are all unreachable in this lane.**

---

## 2. Intended scheduler architecture (determined, not invented)

The repository already specifies this unambiguously; nothing was designed here.

```
INTENDED_SCHEDULER_MECHANISM = GitHub Actions workflow
                               .github/workflows/watchlist-tier2-sweep.yml
INTENDED_CADENCE             = cron '17 */6 * * *'  (4x/day) — currently COMMENTED OUT
INTENDED_TARGET              = POST {SUPABASE_STAGING_FUNCTIONS_URL}/commerce-watch-refresh
INTENDED_AUTHORITY           = header x-watchlist-worker-secret (constant-time compare)
                               + app_config.watchlist_worker_enabled kill switch
```

`pg_cron` is **not** the intended mechanism: it is not installed on staging,
`cron.job` does not exist, and the repo's only pg_cron references are the
deletion worker's *refusal* checks. Three gates must all pass before a row is
claimed, and the workflow header documents them. The schedule was deliberately
left commented out — **this lane did not uncomment it**, because with B1/B2
unmet a cron-enabled workflow would fail its preflight loudly every 6 hours
without ever sweeping.

Estimated load if activated as specified: **4 invocations/day**, batch-capped —
no sub-minute schedule, no unbounded sweep.

---

## 3. Staging pre-state (captured before any mutation)

```
STAGING_PROJECT_STATUS            = ACTIVE_HEALTHY (PG 17.6.1.155)
COMMERCE_WATCH_REFRESH_DEPLOYED   = YES, version 6, deployed 2026-09-03T11:59:13Z
COMMERCE_WATCH_REFRESH_SOURCE_MATCH = NO  (see §4)
WATCHLIST_WORKER_KILL_SWITCH      = app_config.watchlist_worker_enabled = TRUE
                                    (set 2026-09-01T00:51:13Z — see FINDING WL02-01)
ACTIVE_SCHEDULER_EXISTS           = NO
SCHEDULER_MECHANISM               = none active
WATCHLIST_TABLES_PRESENT          = user_commerce_watches, user_commerce_watch_events,
                                    user_device_push_tokens  (watchlist_push_receipts ABSENT)
F03_MIGRATION_STATE               = schema already correct (hardening applied historically
                                    as ledger 20260830214752, AFTER its dependency
                                    20260830212508 — exactly as the F-03 analysis predicted);
                                    repo forward migration 20260909170000 unapplied
WATCHLIST DATA VOLUME             = 0 watches, 0 device routes, 28 auth users,
                                    3 active K+ entitlements
APNs_STAGING_CREDENTIAL_STATUS    = UNKNOWN (not inspectable without secrets access)
FCM_STAGING_CREDENTIAL_STATUS     = UNKNOWN (same)
```

Staging carrying **zero** Watchlist rows is what made live fixture certification
safe: every row touched below was created and removed by this lane.

---

## 4. Deployed-source delta (F-04 evidence)

Deployed staging `commerce-watch-refresh` v6 vs release authority:

```
MISSING ENTIRELY   receiptProcessing.ts     (N-4 — receipt drain, dead-token retirement)
                   pushObservability.ts     (N-5 — operational events)
                   refreshQuery.ts
DIFFERS            index.ts                 275 changed lines
                   pushDelivery.ts           29 changed lines
                   watchRefreshConfig.ts     49 changed lines
IDENTICAL          changeEngine.ts, watchCurrency.ts, watchRefreshObservation.ts
```

`DEPLOYED_SOURCE_MATCH=NO`. Staging is running a pre-N-4/N-5 worker: N-4 and N-5
landed on 2026-09-09, six days after the deployed build.

---

## 5. What WAS certified — live, against staging

All of the following executed against `yzqjvdfgefveprobvvyw` through the real
RPCs and the real SQL predicates, with disposable fixtures.

### Routing / DEF-WL-01 (matrix 17-21)
| Probe | Result |
|---|---|
| iOS + Android registration via `register_device_push_token` | 2 distinct live routes |
| Same-device actor transfer (A→B) | A's route retired, exactly 1 live route on the device |
| A's unrelated second device | untouched by the transfer |
| `revoke_device_push_token` (N-6 current-device OFF) | route no longer selectable |
| Control: duplicate live push token inserted directly | rejected `23505` |

### N-4 exact-token retirement (matrix 30-32)
Executed against the exact predicate `retireStalePushRoute()` issues via
PostgREST — `id=eq.<row> & revoked_at=is.null & push_token=eq.<expected>`:

| Case | Rows retired | Verdict |
|---|---|---|
| Receipt token == current token | 1 | route correctly retired |
| Token refreshed since send (stale receipt) | 0 | refreshed route preserved |
| Device changed actor (old-actor receipt) | 0 | new actor's route preserved |

### Evaluator eligibility (matrix 10, 12-14) — real Tier 2 claim RPC
`claim_watchable_commerce_watches(50, 600000)` against five constructed watches:

```
A due + fully eligible      -> CLAIMED     (the only one)
B push_enabled = false      -> not claimed
C last_checked_at = now()   -> not claimed (not due)
D status = paused           -> not claimed
E owner has no K+           -> not claimed
```

### Duplicate-send protection (matrix 15)
Second immediate sweep reclaimed **nothing** — the claim stamps
`last_checked_at = now()` as the claim itself, removing the row from every
subsequent claim window.

### RLS / isolation (matrix 40-41)
Probed by actually assuming each role, with a service_role positive control
proving the rows exist:

```
service_role      2 fixture watches, 7 fixture routes visible   (positive control)
anon              user_commerce_watches      DENIED
anon              user_device_push_tokens    DENIED
anon              watchlist_push_receipts    DENIED
authenticated(A)  other actor's watches      0 rows
authenticated(A)  other actor's routes       0 rows
authenticated(A)  own watches                1 row   (scoped, not over-tight)
authenticated(A)  watchlist_push_receipts    DENIED
```

### N-4 receipt table posture (matrix 24, 33)
```
RLS enabled = true, policy count = 0 (fail-closed)
anon grants = none, authenticated grants = none
service_role = SELECT/INSERT/UPDATE/DELETE
raw push-token column = ABSENT   (fingerprint only)
check constraints = 6
```

### Negative controls
| Control | Result |
|---|---|
| **B** — drop the exact-token predicate from retirement | RED as expected: the refreshed route was wrongly retired (1 row). Injected fixture removed; residue 0. |
| **D** — defeat the claim interval guard (`min_interval_ms = 0`) | RED as expected: the same watches were re-claimed, proving the guard is what prevents duplicates. |

Controls A, C and E could not be run: they require the deployed worker
(kill-switch gate, actor isolation inside the sweep, and the N-5 observability
sink), which is blocked by B3.

---

## 6. Staging mutations performed

| # | Action | Pre-state | Post-state | Reversible |
|---|---|---|---|---|
| M1 | apply migration `watchlist_push_receipts` | table absent | table + 3 indexes, RLS on, 0 policies, service-role-only | YES |
| M2 | apply migration `watchlist_f03_..._reconciliation` | schema already correct, migration unapplied | idempotent no-op; the migration's own post-conditions executed and PASSED live | N/A |
| M3 | fixture create (2 auth users, 5 watches, 7 routes, 1 entitlement) | — | — | YES |
| M4 | fixture cleanup | — | residue 0; staging back to 0 watches / 0 routes / 28 users | — |

No secret value was read, written or printed. No production resource was touched.

---

## 7. Findings

**WL02-01 — staging worker kill switch is ON while the deployed worker is stale.**
`SEVERITY=P2 · READINESS_BLOCKER=NO (latent)`
`app_config.watchlist_worker_enabled` has been `true` on staging since
2026-09-01, but the sweep has never been invocable (no worker secret, no
scheduler) and the deployed function predates N-4/N-5. It is inert today. The
hazard is ordering: if the owner provisions `WATCHLIST_WORKER_SECRET` **before**
deploying current source, a stale worker begins sweeping against a schema that
now contains `watchlist_push_receipts` it has no code to use.
`SUGGESTED_FIX`: deploy current `commerce-watch-refresh` to staging *before*
creating the secret, or set the flag false until deploy completes. This lane did
not change the flag — it is pre-existing state whose intent was not established
here.

**WL02-02 — CLOSED (was P3).** `apply_migration` records its own wall-clock
version, so the two migrations landed as ledger `20260909171001` /
`20260909171017` while their repo filenames are `20260909115726` /
`20260909170000`. Names match; versions did not, and left undeclared the
governed preflight would have reported *both* sides wrongly — the source
versions as pending and the staging versions as drift.
Closed through the mechanism this repo already has for exactly this:
`config/migration-authority-manifest.json` -> `ledgerReconciliation`, two
entries, classification `EQUIVALENT_RENUMBER`. See §10.

**WL02-03 — APNs/FCM staging credential status not inspectable.**
`SEVERITY=P4 · READINESS_BLOCKER=NO`
Reported as `UNPROVEN` rather than guessed. Physical delivery certification is
a separate artifact/credential gate.

---

## 8. Required report fields

```
AUTHORITY
  BASE_SHA=8d8ceab2ef7ce417c933313178e86ae56ab67225
  PR377_PRESENT=YES  PR378_PRESENT=YES  PR380_PRESENT=YES
  BUILD35_CONTAMINATION=NO   WORKTREE_CLEAN=YES

F-03
  F03_STAGING_CONVERGED=YES (schema); ledger row present under version 20260909171017
  F03_FORWARD_MIGRATION_APPLIED_THIS_LANE=YES
  STAGING_SCHEMA_ALREADY_EQUIVALENT=YES (before the apply)

DEPLOYMENT
  COMMERCE_WATCH_REFRESH_DEPLOYED=NO (blocked — B3)
  DEPLOYED_VERSION=6 (unchanged, 2026-09-03)
  DEPLOYED_SOURCE_MATCH=NO

SCHEDULER
  SCHEDULER_MECHANISM=GitHub Actions workflow (intended); none active
  SCHEDULER_CADENCE=intended '17 */6 * * *'; not enabled
  STAGING_SCHEDULER_EXISTS=NO   STAGING_SCHEDULER_ACTIVE=NO
  PRODUCTION_SCHEDULER_CHANGED=NO
  SCHEDULER_AUTH_SAFE=BY DESIGN (constant-time worker-secret + kill switch);
    PUBLIC_UNAUTHENTICATED_WORKER_INVOCATION=NO by source inspection, NOT probed
    (endpoint unreachable — network policy)
  SCHEDULER_SECRET_LOGGED=NO   SCHEDULER_CREDENTIAL_IN_SOURCE=NO

EVALUATOR
  DUE_ELIGIBLE=PASS  DUE_INELIGIBLE=PASS  NOT_DUE=PASS  INACTIVE=PASS
  DUPLICATE_SEND_PROTECTION=PASS (claim-layer, live)

ROUTING
  ACTOR_ISOLATION=PASS  MULTI_DEVICE=PASS  CURRENT_DEVICE_REVOKE=PASS
  CROSS_ACTOR_DELIVERY=NO (route-selection layer, live)

EXPO
  EXPO_BACKEND_CONTRACT=BLOCKED (function not deployed; endpoint unreachable)
  TICKET_PERSISTENCE=SCHEMA READY, runtime unproven
  LIVE_PROVIDER_RECEIPT_PROOF=NONE
  IOS_PHYSICAL_DELIVERY=DEFERRED   ANDROID_PHYSICAL_DELIVERY=DEFERRED

N-4
  EXACT_TOKEN_RETIREMENT=PASS (SQL predicate, live on staging)
  STALE_TOKEN_SAFE=PASS   ACTOR_TRANSFER_SAFE=PASS
  RAW_TOKEN_AT_REST=NO
  Runtime receipt drain / classification = NOT certified (code not deployed)

N-5
  LIVE_STAGING_OBSERVABILITY=BLOCKED (pushObservability.ts not deployed)
  Source-level suite: 52/52 pass

PARITY
  IOS_BACKEND_SEMANTICS=PASS  ANDROID_BACKEND_SEMANTICS=PASS
  BACKEND_PLATFORM_PARITY=PASS (registration/revocation/distinctness, live)

SECURITY
  RLS=PASS  ANON_ENUMERATION=DENIED  CROSS_ACTOR_READ=DENIED
  SERVICE_ROLE_AUTHORITY=INTACT

FINAL STAGING STATE
  SCHEDULER_ACTIVE=NO
  WORKER_CAN_PROCESS=NO — the app_config flag permits processing, but the worker
    is unreachable: no WATCHLIST_WORKER_SECRET exists, so every sweep request
    authenticates as a normal caller and is refused, and no scheduler invokes it.
  FIXTURE_RESIDUE=0

PRODUCTION
  PRODUCTION_TOUCHED=NO  PRODUCTION_WATCHLIST_ACTIVE=NO
  PRODUCTION_PROMOTION=PENDING_APPLE_CLEARANCE
```

---

## 9. What the owner needs to do to unblock

1. Deploy current `commerce-watch-refresh` to staging via
   `staging-controlled-deploy.yml` (**before** step 2 — see WL02-01).
2. `supabase secrets set WATCHLIST_WORKER_SECRET --project-ref yzqjvdfgefveprobvvyw`.
   *(Superseded 2026-09-10: the CLI rejects a bare name. It accepts only
   `NAME=VALUE` pairs or `--env-file`. Use the Windows PowerShell 5.1
   generate, write and verify procedure in `docs/watchlist-tier2-operations.md`
   §1 steps 1-2, which also covers step 3.)*
3. Add the same value as a GitHub repository secret, plus repository variable
   `SUPABASE_STAGING_FUNCTIONS_URL`.
4. Run the refusal + governed-no-op validations in
   `docs/watchlist-tier2-operations.md` §3-§4.
5. Uncomment the `schedule:` block in `watchlist-tier2-sweep.yml`.

Steps 1-3 are exactly the owner-provisioning steps that document already
records. Once they are done, the remaining certification (F-02 scheduler proof,
live Expo contract, N-4 runtime drain, N-5 live events) becomes executable.

---

## 10. WL02-02 closure — staging ledger aliases

The remote ledger was **not** touched and no source migration was renamed. The
divergence is *recorded*, not resolved by moving anything.

### Why `entries[]` could not carry it

`scripts/verify-migration-authority.js` check 5 hard-requires an entry's
`canonicalFilename` version prefix to **equal** its `ledgerVersion` — "this is
the actual thing `supabase db push` reconciles on". An entry for
`20260909171001` pointing at `20260909115726_watchlist_push_receipts.sql` fails
that check by construction. The only ways to satisfy it would be to rename the
source file or to misstate a field; both are excluded. `entries[]` therefore
*structurally cannot* express a renumber, and the aliases were recorded nowhere
near it — `MIGRATION_AUTHORITY` still verifies 26 entries, unchanged.

### The mechanism that can

`ledgerReconciliation` exists for this and says so:

> Records, per environment, which local migration VERSIONS are already
> represented in that environment's applied ledger under a different version
> identity (renumber) … This never renames, deletes, reorders or re-applies a
> migration: it only records an explicit, evidence-backed decision that a
> version difference is not a missing capability. Anything NOT listed here is
> still treated as genuinely pending and blocks the gate.

Its consumer is `scripts/staging-deploy-preflight.mjs` — precisely the governed
path that would otherwise misclassify these. Twenty-eight such aliases already
existed for this environment, including `20260830190000 -> 20260830214752`,
which is the F-03 pair itself.

### Classification: `EQUIVALENT_RENUMBER`, deliberately not `EXACT`

Staging recorded 3937 and 3095 characters of statement text against source files
of 9231 and 10152 bytes. The difference is comment/header text, omitted when the
executable body was submitted. The SQL is semantically identical but **not**
byte-identical, so `EXACT_CONTENT_RENUMBER` would have been an overclaim.

### Proof

`compareMigrations()` — the preflight's own classifier — run against the real
local tree and the real staging ledger, with and without the entries:

```
BEFORE (entries absent)                AFTER (entries present)
  pending 20260909115726   WRONG         pending  none                       OK
  pending 20260909170000   WRONG         drift    none                       OK
  drift   20260909171001   WRONG         reconciled 20260909115726 -> ...001  OK
  drift   20260909171017   WRONG         reconciled 20260909170000 -> ...017  OK
                                         reconciliation problems, all 30: 0
```

```
REMOTE_LEDGER_MUTATED=NO
SOURCE_MIGRATION_RENAMED=NO
STAGING_ALIAS_RECORDED=YES
MIGRATION_PROVENANCE=PASS
MIGRATION_AUTHORITY=PASS (26 entries — unchanged; aliases are not entries[])
FUTURE_GOVERNED_PUSH_DOES_NOT_MISCLASSIFY_THE_TWO_MIGRATIONS=YES
```

`__tests__/watchlistStagingLedgerAliases.test.js` pins the source-side contract
in 11 assertions. Its negative control — deleting both aliases — turns it red
with 6 named failures.

**Still not done, deliberately:** no worker deployed, no secret provisioned, no
scheduler activated. `WORKER_CAN_PROCESS=NO`.
