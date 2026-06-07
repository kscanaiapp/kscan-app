-- StyleChat v0.1: sessions, messages, memory events, usage tracking
-- Forward-only migration. Do not edit.

-- ── Sessions ──────────────────────────────────────────────────────────────────
create table public.style_chat_sessions (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  title       text        not null default 'New Styling Session',
  mode        text        not null default 'general'
                          check (mode in (
                            'general', 'outfit_advice', 'scan_refinement',
                            'shopping_help', 'dressing_room', 'closet_planning',
                            'budget_finder'
                          )),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index style_chat_sessions_user_updated
  on public.style_chat_sessions (user_id, updated_at desc);

alter table public.style_chat_sessions enable row level security;

create policy "Users manage own sessions"
  on public.style_chat_sessions
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Messages ──────────────────────────────────────────────────────────────────
create table public.style_chat_messages (
  id                          uuid        primary key default gen_random_uuid(),
  session_id                  uuid        not null references public.style_chat_sessions(id) on delete cascade,
  user_id                     uuid        not null references auth.users(id) on delete cascade,
  sender                      text        not null check (sender in ('user', 'assistant', 'system')),
  content                     text        not null,
  referenced_scan_ids         uuid[]      not null default '{}',
  referenced_saved_item_ids   uuid[]      not null default '{}',
  referenced_dressing_room_ids uuid[]     not null default '{}',
  referenced_catalog_items    text[]      not null default '{}',
  ui_blocks                   jsonb       not null default '[]'::jsonb,
  provider                    text                 default 'mock',
  model                       text,
  token_estimate              integer     not null default 0,
  created_at                  timestamptz not null default now()
);

create index style_chat_messages_session_asc
  on public.style_chat_messages (session_id, created_at asc);

create index style_chat_messages_user_desc
  on public.style_chat_messages (user_id, created_at desc);

alter table public.style_chat_messages enable row level security;

create policy "Users read own messages"
  on public.style_chat_messages
  for select
  using (auth.uid() = user_id);

create policy "Users insert own messages"
  on public.style_chat_messages
  for insert
  with check (auth.uid() = user_id);

-- ── Style Memory Events ────────────────────────────────────────────────────────
-- Insert/update restricted to server role; client may only read.
create table public.style_memory_events (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  source      text        not null default 'style_chat',
  event_type  text        not null,
  payload     jsonb       not null default '{}'::jsonb,
  confidence  numeric              default 0.5,
  created_at  timestamptz not null default now()
);

create index style_memory_events_user_desc
  on public.style_memory_events (user_id, created_at desc);

alter table public.style_memory_events enable row level security;

create policy "Users read own memory events"
  on public.style_memory_events
  for select
  using (auth.uid() = user_id);

-- ── Usage Tracking ─────────────────────────────────────────────────────────────
-- Insert/update restricted to server role; client may only read.
create table public.style_chat_usage (
  id              uuid    primary key default gen_random_uuid(),
  user_id         uuid    not null references auth.users(id) on delete cascade,
  period_start    date    not null,
  period_end      date    not null,
  messages_used   integer not null default 0,
  llm_calls_used  integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (user_id, period_start)
);

create index style_chat_usage_user_period
  on public.style_chat_usage (user_id, period_start);

alter table public.style_chat_usage enable row level security;

create policy "Users read own usage"
  on public.style_chat_usage
  for select
  using (auth.uid() = user_id);
