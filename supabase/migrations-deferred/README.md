# Deferred migrations

Migrations that exist in source control but are **deliberately excluded from the
staging production-parity baseline**. Nothing in this directory is applied by
`scripts/staging-v2/apply-migrations.mjs` — it only reads `supabase/migrations`.

These files are preserved, not deleted. Moving one back into
`supabase/migrations` is a product decision, not a deployment step.

## `20260725100000_shared_room_item_contributions.sql`

**Why deferred:** this exact migration source is recorded in production under
the apply-time ledger version `20260808201806`, but it remains intentionally
excluded from the staging production-parity baseline for Build 29. It does not
merely *add* to the schema — it drops and recreates three RLS policies on
`public.dressing_room_items`:

- `Active participants can insert room items`
- `Contributors can update own room items`
- `Contributors can delete own room items`

It also adds `dressing_room_items.created_by uuid NOT NULL DEFAULT auth.uid()`,
plus two functions
(`can_contribute_to_dressing_room`, `guard_dressing_room_item_contribution_identity`),
a trigger, and an index.

The 2026-08-14 authorized read-only production audit verified that production
has the `created_by` column, the three contributor policies, the identity guard
trigger, and both functions. The ledger's stored statement is byte-for-byte the
quarantined migration source. Production's current
`can_contribute_to_dressing_room` definition has subsequently been hardened by
the intentional contribution-block enforcement migration; replaying this older
file is therefore not a safe way to converge staging.

Its location is an explicit Build 29 product decision and a deployment guard:
the active migration runner must continue to ignore this directory. Any future
staging convergence must use a separately reviewed migration that reproduces
production's *current*, block-aware authorization contract. Do not move or copy
this historical migration into `supabase/migrations`.
