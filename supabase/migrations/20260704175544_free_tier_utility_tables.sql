-- WARNING: DO NOT APPLY THIS MIGRATION YET
-- Status: PENDING REVIEW
-- This migration is proposed for future free-tier utility backend sync.
-- It has not been reviewed, tested, or approved for staging/production.
-- Apply only after explicit owner approval, backend review, and QA validation.

-- Purpose
-- Optional backend tables for the Free Tier Utility Expansion prototype.
-- These tables are designed to mirror device-local wardrobe utility data
-- for future cross-device sync. The current app remains local-first; sync
-- is gated by feature flags and is not required for free-tier features.

-- Design notes
-- - user_id references auth.users(id) on delete cascade.
-- - client_id stores the local/offline identifier used for reconciliation.
-- - source_item_id refers to the original scan/library/product identifier.
-- - No raw images, precise location, auth tokens, or sensitive attributes.
-- - metadata jsonb is used only for forward-compatible sparse fields.
-- - Soft delete via deleted_at where future sync reconciliation may need it.

-- ============================================================================
-- P0 sync-first
-- ============================================================================

-- Normalized utility metadata attached to saved items (tags, notes, flags).
create table if not exists public.wardrobe_utility_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text,
  source_item_id text not null,
  source_type text not null default 'unknown',
  title text,
  brand text,
  category text,
  color text,
  material text,
  silhouette text,
  season_tags text[] not null default '{}',
  occasion_tags text[] not null default '{}',
  style_tags text[] not null default '{}',
  image_uri text,
  price_estimate numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on column public.wardrobe_utility_items.client_id is
  'Local/offline identifier for future sync reconciliation.';
comment on column public.wardrobe_utility_items.source_item_id is
  'Original scan/item/library/product identifier this utility data is attached to.';

create index if not exists wardrobe_utility_items_user_id_idx
  on public.wardrobe_utility_items (user_id);
create index if not exists wardrobe_utility_items_source_item_id_idx
  on public.wardrobe_utility_items (source_item_id);
create index if not exists wardrobe_utility_items_client_id_idx
  on public.wardrobe_utility_items (client_id);
create index if not exists wardrobe_utility_items_created_at_idx
  on public.wardrobe_utility_items (user_id, created_at desc);
create index if not exists wardrobe_utility_items_deleted_at_idx
  on public.wardrobe_utility_items (deleted_at)
  where deleted_at is not null;

alter table public.wardrobe_utility_items enable row level security;

create policy "Users can select own wardrobe utility items"
  on public.wardrobe_utility_items
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own wardrobe utility items"
  on public.wardrobe_utility_items
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own wardrobe utility items"
  on public.wardrobe_utility_items
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own wardrobe utility items"
  on public.wardrobe_utility_items
  for delete
  to authenticated
  using (user_id = auth.uid());

-- Collections / lookbooks (lightweight grouping of saved items/outfits).
create table if not exists public.wardrobe_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text,
  name text not null,
  cover_item_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on column public.wardrobe_collections.client_id is
  'Local/offline identifier for future sync reconciliation.';

create index if not exists wardrobe_collections_user_id_idx
  on public.wardrobe_collections (user_id);
create index if not exists wardrobe_collections_client_id_idx
  on public.wardrobe_collections (client_id);
create index if not exists wardrobe_collections_updated_at_idx
  on public.wardrobe_collections (user_id, updated_at desc);

alter table public.wardrobe_collections enable row level security;

create policy "Users can select own wardrobe collections"
  on public.wardrobe_collections
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own wardrobe collections"
  on public.wardrobe_collections
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own wardrobe collections"
  on public.wardrobe_collections
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own wardrobe collections"
  on public.wardrobe_collections
  for delete
  to authenticated
  using (user_id = auth.uid());

-- Many-to-many link between collections and items/outfits.
create table if not exists public.wardrobe_collection_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_id uuid not null references public.wardrobe_collections(id) on delete cascade,
  client_id text,
  source_item_id text not null,
  source_type text not null default 'unknown',
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on column public.wardrobe_collection_items.client_id is
  'Local/offline identifier for future sync reconciliation.';
comment on column public.wardrobe_collection_items.source_item_id is
  'Original scan/item/library/product identifier this utility data is attached to.';

create index if not exists wardrobe_collection_items_user_id_idx
  on public.wardrobe_collection_items (user_id);
create index if not exists wardrobe_collection_items_collection_id_idx
  on public.wardrobe_collection_items (collection_id);
create index if not exists wardrobe_collection_items_source_item_id_idx
  on public.wardrobe_collection_items (source_item_id);
create index if not exists wardrobe_collection_items_client_id_idx
  on public.wardrobe_collection_items (client_id);

