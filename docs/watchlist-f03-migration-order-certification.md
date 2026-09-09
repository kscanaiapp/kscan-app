# F-03 — Watchlist migration ordering / fresh-replay certification

Status: **repaired and certified locally.** Both database histories pass; two
negative controls prove the certification detects the defect. Production was
not touched, staging was not mutated, and no scheduler, worker or notification
path was activated.

Base: `release/kscan-pre-freeze-v1` @ `85134d505bba679945e9b18388a74ebfcdd84acf`
(PR #377 N-5 and PR #378 N-6 both present).

---

## 1. Root cause

Commit `6b8d0390` ("make Build 34 migration authority promotion-safe", MIG-01)
resolved a duplicate migration version. Two unrelated files both claimed
`20260830160000`, and each was renamed to its true applied ledger version:

| original filename | renamed to | why |
| --- | --- | --- |
| `20260830160000_vto_feature_control.sql` | `20260830174616_vto_feature_control.sql` | its real staging ledger version |
| `20260830160000_user_device_push_tokens.sql` | `20260830212508_user_device_push_tokens.sql` | its real staging ledger version |

Both renames are correct against the ledgers. The second one is wrong against
the **source tree**.

`20260830190000_watchlist_push_token_actor_isolation.sql` (DEF-WL-01) hardens
the `register_device_push_token()` RPC and the `user_device_push_tokens` table
that `20260830212508` **creates**. On staging that hardening applied under
ledger version `20260830214752` — *after* its dependency, which is the intended
order. But its repository filename says `20260830190000`, which sorts *before*
`20260830212508`. Moving the dependency from `…160000` to `…212508` carried it
**past its own dependent** in filename order.

```
INTENDED (and how staging was actually built, by ledger version)
  20260830212508   create table user_device_push_tokens + v1 RPCs
  20260830214752   DEF-WL-01 hardening of those RPCs + partial unique index

ACTUAL fresh replay (by filename version)
  20260830190000   DEF-WL-01 hardening       <-- runs first
  20260830212508   create table + v1 RPCs    <-- runs second
```

`config/migration-authority-manifest.json`'s entry for `20260830212508` records
the belief that the hardening was *"already-correctly-versioned … unaffected by
this rename"*. That held for the ledger and not for the source tree; the file's
repo version and its ledger version are different numbers.

### The dependency edge

* **A — `20260830212508_user_device_push_tokens.sql`** creates
  `public.user_device_push_tokens`, its `(user_id, device_id)` unique index,
  RLS, grants, and `register_device_push_token()` v1.
* **B — `20260830190000_watchlist_push_token_actor_isolation.sql`** replaces
  that function with the actor-isolating body, retires duplicate live rows, and
  creates the partial unique index `user_device_push_tokens_live_token_uidx`.

`A → B` is required. Fresh replay does `B → A`.

### Proven consequence

Reproduced by real execution against a disposable PostgreSQL cluster, 140
migrations in:

```
FAIL  20260830190000_watchlist_push_token_actor_isolation.sql
      ERROR:  type "public.user_device_push_tokens" does not exist
```

`returns public.user_device_push_tokens` is a composite-type reference resolved
when the function is created, so this is a hard abort, not a deferred failure.
**A fresh database could not be built from this tree at all.**

The second-order failure is worse than the first. Had it not aborted, `A`'s own
`create or replace function public.register_device_push_token(...)` would have
**overwritten** the DEF-WL-01 hardened body with the pre-hardening v1. A fresh
database would then carry:

* an unhardened `register_device_push_token` — the DEF-WL-01 actor-switch push
  leak reopened (actor A's price alert, whose body carries A's watched item
  title and price, delivered to a handset now signed in as actor B);
* no `user_device_push_tokens_live_token_uidx`; while
* `20260902120000` (WL-04) still creates the live-**device** unique index and
  documents its own safety as resting on *"register_device_push_token retires by
  device_id OR push_token"* — which, unhardened, it does not. A second actor
  registering on a device already live for a first would hit `23505` instead of
  taking custody of the route.

---

## 2. The repair

Two parts. Neither renames, deletes, squashes or reuses a migration version,
and no migration ledger entry is fabricated or hand-edited.

**Part 1 — existence guard, in place, identity preserved.**
`20260830190000`'s executable body is wrapped in
`do $f03_guard$ … if to_regclass('public.user_device_push_tokens') is null then return; end if; …`.
On a database that has not yet created the table the file is a no-op instead of
an abort. The statements inside the guard are unchanged, so on every database
where the table exists — which is every database this file has ever actually run
on — behaviour is identical. Its version, filename and ledger identity are
untouched, and **a database that already applied it never re-executes it**, so
this edit can only ever affect a fresh replay.

This is the same in-place existence-guard repair commit `6b8d0390` applied for
MIG-04 in `20260808115735_enforce_rpc_privilege_boundary.sql`, for the reason it
recorded there: *a trailing reconciliation migration cannot fix an aborting
transaction.*

**Part 2 — additive forward reconciliation.**
`20260909170000_watchlist_f03_push_token_actor_isolation_reconciliation.sql`
re-applies the identical DEF-WL-01 hardening at a version after `20260830212508`
and after every later migration that touches the table (`20260831120000`,
`20260902120000`, `20260909115726`), so a fresh replay converges on the intended
end state. It is idempotent, forward-only, non-destructive, and asserts its own
pre- and post-conditions rather than assuming them.

Neither part alone is sufficient: the guard alone silently drops the hardening
from a fresh database, and the reconciliation alone never runs because the
replay has already aborted.

---

## 3. Certification harness

`scripts/f03/` — local and disposable. It contacts no hosted Supabase project.

| file | role |
| --- | --- |
| `supabase-bootstrap.sql` | the Supabase platform state that exists *before* the first repo migration: roles, `auth`/`storage` schemas, `auth.uid()` and friends, the ledger table |
| `replay.sh` | applies `supabase/migrations/*.sql` to a throwaway database; supports `--resolve-aliases`, `--historical-order`, `--until`, `--only`, `--keep` |
| `verify-watchlist-schema.sql` / `verify.sh` | 54-assertion schema **and security** battery (RLS on, no anon/authenticated broad grants, service-role-only RPCs, N-4 receipt constraints, no raw token column, no scheduler) |
| `upgrade-fixture.sql` | the pre-upgrade Watchlist rows §16 requires to survive |
| `snapshot.sql` | stable text rendering of those rows, for a byte-exact before/after diff |
| `behaviour-test.sql` | four routing probes, including a control proving the probe can detect an absent constraint |
| `negative-control.sh` | removes the repair and proves the certification turns red |
| `certify.sh` | runs everything and prints the summary below |

Run it with `./scripts/f03/certify.sh` against a local PostgreSQL cluster.
`__tests__/watchlistF03MigrationOrder.test.js` pins the source-level contract
inside the governed suite, which needs no database.

### Two documented harness adaptations

Both are reported by the harness on every run; neither is silent, and neither
touches a file on disk.

* **`ENGINE_SHIM`** — this tree targets PostgreSQL 17 (ten migrations REVOKE the
  PG17-only `MAINTAIN` privilege; see the comment in
  `20260712020000_harden_app_role_privileges.sql`). The certification cluster is
  PostgreSQL 16, because the environment's network policy blocks the PGDG
  repository. `MAINTAIN` is stripped from `GRANT`/`REVOKE` privilege lists on
  those ten files before they are applied. This can only weaken the harness's
  own assertion, never the repair, and it does not reach the Watchlist
  push-token region, which uses no version-gated syntax.
* **`ALIAS_SKIP`** — `config/migration-provenance-manifest.json` declares two
  logical migrations that exist in the tree under two filenames each, where only
  one of the pair was ever applied in any environment. A naive `ls | sort` replay
  applies both and the second fails. `--resolve-aliases` applies only the alias
  the manifest records as **applied**, which is the lineage the real ledgers
  carry. See finding F03-P2-01 below.

---

## 4. Results

```
HISTORY A — fresh database
  FRESH_REPLAY=PASS            156 migrations, first 202605122359_profiles_base,
                               last 20260909170000_..._reconciliation, 0 failures
  SCHEMA_VERIFY=PASS           54/54
  FRESH_BEHAVIOUR=PASS         4/4 probes incl. control

HISTORY B — existing upgraded database
  HISTORICAL_STATE_RECONSTRUCTED=YES   hardening applied after its dependency,
                                       under its true ledger version 20260830214752
  HISTORICAL_REPLAY=PASS               155 migrations, cut at 20260909115726
  EXISTING_UPGRADE=PASS                repair applied alone, 1 migration
  WATCHLIST_ROWS_PRESERVED=YES         snapshots byte-identical
  PUSH_ROUTE_ROWS_PRESERVED=YES
  RECEIPT_ROWS_PRESERVED=YES
  REPAIR_IDEMPOTENT=YES                second application changes nothing
  SCHEMA_VERIFY=PASS                   54/54
  UPGRADE_BEHAVIOUR=PASS               4/4 probes incl. control

NEGATIVE CONTROLS
  NC1=RED_AS_EXPECTED   both parts reverted -> replay aborts on the original
                        missing-type error at 20260830190000
  NC2=RED_AS_EXPECTED   guard kept, reconciliation removed -> replay PASSES but
                        the battery FAILS on 3 DEF-WL-01 assertions
  NC3=RED_AS_EXPECTED   both parts reverted -> the governed test reports 6 named
                        failures (16/16 green with the repair)
```

Reconstructing History B also proves hostile-matrix item 3 directly: replayed in
the **intended** dependency order the current tree produces the correct schema
with no repair at all, which is what identifies the ordering — not the SQL — as
the defect.

---

## 5. Findings not required to close F-03

**F03-P2-01 — a raw fresh replay of the tree still fails outside the Watchlist
region.**

* Severity: P2
* Location: `supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql`
  and `20260721170559_dr3_collaborative_interactions.sql`
* Defect: `config/migration-provenance-manifest.json` declares each of these as
  an alias of a logical migration that was applied under the *other* filename in
  the pair. Both copies are in the active tree, so a replay that applies every
  file in lexical order applies the same SQL twice and the second copy aborts:
  `ERROR: relation "dressing_room_collab_idempotency_room_actor_op_request_key" already exists`.
* Impact: a fresh database cannot be built with a plain `supabase db push`
  against the whole directory. It can be built from the lineage the ledgers
  actually record, which is what `--resolve-aliases` replays.
* Suggested fix: give the unapplied alias of each pair the same treatment
  `6b8d0390` gave the fourth MIG-03 pair — relocate it out of the active
  migration set (the third declared pair, `add_purchase_options_to_saved_scans`,
  already has exactly that treatment: its unapplied alias is named in the
  manifest but is not in `supabase/migrations/`).
* `F03_BLOCKER=NO`. It is in Dressing Room collaboration schema, is reachable
  before any Watchlist migration, is unchanged by this lane, and is proven
  independent: with alias resolution the replay reaches migration 141 and fails
  only on F-03, and after the F-03 repair it completes all 156.

---

## 6. Scope and safety

```
PRODUCTION_TOUCHED=NO
PRODUCTION_PROMOTION=PENDING_APPLE_CLEARANCE
STAGING_MUTATED=NO
WATCHLIST_SCHEDULER_ACTIVATED=NO
WATCHLIST_WORKER_ACTIVATED=NO
EDGE_FUNCTION_RUNTIME_CHANGE=NO
OLD_MIGRATIONS_MODIFIED=NO   (no rename, delete, squash or version reuse;
                              one already-applied file gained a fresh-replay
                              guard around unchanged statements)
EXISTING_APPLIED_IDENTITIES_PRESERVED=YES
```

N-1 … N-6, RP-104 and RP-109 runtime semantics are unchanged: the repair adds no
column, drops nothing, alters no policy, and installs a
`register_device_push_token` body byte-identical to the one staging already
runs. `watchlist_push_receipts` is not referenced by the repair at all, and its
constraints, fingerprint shape, service-role-only posture and absence of a raw
token column are asserted on both certified databases.

### Staging

Staging was **not** mutated. Both database histories are certified locally, and
the upgrade path was proven against a reconstruction of staging's own applied
lineage rather than against staging itself. Applying the repair to staging would
add no evidence the local upgrade test does not already provide, so it was not
done for ceremony; it remains available as a normal promotion step whenever the
release line is next pushed.
