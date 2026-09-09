-- F-03 Watchlist schema + security certification battery.
--
-- Read-only. Emits one row per check: CHECK_ID | PASS/FAIL | detail. The shell
-- wrapper (scripts/f03/verify.sh) fails the run if any row is FAIL, so a new
-- assertion cannot be added and then quietly ignored.
--
-- Scope is the Watchlist region F-03 touches plus the N-4 receipt table and
-- the N-1..N-6 / RP-104 / RP-109 routing state that must survive the repair.
-- It deliberately asserts SECURITY POSTURE (RLS on, no anon/authenticated
-- broad grants, service-role-only RPCs) as well as shape, so a repair that
-- made replay succeed by loosening access would fail here rather than pass.

\pset tuples_only on
\pset format unaligned
\pset fieldsep ' | '

with checks as (

-- ── 7. required tables ────────────────────────────────────────────────────
select 1 as ord, 'TABLE_' || upper(t) as id,
       case when to_regclass('public.' || t) is not null then 'PASS' else 'FAIL' end as result,
       coalesce(to_regclass('public.' || t)::text, 'missing') as detail
from unnest(array[
  'user_commerce_watches','user_commerce_watch_events',
  'user_device_push_tokens','watchlist_push_receipts'
]) as t

-- ── 8. required columns ───────────────────────────────────────────────────
union all
select 2, 'COLUMN_' || upper(c.tbl) || '_' || upper(c.col),
       case when exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = c.tbl and column_name = c.col
       ) then 'PASS' else 'FAIL' end,
       c.tbl || '.' || c.col
from (values
  ('user_device_push_tokens','user_id'),('user_device_push_tokens','push_token'),
  ('user_device_push_tokens','platform'),('user_device_push_tokens','device_id'),
  ('user_device_push_tokens','revoked_at'),('user_device_push_tokens','last_used_at'),
  ('watchlist_push_receipts','ticket_id'),('watchlist_push_receipts','token_row_id'),
  ('watchlist_push_receipts','token_fingerprint'),('watchlist_push_receipts','state'),
  ('watchlist_push_receipts','retirement_outcome'),('watchlist_push_receipts','attempt_count'),
  ('user_commerce_watches','push_enabled')
) as c(tbl, col)

-- ── 21. no raw push token duplicated into receipt storage ─────────────────
union all
select 3, 'RECEIPTS_NO_RAW_TOKEN_COLUMN',
       case when not exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'watchlist_push_receipts'
           and column_name in ('push_token','token','expo_push_token','raw_token')
       ) then 'PASS' else 'FAIL' end,
       'watchlist_push_receipts stores a fingerprint, never the delivery token'

-- ── 20/22. N-4 constraints ────────────────────────────────────────────────
union all
select 4, 'CONSTRAINT_' || upper(k), 
       case when exists (
         select 1 from pg_constraint where conname = k
       ) then 'PASS' else 'FAIL' end, k
from unnest(array[
  'watchlist_push_receipts_fingerprint_len',
  'watchlist_push_receipts_state_enum',
  'watchlist_push_receipts_retirement_enum',
  'watchlist_push_receipts_error_category_enum',
  'watchlist_push_receipts_attempt_bound',
  'watchlist_push_receipts_ticket_id_len',
  'user_device_push_tokens_platform_enum',
  'user_device_push_tokens_push_token_len',
  'user_device_push_tokens_device_id_len'
]) as k

-- ── 10. required indexes (the two F-03 restores plus their neighbours) ────
union all
select 5, 'INDEX_' || upper(i),
       case when to_regclass('public.' || i) is not null then 'PASS' else 'FAIL' end, i
from unnest(array[
  'user_device_push_tokens_live_token_uidx',
  'user_device_push_tokens_live_device_uidx',
  'user_device_push_tokens_user_device_uidx',
  'user_device_push_tokens_deliverable_idx',
  'watchlist_push_receipts_ticket_uidx',
  'watchlist_push_receipts_due_idx'
]) as i

-- ── 11. required functions ────────────────────────────────────────────────
union all
select 6, 'FUNCTION_' || upper(f),
       case when exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = f
       ) then 'PASS' else 'FAIL' end, f
from unnest(array[
  'register_device_push_token','revoke_device_push_token','claim_device_for_actor'
]) as f

