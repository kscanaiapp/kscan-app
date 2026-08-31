-- Build 34 -- hostile-audit repair INT-KPLUS-010 (P4 policy closure).
--
-- DEFECT. Account purge deliberately RETAINS storage objects that a surviving
-- dressing_room_items row still points at: dressing-room item rows cascade with
-- their ROOM, not with the deleting user, so a room transferred to another owner
-- legitimately keeps its images. deleteOwnedStorage() therefore computes
-- `retained` and skips those objects. That part is correct and must not change.
--
-- What was missing is the OTHER end of the lifecycle. Nothing ever revisited a
-- retained object once the last surviving reference disappeared. The room gets
-- deleted, the item row goes, and the deleted owner's media stays in storage
-- forever with nothing pointing at it and no account left to own it.
--
-- Room/item teardown is a direct CLIENT-side table delete
-- (services/styleObjects.ts), so there is no server-side teardown seam to hook
-- and the client is not a trustworthy deletion authority for another user's
-- media. The closure is therefore a scheduled server-side sweep, run by the
-- existing account-deletion worker.
--
-- APPROVED RETENTION POLICY (owner ruling, 2026-08-31):
--   - while ANY surviving dressing_room_items row references media under the
--     deleted owner's prefix, that media is retained;
--   - once the FINAL surviving reference disappears, the object becomes
--     eligible for deletion by the next governed orphan sweep;
--   - the existing reference-check logic is reused unchanged;
--   - client-side room teardown is never trusted as deletion authority;
--   - indefinite retention is NOT adopted;
--   - NO additional arbitrary retention period is introduced. Eligibility
--     begins the moment the last reference is gone, because no existing
--     product or legal requirement defines a longer window.
--
-- This table is a WORK LIST, not a data store: it records only which storage
-- prefixes still hold retained objects, so the sweep knows where to look. It
-- holds no user content. The prefix embeds the deleted user's id because that
-- is what addresses the objects -- the same identifier already present in every
-- storage path it points at -- and the row is deleted once the prefix is clear.

create table if not exists public.deleted_owner_retained_media (
  id                uuid        primary key default gen_random_uuid(),
  -- The deletion_requests ledger row this came from. That row survives auth
  -- deletion by design (survive_auth_delete), so this reference stays valid.
  deletion_request_id uuid      not null references public.deletion_requests(id) on delete cascade,
  storage_bucket    text        not null,
  storage_prefix    text        not null,
  -- How many objects were still referenced at the last sweep. Purely
  -- observational; the sweep always re-derives the truth from storage.
  retained_count    integer     not null default 0,
  first_retained_at timestamptz not null default now(),
  last_swept_at     timestamptz,
  sweep_attempts    integer     not null default 0,
  -- Set when the prefix has been fully cleared. Retained briefly for audit,
  -- then removed by the sweep's own housekeeping.
  cleared_at        timestamptz,

  constraint deleted_owner_retained_media_bucket_len
    check (char_length(storage_bucket) between 1 and 100),
  constraint deleted_owner_retained_media_prefix_len
    check (char_length(storage_prefix) between 1 and 400),
  constraint deleted_owner_retained_media_count_nonneg
    check (retained_count >= 0),
  unique (storage_bucket, storage_prefix)
);

create index if not exists deleted_owner_retained_media_open
  on public.deleted_owner_retained_media (first_retained_at)
  where cleared_at is null;

alter table public.deleted_owner_retained_media enable row level security;

-- No client access of any kind. This is worker-only bookkeeping about accounts
-- that no longer exist; there is no actor who could legitimately read it.
revoke all on table public.deleted_owner_retained_media from public, anon, authenticated;
grant select on table public.deleted_owner_retained_media to service_role;

comment on table public.deleted_owner_retained_media is
  'INT-KPLUS-010. Work list of storage prefixes belonging to purged accounts that still held objects referenced by surviving dressing-room items. The scheduled orphan sweep re-checks each prefix and removes objects once their final reference is gone. Holds no user content.';

-- ── Record a prefix that finished a purge with objects still retained ───────
create or replace function public.record_retained_owner_media(
  p_request_id uuid,
  p_bucket     text,
  p_prefix     text,
  p_retained   integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_request_id is null or p_bucket is null or p_prefix is null then
    raise exception 'request_id, bucket and prefix are required' using errcode = '23502';
  end if;

  -- Nothing retained means nothing to sweep: clear any prior work item rather
  -- than leaving a stale one behind.
  if coalesce(p_retained, 0) <= 0 then
    delete from public.deleted_owner_retained_media
     where storage_bucket = p_bucket and storage_prefix = p_prefix;
    return;
  end if;

  insert into public.deleted_owner_retained_media
    (deletion_request_id, storage_bucket, storage_prefix, retained_count)
  values (p_request_id, p_bucket, p_prefix, p_retained)
  on conflict (storage_bucket, storage_prefix) do update
    set retained_count = excluded.retained_count,
        deletion_request_id = excluded.deletion_request_id,
        cleared_at = null;
end;
$$;

revoke all on function public.record_retained_owner_media(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.record_retained_owner_media(uuid, text, text, integer) to service_role;

-- ── Claim prefixes to sweep ────────────────────────────────────────────────
-- Same claim discipline as the rest of this project's workers: bounded, and
-- FOR UPDATE SKIP LOCKED so two overlapping worker invocations take disjoint
-- work instead of racing the same prefix.
create or replace function public.claim_retained_owner_media_for_sweep(
  p_limit int default 25
)
returns setof public.deleted_owner_retained_media
language plpgsql
security definer
set search_path = public
as $$
declare
  bounded_limit int := greatest(1, least(coalesce(p_limit, 25), 200));
begin
  return query
  update public.deleted_owner_retained_media m
  set last_swept_at = now(),
      sweep_attempts = m.sweep_attempts + 1
  from (
    select id
    from public.deleted_owner_retained_media
    where cleared_at is null
    order by last_swept_at nulls first, first_retained_at
    limit bounded_limit
    for update skip locked
  ) due
  where m.id = due.id
  returning m.*;
end;
$$;

revoke all on function public.claim_retained_owner_media_for_sweep(int) from public, anon, authenticated;
grant execute on function public.claim_retained_owner_media_for_sweep(int) to service_role;

-- ── Settle a swept prefix ──────────────────────────────────────────────────
create or replace function public.settle_retained_owner_media(
  p_bucket    text,
  p_prefix    text,
  p_remaining integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_bucket is null or p_prefix is null then
    return false;
  end if;

  if coalesce(p_remaining, 0) <= 0 then
    -- Fully cleared: the work item has served its purpose and is removed, so
    -- no record of a deleted account's storage layout lingers.
    delete from public.deleted_owner_retained_media
     where storage_bucket = p_bucket and storage_prefix = p_prefix;
    return true;
  end if;

  update public.deleted_owner_retained_media
  set retained_count = p_remaining,
      cleared_at = null
  where storage_bucket = p_bucket and storage_prefix = p_prefix;

  return found;
end;
$$;

revoke all on function public.settle_retained_owner_media(text, text, integer) from public, anon, authenticated;
grant execute on function public.settle_retained_owner_media(text, text, integer) to service_role;

comment on function public.settle_retained_owner_media(text, text, integer) is
  'INT-KPLUS-010. Records the post-sweep state of a prefix. A fully-cleared prefix has its work item deleted outright so no residue of a purged account survives.';
