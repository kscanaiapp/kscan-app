-- Migration provenance (restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29).
--
-- Owning repository: kscan-app
-- Original authored file: (same name)
-- Original source commit: a66b757
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version: 20260806153233
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/LEDGER_INTEGRITY_CHECK.md
-- for source/ledger SHA-256 hashes and full verification detail.

-- Dressing Room account-level user blocking.
--
-- Adds a shared, account-level (not room-scoped) block relationship between
-- two authenticated users, plus enforcement across every Dressing Room
-- authorization surface: message read/write, room-metadata visibility via
-- the Shared-with-Me path, and share-link redemption. A block is active in
-- either direction (A blocked B OR B blocked A).
--
-- Reuses the existing derived-revocation model (see
-- 20260721170559_dr3_collaborative_interactions.sql / revoke_room_share):
-- dressing_room_participants rows and dressing_room_messages are never
-- deleted; access is re-derived on every check. This migration follows the
-- same convention rather than introducing row deletion.
--
-- Non-owner-to-non-owner blocking: the room-wide message stream (all
-- participants see all messages; no per-recipient scoping) cannot
-- selectively hide one participant's content from another while both remain
-- active participants. The minimal, backend-enforced (not client-side-only)
-- outcome is that the blocking participant's OWN participation in any room
-- they share with the blocked non-owner is marked left (dressing_room_
-- participants.left_at), touching only the blocker's own row. The owner and
-- any other unrelated co-participants are unaffected.
--
-- `internal` is an existing, unexposed (non-public, not in the PostgREST
-- Data API schema list) schema already used in this project for
-- internal.edge_function_errors. New pair-relationship helpers live there
-- specifically so they can never be reached as a client-callable
-- `/rest/v1/rpc/...` RPC regardless of table/function grants, closing the
-- "arbitrary relationship enumeration" risk a public-schema equivalent would
-- carry even with EXECUTE revoked from anon/authenticated (RLS policies that
-- reference the helper still need EXECUTE from `authenticated`, since RLS
-- predicates evaluate as the querying role, not as the function owner).

-- ── 1. Block relationship table ──────────────────────────────────────────

create table public.dressing_room_user_blocks (
  blocker_user_id uuid not null
    references auth.users(id) on delete cascade,

  blocked_user_id uuid not null
    references auth.users(id) on delete cascade,

  created_at timestamptz not null default now(),

  primary key (blocker_user_id, blocked_user_id),

  constraint dressing_room_user_blocks_no_self_block
    check (blocker_user_id <> blocked_user_id)
);

comment on table public.dressing_room_user_blocks is
  'Account-level Dressing Room block relationships. A pair is blocked when either direction exists. Not room-scoped.';

create index dressing_room_user_blocks_blocked_idx
  on public.dressing_room_user_blocks (blocked_user_id);

alter table public.dressing_room_user_blocks enable row level security;

revoke all on public.dressing_room_user_blocks from anon;
revoke all on public.dressing_room_user_blocks from public;

-- Direct-table policies (defense in depth). The block/unblock/list RPCs
-- below are the intended primary path, but the table remains independently
-- correct if ever queried/written directly under RLS.
grant select, insert, delete on public.dressing_room_user_blocks to authenticated;

create policy "dressing_room_user_blocks_select_own"
on public.dressing_room_user_blocks
for select
to authenticated
using (auth.uid() = blocker_user_id);

create policy "dressing_room_user_blocks_insert_own"
on public.dressing_room_user_blocks
for insert
to authenticated
with check (auth.uid() = blocker_user_id);

create policy "dressing_room_user_blocks_delete_own"
on public.dressing_room_user_blocks
for delete
to authenticated
using (auth.uid() = blocker_user_id);

-- ── 2. Participant-level voluntary departure (additive column) ──────────
-- Minimal, additive column mirroring the existing soft-marker convention
-- (dressing_room_messages.deleted_at). Participant rows are still never
-- deleted; NULL means active, non-NULL means the participant is no longer
-- an active member of that specific room (currently only ever set by the
-- non-owner-to-non-owner block path below).

alter table public.dressing_room_participants
  add column left_at timestamptz null;

comment on column public.dressing_room_participants.left_at is
  'Set when this participant voluntarily leaves this specific room (e.g. blocking a co-participant in a room the caller does not own). NULL means active. Never affects other participants or the room owner.';

