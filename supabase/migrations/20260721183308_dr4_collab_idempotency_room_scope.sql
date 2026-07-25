-- DR-4: scope collaboration idempotency to (room_id, actor_id, operation, request_id).
-- Forward-only. Does NOT apply to production in this pass.
--
-- Defect: DR-3 unique (actor_id, operation, request_id) blocked the same requestId
-- from being used legitimately in a different room (payload hash includes room_id,
-- so cross-room reuse raised "Idempotency key reused with different payload").
-- Semantic scope required by DR-4: room + authenticated actor + requestId.

-- Drop any null-room ledger rows (should not exist; inserts always set room_id).
delete from public.dressing_room_collab_idempotency
where room_id is null;

alter table public.dressing_room_collab_idempotency
  alter column room_id set not null;

alter table public.dressing_room_collab_idempotency
  drop constraint if exists dressing_room_collab_idempotency_actor_op_request_key;

alter table public.dressing_room_collab_idempotency
  add constraint dressing_room_collab_idempotency_room_actor_op_request_key
  unique (room_id, actor_id, operation, request_id);

comment on constraint dressing_room_collab_idempotency_room_actor_op_request_key
  on public.dressing_room_collab_idempotency is
  'DR-4: idempotency scoped to room + actor + operation + request_id';

-- Rebind reaction RPC lookups to include room_id.
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
  where room_id = p_room_id
    and actor_id = current_user_id
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

-- Rebind message create RPC lookups to include room_id.
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
$$;

revoke all on function public.create_dressing_room_message(uuid, text, uuid, uuid)
  from public, anon;
grant execute on function public.create_dressing_room_message(uuid, text, uuid, uuid)
  to authenticated;
