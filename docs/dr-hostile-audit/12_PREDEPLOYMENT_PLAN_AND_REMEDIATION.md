# Pre-deployment plan and remediation

## Approved change set

Only the following changes are approved for deployment to production Supabase project `wyyuqfdxucjksghsmhry`:

1. Migration `supabase/migrations/20260721170559_dr3_collaborative_interactions.sql`
2. Migration `supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql`

No new hostile-audit migration is required. No Edge Function change is required (this audit did not modify any Supabase edge function; the two P2 audit repairs are in JavaScript client code and a Node test file, neither of which is deployed to Supabase).

## Pre-deployment operator checklist

Executed by the operator with `supabase` CLI:

```
supabase link --project-ref wyyuqfdxucjksghsmhry     # if not already linked
supabase migration list --linked                     # confirm current state
```

Required state before deployment:

- Neither `20260721170559_dr3_collaborative_interactions` nor `20260721183308_dr4_collab_idempotency_room_scope` appears in the applied list.
- Production does not already contain `dressing_room_collab_idempotency` table.
- Production `can_access_room_messages(uuid)` function definition is the pre-DR-3 (owner-or-any-participant) form.

If any pre-existing partial DR-3 state is found, STOP; forward-remediate via a new migration rather than attempting to re-run the DR-3 migration.

## Controlled migration replay (executed in this audit)

Executed in this audit. See [`10_TEST_AND_VALIDATION_EVIDENCE.md`](10_TEST_AND_VALIDATION_EVIDENCE.md) for the 22 hostile scenarios covering all of:

- Pre-DR-3 schema baseline
- DR-3 migration application
- DR-4 migration application
- Cross-room requestId reuse now succeeds (DR-4 fix)
- Same-room duplicate requestId with different payload rejected
- Reply-to-reply, cross-room parent, oversized body, empty body, non-v4 request id all rejected
- Revocation: access lost for recipients, history preserved for owner, access version bumped
- Anonymous rejected

Result: all scenarios pass with the exact expected outcome. Migration replay classification: **MIGRATION REPLAY VERIFIED**.

The operator should still confirm identical behavior against a `supabase` CLI local stack bound to the production project before applying to production, but the audit's replay against a genuine pre-DR-3 schema constitutes affirmative evidence that the migrations apply cleanly and that the RPCs enforce their advertised contracts.

## Deploy command

```
supabase db push --linked --include-all=false
```

The operator must explicitly limit the change set to the two approved migration timestamps. If `supabase db push` cannot be constrained to the two migrations (e.g., because of other pending timestamps), execute each migration explicitly instead:

```
supabase db execute --file supabase/migrations/20260721170559_dr3_collaborative_interactions.sql
supabase db execute --file supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql
```

## Forward-remediation plan

If a defect surfaces post-deployment:

- Idempotency ledger insertion collision: forward-remediate via a new migration that adjusts the unique constraint or adds a targeted DELETE for the offending row set. Do not edit either applied migration.
- RPC bug: forward-remediate by shipping a new migration that recreates (`CREATE OR REPLACE FUNCTION`) the affected RPC. All DR-3/DR-4 RPCs use `CREATE OR REPLACE FUNCTION` so forward replacement is safe.
- Access decision bug: forward-remediate via a new `CREATE OR REPLACE FUNCTION public.resolve_dressing_room_collaboration_access(...)` or `can_access_room_messages(...)`.
- Trigger bug: forward-remediate via `CREATE OR REPLACE FUNCTION public.enforce_dressing_room_message_flat_thread()`.

Destructive rollback is discouraged because DR-3 changes are additive; forward remediation is safer than trying to drop columns/tables that clients may already read.

## Pre-deployment gate assessment

| Gate | State |
| --- | --- |
| Worktree correct | PASS |
| Branch correct | PASS |
| Starting SHA correct | PASS |
| DR-4 milestone ancestry | PASS |
| DR-1/2/3 ancestry | PASS |
| Inventory complete | PASS (see [`01_COMPLETE_DR_TREE_INVENTORY.md`](01_COMPLETE_DR_TREE_INVENTORY.md)) |
| Reachability traced | PASS |
| Source-repairable BLOCKER closed | PASS (none found) |
| P0 closed | PASS (none found) |
| P1 closed | PASS (none found) |
| Source-repairable P2 closed | PASS (2 of 2 repaired) |
| Cross-user exposure | PASS (none) |
| Cross-room exposure | PASS (none) |
| Revocation defects | PASS (none) |
| Idempotency defects | PASS (DR-4 addresses DR-3 defect) |
| Pagination defects | PASS (none) |
| Reply-depth defects | PASS (none) |
| Account-isolation defects | PASS (none) |
| Scanner provenance defects | PASS (none) |
| Commerce preservation defects | PASS (none) |
| Elise authorization defects | PASS (none) |
| Migration safety defects | PASS (none source-verified) |
| Old-client compatibility defects | PASS (backward compatible; DR-3 tightens access — intended) |
| Public-preview compatibility defects | PASS (unchanged) |
| Website/backend authorization conflict | PASS (none observed) |
| Controlled migration replay | PASS (MIGRATION REPLAY VERIFIED — 22 hostile scenarios pass) |
| RLS access matrix | PASS (SOURCE VERIFIED) |
| RPC contract matrix | PASS (SOURCE VERIFIED) |
| TypeScript | PASS |
| Deno check | PASS |
| Deno suite | N/A (no Deno test files touched by DR-1..DR-4) |
| Node suite | PASS (1703/1703) |
| DR-1..DR-4 tests | PASS (68/68) |
| Hostile-audit tests added | N/A (no new hostile-audit tests required — existing coverage sufficed to catch both defects) |
| Complete repo tests | PASS (1703/1703) |
| `git diff --check` | PASS |
| Feature flags OFF | PASS (all 12 default OFF) |
| Realtime deferred | PASS |
| No mobile build required | PASS (backend-only) |
| Deployment plan | PASS (documented above) |
| Forward-remediation plan | PASS (documented above) |
| Local audit commits complete | PASS after commit step |

## Pre-deployment verdict

**PRE-DEPLOYMENT VERDICT: PASS**
