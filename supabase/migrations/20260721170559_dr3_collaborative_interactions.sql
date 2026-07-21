-- DR-3 Collaborative / Interactive Dressing Rooms
-- Additive only. Does NOT apply to production in this pass.
--
-- Goals:
--   1. Harden collaboration access so share revocation ends participant access
--      without deleting historical messages or reactions.
--   2. Add room access_version for revocation-safe client teardown.
--   3. Add message client_message_id + parent_message_id (flat depth-1 threads).
--   4. Add keyset index for cursor pagination (no OFFSET).
--   5. Add scoped idempotency ledger + RPCs for reactions and messages.
--
-- Old clients: direct table paths continue via hardened RLS. New RPCs are additive.

-- ── Access version on rooms ──────────────────────────────────────────────────
alter table public.dressing_rooms
  add column if not exists collaboration_access_version bigint not null default 1;

comment on column public.dressing_rooms.collaboration_access_version is
  'Monotonic collaboration access epoch. Bumped on share revoke/expiry propagation so clients can tear down zombie channels without deleting history.';

-- ── Message columns: idempotency + flat replies ──────────────────────────────
alter table public.dressing_room_messages
  add column if not exists client_message_id uuid,
  add column if not exists parent_message_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'dressing_room_messages_parent_fkey'
      and conrelid = 'public.dressing_room_messages'::regclass
  ) then
    alter table public.dressing_room_messages
      add constraint dressing_room_messages_parent_fkey
      foreign key (parent_message_id)
      references public.dressing_room_messages(id)
      on delete set null;
  end if;
end $$;

create unique index if not exists dressing_room_messages_sender_room_client_msg_uidx
  on public.dressing_room_messages (sender_id, room_id, client_message_id)
  where client_message_id is not null;

-- Keyset pagination: room + ordering tie-break. Partial for live rows.
create index if not exists dressing_room_messages_room_created_id_idx
  on public.dressing_room_messages (room_id, created_at, id)
  where deleted_at is null;

create index if not exists dressing_room_messages_parent_idx
  on public.dressing_room_messages (room_id, parent_message_id)
  where deleted_at is null and parent_message_id is not null;

-- Flat-thread invariant: parent must be same-room root (no parent of its own).
create or replace function public.enforce_dressing_room_message_flat_thread()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  parent_row public.dressing_room_messages%rowtype;
begin
  if new.parent_message_id is null then
    return new;
  end if;

  select *
    into parent_row
  from public.dressing_room_messages
  where id = new.parent_message_id;

  if not found then
    raise exception 'Parent message not found' using errcode = '22023';
  end if;

  if parent_row.deleted_at is not null then
    raise exception 'Parent message unavailable' using errcode = '22023';
  end if;

  if parent_row.room_id is distinct from new.room_id then
    raise exception 'Parent message must belong to the same room' using errcode = '22023';
  end if;

  if parent_row.parent_message_id is not null then
    raise exception 'Replies to replies are not allowed' using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_dressing_room_message_flat_thread()
  from public, anon, authenticated, service_role;

drop trigger if exists dressing_room_messages_flat_thread
  on public.dressing_room_messages;
create trigger dressing_room_messages_flat_thread
before insert or update of parent_message_id, room_id
on public.dressing_room_messages
for each row
execute function public.enforce_dressing_room_message_flat_thread();

-- ── Idempotency ledger (actor + operation + request_id scoped) ───────────────
create table if not exists public.dressing_room_collab_idempotency (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation text not null,
  request_id uuid not null,
  room_id uuid references public.dressing_rooms(id) on delete cascade,
  payload_hash text not null,
  result_json jsonb not null,
  created_at timestamptz not null default now(),
  constraint dressing_room_collab_idempotency_operation_check
    check (operation in ('reaction', 'message')),
  constraint dressing_room_collab_idempotency_actor_op_request_key
    unique (actor_id, operation, request_id)
);

create index if not exists dressing_room_collab_idempotency_room_idx
  on public.dressing_room_collab_idempotency (room_id, created_at desc);

alter table public.dressing_room_collab_idempotency enable row level security;

revoke all on table public.dressing_room_collab_idempotency
  from public, anon, authenticated;

grant select, insert, update, delete on table public.dressing_room_collab_idempotency
  to service_role;

-- No authenticated table grants; RPC-only. Defense-in-depth owner/self select.
drop policy if exists "Actors can select own collab idempotency"
  on public.dressing_room_collab_idempotency;
create policy "Actors can select own collab idempotency"
  on public.dressing_room_collab_idempotency
  for select
  to authenticated
  using (actor_id = (select auth.uid()));

