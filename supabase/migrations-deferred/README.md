# Deferred migrations

Migrations that exist in source control but are **deliberately excluded from the
staging production-parity baseline**. Nothing in this directory is applied by
`scripts/staging-v2/apply-migrations.mjs` — it only reads `supabase/migrations`.

These files are preserved, not deleted. Moving one back into
`supabase/migrations` is a product decision, not a deployment step.

## `20260725100000_shared_room_item_contributions.sql`

**Why deferred:** it is not applied in production, and it does not merely *add*
to the schema — it drops and recreates three RLS policies that production
already defines differently on `public.dressing_room_items`:

- `Active participants can insert room items`
- `Contributors can update own room items`
- `Contributors can delete own room items`

It also adds `dressing_room_items.created_by uuid NOT NULL DEFAULT auth.uid()`,
a column production does not have, plus two functions
(`can_contribute_to_dressing_room`, `guard_dressing_room_item_contribution_identity`),
a trigger, and an index.

Object-level comparison of the locally rebuilt baseline against production
identified `dressing_room_items` as the *only* table whose column set diverged,
and this migration was the sole cause.

Applying it to staging would make staging enforce a different write-authorization
contract than the released client runs against in production — precisely the
class of drift this rebuild exists to remove. It stays deferred until the
shared-room contributions feature actually ships to production.
