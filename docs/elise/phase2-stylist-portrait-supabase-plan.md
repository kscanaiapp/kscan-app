# Phase 2 — Stylist Portrait Avatar Supabase Plan

This is the forward-only database sequence for enabling the ten local portrait presets. It records the pre-audit gap, the local Phase 1 hardening migration, and the later Phase 2 expansion. Neither migration is deployed by this audit.

## Verified Phase 1 contract

Source migrations:

- `20260713000001_user_stylist_preferences.sql`
- `20260714000001_user_stylist_preferences_rls_grants.sql`
- `20260714000003_add_user_stylist_preferences_avatar_allowlist.sql`

`public.user_stylist_preferences` has `user_id uuid primary key references auth.users(id) on delete cascade`, `display_name`, `avatar_id text not null default 'elise_default'`, `created_at`, and `updated_at`.

### Current pre-audit state

No database `avatar_id` CHECK constraint existed. The original source migration had name and control-character checks only, so RLS enforced ownership but not allowed avatar values.

### Phase 1 audit hardening

`20260714000003_add_user_stylist_preferences_avatar_allowlist.sql` adds `user_stylist_preferences_avatar_id_check` with exactly these six shipped abstract IDs:

- `elise_default`
- `editorial_plum`
- `chrome_muse`
- `deep_space`
- `cream_gold`
- `obsidian_orchid`

The migration counts unsupported existing rows and aborts without exposing values, deleting rows, or coercing data. It is created locally and **not deployed by this audit**. It must be reviewed and applied in the authorized backend deployment step before Phase 2 begins.

RLS is enabled. The three policies are `Users can select own stylist preferences`, `Users can insert own stylist preferences`, and `Users can update own stylist preferences`; each is scoped to `authenticated` and `auth.uid() = user_id`, with both `USING` and `WITH CHECK` on update. `authenticated` has SELECT/INSERT/UPDATE, `service_role` has CRUD, and `anon` has no table grant. The `user_stylist_preferences_updated_at` trigger calls `set_user_stylist_preferences_updated_at()`. Account deletion is covered both by the foreign-key cascade and `scripts/process-deletion-request.js`.

## Proposed Phase 2 migration

Proposed forward-only filename:

`supabase/migrations/20260715000001_expand_stylist_portrait_avatar_allowlist.sql`

At implementation time, create it with `supabase migration new expand_stylist_portrait_avatar_allowlist` and use the CLI-generated timestamp if it differs; do not hand-create migration history.

First verify the Phase 1 migration is applied and the six-ID constraint exists. Phase 2 intentionally replaces that same named constraint with the sixteen-ID definition below.

```sql
-- Refuse to continue if an existing row would be invalid. Do not rewrite rows.
do $$
declare
  invalid_row_count bigint;
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_stylist_preferences'::regclass
      and conname = 'user_stylist_preferences_avatar_id_check'
  ) then
    raise exception 'Phase 1 avatar allowlist constraint is not applied';
  end if;

  select count(*) into invalid_row_count
  from public.user_stylist_preferences
  where avatar_id not in (
    'elise_default',
    'editorial_plum',
    'chrome_muse',
    'deep_space',
    'cream_gold',
    'obsidian_orchid',
    'stylist_portrait_01',
    'stylist_portrait_02',
    'stylist_portrait_03',
    'stylist_portrait_04',
    'stylist_portrait_05',
    'stylist_portrait_06',
    'stylist_portrait_07',
    'stylist_portrait_08',
    'stylist_portrait_09',
    'stylist_portrait_10'
  );

  if invalid_row_count > 0 then
    raise exception 'user_stylist_preferences contains % invalid avatar_id row(s)', invalid_row_count;
  end if;
end
$$;

alter table public.user_stylist_preferences
  drop constraint user_stylist_preferences_avatar_id_check,
  add constraint user_stylist_preferences_avatar_id_check
  check (
    avatar_id in (
      'elise_default',
      'editorial_plum',
      'chrome_muse',
      'deep_space',
      'cream_gold',
      'obsidian_orchid',
      'stylist_portrait_01',
      'stylist_portrait_02',
      'stylist_portrait_03',
      'stylist_portrait_04',
      'stylist_portrait_05',
      'stylist_portrait_06',
      'stylist_portrait_07',
      'stylist_portrait_08',
      'stylist_portrait_09',
      'stylist_portrait_10'
    )
  );
```

The final allowlist is exactly six abstract IDs plus ten portrait IDs. The replacement occurs in one migration transaction and does not modify existing rows, alter RLS, reissue grants, change the foreign key, replace the trigger, or change defaults.

## Rollout order

1. Review and apply the Phase 1 six-ID migration to the intended project in an authorized backend deployment step. Verify its exact constraint definition and invalid-ID rejection.
2. Add and validate the ten static local assets in the client, but keep portrait presets non-selectable and non-persistable.
3. Create the Phase 2 forward migration with `supabase migration new expand_stylist_portrait_avatar_allowlist`; review the generated filename and SQL.
4. Verify the six-ID constraint exists, then run the sixteen-ID invalid-row precheck. Investigate invalid rows individually; do not silently coerce them.
5. Deploy the Phase 2 migration first. Verify the sixteen-ID constraint, RLS, grants, cascade, and trigger.
6. Verify an abstract write and a portrait write on a non-production test user, plus invalid-ID rejection and User A/User B isolation.
7. Only after backend acceptance is proven, change each shipped portrait registry entry from placeholder to ready with its static source and enable client persistence. Release the compatible client.
8. Monitor persistence failures. Older clients remain compatible because all six abstract IDs stay allowed.

Never ship a portrait-enabled client before the backend constraint and portrait acceptance are verified.

## Validation queries and checks

Constraint and definition:

```sql
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.user_stylist_preferences'::regclass
  and conname = 'user_stylist_preferences_avatar_id_check';
```

Expected: one CHECK constraint containing exactly the sixteen registry IDs. Then confirm there are no invalid rows using the same sixteen-value predicate reviewed in the migration precheck.

RLS, grants, foreign key, and trigger:

```sql
select relrowsecurity
from pg_class
where oid = 'public.user_stylist_preferences'::regclass;

select policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'user_stylist_preferences'
order by policyname;

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'user_stylist_preferences'
order by grantee, privilege_type;

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.user_stylist_preferences'::regclass
  and contype = 'f';

select tgname, pg_get_triggerdef(oid)
from pg_trigger
where tgrelid = 'public.user_stylist_preferences'::regclass
  and not tgisinternal;
```

Expected: RLS true; the same three owner policies; no `anon` table grant; authenticated SELECT/INSERT/UPDATE; service-role CRUD; `ON DELETE CASCADE`; and the existing updated-at trigger.

Application-level verification must use disposable test users:

- User A can read, insert, and update only User A's row.
- User B cannot read or update User A's row, and User A cannot read or update User B's row.
- A valid abstract ID succeeds.
- `stylist_portrait_01` succeeds only after the migration is deployed.
- `unknown_avatar_id` fails with a CHECK-constraint violation.
- Deleting a disposable auth user removes its preference row through cascade.

## Recovery guidance

If the precheck finds invalid rows, stop deployment, identify their provenance, and resolve them through an approved data-repair process before retrying. If post-deployment portrait writes fail, keep or restore the client portraits to placeholder state while investigating; the six abstract IDs continue to work. Do not remove the CHECK constraint merely to make writes pass. Any emergency constraint rollback requires portraits to be disabled first and a reviewed follow-up migration; never edit applied migration history.
