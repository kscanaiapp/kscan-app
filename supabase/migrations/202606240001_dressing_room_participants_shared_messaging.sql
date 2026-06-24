-- Shared Dressing Room Chat v1 — real multi-participant in-room messaging.
--
-- Replaces the previous owner-restricted access model on
-- public.dressing_room_messages with an owner-OR-authorized-participant model,
-- and adds an explicit, authenticated participant/member table.
--
-- Access model:
--   * Room owner (public.dressing_rooms.user_id) is an implicit participant.
--   * A second authenticated user becomes a participant ONLY by joining via an
--     active share token (public.join_room_via_share_token). No anonymous access,
--     no client-side self-insert, no fake/guest identity.
--
-- Privacy / safety guarantees:
--   * RLS enabled on the participant table; no anon access of any kind.
--   * Clients have NO direct insert/update/delete on the participant table —
--     membership is mutated only by the SECURITY DEFINER join RPC, which
--     validates the share token.
--   * The public read-only preview (get_public_room_preview) is NOT modified
--     here and continues to never select, join, count, or return messages.
--   * No public unrestricted writes; no service_role; no message bodies logged.

create extension if not exists pgcrypto;

-- ── Participant / member model ──────────────────────────────────────────────
create table if not exists public.dressing_room_participants (
  id uuid primary key default gen_random_uuid(),
  dressing_room_id uuid not null references public.dressing_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'participant',
  joined_via_share_id uuid references public.room_shares(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint dressing_room_participants_role_check check (role in ('participant')),
  constraint dressing_room_participants_room_user_key unique (dressing_room_id, user_id)
);

create index if not exists dressing_room_participants_room_idx
on public.dressing_room_participants (dressing_room_id);

create index if not exists dressing_room_participants_user_idx
on public.dressing_room_participants (user_id);

alter table public.dressing_room_participants enable row level security;

-- No anonymous access. Read-only client surface; membership is created only by
-- the SECURITY DEFINER join RPC below (no client insert/update/delete grant).
revoke all on public.dressing_room_participants from anon;
revoke all on public.dressing_room_participants from public;
grant select on public.dressing_room_participants to authenticated;

-- SELECT: a user may read their own membership row; a room owner may read the
-- participants of their own room. Non-participants see nothing; a participant
-- cannot enumerate other participants.
drop policy if exists "Participants can read own membership" on public.dressing_room_participants;
create policy "Participants can read own membership"
on public.dressing_room_participants
for select
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.dressing_rooms dr
    where dr.id = dressing_room_participants.dressing_room_id
      and dr.user_id = auth.uid()
  )
);

-- INSERT/UPDATE/DELETE: intentionally NO policies. With RLS enabled and no
-- policy, all client writes are denied. Membership changes flow through the
-- SECURITY DEFINER RPC only.

-- ── Access helper: owner OR participant ─────────────────────────────────────
-- SECURITY DEFINER so message RLS policies can evaluate access without applying
-- RLS to dressing_rooms / dressing_room_participants. This keeps the message
-- policies simple and avoids any policy recursion.
create or replace function public.can_access_room_messages(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.dressing_rooms dr
    where dr.id = p_room_id
      and dr.user_id = auth.uid()
  )
  or exists (
    select 1
    from public.dressing_room_participants drp
    where drp.dressing_room_id = p_room_id
      and drp.user_id = auth.uid()
  );
$$;

revoke all on function public.can_access_room_messages(uuid) from public;
revoke all on function public.can_access_room_messages(uuid) from anon;
grant execute on function public.can_access_room_messages(uuid) to authenticated;

-- ── Join a shared room as an authenticated participant ──────────────────────
-- Validates an active, non-revoked, non-expired share token, then upserts the
-- caller (if not the owner) as a participant. Returns the dressing room id so
-- the app can open in-room chat. Authentication is required; anon is rejected.
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
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Invalid share link' using errcode = '22023';
  end if;

  select rs.id, rs.room_id, dr.user_id
  into target_share_id, target_room_id, target_owner_id
  from public.room_shares rs
  join public.dressing_rooms dr
    on dr.id = rs.room_id
  where rs.share_token = normalized_token
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  limit 1;

  if target_room_id is null then
    raise exception 'Shared room is unavailable' using errcode = '42501';
  end if;

  -- The owner is an implicit participant; never create a membership row for them.
  if target_owner_id is distinct from current_user_id then
    insert into public.dressing_room_participants (dressing_room_id, user_id, role, joined_via_share_id)
    values (target_room_id, current_user_id, 'participant', target_share_id)
    on conflict (dressing_room_id, user_id) do nothing;
  end if;

  return target_room_id;
end;
$$;

revoke all on function public.join_room_via_share_token(text) from public;
revoke all on function public.join_room_via_share_token(text) from anon;
grant execute on function public.join_room_via_share_token(text) to authenticated;

-- ── Re-point dressing_room_messages RLS to owner-or-participant ─────────────
-- Replaces the prior owner-restricted policies. Grants are unchanged
-- (authenticated may select/insert; no update/delete policy exists, so
-- message edits/deletes stay blocked for all clients).
drop policy if exists "Room owners can read room messages" on public.dressing_room_messages;
drop policy if exists "Room owners can send room messages" on public.dressing_room_messages;

drop policy if exists "Room participants can read room messages" on public.dressing_room_messages;
create policy "Room participants can read room messages"
on public.dressing_room_messages
for select
to authenticated
using (
  deleted_at is null
  and public.can_access_room_messages(room_id)
);

drop policy if exists "Room participants can send room messages" on public.dressing_room_messages;
create policy "Room participants can send room messages"
on public.dressing_room_messages
for insert
to authenticated
with check (
  sender_id = auth.uid()
  and deleted_at is null
  and public.can_access_room_messages(room_id)
);
