-- IOS29-NEW-003 pgTAP coverage for the Apple revocation credential store.
--
-- The whole security value of this table is that no client role can ever read
-- the stored Apple token. These assertions exist so that stays true if someone
-- later adds a permissive policy sweep or a blanket grant.
--
-- Every fixture is rolled back; this test never mutates production data.

begin;
select no_plan();

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000007001', 'apple-cred-owner@example.invalid'),
  ('00000000-0000-0000-0000-000000007002', 'apple-cred-attacker@example.invalid');

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.apple_auth_credentials'::regclass),
  'apple_auth_credentials has RLS enabled'
);

-- RLS with zero policies is the fail-closed posture: authenticated matches no
-- rows for any command. A policy appearing here is a deliberate decision that
-- must be reviewed, so assert the count rather than the absence of a named one.
select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'apple_auth_credentials'),
  0::bigint,
  'apple_auth_credentials has no RLS policies, so no client role matches any row'
);

select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'apple_auth_credentials'
      and grantee in ('anon', 'authenticated')),
  0::bigint,
  'neither anon nor authenticated holds any privilege on apple_auth_credentials'
);

select ok(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'apple_auth_credentials'
      and grantee = 'service_role' and privilege_type = 'SELECT') = 1,
  'service_role can read the table for revocation'
);

-- Only the encrypted envelope is stored. A column that could hold a raw Apple
-- token, an identity token, an email, or a name would be a widening of scope.
select set_eq(
  $$select column_name::text from information_schema.columns
     where table_schema = 'public' and table_name = 'apple_auth_credentials'$$,
  $$values ('user_id'), ('encrypted_refresh_token'), ('created_at'), ('updated_at')$$,
  'apple_auth_credentials stores only the encrypted token and its ownership/timestamps'
);

-- ---------------------------------------------------------------------------
-- The envelope constraint rejects anything that is not ciphertext
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.apple_auth_credentials (user_id, encrypted_refresh_token)
    values ('00000000-0000-0000-0000-000000007001', 'r1abc.plaintext.apple.token')$$,
  23514,
  null,
  'a value that is not a v1 AES-GCM envelope is rejected'
);

select lives_ok(
  $$insert into public.apple_auth_credentials (user_id, encrypted_refresh_token)
    values ('00000000-0000-0000-0000-000000007001', 'v1.AAAAAAAAAAAAAAAA.Y2lwaGVydGV4dA==')$$,
  'a well-formed envelope is accepted'
);

-- One live authorization per user: re-authorising must replace, not accumulate.
select throws_ok(
  $$insert into public.apple_auth_credentials (user_id, encrypted_refresh_token)
    values ('00000000-0000-0000-0000-000000007001', 'v1.BBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA==')$$,
  23505,
  null,
  'a second credential row for the same user is rejected'
);

-- ---------------------------------------------------------------------------
-- No client role can reach the stored token
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000007001', true);

-- The owner cannot read their OWN credential. That is intentional: the token is
-- a server-side revocation instrument, not user data the client ever needs.
select throws_ok(
  $$select encrypted_refresh_token from public.apple_auth_credentials$$,
  42501,
  null,
  'the owning user cannot select their own Apple credential'
);

select throws_ok(
  $$insert into public.apple_auth_credentials (user_id, encrypted_refresh_token)
    values ('00000000-0000-0000-0000-000000007002', 'v1.CCCCCCCCCCCCCCCC.Y2lwaGVydGV4dA==')$$,
  42501,
  null,
  'an authenticated caller cannot plant a credential for another user'
);

select throws_ok(
  $$delete from public.apple_auth_credentials$$,
  42501,
  null,
  'an authenticated caller cannot delete credentials to dodge revocation'
);

reset role;

set local role anon;
select throws_ok(
  $$select encrypted_refresh_token from public.apple_auth_credentials$$,
  42501,
  null,
  'anon cannot select Apple credentials'
);
reset role;

-- ---------------------------------------------------------------------------
-- The credential cannot outlive the account
-- ---------------------------------------------------------------------------

-- Normal deletion revokes and erases this row BEFORE the auth user goes away.
-- The cascade is the safety net for a purge path that skipped revocation: the
-- secret must not survive its owner either way.
delete from auth.users where id = '00000000-0000-0000-0000-000000007001';

select is(
  (select count(*) from public.apple_auth_credentials
    where user_id = '00000000-0000-0000-0000-000000007001'),
  0::bigint,
  'deleting the auth user removes any surviving Apple credential'
);

select * from finish();
rollback;
