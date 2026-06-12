-- Private In-App Room Messaging v1 (owner-only).
--
-- Forward-only migration. Creates public.dressing_room_messages: private,
-- authenticated, Dressing Room-scoped text messages.
--
-- Access model (v1): owner-only. The repo has no authenticated
-- participant/member table; public.room_shares is token-based public preview
-- (owner_id + share_token, no shared_with_user_id), so token rows are NOT
-- treated as authenticated participants. A participant model can extend the
-- RLS policies in a future migration without schema changes here.
--
-- Privacy guarantees:
--   * RLS enabled; no anonymous access; no public/link-share fields.
--   * This table must never be selected, joined, counted, or returned by
--     get_public_room_preview or any other public preview RPC/route.
--   * deleted_at exists for future soft delete; v1 exposes no delete UI and
--     all list queries must filter deleted_at IS NULL.

create table if not exists public.dressing_room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.dressing_rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  deleted_at timestamptz,
  constraint dressing_room_messages_body_not_blank check (length(btrim(body)) > 0),
  constraint dressing_room_messages_body_max_length check (char_length(body) <= 1000)
);

create index if not exists dressing_room_messages_room_created_idx
on public.dressing_room_messages(room_id, created_at);

create index if not exists dressing_room_messages_sender_idx
on public.dressing_room_messages(sender_id);

-- Reuse the existing shared updated_at trigger function
-- (defined in 202605130001_privacy_settings.sql / 202605130002_privacy_settings_schema_parity.sql).
drop trigger if exists dressing_room_messages_set_updated_at on public.dressing_room_messages;
create trigger dressing_room_messages_set_updated_at
before update on public.dressing_room_messages
for each row
execute function public.set_updated_at();

alter table public.dressing_room_messages enable row level security;

-- No anonymous access of any kind.
revoke all on public.dressing_room_messages from anon;
revoke all on public.dressing_room_messages from public;
grant select, insert on public.dressing_room_messages to authenticated;

-- SELECT: room owner only, non-deleted messages only.
drop policy if exists "Room owners can read room messages" on public.dressing_room_messages;
create policy "Room owners can read room messages"
on public.dressing_room_messages
for select
to authenticated
using (
  deleted_at is null
  and exists (
    select 1
    from public.dressing_rooms dr
    where dr.id = dressing_room_messages.room_id
      and dr.user_id = auth.uid()
  )
);

-- INSERT: room owner only, sending as themselves, into a live (non-deleted) row.
drop policy if exists "Room owners can send room messages" on public.dressing_room_messages;
create policy "Room owners can send room messages"
on public.dressing_room_messages
for insert
to authenticated
with check (
  sender_id = auth.uid()
  and deleted_at is null
  and exists (
    select 1
    from public.dressing_rooms dr
    where dr.id = dressing_room_messages.room_id
      and dr.user_id = auth.uid()
  )
);

-- UPDATE/DELETE: intentionally no policies in v1. Clients cannot update or
-- delete messages; soft delete / editing is deferred to a future iteration.
