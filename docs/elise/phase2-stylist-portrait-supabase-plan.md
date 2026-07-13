# Phase 2 — Stylist Portrait Avatar Supabase Plan

This is the forward-only database sequence for enabling the ten local portrait presets. It records the pre-audit gap, the Phase 1 hardening migration, the Phase 2 expansion, and the final audit deployment state.

## Final audit deployment state

The intended remote project was confirmed safely as `wyyu...mhry`. At final-audit
preflight, that project did not contain `public.user_stylist_preferences`, and
neither avatar migration was recorded remotely. Several earlier repository
migrations were also pending, including the table-creation and grants
prerequisites. Because the audit authorized deployment of only the two avatar
allowlist migrations, no remote migration was deployed and no unrelated
pending migration was applied.

The local test database already contained the preference table. The audit
applied the exact Phase 1 and Phase 2 files locally through Postgres with
stop-on-error, recorded their local history only after successful execution,
and verified all sixteen values, invalid-value rejection, owner isolation,
anonymous denial, grants, RLS, cascade deletion, and updated-at trigger
behavior.

### Backend-target verification

- Release `.env` configuration and every EAS build profile target the same
  abbreviated Supabase project: `wyyu...mhry`.
- The Supabase CLI is linked to `wyyu...mhry`.
- The Android audit APK intentionally targets local Supabase through
  `10.0.2.2:54321`; it is not evidence of a different release project.
- The older working phone build was not connected for binary inspection, so
  its embedded project remains unresolved. No repository or EAS evidence points
  to a second intended release project.

Release configuration and the CLI therefore match. If later inspection of the
working phone identifies a different project, stop before deployment and
reconcile the target explicitly.

### Minimal remote prerequisite set

Apply only this dependency chain, in order, after separate authorization:

1. `20260713000001_user_stylist_preferences.sql` - creates only
   `public.user_stylist_preferences`, its PK/auth-user cascade FK, name checks,
   three owner-scoped RLS policies, the updated-at function/trigger, and the
   service-role table grant.
2. `20260714000001_user_stylist_preferences_rls_grants.sql` - grants only
   SELECT/INSERT/UPDATE on that table to `authenticated`; it creates no object
   and changes no policy.
3. `20260714000003_add_user_stylist_preferences_avatar_allowlist.sql` - adds
   only the six-ID Phase 1 CHECK after its non-destructive row precheck.
4. `20260715000001_expand_stylist_portrait_avatar_allowlist.sql` - replaces
   only that named CHECK with the sixteen-ID definition after its precheck.

Deletion coverage is also declared in `scripts/process-deletion-request.js`;
the database deletion guarantee itself comes from the auth-user FK cascade.

The other remotely pending repository migrations are not prerequisites and
must not be bundled: `20260711000001`, `20260711000002`, `20260711000003`,
`20260711195508`, `20260712000001`, `20260712010000`, `20260712020000`, and
`20260714000002`. Remote history also contains `20260709130346` without a
matching local migration file; this drift must not be rewritten as part of the
stylist-identity deployment.

The connected Supabase migration interface supports applying each exact SQL
file as a separately named migration, so targeted deployment is supported once
the four filenames above are explicitly authorized. A broad CLI migration push
would include unrelated pending files and must not be used.

Remote catalog inspection found no differently named stylist/preference table,
equivalent RPC, alternate-schema object, or manually created equivalent. The
minimal chain does not duplicate an existing remote persistence architecture.

An isolated disposable Postgres database bootstrapped from the remote
prerequisite boundary accepted the four-file sequence. It produced one table,
one sixteen-ID constraint, three policies, three authenticated grants, no anon
grant, RLS enabled, the cascade FK, and the updated-at trigger; cross-actor read
and arbitrary avatar-ID checks were rejected.

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

The migration counts unsupported existing rows and aborts without exposing values, deleting rows, or coercing data. It is committed and locally verified. Remote deployment remains blocked until the table and grants prerequisites are explicitly authorized and applied.

RLS is enabled. The three policies are `Users can select own stylist preferences`, `Users can insert own stylist preferences`, and `Users can update own stylist preferences`; each is scoped to `authenticated` and `auth.uid() = user_id`, with both `USING` and `WITH CHECK` on update. `authenticated` has SELECT/INSERT/UPDATE, `service_role` has CRUD, and `anon` has no table grant. The `user_stylist_preferences_updated_at` trigger calls `set_user_stylist_preferences_updated_at()`. Account deletion is covered both by the foreign-key cascade and `scripts/process-deletion-request.js`.

## Phase 2 migration

Forward-only filename:

`supabase/migrations/20260715000001_expand_stylist_portrait_avatar_allowlist.sql`

The migration was created for Phase 2 and is committed at the exact filename above. Do not rename it or edit applied migration history.

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

1. Explicitly authorize and apply the existing preference-table creation and grants prerequisites to the intended project. Do not bundle unrelated pending migrations.
2. Verify the table, RLS policies, grants, cascade, trigger, and unsupported-row count.
3. Apply `20260714000003_add_user_stylist_preferences_avatar_allowlist.sql` and record its migration history only after successful execution.
4. Verify the exact six-ID constraint and invalid-ID rejection.
5. Apply `20260715000001_expand_stylist_portrait_avatar_allowlist.sql` and record its migration history only after successful execution.
6. Verify the exact sixteen-ID constraint, RLS, grants, cascade, and trigger.
7. Verify an abstract write and a portrait write on disposable test users, plus invalid-ID rejection and User A/User B isolation.
8. Only then distribute a portrait-enabled client. The Phase 2 client source is already enabled, so it must not be released ahead of this backend gate.
9. Monitor persistence failures. Older clients remain compatible because all six abstract IDs stay allowed.

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