create index dressing_room_participants_active_idx
  on public.dressing_room_participants (dressing_room_id, user_id)
  where left_at is null;

-- ── 3. Internal (unexposed-schema) pair-relationship helpers ────────────

create or replace function internal.is_dressing_room_pair_blocked(user_a uuid, user_b uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
  select exists (
    select 1
    from public.dressing_room_user_blocks b
    where (b.blocker_user_id = user_a and b.blocked_user_id = user_b)
       or (b.blocker_user_id = user_b and b.blocked_user_id = user_a)
  );
$function$;

comment on function internal.is_dressing_room_pair_blocked(uuid, uuid) is
  'Bidirectional block check. Boolean only — never exposes which account blocked which, and never returns block-table rows. Not client-callable: internal schema is not in the exposed Data API schema list.';

revoke all on function internal.is_dressing_room_pair_blocked(uuid, uuid) from public;
revoke all on function internal.is_dressing_room_pair_blocked(uuid, uuid) from anon;
-- Granted to authenticated because RLS predicates (content_reports, dressing_rooms
-- below) evaluate as the querying role, not as this function's owner; the
-- unexposed schema — not this grant — is what prevents direct client enumeration.
grant execute on function internal.is_dressing_room_pair_blocked(uuid, uuid) to authenticated;

create or replace function internal.dressing_room_pair_has_interacted(user_a uuid, user_b uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
  select exists (
    select 1
    from public.dressing_rooms dr
    join public.dressing_room_participants p on p.dressing_room_id = dr.id
    where (dr.user_id = user_a and p.user_id = user_b)
       or (dr.user_id = user_b and p.user_id = user_a)
  )
  or exists (
    -- Both are non-owner co-participants of the same room (owner unrelated
    -- to either). Without this clause, two participants who only ever met
    -- as fellow guests in a third party's room could never block each other.
    select 1
    from public.dressing_room_participants pa
    join public.dressing_room_participants pb
      on pb.dressing_room_id = pa.dressing_room_id
    where pa.user_id = user_a and pb.user_id = user_b
  );
$function$;

comment on function internal.dressing_room_pair_has_interacted(uuid, uuid) is
  'True when one account owns a Dressing Room the other has ever joined (as participant), in either direction, OR both accounts have ever been co-participants in the same room. Used to require a real prior Dressing Room relationship before a block or a user-report is accepted.';

revoke all on function internal.dressing_room_pair_has_interacted(uuid, uuid) from public;
revoke all on function internal.dressing_room_pair_has_interacted(uuid, uuid) from anon;
grant execute on function internal.dressing_room_pair_has_interacted(uuid, uuid) to authenticated;

create or replace function internal.lock_dressing_room_pair(user_a uuid, user_b uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'pg_catalog'
as $function$
declare
  sorted_a uuid;
  sorted_b uuid;
begin
  if user_a is null or user_b is null then
    raise exception 'Both accounts are required for pair locking' using errcode = '22023';
  end if;

  if user_a = user_b then
    return;
  end if;

  if user_a < user_b then
    sorted_a := user_a;
    sorted_b := user_b;
  else
    sorted_a := user_b;
    sorted_b := user_a;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(sorted_a::text || ':' || sorted_b::text, 0));
end;
$function$;

comment on function internal.lock_dressing_room_pair(uuid, uuid) is
  'Transaction-scoped advisory lock keyed on the sorted account pair (64-bit hashtextextended, seed 0). Serializes block creation against message send / share redemption / participant creation for the same pair. VOLATILE by construction (side-effecting) — never call from a STABLE function. No public/anon/authenticated grant: only ever invoked from within other postgres-owned SECURITY DEFINER functions, never from RLS or directly as a client RPC.';

revoke all on function internal.lock_dressing_room_pair(uuid, uuid) from public;
revoke all on function internal.lock_dressing_room_pair(uuid, uuid) from anon;
revoke all on function internal.lock_dressing_room_pair(uuid, uuid) from authenticated;

-- ── 4. Update existing authorization primitives ──────────────────────────

create or replace function public.can_access_room_messages(p_room_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
  select
    exists (
      select 1
      from public.dressing_rooms dr
      where dr.id = p_room_id
        and dr.user_id = (select auth.uid())
    )
    or exists (
      select 1
      from public.dressing_room_participants drp
      join public.room_shares rs
        on rs.id = drp.joined_via_share_id
      join public.dressing_rooms dr
        on dr.id = drp.dressing_room_id
      where drp.dressing_room_id = p_room_id
        and drp.user_id = (select auth.uid())
        and drp.left_at is null
        and rs.room_id = p_room_id
        and rs.is_active = true
        and rs.revoked_at is null
        and (rs.expires_at is null or rs.expires_at > clock_timestamp())
        and rs.owner_id = dr.user_id
        and dr.user_id is distinct from (select auth.uid())
        and not internal.is_dressing_room_pair_blocked(dr.user_id, drp.user_id)
    );
$function$;

create or replace function public.resolve_dressing_room_collaboration_access(p_room_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  current_user_id uuid := (select auth.uid());
  room_owner_id uuid;
  access_version bigint;
  is_owner boolean := false;
  is_shared boolean := false;
  can_access boolean := false;
  can_message boolean := false;
begin
  if current_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'unauthenticated'
    );
  end if;

  if p_room_id is null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'unauthorized'
    );
  end if;

  select dr.user_id, dr.collaboration_access_version
    into room_owner_id, access_version
  from public.dressing_rooms dr
  where dr.id = p_room_id;

  if room_owner_id is null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'not_found'
    );
  end if;

  is_owner := room_owner_id = current_user_id;

  if not is_owner then
    select exists (
      select 1
      from public.dressing_room_participants drp
      join public.room_shares rs
        on rs.id = drp.joined_via_share_id
      where drp.dressing_room_id = p_room_id
        and drp.user_id = current_user_id
        and drp.left_at is null
        and rs.room_id = p_room_id
        and rs.is_active = true
        and rs.revoked_at is null
        and (rs.expires_at is null or rs.expires_at > clock_timestamp())
        and rs.owner_id = room_owner_id
        and not internal.is_dressing_room_pair_blocked(room_owner_id, current_user_id)
    ) into is_shared;
  end if;

  can_access := is_owner or is_shared;

  if not can_access then
    return jsonb_build_object(
      'ok', false,
      'reason', 'unauthorized',
      'roomId', p_room_id,
      'accessVersion', access_version
    );
  end if;

  -- The owner's room and message history are always preserved (ok/canView
  -- stay true), but if every participant this room has ever had is blocked
  -- against the owner, the owner cannot send NEW messages into a room with
  -- no reachable audience. A room that has NEVER had any participant at all
  -- (nobody has redeemed a link yet) is unaffected — there is nothing to be
  -- blocked from, and that is distinct from "had a participant who left
  -- because of a block": the latter must still resolve to canMessage=false,
  -- so the emptiness check does not filter left_at.
  if is_owner then
    can_message := not exists (
      select 1
      from public.dressing_room_participants drp2
      where drp2.dressing_room_id = p_room_id
    ) or exists (
      select 1
      from public.dressing_room_participants drp2
      where drp2.dressing_room_id = p_room_id
        and drp2.left_at is null
        and not internal.is_dressing_room_pair_blocked(room_owner_id, drp2.user_id)
    );
  else
    -- Reaching here means is_shared was true, which already required the
    -- pair to be unblocked.
    can_message := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'roomId', p_room_id,
    'authenticatedActorId', current_user_id,
    'currentOwnerId', room_owner_id,
    'relationship', case when is_owner then 'owner' else 'shared_recipient' end,
    'canView', true,
    'canReact', can_message,
    'canMessage', can_message,
    'canReply', can_message,
    'canSubscribe', true,
    'canUpdateReadState', false,
    'accessVersion', access_version
  );
