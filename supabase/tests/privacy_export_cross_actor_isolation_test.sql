-- TS-07 — privacy export cross-actor isolation.
--
-- Closes a COVERAGE GAP: the isolation was believed to hold but had never been
-- attacked. Nothing here changes product code; every assertion is an attempt by
-- one user to reach another user's export request, plus the anonymous and
-- malformed-identifier cases.
--
-- The surface is deliberately small. `privacy-data-export` is write-only: it
-- derives user_id from the VERIFIED JWT (never from the request body) and
-- returns only the row it just created for the caller. There is no read
-- endpoint, so the only way to reach someone else's export is the table itself
-- — which is what this file attacks.
--
-- Every assertion switches role explicitly, because the role running this file
-- is superuser-like and would BYPASSRLS otherwise: a denial observed as a
-- superuser proves nothing.
--
-- Runs in one transaction and is rolled back.

begin;

select plan(25);

-- ── Fixture: two real users, each with an export request ─────────────────────

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000301', 'ts07-user-a@example.invalid'),
  ('00000000-0000-0000-0000-000000000302', 'ts07-user-b@example.invalid');

insert into public.privacy_export_requests (id, user_id, status, request_source, export_manifest, notes)
values
  ('00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-000000000301',
   'completed', 'mobile_app', '{"includes":["profile account fields"],"download":"https://example.invalid/a-secret"}'::jsonb,
   'A private note belonging to user A'),
  ('00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-000000000302',
   'pending', 'mobile_app', '{"includes":["profile account fields"]}'::jsonb, null);

insert into public.privacy_correction_requests (user_id, status, request_source, requested_changes)
values ('00000000-0000-0000-0000-000000000301', 'pending', 'mobile_app',
        '{"field":"display_name","to":"A correction belonging to user A"}'::jsonb);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;

-- ── 1. The table is not reachable by client roles at all ─────────────────────
-- Defence in depth: an owner-scoped RLS policy exists, AND no client role holds
-- a table grant, so the policy is a second line rather than the only one.

select is_empty(
  $$ select 1 from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = 'privacy_export_requests'
       and grantee in ('anon', 'authenticated') $$,
  'no client role holds any grant on privacy_export_requests'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.privacy_export_requests'::regclass),
  'row level security is enabled on privacy_export_requests'
);
select is(
  (select pg_get_expr(polqual, polrelid) from pg_policy
    where polrelid = 'public.privacy_export_requests'::regclass and polcmd = 'r'),
  '(user_id = auth.uid())',
  'the read policy is owner-scoped, so adding a grant later would still be safe'
);
select is_empty(
  $$ select 1 from pg_policy
     where polrelid = 'public.privacy_export_requests'::regclass
       and polcmd in ('a', 'w', 'd') $$,
  'no client-side insert, update or delete policy exists on export requests'
);

-- ── 2. Anonymous reaches nothing ─────────────────────────────────────────────

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

select throws_ok(
  $$ select 1 from public.privacy_export_requests $$,
  '42501', null,
  'anonymous cannot read the export table'
);
select throws_ok(
  $$ select 1 from public.privacy_export_requests
     where id = '00000000-0000-0000-0000-0000000003a1' $$,
  '42501', null,
  'anonymous cannot read a named export request'
);
select throws_ok(
  $$ select export_manifest from public.privacy_export_requests $$,
  '42501', null,
  'anonymous cannot reach the manifest, which is where a download URL would live'
);
select throws_ok(
  $$ insert into public.privacy_export_requests (user_id, status, request_source)
     values ('00000000-0000-0000-0000-000000000301', 'pending', 'mobile_app') $$,
  '42501', null,
  'anonymous cannot forge an export request for someone else'
);
select throws_ok(
  $$ select 1 from public.privacy_correction_requests $$,
  '42501', null,
  'anonymous cannot read correction requests either'
);
reset role;

-- ── 3. User B reaches nothing of User A's ────────────────────────────────────

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000302');

