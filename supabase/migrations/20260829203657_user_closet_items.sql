-- Build 34 / Track B / Phase B1A -- Cloud Closet Facts contract.
--
-- Account-level cloud representation of the existing LOCAL K Scan Closet
-- (services/closetLibrary.js). This is a database contract only: no client
-- reads or writes it yet, no media, no sync engine. See
-- docs/build34-trackb-closet-facts-ledger.md for the full local-to-cloud
-- field mapping and the reasoning behind every included/excluded field.
--
-- Cloud persistence of Closet items is a K+ (paid-tier) capability. The
-- local, device-only Closet is unaffected and remains free. Authorization
-- reuses the existing K+ entitlement primitive
-- (public.kplus_has_active_entitlement, see 20260829120000_kplus_entitlements.sql)
-- via a new no-argument wrapper, has_active_k_plus(), so RLS policies never
-- need to accept a client-suppliable user id.

create table if not exists public.user_closet_items (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  client_id        text not null,

  -- Structured fashion taxonomy -- mirrors services/closetLibrary.js's
  -- CLOSET_ITEM_TAXONOMY_FIELDS exactly, field for field.
  title            text not null default 'Closet item',
  category         text,
  clothing_type    text,
  subtype          text,
  brand            text,
  primary_color    text,
  secondary_colors text[] not null default '{}'::text[],
  material         text[] not null default '{}'::text[],
  size             text,
  notes            text,
  origin           text not null default 'direct_intake',

  -- Sync/versioning infrastructure primitives (Phase B1A freezes the shape;
  -- Phase B2 defines the update/retry engine that consumes them).
  schema_version   smallint not null,
  row_version      bigint not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  constraint user_closet_items_client_id_len check (char_length(client_id) between 1 and 200),
  constraint user_closet_items_title_len check (char_length(title) between 1 and 200),
  constraint user_closet_items_category_len check (category is null or char_length(category) <= 80),
  constraint user_closet_items_clothing_type_len check (clothing_type is null or char_length(clothing_type) <= 80),
  constraint user_closet_items_subtype_len check (subtype is null or char_length(subtype) <= 80),
  constraint user_closet_items_brand_len check (brand is null or char_length(brand) <= 120),
  constraint user_closet_items_primary_color_len check (primary_color is null or char_length(primary_color) <= 60),
  constraint user_closet_items_secondary_colors_bound check (coalesce(array_length(secondary_colors, 1), 0) <= 8),
  constraint user_closet_items_material_bound check (coalesce(array_length(material, 1), 0) <= 8),
  constraint user_closet_items_size_len check (size is null or char_length(size) <= 40),
  constraint user_closet_items_notes_len check (notes is null or char_length(notes) <= 500),
  constraint user_closet_items_origin_enum check (origin in ('direct_intake', 'recent_scan')),
  constraint user_closet_items_schema_version_positive check (schema_version >= 1),
  constraint user_closet_items_row_version_positive check (row_version >= 1)
);

comment on table public.user_closet_items is
  'Build 34 Track B Phase B1A. Account-level cloud facts for the existing local K Scan Closet (services/closetLibrary.js). K+ gated. No media fields, no client sync yet -- see docs/build34-trackb-closet-facts-ledger.md.';
comment on column public.user_closet_items.client_id is
  'The local Closet record''s own stable id (services/closetLibrary.js buildClosetRecord), reused as the sync idempotency key. Never regenerated once assigned. Paired with user_id in the UNIQUE constraint below.';
comment on column public.user_closet_items.schema_version is
  'Client-reported local CLOSET_ITEM_SCHEMA_VERSION this row''s taxonomy shape was written under. No upper bound enforced here so a future client schema bump never requires a backend migration.';
comment on column public.user_closet_items.row_version is
  'Monotonic server-side revision counter, bumped by set_user_closet_items_touch on every update (soft-delete included). Primitive only -- Phase B2 defines the conflict/retry semantics that consume it.';
