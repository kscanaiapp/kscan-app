-- Status: REVIEWED — approved for K Scan AI Staging (yzqjvdfgefveprobvvyw) only.
-- Not for Production (KScan App Production, wyyuqfdxucjksghsmhry) until validated.
--
-- REF CORRECTION (S7). This header previously read "KScan App Staging
-- (wyyuqfdxucjksghsmhry)", copied from the convention used by several older
-- migrations. That ref is PRODUCTION, not staging. The authoritative mapping
-- is security/scripts/lib/environment-authority.js:
--     staging     yzqjvdfgefveprobvvyw   ("K Scan AI Staging")
--     production  wyyuqfdxucjksghsmhry   ("KScan App Production")
-- A header that names the production project while claiming staging approval
-- is wrong in the one direction that matters, so it is corrected here.
--
-- Build 29 Closet V2 / S5 — wear-history data-model reconciliation.
--
-- WHAT THIS ESTABLISHES
-- --------------------
-- One wear-history authority capable of representing BOTH "wore this item"
-- and "wore this look" without creating a second competing model:
--
--     auth.users
--        -> public.wardrobe_wear_events        (one logical wear)
--        -> public.wardrobe_wear_event_items   (one row per garment worn)
--        -> source wardrobe/Closet item identity (text, not an FK)
--
-- WHY source_item_id BECOMES NULLABLE
-- -----------------------------------
-- The existing table models one event = one item: `source_item_id text not
-- null` sits on the EVENT. That cannot express an outfit-level wear — a look
-- of four garments has no single source item, and choosing one would invent a
-- meaning the user never expressed.
--
-- Relaxing the NOT NULL is backward-compatible in the direction that matters:
-- the only writer, services/free-tier/freeTierSupabaseSync.ts via
-- mapWearTrackingEntryToRemoteWearEvent, always supplies a value (it falls
-- back to 'unknown'), and there is no read-back path in the tree that would
-- meet a null. A Build 28 client therefore neither writes nor reads a row
-- shaped differently from what it already handles.
--
-- The constraint is replaced rather than removed: every row must still carry
-- identity from SOMEWHERE — an item, or a look. A wear event that identifies
-- neither is meaningless and is rejected by the database rather than by
-- whichever service happens to be writing.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ----------------------------------
--   * No column is dropped and no existing column changes type.
--   * source_item_id stays TEXT and is NOT promoted to a foreign key.
--     Closet identity spans a device-local manifest, saved_scans and
--     inspiration_items; a FK would make wear history undeletable-by-proxy
--     and would break the moment a device-local id is logged.
--   * Cost Per Wear is untouched. `estimated_price` already exists on the
--     event table and keeps its current meaning; nothing here reads it.

-- ============================================================================
-- 1. Outfit-level identity on the existing event table
-- ============================================================================

alter table public.wardrobe_wear_events
  add column if not exists saved_look_id uuid
  references public.looks(id) on delete set null;

comment on column public.wardrobe_wear_events.saved_look_id is
  'Live FK to the Saved Look this wear came from. ON DELETE SET NULL: deleting '
  'the look must not erase the fact that the user wore it. The durable id '
  'remains in saved_look_ref and the garments in wardrobe_wear_event_items.';

alter table public.wardrobe_wear_events
  alter column source_item_id drop not null;

-- Durable, non-FK record of WHICH look was worn.
--
-- saved_look_id is a real foreign key and is therefore nulled when the look is
-- deleted. That is the behaviour we want for live linkage, but it cannot be the
-- only identity an outfit-level event has: such a row carries no
-- source_item_id, so nulling the look would leave it identity-less, and the
-- CHECK below would reject the UPDATE — making a worn Saved Look impossible to
-- delete. This column keeps the identity after the FK lets go, mirroring the
-- reason source_item_id is deliberately TEXT rather than a foreign key.
alter table public.wardrobe_wear_events
  add column if not exists saved_look_ref text;

comment on column public.wardrobe_wear_events.saved_look_ref is
  'Durable id of the Saved Look this wear came from. Survives deletion of the '
  'look; saved_look_id is the live FK and nulls out.';

-- Identity must come from one side or the other. Written as NOT VALID first
-- so the statement cannot fail against pre-existing staging rows, then
-- validated separately: every legacy row already has a non-null
-- source_item_id, so validation is expected to succeed, but a surprise row
-- must surface as a validation error rather than as a failed migration that
-- has already half-applied.
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

-- ============================================================================
-- 2. Event -> item relationships
-- ============================================================================