select throws_ok(
  $$ select 1 from public.privacy_export_requests $$,
  '42501', null,
  'an authenticated user cannot list export requests at all'
);
-- Naming the exact row id.
select throws_ok(
  $$ select 1 from public.privacy_export_requests
     where id = '00000000-0000-0000-0000-0000000003a1' $$,
  '42501', null,
  'user B cannot read user A''s export request by its id'
);
-- UUID substitution: claiming to be user A in the predicate.
select throws_ok(
  $$ select 1 from public.privacy_export_requests
     where user_id = '00000000-0000-0000-0000-000000000301' $$,
  '42501', null,
  'user B cannot read user A''s export requests by substituting A''s user id'
);
-- The status alone is sensitive: it discloses that A requested an export.
select throws_ok(
  $$ select status from public.privacy_export_requests
     where user_id = '00000000-0000-0000-0000-000000000301' $$,
  '42501', null,
  'user B cannot learn the status of user A''s export'
);
select throws_ok(
  $$ select export_manifest ->> 'download' from public.privacy_export_requests
     where id = '00000000-0000-0000-0000-0000000003a1' $$,
  '42501', null,
  'user B cannot reach a download reference inside user A''s manifest'
);
select throws_ok(
  $$ select notes from public.privacy_export_requests
     where id = '00000000-0000-0000-0000-0000000003a1' $$,
  '42501', null,
  'user B cannot read the free-text notes on user A''s request'
);
-- Aggregate probing: a count still discloses that something exists.
select throws_ok(
  $$ select count(*) from public.privacy_export_requests
     where user_id = '00000000-0000-0000-0000-000000000301' $$,
  '42501', null,
  'user B cannot count user A''s export requests'
);
select throws_ok(
  $$ update public.privacy_export_requests set status = 'cancelled'
     where id = '00000000-0000-0000-0000-0000000003a1' $$,
  '42501', null,
  'user B cannot mutate user A''s export request'
);
select throws_ok(
  $$ delete from public.privacy_export_requests
     where id = '00000000-0000-0000-0000-0000000003a1' $$,
  '42501', null,
  'user B cannot delete user A''s export request'
);
select throws_ok(
  $$ insert into public.privacy_export_requests (user_id, status, request_source)
     values ('00000000-0000-0000-0000-000000000301', 'pending', 'mobile_app') $$,
  '42501', null,
  'user B cannot forge an export request attributed to user A'
);
select throws_ok(
  $$ select requested_changes from public.privacy_correction_requests
     where user_id = '00000000-0000-0000-0000-000000000301' $$,
  '42501', null,
  'user B cannot read user A''s correction request'
);
-- A guessed but non-existent id must fail identically to a real one, so the
-- error itself does not confirm which ids exist.
select throws_ok(
  $$ select 1 from public.privacy_export_requests
     where id = '00000000-0000-0000-0000-0000000009ff' $$,
  '42501', null,
  'a guessed id is refused exactly as a real one is, disclosing nothing'
);
reset role;

-- ── 4. User A is no more privileged than user B on this table ────────────────

set local role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000301');
select throws_ok(
  $$ select 1 from public.privacy_export_requests
     where id = '00000000-0000-0000-0000-0000000003a1' $$,
  '42501', null,
  'even the owner cannot read the table directly — the client path is the function, not the table'
);
reset role;

-- ── 5. User A's own authorized path still works ──────────────────────────────
-- privacy-data-export runs as service_role and derives user_id from the
-- verified JWT. Modelled here at the layer this file can reach: a service-role
-- write scoped to the caller succeeds, and the row it returns is A's own.

set local role service_role;
select lives_ok(
  $$ insert into public.privacy_export_requests (user_id, status, request_source, export_manifest)
     values ('00000000-0000-0000-0000-000000000301', 'pending', 'mobile_app', '{}'::jsonb) $$,
  'user A''s authorized export path still creates a request'
);
select is(
  (select count(*)::int from public.privacy_export_requests
    where user_id = '00000000-0000-0000-0000-000000000301'),
  2,
  'the new request belongs to user A and did not disturb the existing one'
);
select is(
  (select count(*)::int from public.privacy_export_requests
    where user_id = '00000000-0000-0000-0000-000000000302'),
  1,
  'user B''s request is untouched by user A''s activity'
);
reset role;

select * from finish();
rollback;