comment on column public.user_closet_items.deleted_at is
  'Tombstone marker. A soft-deleted row is never hard-deleted by this contract -- media/device cleanup and cross-device propagation are later phases.';

create unique index if not exists user_closet_items_user_client_uidx
  on public.user_closet_items (user_id, client_id);

create index if not exists user_closet_items_sync_idx
  on public.user_closet_items (user_id, deleted_at, updated_at);

alter table public.user_closet_items enable row level security;

-- ── K+ authorization primitive ───────────────────────────────────────────
-- Thin, no-argument wrapper around the existing kplus_has_active_entitlement
-- primitive (20260829120000_kplus_entitlements.sql), reused rather than
-- reimplemented. Derives the caller's identity from auth.uid() itself, so no
-- policy or caller ever supplies a user id that could be forged. Runs
-- SECURITY DEFINER purely so it can invoke kplus_has_active_entitlement
-- (locked to service_role) on the caller's behalf -- it grants no broader
-- access than "is the current session's own K+ status active".
create or replace function public.has_active_k_plus()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.kplus_has_active_entitlement(auth.uid(), 'k_plus'), false);
$$;

revoke all on function public.has_active_k_plus() from public, anon;
grant execute on function public.has_active_k_plus() to authenticated;

drop policy if exists "select own closet items when k+ active" on public.user_closet_items;
create policy "select own closet items when k+ active"
  on public.user_closet_items
  for select
  to authenticated
  using (user_id = auth.uid() and public.has_active_k_plus());

drop policy if exists "insert own closet items when k+ active" on public.user_closet_items;
create policy "insert own closet items when k+ active"
  on public.user_closet_items
  for insert
  to authenticated
  with check (user_id = auth.uid() and public.has_active_k_plus());

drop policy if exists "update own closet items when k+ active" on public.user_closet_items;
create policy "update own closet items when k+ active"
  on public.user_closet_items
  for update
  to authenticated
  using (user_id = auth.uid() and public.has_active_k_plus())
  with check (user_id = auth.uid() and public.has_active_k_plus());

-- No delete policy: deletion is exclusively the soft-delete (UPDATE
-- deleted_at) path above. Hard delete is not exposed to any client role.
revoke all on public.user_closet_items from anon, authenticated, public;
grant select, insert, update on public.user_closet_items to authenticated;
grant select, insert, update, delete on public.user_closet_items to service_role;
revoke truncate, references, trigger, maintain on public.user_closet_items
  from anon, authenticated, service_role;

-- ── Server-controlled fields ─────────────────────────────────────────────
-- Belt-and-suspenders alongside the RLS WITH CHECK clauses above: identity
-- and revision fields are re-stamped from server state regardless of what a
-- client sends, so a bug in a future policy change cannot alone regress
-- "client can choose their own user_id / roll back row_version".
create or replace function public.set_user_closet_items_insert_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_id = auth.uid();
  new.created_at = now();
  new.updated_at = now();
  new.row_version = 1;
  return new;
end;
$$;

revoke all on function public.set_user_closet_items_insert_authority() from public, anon, authenticated;

drop trigger if exists user_closet_items_insert_authority on public.user_closet_items;
create trigger user_closet_items_insert_authority
  before insert on public.user_closet_items
  for each row
  execute function public.set_user_closet_items_insert_authority();

create or replace function public.set_user_closet_items_update_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Identity is immutable via UPDATE by construction: reasserted from the
  -- persisted row regardless of what the client's payload contains.
  new.user_id = old.user_id;
  new.client_id = old.client_id;
  new.created_at = old.created_at;
  new.updated_at = now();
  new.row_version = old.row_version + 1;
  return new;
end;
$$;

revoke all on function public.set_user_closet_items_update_authority() from public, anon, authenticated;

drop trigger if exists user_closet_items_update_authority on public.user_closet_items;
create trigger user_closet_items_update_authority
  before update on public.user_closet_items
  for each row
  execute function public.set_user_closet_items_update_authority();