alter table public.wardrobe_collection_items enable row level security;

create policy "Users can select own wardrobe collection items"
  on public.wardrobe_collection_items
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own wardrobe collection items"
  on public.wardrobe_collection_items
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own wardrobe collection items"
  on public.wardrobe_collection_items
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own wardrobe collection items"
  on public.wardrobe_collection_items
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ============================================================================
-- P1 sync-next
-- ============================================================================

-- Brand sizing memory (per-brand fit notes and size preferences).
create table if not exists public.wardrobe_brand_sizing_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text,
  brand text not null,
  usual_size text,
  fit_note text,
  runs_small boolean,
  runs_large boolean,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on column public.wardrobe_brand_sizing_notes.client_id is
  'Local/offline identifier for future sync reconciliation.';

create index if not exists wardrobe_brand_sizing_notes_user_id_idx
  on public.wardrobe_brand_sizing_notes (user_id);
create index if not exists wardrobe_brand_sizing_notes_brand_idx
  on public.wardrobe_brand_sizing_notes (user_id, brand);

alter table public.wardrobe_brand_sizing_notes enable row level security;

create policy "Users can select own brand sizing notes"
  on public.wardrobe_brand_sizing_notes
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own brand sizing notes"
  on public.wardrobe_brand_sizing_notes
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own brand sizing notes"
  on public.wardrobe_brand_sizing_notes
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own brand sizing notes"
  on public.wardrobe_brand_sizing_notes
  for delete
  to authenticated
  using (user_id = auth.uid());

-- Outfit / item feedback and ratings.
create table if not exists public.wardrobe_outfit_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text,
  target_id text not null,
  target_type text not null default 'outfit',
  rating integer,
  tags text[] not null default '{}',
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on column public.wardrobe_outfit_feedback.client_id is
  'Local/offline identifier for future sync reconciliation.';

create index if not exists wardrobe_outfit_feedback_user_id_idx
  on public.wardrobe_outfit_feedback (user_id);
create index if not exists wardrobe_outfit_feedback_target_id_idx
  on public.wardrobe_outfit_feedback (user_id, target_id);

alter table public.wardrobe_outfit_feedback enable row level security;

create policy "Users can select own outfit feedback"
  on public.wardrobe_outfit_feedback
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own outfit feedback"
  on public.wardrobe_outfit_feedback
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own outfit feedback"
  on public.wardrobe_outfit_feedback
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own outfit feedback"
  on public.wardrobe_outfit_feedback
  for delete
  to authenticated
  using (user_id = auth.uid());

-- Care notes attached to items.
create table if not exists public.wardrobe_care_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text,
  source_item_id text not null,
  tags text[] not null default '{}',
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on column public.wardrobe_care_notes.client_id is
  'Local/offline identifier for future sync reconciliation.';
comment on column public.wardrobe_care_notes.source_item_id is
  'Original scan/item/library/product identifier this utility data is attached to.';

create index if not exists wardrobe_care_notes_user_id_idx
  on public.wardrobe_care_notes (user_id);
create index if not exists wardrobe_care_notes_source_item_id_idx
  on public.wardrobe_care_notes (user_id, source_item_id);

alter table public.wardrobe_care_notes enable row level security;

create policy "Users can select own care notes"
  on public.wardrobe_care_notes
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own care notes"
  on public.wardrobe_care_notes
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own care notes"
  on public.wardrobe_care_notes
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own care notes"
  on public.wardrobe_care_notes
  for delete
  to authenticated
  using (user_id = auth.uid());

-- Wishlist / shopping intent signals.
create table if not exists public.wardrobe_wishlist_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text,
  source_item_id text not null,
  intent text not null,
  title_snapshot text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on column public.wardrobe_wishlist_intents.client_id is
  'Local/offline identifier for future sync reconciliation.';
comment on column public.wardrobe_wishlist_intents.source_item_id is
  'Original scan/item/library/product identifier this utility data is attached to.';

create index if not exists wardrobe_wishlist_intents_user_id_idx
  on public.wardrobe_wishlist_intents (user_id);
create index if not exists wardrobe_wishlist_intents_source_item_id_idx
  on public.wardrobe_wishlist_intents (user_id, source_item_id);

alter table public.wardrobe_wishlist_intents enable row level security;

create policy "Users can select own wishlist intents"
  on public.wardrobe_wishlist_intents
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own wishlist intents"
  on public.wardrobe_wishlist_intents
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own wishlist intents"
  on public.wardrobe_wishlist_intents
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own wishlist intents"
  on public.wardrobe_wishlist_intents
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ============================================================================
-- P2 defer/optional
-- ============================================================================

