# Rollback: 20260806153233_dressing_room_user_blocking

This repository has no down-migration framework (no paired `_down.sql` files
exist anywhere under `supabase/migrations/`; see
`ACCOUNT_DELETION_MIGRATION_DIVERGENCE.md` for the established convention of
documenting rollback procedures in prose rather than committing forward/back
migration pairs). This file is that documentation for this migration.

**Apply only to STAGING (`yzqjvdfgefveprobvvyw`). Never run against
production (`wyyuqfdxucjksghsmhry`).**

Run as one transaction. Steps 1–5 restore the exact pre-migration function
and policy bodies (verified against staging before this migration was
applied — see the assessment/audit transcript). Steps 6–7 are
**data-destructive**: they permanently discard the `left_at` departure
marker and every block relationship created since this migration was
applied. Do not run steps 6–7 if any real block has been created that must
be preserved for audit purposes — steps 1–5 alone fully disable enforcement
while leaving the data recoverable.

```sql
begin;

-- 1. Restore original join_room_via_share_token (no lock, no block check,
--    no left_at reactivation branch).
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

  if target_owner_id is not distinct from current_user_id then
    return target_room_id;
  end if;

  if exists (
    select 1
    from public.dressing_room_participants p
    where p.dressing_room_id = target_room_id
      and p.user_id = current_user_id
  ) then
    return target_room_id;
  end if;

  if target_max_redemptions is not null then
    select count(*)
    into current_redemptions
    from public.dressing_room_participants p
    where p.joined_via_share_id = target_share_id;

    if current_redemptions >= target_max_redemptions then
      raise exception 'Shared room is full' using errcode = '42501';
    end if;
  end if;

  insert into public.dressing_room_participants (dressing_room_id, user_id, role, joined_via_share_id)
  values (target_room_id, current_user_id, 'participant', target_share_id);

  return target_room_id;
end;
$$;

-- 2. Restore original create_dressing_room_message (ok-only gate, no lock).
create or replace function public.create_dressing_room_message(p_room_id uuid, p_body text, p_client_message_id uuid, p_parent_message_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
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
    room_id, sender_id, body, client_message_id, parent_message_id
  ) values (
    p_room_id, current_user_id, cleaned, p_client_message_id, p_parent_message_id
  )
  returning * into inserted;

  result_json := jsonb_build_object(
    'ok', true, 'id', inserted.id, 'roomId', inserted.room_id, 'senderId', inserted.sender_id,
    'body', inserted.body, 'createdAt', inserted.created_at, 'clientMessageId', inserted.client_message_id,
    'parentMessageId', inserted.parent_message_id, 'accessVersion', (access->>'accessVersion')::bigint
  );

  insert into public.dressing_room_collab_idempotency (
    actor_id, operation, request_id, room_id, payload_hash, result_json
  ) values (
    current_user_id, 'message', p_client_message_id, p_room_id, payload_hash, result_json
  );

  return result_json;
end;
$function$;

-- 3. Restore original resolve_dressing_room_collaboration_access (no
--    left_at filter, no block check, canMessage/canReact/canReply always
--    hardcoded true on success).
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
begin
  if current_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  if p_room_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  select dr.user_id, dr.collaboration_access_version
    into room_owner_id, access_version
  from public.dressing_rooms dr
  where dr.id = p_room_id;

  if room_owner_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
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
    return jsonb_build_object('ok', false, 'reason', 'unauthorized', 'roomId', p_room_id, 'accessVersion', access_version);
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
$function$;

-- 4. Restore original can_access_room_messages (no left_at filter, no block check).
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
        and rs.room_id = p_room_id
        and rs.is_active = true
        and rs.revoked_at is null
        and (rs.expires_at is null or rs.expires_at > clock_timestamp())
        and rs.owner_id = dr.user_id
        and dr.user_id is distinct from (select auth.uid())
    );
$function$;

-- 5. Restore original dressing_rooms and content_reports policies, and drop
--    the new RPCs (safe: these are strictly additive surface, not referenced
--    by anything the app used before this migration).
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
  )
);

drop policy if exists "content_reports_insert_own" on public.content_reports;
create policy "content_reports_insert_own"
on public.content_reports
for insert
to authenticated
with check (auth.uid() = reporter_user_id);

drop function if exists public.block_dressing_room_user(uuid);
drop function if exists public.unblock_dressing_room_user(uuid);
drop function if exists public.list_dressing_room_blocked_users();

drop function if exists internal.is_dressing_room_pair_blocked(uuid, uuid);
drop function if exists internal.dressing_room_pair_has_interacted(uuid, uuid);
drop function if exists internal.lock_dressing_room_pair(uuid, uuid);

commit;
```

**Data-destructive steps (separate transaction; only if the block feature is
being fully torn down, not just disabled):**

```sql
begin;

-- 6. Discards the "voluntarily left this room" marker. Safe only once no
--    code path reads dressing_room_participants.left_at (guaranteed after
--    step 1-5 above, since the restored function bodies never reference it).
drop index if exists public.dressing_room_participants_active_idx;
alter table public.dressing_room_participants drop column if exists left_at;

-- 7. Discards every block relationship ever created by this feature.
drop table if exists public.dressing_room_user_blocks;

commit;
```

## Verification after rollback

- `select proname from pg_proc where proname in ('block_dressing_room_user','unblock_dressing_room_user','list_dressing_room_blocked_users');` returns zero rows.
- `select public.create_dressing_room_message(...)` and `select public.join_room_via_share_token(...)` behave exactly as they did before `20260806153233_dressing_room_user_blocking.sql` (confirmed against `supabase/tests/room_share_redemption_contract_test.sql`, which exercises `join_room_via_share_token` and must still pass unmodified).
- If step 6/7 were skipped, `dressing_room_user_blocks` and `dressing_room_participants.left_at` remain but are inert (nothing reads them once steps 1–5 are applied).