-- ── Harden collaboration access (revocation-aware) ───────────────────────────
-- Membership/participant row alone is insufficient. Active share + owner match
-- required. Historical messages/reactions are NOT deleted on revoke.
create or replace function public.can_access_room_messages(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
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
        and rs.room_id = p_room_id
        and rs.is_active = true
        and rs.revoked_at is null
        and (rs.expires_at is null or rs.expires_at > clock_timestamp())
        and rs.owner_id = dr.user_id
        and dr.user_id is distinct from (select auth.uid())
    );
$$;

revoke all on function public.can_access_room_messages(uuid) from public;
revoke all on function public.can_access_room_messages(uuid) from anon;
grant execute on function public.can_access_room_messages(uuid) to authenticated;

-- Full collaboration access decision (server-authoritative).
create or replace function public.resolve_dressing_room_collaboration_access(p_room_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  current_user_id uuid := (select auth.uid());
  room_owner_id uuid;
  access_version bigint;
  is_owner boolean := false;
  is_shared boolean := false;
  can_access boolean := false;
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
        and rs.room_id = p_room_id
        and rs.is_active = true
        and rs.revoked_at is null
        and (rs.expires_at is null or rs.expires_at > clock_timestamp())
        and rs.owner_id = room_owner_id
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

  return jsonb_build_object(
    'ok', true,
    'roomId', p_room_id,
    'authenticatedActorId', current_user_id,
    'currentOwnerId', room_owner_id,
    'relationship', case when is_owner then 'owner' else 'shared_recipient' end,
    'canView', true,
    'canReact', true,
    'canMessage', true,
    'canReply', true,
    'canSubscribe', true,
    'canUpdateReadState', false,
    'accessVersion', access_version
  );
end;
$$;

revoke all on function public.resolve_dressing_room_collaboration_access(uuid)
  from public, anon;
grant execute on function public.resolve_dressing_room_collaboration_access(uuid)
  to authenticated;

-- ── Revoke bumps access version; does NOT delete messages/reactions ──────────
create or replace function public.revoke_room_share(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_user_id uuid := (select auth.uid());
  affected_count integer := 0;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_room_id is null then
    raise exception 'Dressing room is required' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.dressing_rooms dr
    where dr.id = p_room_id
      and dr.user_id = current_user_id
  ) then
    raise exception 'Dressing room not found' using errcode = '42501';
  end if;

  update public.room_shares
  set
    is_active = false,
    revoked_at = clock_timestamp()
  where room_id = p_room_id
    and owner_id = current_user_id
    and is_active = true;

  get diagnostics affected_count = row_count;

  -- Always bump access version when owner revokes so open clients observe loss
  -- of access even if no active share row remained.
  update public.dressing_rooms
  set collaboration_access_version = collaboration_access_version + 1
  where id = p_room_id
    and user_id = current_user_id;

  -- Intentionally do NOT delete dressing_room_messages, reactions, or
  -- participant rows. History remains for the owner; revoked actors fail closed
  -- via can_access_room_messages / resolve_dressing_room_collaboration_access.
  return affected_count > 0;
end;
$$;

revoke all on function public.revoke_room_share(uuid) from public;
revoke all on function public.revoke_room_share(uuid) from anon;
grant execute on function public.revoke_room_share(uuid) to authenticated;

-- ── Helpers ──────────────────────────────────────────────────────────────────
create or replace function public.dr3_is_uuid_v4(p_value uuid)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_value is not null
    and substring(p_value::text from 15 for 1) = '4'
    and substring(p_value::text from 20 for 1) in ('8', '9', 'a', 'b');
$$;

revoke all on function public.dr3_is_uuid_v4(uuid) from public, anon;
grant execute on function public.dr3_is_uuid_v4(uuid) to authenticated;

-- Prefer pgcrypto digest; fall back to md5 if digest() is unavailable.
create or replace function public.dr3_payload_hash(p_payload text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public, extensions
as $$
begin
  begin
    return encode(digest(convert_to(coalesce(p_payload, ''), 'UTF8'), 'sha256'), 'hex');
  exception
    when undefined_function then
      return md5(coalesce(p_payload, ''));
  end;
end;
$$;

revoke all on function public.dr3_payload_hash(text) from public, anon;
grant execute on function public.dr3_payload_hash(text) to authenticated;

-- ── Idempotent reaction desired-state RPC ────────────────────────────────────
create or replace function public.set_dressing_room_item_reaction(
  p_room_id uuid,
  p_item_id uuid,
  p_reaction_type text,
  p_active boolean,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_user_id uuid := (select auth.uid());
  access jsonb;
  item_room_id uuid;
  normalized_type text := nullif(btrim(coalesce(p_reaction_type, '')), '');
  payload_key text;
  payload_hash text;
  existing public.dressing_room_collab_idempotency%rowtype;
  result_json jsonb;
  my_reaction text;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not public.dr3_is_uuid_v4(p_request_id) then
    raise exception 'Invalid request id' using errcode = '22023';
  end if;

  if p_room_id is null or p_item_id is null or p_active is null then
    raise exception 'Invalid reaction request' using errcode = '22023';
  end if;

  if normalized_type is null
     or normalized_type not in ('like', 'love', 'favorite', 'looking', 'thumbs_down') then
    raise exception 'Invalid reaction type' using errcode = '22023';
  end if;

  access := public.resolve_dressing_room_collaboration_access(p_room_id);
  if coalesce((access->>'ok')::boolean, false) is not true then
    raise exception 'Shared room is unavailable' using errcode = '42501';
  end if;

  select dri.dressing_room_id
    into item_room_id
  from public.dressing_room_items dri
  where dri.id = p_item_id;

  if item_room_id is null or item_room_id is distinct from p_room_id then
    raise exception 'Item not found in room' using errcode = '42501';
  end if;

  payload_key := concat_ws(
    '|',
    p_room_id::text,
    p_item_id::text,
    normalized_type,
    case when p_active then '1' else '0' end
  );
  payload_hash := public.dr3_payload_hash(payload_key);

  select *
    into existing
  from public.dressing_room_collab_idempotency
  where actor_id = current_user_id
    and operation = 'reaction'
    and request_id = p_request_id;

  if found then
    if existing.payload_hash is distinct from payload_hash then
      raise exception 'Idempotency key reused with different payload' using errcode = '22023';
    end if;
    return existing.result_json;
  end if;

  if p_active then
    insert into public.dressing_room_item_reactions (item_id, user_id, reaction_type)
    values (p_item_id, current_user_id, normalized_type)
    on conflict (item_id, user_id) do update
      set reaction_type = excluded.reaction_type,
          updated_at = clock_timestamp();
  else
    delete from public.dressing_room_item_reactions
    where item_id = p_item_id
      and user_id = current_user_id
      and reaction_type = normalized_type;
  end if;

  select reaction_type
    into my_reaction
  from public.dressing_room_item_reactions
  where item_id = p_item_id
    and user_id = current_user_id;

  result_json := jsonb_build_object(
    'ok', true,
    'roomId', p_room_id,
    'itemId', p_item_id,
    'reactionType', normalized_type,
    'active', coalesce(my_reaction = normalized_type, false),
    'myReaction', my_reaction,
    'requestId', p_request_id,
    'accessVersion', (access->>'accessVersion')::bigint
  );

  insert into public.dressing_room_collab_idempotency (
    actor_id, operation, request_id, room_id, payload_hash, result_json
  ) values (
    current_user_id, 'reaction', p_request_id, p_room_id, payload_hash, result_json
  );

  return result_json;
end;
$$;

revoke all on function public.set_dressing_room_item_reaction(uuid, uuid, text, boolean, uuid)
  from public, anon;
grant execute on function public.set_dressing_room_item_reaction(uuid, uuid, text, boolean, uuid)
  to authenticated;

-- ── Message create (idempotent + flat reply) ─────────────────────────────────
create or replace function public.create_dressing_room_message(
  p_room_id uuid,
  p_body text,
  p_client_message_id uuid,
  p_parent_message_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_user_id uuid := (select auth.uid());
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

  -- Strip C0 controls except tab/newline; then trim.
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
  if coalesce((access->>'ok')::boolean, false) is not true then
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
  where actor_id = current_user_id
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
$$;

revoke all on function public.create_dressing_room_message(uuid, text, uuid, uuid)
  from public, anon;
grant execute on function public.create_dressing_room_message(uuid, text, uuid, uuid)
  to authenticated;

-- ── Keyset message list (no OFFSET) ──────────────────────────────────────────
create or replace function public.list_dressing_room_messages(
  p_room_id uuid,
  p_limit integer default 30,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_direction text default 'older'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  current_user_id uuid := (select auth.uid());
  access jsonb;
  page_limit integer;
  direction text := lower(nullif(btrim(coalesce(p_direction, 'older')), ''));
  rows_json jsonb;
  next_cursor jsonb := null;
  first_created timestamptz;
  first_id uuid;
  last_created timestamptz;
  last_id uuid;
  row_count integer := 0;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  access := public.resolve_dressing_room_collaboration_access(p_room_id);
  if coalesce((access->>'ok')::boolean, false) is not true then
    raise exception 'Shared room is unavailable' using errcode = '42501';
  end if;

  page_limit := greatest(1, least(coalesce(p_limit, 30), 50));
  if direction is null or direction not in ('older', 'newer') then
    direction := 'older';
  end if;

  -- Initial page (no cursor): latest page_limit messages, returned ascending.
  if p_cursor_created_at is null or p_cursor_id is null then
    with latest as (
      select m.id, m.room_id, m.sender_id, m.body, m.created_at,
             m.client_message_id, m.parent_message_id
      from public.dressing_room_messages m
      where m.room_id = p_room_id
        and m.deleted_at is null
      order by m.created_at desc, m.id desc
      limit page_limit
    )
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', latest.id,
            'roomId', latest.room_id,
            'senderId', latest.sender_id,
            'body', latest.body,
            'createdAt', latest.created_at,
            'clientMessageId', latest.client_message_id,
            'parentMessageId', latest.parent_message_id,
            'isMine', latest.sender_id = current_user_id
          )
          order by latest.created_at asc, latest.id asc
        ),
        '[]'::jsonb
      ),
      count(*)::integer,
      min(latest.created_at),
      (array_agg(latest.id order by latest.created_at asc, latest.id asc))[1],
      max(latest.created_at),
      (array_agg(latest.id order by latest.created_at desc, latest.id desc))[1]
    into rows_json, row_count, first_created, first_id, last_created, last_id
    from latest;
  elsif direction = 'older' then
    with page as (
      select m.id, m.room_id, m.sender_id, m.body, m.created_at,
             m.client_message_id, m.parent_message_id
      from public.dressing_room_messages m
      where m.room_id = p_room_id
        and m.deleted_at is null
        and (m.created_at, m.id) < (p_cursor_created_at, p_cursor_id)
      order by m.created_at desc, m.id desc
      limit page_limit
    )
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', page.id,
            'roomId', page.room_id,
            'senderId', page.sender_id,
            'body', page.body,
            'createdAt', page.created_at,
            'clientMessageId', page.client_message_id,
            'parentMessageId', page.parent_message_id,
            'isMine', page.sender_id = current_user_id
          )
          order by page.created_at asc, page.id asc
        ),
        '[]'::jsonb
      ),
      count(*)::integer,
      min(page.created_at),
      (array_agg(page.id order by page.created_at asc, page.id asc))[1],
      max(page.created_at),
      (array_agg(page.id order by page.created_at desc, page.id desc))[1]
    into rows_json, row_count, first_created, first_id, last_created, last_id
    from page;
  else
    -- newer: messages after cursor (for reconnect reconciliation)
    with page as (
      select m.id, m.room_id, m.sender_id, m.body, m.created_at,
             m.client_message_id, m.parent_message_id
      from public.dressing_room_messages m
      where m.room_id = p_room_id
        and m.deleted_at is null
        and (m.created_at, m.id) > (p_cursor_created_at, p_cursor_id)
      order by m.created_at asc, m.id asc
      limit page_limit
    )
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', page.id,
            'roomId', page.room_id,
            'senderId', page.sender_id,
            'body', page.body,
            'createdAt', page.created_at,
            'clientMessageId', page.client_message_id,
            'parentMessageId', page.parent_message_id,
            'isMine', page.sender_id = current_user_id
          )
          order by page.created_at asc, page.id asc
        ),
        '[]'::jsonb
      ),
      count(*)::integer,
      min(page.created_at),
      (array_agg(page.id order by page.created_at asc, page.id asc))[1],
      max(page.created_at),
      (array_agg(page.id order by page.created_at desc, page.id desc))[1]
    into rows_json, row_count, first_created, first_id, last_created, last_id
    from page;
  end if;

  if row_count >= page_limit and first_created is not null and first_id is not null then
    next_cursor := jsonb_build_object(
      'createdAt', first_created,
      'id', first_id,
      'direction', 'older'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'messages', coalesce(rows_json, '[]'::jsonb),
    'nextCursor', next_cursor,
    'newestCursor', case
      when last_created is not null and last_id is not null then
        jsonb_build_object('createdAt', last_created, 'id', last_id, 'direction', 'newer')
      else null
    end,
    'accessVersion', (access->>'accessVersion')::bigint
  );
end;
$$;

revoke all on function public.list_dressing_room_messages(uuid, integer, timestamptz, uuid, text)
  from public, anon;
grant execute on function public.list_dressing_room_messages(uuid, integer, timestamptz, uuid, text)
  to authenticated;