-- Wear events for cost-per-wear tracking and "worn today" signals.
create table if not exists public.wardrobe_wear_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text,
  source_item_id text not null,
  worn_at timestamptz not null default now(),
  estimated_price numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on column public.wardrobe_wear_events.client_id is
  'Local/offline identifier for future sync reconciliation.';
comment on column public.wardrobe_wear_events.source_item_id is
  'Original scan/item/library/product identifier this utility data is attached to.';

create index if not exists wardrobe_wear_events_user_id_idx
  on public.wardrobe_wear_events (user_id);
create index if not exists wardrobe_wear_events_source_item_id_idx
  on public.wardrobe_wear_events (user_id, source_item_id);
create index if not exists wardrobe_wear_events_worn_at_idx
  on public.wardrobe_wear_events (user_id, worn_at desc);

alter table public.wardrobe_wear_events enable row level security;

create policy "Users can select own wear events"
  on public.wardrobe_wear_events
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own wear events"
  on public.wardrobe_wear_events
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own wear events"
  on public.wardrobe_wear_events
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own wear events"
  on public.wardrobe_wear_events
  for delete
  to authenticated
  using (user_id = auth.uid());

-- Activity log (timeline of utility interactions).
create table if not exists public.wardrobe_activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text,
  event_type text not null,
  label text not null,
  source_item_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on column public.wardrobe_activity_log.client_id is
  'Local/offline identifier for future sync reconciliation.';
comment on column public.wardrobe_activity_log.source_item_id is
  'Original scan/item/library/product identifier this utility data is attached to.';

create index if not exists wardrobe_activity_log_user_id_idx
  on public.wardrobe_activity_log (user_id);
create index if not exists wardrobe_activity_log_event_type_idx
  on public.wardrobe_activity_log (user_id, event_type);
create index if not exists wardrobe_activity_log_created_at_idx
  on public.wardrobe_activity_log (user_id, created_at desc);

alter table public.wardrobe_activity_log enable row level security;

create policy "Users can select own activity log"
  on public.wardrobe_activity_log
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert own activity log"
  on public.wardrobe_activity_log
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update own activity log"
  on public.wardrobe_activity_log
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own activity log"
  on public.wardrobe_activity_log
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ============================================================================
-- Shared updated_at trigger
-- Reuses the existing project-wide trigger function if it exists.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists wardrobe_utility_items_set_updated_at on public.wardrobe_utility_items;
    create trigger wardrobe_utility_items_set_updated_at
      before update on public.wardrobe_utility_items
      for each row
      execute function public.set_updated_at();

    drop trigger if exists wardrobe_collections_set_updated_at on public.wardrobe_collections;
    create trigger wardrobe_collections_set_updated_at
      before update on public.wardrobe_collections
      for each row
      execute function public.set_updated_at();

    drop trigger if exists wardrobe_collection_items_set_updated_at on public.wardrobe_collection_items;
    create trigger wardrobe_collection_items_set_updated_at
      before update on public.wardrobe_collection_items
      for each row
      execute function public.set_updated_at();

    drop trigger if exists wardrobe_brand_sizing_notes_set_updated_at on public.wardrobe_brand_sizing_notes;
    create trigger wardrobe_brand_sizing_notes_set_updated_at
      before update on public.wardrobe_brand_sizing_notes
      for each row
      execute function public.set_updated_at();

    drop trigger if exists wardrobe_outfit_feedback_set_updated_at on public.wardrobe_outfit_feedback;
    create trigger wardrobe_outfit_feedback_set_updated_at
      before update on public.wardrobe_outfit_feedback
      for each row
      execute function public.set_updated_at();

    drop trigger if exists wardrobe_care_notes_set_updated_at on public.wardrobe_care_notes;
    create trigger wardrobe_care_notes_set_updated_at
      before update on public.wardrobe_care_notes
      for each row
      execute function public.set_updated_at();

    drop trigger if exists wardrobe_wishlist_intents_set_updated_at on public.wardrobe_wishlist_intents;
    create trigger wardrobe_wishlist_intents_set_updated_at
      before update on public.wardrobe_wishlist_intents
      for each row
      execute function public.set_updated_at();

    drop trigger if exists wardrobe_wear_events_set_updated_at on public.wardrobe_wear_events;
    create trigger wardrobe_wear_events_set_updated_at
      before update on public.wardrobe_wear_events
      for each row
      execute function public.set_updated_at();

    drop trigger if exists wardrobe_activity_log_set_updated_at on public.wardrobe_activity_log;
    create trigger wardrobe_activity_log_set_updated_at
      before update on public.wardrobe_activity_log
      for each row
      execute function public.set_updated_at();
  end if;
end $$;
