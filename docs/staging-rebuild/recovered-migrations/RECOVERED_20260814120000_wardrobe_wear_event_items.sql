-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260814120000
-- name: wardrobe_wear_event_items
-- statement_count: 1
-- Build 29 Closet V2 / S5 — wear-history data-model reconciliation.
-- Applied to K Scan AI Staging (yzqjvdfgefveprobvvyw) only. Owner-approved,
-- including the governance-classified DESTRUCTIVE_ALTER (drop not null).

alter table public.wardrobe_wear_events
  add column if not exists saved_look_id uuid
  references public.looks(id) on delete set null;

comment on column public.wardrobe_wear_events.saved_look_id is
  'Live FK to the Saved Look this wear came from. ON DELETE SET NULL: deleting the look must not erase the fact that the user wore it. The durable id remains in saved_look_ref and the garments in wardrobe_wear_event_items.';

alter table public.wardrobe_wear_events
  alter column source_item_id drop not null;

alter table public.wardrobe_wear_events
  add column if not exists saved_look_ref text;

comment on column public.wardrobe_wear_events.saved_look_ref is
  'Durable id of the Saved Look this wear came from. Survives deletion of the look; saved_look_id is the live FK and nulls out.';

alter table public.wardrobe_wear_events
  drop constraint if exists wardrobe_wear_events_identity_present;

alter table public.wardrobe_wear_events
  add constraint wardrobe_wear_events_identity_present
  check (
    source_item_id is not null
    or saved_look_id is not null
    or saved_look_ref is not null
  )
  not valid;

alter table public.wardrobe_wear_events
  validate constraint wardrobe_wear_events_identity_present;

create index if not exists wardrobe_wear_events_saved_look_id_idx
  on public.wardrobe_wear_events (user_id, saved_look_id)
  where saved_look_id is not null;

create table if not exists public.wardrobe_wear_event_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  wear_event_id uuid not null
    references public.wardrobe_wear_events(id) on delete cascade,
  client_id text,
  source_item_id text not null,
  source_type text not null default 'unknown',
  title_snapshot text,
  category_snapshot text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint wardrobe_wear_event_items_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint wardrobe_wear_event_items_source_item_id_nonempty
    check (length(btrim(source_item_id)) > 0)
);

comment on table public.wardrobe_wear_event_items is
  'One row per garment participating in a logical wear event. A Saved Look worn once produces ONE wardrobe_wear_events row and N of these.';
comment on column public.wardrobe_wear_event_items.client_id is
  'Local/offline identifier for sync reconciliation.';
comment on column public.wardrobe_wear_event_items.title_snapshot is
  'Point-in-time display title. Preserves historical meaning after the source item is renamed or removed. Never a full item payload.';

create index if not exists wardrobe_wear_event_items_user_id_idx
  on public.wardrobe_wear_event_items (user_id);
create index if not exists wardrobe_wear_event_items_event_id_idx
  on public.wardrobe_wear_event_items (wear_event_id);
create index if not exists wardrobe_wear_event_items_source_item_idx
  on public.wardrobe_wear_event_items (user_id, source_item_id)
  where deleted_at is null;
create index if not exists wardrobe_wear_event_items_created_at_idx
  on public.wardrobe_wear_event_items (user_id, created_at desc);

create unique index if not exists wardrobe_wear_event_items_event_source_uidx
  on public.wardrobe_wear_event_items (wear_event_id, source_item_id)
  where deleted_at is null;

create unique index if not exists wardrobe_wear_event_items_user_client_uidx
  on public.wardrobe_wear_event_items (user_id, client_id);

alter table public.wardrobe_wear_event_items enable row level security;

create policy "Users can select own wear event items"
  on public.wardrobe_wear_event_items
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own wear event items"
  on public.wardrobe_wear_event_items
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own wear event items"
  on public.wardrobe_wear_event_items
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own wear event items"
  on public.wardrobe_wear_event_items
  for delete
  to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete
  on public.wardrobe_wear_event_items to authenticated;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists wardrobe_wear_event_items_set_updated_at
      on public.wardrobe_wear_event_items;
    create trigger wardrobe_wear_event_items_set_updated_at
      before update on public.wardrobe_wear_event_items
      for each row
      execute function public.set_updated_at();
  end if;
end $$;
