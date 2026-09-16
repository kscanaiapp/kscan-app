-- Build 33 backend repair -- Finding C (B33-STO-002): orphan-owner media reconciliation RPC.
--
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version 20260916130553 on
-- 2026-09-16. Read-only function; it deletes nothing.
--
-- STAGING TEST EVIDENCE (controlled harness, transaction rolled back so no synthetic
-- row persisted; verified 0 residue afterwards):
--   [PASS] referenced object PRESERVED                expected=0 actual=0
--   [PASS] unreferenced orphan DETECTED               expected=1 actual=1
--   [PASS] live-owner object NEVER swept              expected=0 actual=0
--   [PASS] null-owner object OUT OF SCOPE             expected=0 actual=0
--   [PASS] bucket allowlist raises on other buckets   raised 22023
--   [PASS] pagination no duplicates                   expected=0 actual=0
--   [PASS] pagination no omissions                    0 missing of 1200 paged
--   [PASS] pagination total scanned                   1231 across 3 pages of 500
--
-- PROBLEM THIS SOLVES, AND WHY THE EXISTING MACHINERY DOES NOT
--
-- Storage objects carry no foreign key to auth.users. When an account's Auth row
-- is removed, all 51 user-scoped public tables cascade, and
-- deletion_requests.user_id is set to NULL -- but storage.objects rows simply
-- remain, with storage.objects.owner left pointing at a user id that no longer
-- resolves. Production currently holds 7 such objects across 4 vanished owners.
--
-- The newer retained-owner-media work queue (20260831140000) does not address
-- this. That mechanism exists for objects a SUCCESSFUL purge deliberately
-- retained because a surviving transferred room still referenced them; the
-- worker enqueues those prefixes at the end of the purge. Production's objects
-- were never enqueued, because the purge never ran for them at all -- the Auth
-- users were deleted outside the governed worker path (attempt_count = 0,
-- worker_id null, and no purge state transition exists for any of them). A work
-- queue cannot service rows that were never written.
--
-- The one signal that survives an out-of-band Auth deletion is
-- storage.objects.owner failing to resolve against auth.users. This function
-- reads exactly that signal, and verifies in the same snapshot that nothing
-- still references the object.
--
-- SAFETY PROPERTIES
--
-- * Bucket allowlist. Only style-library-images is sweepable. legal-documents
--   and public-assets hold system assets with no user owner and are rejected.
-- * Never returns an object whose owner still resolves to a live auth.users row.
-- * Never returns an object with owner IS NULL. Such an object cannot be proven
--   to belong to a deleted account, so it is out of scope by construction.
--   (Production holds 5 of these; they are deliberately left alone.)
-- * Never returns an object that any reference column still points at. The
--   reference check spans every column that can hold a storage reference, not
--   just dressing_room_items, so media still used by a surviving transferred
--   room is preserved.
-- * Fails closed. If a referenced table or column is missing the function raises
--   and returns nothing, so the caller deletes nothing.
-- * Read-only. It selects; it never deletes. Byte removal is the caller's job,
--   because only the Storage API removes the underlying object as well as the row.
-- * Keyset pagination on name, so enumeration is stable and bounded.
--
-- service_role only: this reads across all users' media and must never be
-- reachable from a client role.

create or replace function public.list_orphan_owner_media(
  p_bucket text,
  p_limit  integer default 100,
  p_after  text default null
)
returns table (
  object_name  text,
  size_bytes   bigint,
  owner_prefix text,
  created_at   timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 1000));
begin
  if p_bucket is distinct from 'style-library-images' then
    raise exception 'bucket not sweepable: %', coalesce(p_bucket, '(null)')
      using errcode = '22023';
  end if;

  return query
  with referenced as (
    select s.storage_path as ref from public.saved_scans s where s.storage_path is not null
    union all select s.image_uri from public.saved_scans s where s.image_uri is not null
    union all select li.storage_path from public.look_items li where li.storage_path is not null
    union all select li.image_url from public.look_items li where li.image_url is not null
    union all select dri.storage_path from public.dressing_room_items dri where dri.storage_path is not null
    union all select dri.image_url from public.dressing_room_items dri where dri.image_url is not null
    union all select ii.storage_path from public.inspiration_items ii where ii.storage_path is not null
    union all select odi.storage_path from public.outfit_decision_option_items odi where odi.storage_path is not null
    union all select odi.image_url from public.outfit_decision_option_items odi where odi.image_url is not null
    union all select dr.cover_image_url from public.dressing_rooms dr where dr.cover_image_url is not null
    union all select l.cover_image_url from public.looks l where l.cover_image_url is not null
    union all select wui.image_uri from public.wardrobe_utility_items wui where wui.image_uri is not null
  )
  select
    o.name::text,
    coalesce((o.metadata->>'size')::bigint, 0),
    left(o.owner::text, 8),
    o.created_at
  from storage.objects o
  where o.bucket_id = p_bucket
    and o.owner is not null
    and not exists (select 1 from auth.users u where u.id = o.owner)
    and (p_after is null or o.name > p_after)
    and not exists (
      select 1 from referenced r
      where r.ref = o.name or r.ref like '%' || o.name
    )
  order by o.name
  limit v_limit;
end;
$function$;

revoke execute on function public.list_orphan_owner_media(text,integer,text) from public;
revoke execute on function public.list_orphan_owner_media(text,integer,text) from anon;
revoke execute on function public.list_orphan_owner_media(text,integer,text) from authenticated;
grant  execute on function public.list_orphan_owner_media(text,integer,text) to service_role;

-- Post-condition: the function must not be client-reachable.
do $verify$
declare v_oid oid := to_regprocedure('public.list_orphan_owner_media(text,integer,text)');
begin
  if v_oid is null then
    raise exception 'list_orphan_owner_media was not created';
  end if;
  if has_function_privilege('anon', v_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_oid, 'EXECUTE')
     or has_function_privilege('public', v_oid, 'EXECUTE') then
    raise exception 'list_orphan_owner_media is client-executable';
  end if;
  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception 'list_orphan_owner_media lost service_role EXECUTE';
  end if;
end
$verify$;