end;
$function$;

create or replace function public.create_dressing_room_message(p_room_id uuid, p_body text, p_client_message_id uuid, p_parent_message_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  current_user_id uuid := (select auth.uid());
  room_owner_id uuid;
  access jsonb;
  cleaned text;
  payload_key text;
  payload_hash text;
  existing public.dressing_room_collab_idempotency%rowtype;
  inserted public.dressing_room_messages%rowtype;
  result_json jsonb;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not public.dr3_is_uuid_v4(p_client_message_id) then
    raise exception 'Invalid client message id' using errcode = '22023';
  end if;

  if p_room_id is null then
    raise exception 'Dressing room is required' using errcode = '22023';
  end if;

  select dr.user_id into room_owner_id
  from public.dressing_rooms dr
  where dr.id = p_room_id;

  if room_owner_id is not null and room_owner_id is distinct from current_user_id then
    perform internal.lock_dressing_room_pair(room_owner_id, current_user_id);
  end if;

  cleaned := btrim(
    regexp_replace(coalesce(p_body, ''), E'[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]', '', 'g')
  );

  if cleaned = '' then
    raise exception 'Message cannot be empty' using errcode = '22023';
  end if;

  if char_length(cleaned) > 1000 then
    raise exception 'Message too long' using errcode = '22023';
  end if;

  access := public.resolve_dressing_room_collaboration_access(p_room_id);
  if coalesce((access->>'ok')::boolean, false) is not true
     or coalesce((access->>'canMessage')::boolean, false) is not true then
    raise exception 'Shared room is unavailable' using errcode = '42501';
  end if;

  payload_key := concat_ws(
    '|',
    p_room_id::text,
    cleaned,
    coalesce(p_parent_message_id::text, '')
  );
  payload_hash := public.dr3_payload_hash(payload_key);

  select *
    into existing
  from public.dressing_room_collab_idempotency
  where room_id = p_room_id
    and actor_id = current_user_id
    and operation = 'message'
    and request_id = p_client_message_id;

  if found then
    if existing.payload_hash is distinct from payload_hash then
      raise exception 'Idempotency key reused with different payload' using errcode = '22023';
    end if;
    return existing.result_json;
  end if;

  insert into public.dressing_room_messages (
    room_id,
    sender_id,
    body,
    client_message_id,
    parent_message_id
  ) values (
    p_room_id,
    current_user_id,
    cleaned,
    p_client_message_id,
    p_parent_message_id
  )
  returning * into inserted;

  result_json := jsonb_build_object(
    'ok', true,
    'id', inserted.id,
    'roomId', inserted.room_id,
    'senderId', inserted.sender_id,
    'body', inserted.body,
    'createdAt', inserted.created_at,
    'clientMessageId', inserted.client_message_id,
    'parentMessageId', inserted.parent_message_id,
    'accessVersion', (access->>'accessVersion')::bigint
  );

  insert into public.dressing_room_collab_idempotency (
    actor_id, operation, request_id, room_id, payload_hash, result_json
  ) values (
    current_user_id, 'message', p_client_message_id, p_room_id, payload_hash, result_json
  );

  return result_json;
end;
$function$;

create or replace function public.join_room_via_share_token(p_share_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_token text := nullif(btrim(coalesce(p_share_token, '')), '');
  target_share_id uuid;
  target_room_id uuid;
  target_owner_id uuid;
  target_max_redemptions integer;
  current_redemptions integer;
  existing_participant_id uuid;
  existing_left_at timestamptz;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Invalid share link' using errcode = '22023';
  end if;

  select rs.id, rs.room_id, dr.user_id, rs.max_redemptions
  into target_share_id, target_room_id, target_owner_id, target_max_redemptions
  from public.room_shares rs
  join public.dressing_rooms dr
    on dr.id = rs.room_id
  where rs.share_token = normalized_token
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  limit 1
  for update of rs;

  if target_room_id is null then
    raise exception 'Shared room is unavailable' using errcode = '42501';
  end if;

  -- The owner is an implicit participant; never create a membership row for them.
  if target_owner_id is not distinct from current_user_id then
    return target_room_id;
  end if;

  -- Serialize against a concurrent block transaction for this exact pair
  -- before deciding anything else.
  perform internal.lock_dressing_room_pair(target_owner_id, current_user_id);

  if internal.is_dressing_room_pair_blocked(target_owner_id, current_user_id) then
    raise exception 'Shared room is unavailable' using errcode = '42501';
  end if;

  select p.id, p.left_at
  into existing_participant_id, existing_left_at
  from public.dressing_room_participants p
  where p.dressing_room_id = target_room_id
    and p.user_id = current_user_id;

  if existing_participant_id is not null then
    -- Reopening an already-joined room is idempotent and does not consume
    -- another redemption.
    if existing_left_at is null then
      return target_room_id;
    end if;

    -- Previously left this specific room (only ever set by the non-owner
    -- block path below) and the pair is not blocked: redeeming the link
    -- again reactivates participation, still subject to the numeric cap.
    if target_max_redemptions is not null then
      select count(*)
      into current_redemptions
      from public.dressing_room_participants p
      where p.joined_via_share_id = target_share_id
        and p.left_at is null;

      if current_redemptions >= target_max_redemptions then
        raise exception 'Shared room is full' using errcode = '42501';
      end if;
    end if;

    update public.dressing_room_participants
    set left_at = null,
        joined_via_share_id = target_share_id
    where id = existing_participant_id;

    return target_room_id;
  end if;

  -- NULL is the preserved unlimited sentinel. Numeric caps alone are counted.
  if target_max_redemptions is not null then
    select count(*)
    into current_redemptions
    from public.dressing_room_participants p
    where p.joined_via_share_id = target_share_id
      and p.left_at is null;

    if current_redemptions >= target_max_redemptions then
      raise exception 'Shared room is full' using errcode = '42501';
    end if;
  end if;

  insert into public.dressing_room_participants (dressing_room_id, user_id, role, joined_via_share_id)
  values (target_room_id, current_user_id, 'participant', target_share_id);

  return target_room_id;
end;
$$;

-- ── 5. Room-metadata visibility (Shared with Me path) ────────────────────

drop policy if exists "Recipients can select rooms via active shares" on public.dressing_rooms;
create policy "Recipients can select rooms via active shares"
on public.dressing_rooms
for select
to authenticated
using (
  exists (
    select 1
    from shared_room_memberships m
    join room_shares s on s.id = m.share_id
    where s.room_id = dressing_rooms.id
      and m.recipient_user_id = (select auth.uid())
      and m.removed_at is null
      and s.is_active = true
      and s.revoked_at is null
      and (s.expires_at is null or s.expires_at > now())
      and not internal.is_dressing_room_pair_blocked(dressing_rooms.user_id, (select auth.uid()))
  )
);

-- ── 6. Block / unblock / list RPCs ────────────────────────────────────────

create or replace function public.block_dressing_room_user(p_target_user_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_target_user_id is null then
    raise exception 'This Dressing Room interaction is unavailable' using errcode = '22023';
  end if;

  if p_target_user_id = current_user_id then
    raise exception 'This Dressing Room interaction is unavailable' using errcode = '22023';
  end if;

  perform internal.lock_dressing_room_pair(current_user_id, p_target_user_id);

  if not internal.dressing_room_pair_has_interacted(current_user_id, p_target_user_id) then
    raise exception 'This Dressing Room interaction is unavailable' using errcode = '42501';
  end if;

  insert into public.dressing_room_user_blocks (blocker_user_id, blocked_user_id)
  values (current_user_id, p_target_user_id)
  on conflict (blocker_user_id, blocked_user_id) do nothing;

  -- Bump collaboration_access_version on every room where this pair has an
  -- owner/participant relationship, in both directions, so an already-open
  -- screen's next poll observes the change rather than waiting on RPC denial.
  update public.dressing_rooms dr
  set collaboration_access_version = collaboration_access_version + 1
  where (
      dr.user_id = current_user_id
      and exists (
        select 1 from public.dressing_room_participants p
        where p.dressing_room_id = dr.id and p.user_id = p_target_user_id
      )
    ) or (
      dr.user_id = p_target_user_id
      and exists (
        select 1 from public.dressing_room_participants p
        where p.dressing_room_id = dr.id and p.user_id = current_user_id
      )
    );

  -- Mark participant rows inactive so unblocking never silently restores
  -- access (the is_dressing_room_pair_blocked check alone would otherwise
  -- pass again the instant the block row is deleted). left_at is permanent
  -- and only ever cleared by a fresh join_room_via_share_token redemption
  -- while unblocked, matching "fresh invitation required after unblock."
  --
  -- Case A: target is a participant in a room the blocker owns (owner blocks
  -- participant) — the target's row in the blocker's room(s) is marked left.
  update public.dressing_room_participants p
  set left_at = now()
  where p.user_id = p_target_user_id
    and p.left_at is null
    and exists (
      select 1 from public.dressing_rooms dr
      where dr.id = p.dressing_room_id and dr.user_id = current_user_id
    );

  -- Case B: blocker is a participant in a room the target owns (participant
  -- blocks owner) — the blocker's own row in the target's room(s) is marked
  -- left.
  update public.dressing_room_participants p
  set left_at = now()
  where p.user_id = current_user_id
    and p.left_at is null
    and exists (
      select 1 from public.dressing_rooms dr
      where dr.id = p.dressing_room_id and dr.user_id = p_target_user_id
    );

  -- Case C: neither owns the room; both are co-participants (non-owner
  -- blocks non-owner). The room-wide message stream cannot selectively hide
  -- the target's messages from the blocker while both remain active
  -- participants, so only the blocker's own row is marked left. The owner
  -- and any other co-participants are unaffected — this never touches the
  -- target's row or removes them from a third party's room.
  update public.dressing_room_participants p
  set left_at = now()
  where p.user_id = current_user_id
    and p.left_at is null
    and exists (
      select 1 from public.dressing_room_participants p2
      where p2.dressing_room_id = p.dressing_room_id
        and p2.user_id = p_target_user_id
        and p2.left_at is null
    )
    and not exists (
      select 1 from public.dressing_rooms dr
      where dr.id = p.dressing_room_id
        and dr.user_id in (current_user_id, p_target_user_id)
    );

  return jsonb_build_object('ok', true);
end;
$function$;

comment on function public.block_dressing_room_user(uuid) is
  'Creates (idempotently) a Dressing Room block from the caller to the target and applies its access consequences in the same transaction. Neutral result only — never reveals block direction or the other account''s details, never notifies the other account.';

revoke all on function public.block_dressing_room_user(uuid) from public;
revoke all on function public.block_dressing_room_user(uuid) from anon;
grant execute on function public.block_dressing_room_user(uuid) to authenticated;

create or replace function public.unblock_dressing_room_user(p_target_user_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  current_user_id uuid := (select auth.uid());
  removed_count integer;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_target_user_id is null then
    raise exception 'This Dressing Room interaction is unavailable' using errcode = '22023';
  end if;

  delete from public.dressing_room_user_blocks
  where blocker_user_id = current_user_id
    and blocked_user_id = p_target_user_id;

  get diagnostics removed_count = row_count;

  -- Intentionally no restoration of participant rows, grants, memberships,
  -- invitations, links, left_at, or room access. A fresh invitation from the
  -- owner follows the normal share/redemption flow.
  return jsonb_build_object('ok', true, 'removed', removed_count > 0);
end;
$function$;

comment on function public.unblock_dressing_room_user(uuid) is
  'Removes a block the caller created. Idempotent. Never restores prior grants, invitations, links, or room access.';

revoke all on function public.unblock_dressing_room_user(uuid) from public;
revoke all on function public.unblock_dressing_room_user(uuid) from anon;
grant execute on function public.unblock_dressing_room_user(uuid) to authenticated;

create or replace function public.list_dressing_room_blocked_users()
 returns table(blocked_user_id uuid, created_at timestamptz)
 language sql
 stable
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
  select b.blocked_user_id, b.created_at
  from public.dressing_room_user_blocks b
  where b.blocker_user_id = (select auth.uid())
  order by b.created_at desc;
$function$;

comment on function public.list_dressing_room_blocked_users() is
  'Returns only blocks the calling account created. No profile fields (this schema has no display-name/username column beyond email, which must not be exposed here) — the client renders a generic label.';

revoke all on function public.list_dressing_room_blocked_users() from public;
revoke all on function public.list_dressing_room_blocked_users() from anon;
grant execute on function public.list_dressing_room_blocked_users() to authenticated;

-- ── 7. User-report validation (content_reports; reuses the existing table) ─

drop policy if exists "content_reports_insert_own" on public.content_reports;
create policy "content_reports_insert_own"
on public.content_reports
for insert
to authenticated
with check (
  auth.uid() = reporter_user_id
  and (
    target_type <> 'user'
    or (
      reported_user_id is not null
      and reported_user_id <> auth.uid()
      and target_id = reported_user_id::text
      and internal.dressing_room_pair_has_interacted(auth.uid(), reported_user_id)
    )
  )
);

comment on policy "content_reports_insert_own" on public.content_reports is
  'Message-type reports (target_type <> ''user'') are unchanged. User-type reports additionally require reported_user_id = target_id and a real prior Dressing Room relationship with the reporter, preventing forged reports against arbitrary unrelated accounts.';