create table if not exists public.wardrobe_wear_event_items (
  id uuid primary key default gen_random_uuid(),
  -- Denormalized owner. The RLS policies below scope on this directly rather
  -- than joining through wardrobe_wear_events: a policy that has to join is a
  -- policy that can be defeated by a missing index or a planner change, and
  -- account-isolation must not depend on either.
  user_id uuid not null references auth.users(id) on delete cascade,
  wear_event_id uuid not null
    references public.wardrobe_wear_events(id) on delete cascade,
  client_id text,
  source_item_id text not null,
  source_type text not null default 'unknown',
  -- Smallest privacy-safe historical snapshot. Bounded display text only:
  -- what the garment was CALLED and its category at the moment it was worn,
  -- so an August wear still reads correctly after the item is renamed or the
  -- look is edited. Deliberately NOT a copy of the Closet payload — no
  -- images, no storage references, no commerce, no brand evidence.
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
  'One row per garment participating in a logical wear event. A Saved Look '
  'worn once produces ONE wardrobe_wear_events row and N of these.';
comment on column public.wardrobe_wear_event_items.client_id is
  'Local/offline identifier for sync reconciliation.';
comment on column public.wardrobe_wear_event_items.title_snapshot is
  'Point-in-time display title. Preserves historical meaning after the '
  'source item is renamed or removed. Never a full item payload.';

create index if not exists wardrobe_wear_event_items_user_id_idx
  on public.wardrobe_wear_event_items (user_id);
create index if not exists wardrobe_wear_event_items_event_id_idx
  on public.wardrobe_wear_event_items (wear_event_id);
-- Serves "times worn" / "last worn" for a single garment.
create index if not exists wardrobe_wear_event_items_source_item_idx
  on public.wardrobe_wear_event_items (user_id, source_item_id)
  where deleted_at is null;
create index if not exists wardrobe_wear_event_items_created_at_idx
  on public.wardrobe_wear_event_items (user_id, created_at desc);

-- ============================================================================
-- 3. Duplicate protection
-- ============================================================================

-- A garment may appear only ONCE in a given logical wear event. This is the
-- schema-level half of the "do not double-count a duplicated look payload"
-- invariant: a corrupt look listing the same blazer twice cannot produce two
-- relationships even if the service layer forgets to de-duplicate.
--
-- Partial on deleted_at so a soft-deleted relationship does not block the
-- garment being legitimately re-added to the same event later.
create unique index if not exists wardrobe_wear_event_items_event_source_uidx
  on public.wardrobe_wear_event_items (wear_event_id, source_item_id)
  where deleted_at is null;

-- Upsert arbiter, matching the convention every other free-tier table uses.
create unique index if not exists wardrobe_wear_event_items_user_client_uidx
  on public.wardrobe_wear_event_items (user_id, client_id);

-- Idempotency for the EVENT itself. wardrobe_wear_events already has a
-- (user_id, client_id) unique index from the free-tier migration, which is
-- what makes a repeated submission of the same logical wear action collapse
-- onto one row instead of incrementing wear twice. Recorded here as the
-- load-bearing fact it is; not recreated.

-- ============================================================================
-- 4. RLS + explicit privileges
-- ============================================================================

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

-- RLS is necessary but NOT sufficient here, and the insufficiency runs in BOTH
-- directions. The privilege layer has to be stated explicitly on each side.
--
-- MISSING PRIVILEGE. A from-zero database does not grant new public tables to
-- the authenticated role, so without the GRANT below every authenticated query
-- fails with 42501. Same hazard the free-tier migration documents.
--
-- UNREQUESTED PRIVILEGE. The opposite failure was observed for real. Applied to
-- K Scan AI Staging, this table came up holding SELECT/INSERT/UPDATE/DELETE for
-- anon, which this migration never granted: they arrived from ALTER DEFAULT
-- PRIVILEGES configured on that database, so deploying the migration created a
-- privilege the source never asked for. Staging was repaired by hand with a
-- REVOKE; stating it here is what stops a clean apply to any other environment
-- from silently recreating it.
--
-- anon is revoked rather than left to RLS. Wear history is private user data,
-- and a table privilege held shut only by policy is one policy mistake away
-- from being reachable — the same belt-and-braces reasoning public.saved_scans
-- and public.apple_auth_credentials already use. PUBLIC is included because
-- anon inherits it, so revoking anon alone would leave a second route to the
-- same privilege; public.outfit_decision_groups and friends revoke both for
-- that reason.
revoke all on public.wardrobe_wear_event_items from anon, public;

grant select, insert, update, delete
  on public.wardrobe_wear_event_items to authenticated;

-- ============================================================================
-- 5. Shared updated_at trigger
-- ============================================================================

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