-- ── 3. THE F-03 DEPENDENCY ITSELF: hardened body, not merely a name ───────
union all
select 7, 'DEFWL01_REGISTER_RPC_HARDENED',
       case when exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'register_device_push_token'
           and p.prosrc like '%device_id = p_device_id or push_token = p_push_token%'
       ) then 'PASS' else 'FAIL' end,
       'register_device_push_token retires competing live routes before upsert'

union all
select 7, 'DEFWL01_LIVE_TOKEN_INDEX_PARTIAL',
       case when exists (
         select 1 from pg_index x
         join pg_class c on c.oid = x.indexrelid
         where c.relname = 'user_device_push_tokens_live_token_uidx'
           and x.indisunique and x.indpred is not null
       ) then 'PASS' else 'FAIL' end,
       'unique, and partial on revoked_at is null'

-- ── 12. RLS enabled ───────────────────────────────────────────────────────
union all
select 8, 'RLS_ENABLED_' || upper(t),
       case when (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass)
            then 'PASS' else 'FAIL' end, t
from unnest(array[
  'user_commerce_watches','user_commerce_watch_events',
  'user_device_push_tokens','watchlist_push_receipts'
]) as t

-- ── 13. no anon table privileges anywhere in the Watchlist region ─────────
union all
select 9, 'ANON_NO_TABLE_PRIVILEGE_' || upper(t),
       case when not exists (
         select 1 from information_schema.role_table_grants
         where table_schema = 'public' and table_name = t and grantee = 'anon'
       ) then 'PASS' else 'FAIL' end,
       coalesce((
         select string_agg(privilege_type, ',') from information_schema.role_table_grants
         where table_schema = 'public' and table_name = t and grantee = 'anon'
       ), 'none')
from unnest(array[
  'user_commerce_watches','user_commerce_watch_events',
  'user_device_push_tokens','watchlist_push_receipts'
]) as t

-- ── 14. authenticated is read-only on the token route, absent on receipts ─
union all
select 10, 'AUTHENTICATED_TOKENS_SELECT_ONLY',
       case when (
         select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'none')
         from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'user_device_push_tokens'
           and grantee = 'authenticated'
       ) = 'SELECT' then 'PASS' else 'FAIL' end,
       coalesce((
         select string_agg(distinct privilege_type, ',' order by privilege_type)
         from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'user_device_push_tokens'
           and grantee = 'authenticated'
       ), 'none')

union all
select 10, 'AUTHENTICATED_NO_RECEIPT_ACCESS',
       case when not exists (
         select 1 from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'watchlist_push_receipts'
           and grantee = 'authenticated'
       ) then 'PASS' else 'FAIL' end,
       'watchlist_push_receipts is service-role only'

-- ── 15. service_role retains the worker surface ───────────────────────────
union all
select 11, 'SERVICE_ROLE_TOKENS_WRITE',
       case when (
         select count(distinct privilege_type) from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'user_device_push_tokens'
           and grantee = 'service_role'
           and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
       ) = 4 then 'PASS' else 'FAIL' end,
       'service_role keeps select/insert/update/delete'

union all
select 11, 'SERVICE_ROLE_RECEIPTS_WRITE',
       case when (
         select count(distinct privilege_type) from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'watchlist_push_receipts'
           and grantee = 'service_role'
           and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
       ) = 4 then 'PASS' else 'FAIL' end,
       'service_role keeps select/insert/update/delete'

-- ── register/revoke RPCs remain service-role-only ─────────────────────────
union all
select 12, 'RPC_SERVICE_ROLE_ONLY_' || upper(f),
       case when not (
         has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE')
       ) and has_function_privilege('service_role', p.oid, 'EXECUTE')
       then 'PASS' else 'FAIL' end,
       f || ' anon=' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
         || ' authenticated=' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
         || ' service_role=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
from unnest(array['register_device_push_token','revoke_device_push_token']) as f
join pg_proc p on p.proname = f
join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'

-- ── 26/27/28. nothing in this lane may activate the evaluator ─────────────
union all
select 13, 'NO_PG_CRON_EXTENSION',
       case when not exists (select 1 from pg_extension where extname = 'pg_cron')
            then 'PASS' else 'FAIL' end,
       'pg_cron must not be installed by this migration tree'

union all
select 13, 'NO_ACTIVE_WATCHLIST_SCHEDULE',
       case when to_regclass('cron.job') is null then 'PASS' else 'FAIL' end,
       'no cron.job relation exists'

)
select id || ' | ' || result || ' | ' || detail
from checks
order by ord, id;
