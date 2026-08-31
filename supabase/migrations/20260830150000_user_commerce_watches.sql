-- Build 34 / K+ Smart Watchlist V1 -- K5-C2: Watch persistence + user intent.
--
-- A Watch is an OFFER at ONE retailer, identified by its normalized HTTPS
-- listing URL -- never a product, never a variant (see
-- docs/build34-kplus-smart-watchlist-v1-k5c0-audit.md). V1 watch eligibility
-- is narrowed to the two providers with a real re-read-by-URL adapter
-- (Farfetch, KicksCrew -- see supabase/functions/scan-identify/
-- watchlistCapability.ts), so this table never needs to carry MODE B
-- re-discovery evidence: refresh is always a direct URL re-read.
--
-- This is a new, more sensitive personal-data class than Closet ("products
-- this user is considering buying, and the price they will buy at" --
-- commercial intent, not just taxonomy) but follows the user_closet_items
-- pattern (20260829203657_user_closet_items.sql) as its structural template:
-- same K+ gate, same identity-stamping triggers, same revoke-all-then-narrow
-- grant discipline, same soft-delete-only lifecycle.
--
-- DELIBERATE DEVIATION from the user_closet_items template: Watch actions
-- have different K+ requirements per action (view/pause/delete never require
-- K+; create/resume do -- see the master build brief §26), which a single
-- coarse RLS policy per verb cannot express. So this table exposes NO client
-- INSERT/UPDATE/DELETE policies at all -- every state transition goes
-- through a SECURITY DEFINER RPC below that enforces its own gate. SELECT is
-- the only raw-table client policy, and it is intentionally NOT K+-gated:
-- an expired K+ user must still be able to see a Watch they already made.

create table if not exists public.user_commerce_watches (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,

  -- ── Identity (§10, §15 of the C0 audit) ──────────────────────────────────
  -- source/canonical_url together ARE the identity. No canonicalProductKey,
  -- no brand/title hash: both are unstable and were explicitly rejected as a
  -- Watch identity in the audit.
  source                 text not null,
  canonical_url          text not null,
  provider_listing_id    text,

  -- ── Offer snapshot at watch time (display only, never re-derived) ───────
  display_title          text not null,
  display_image_url      text,

  -- ── Price authority ───────────────────────────────────────────────────--
  initial_price_amount   numeric,
  current_price_amount   numeric,
  currency               text not null,

  -- ── Intent ────────────────────────────────────────────────────────────--
  watch_intent           text not null default 'just_watching',
  target_price_amount    numeric,
  target_reached_at      timestamptz,

  -- ── Refresh / observation state ──────────────────────────────────────--
  status                 text not null default 'active',
  last_checked_at        timestamptz,
  last_status            text not null default 'unchecked',
  consecutive_failures   integer not null default 0,

  -- ── Sync/versioning (mirrors user_closet_items) ──────────────────────--
  schema_version         smallint not null default 1,
  row_version            bigint not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,

  constraint user_commerce_watches_source_len check (char_length(source) between 1 and 60),
  constraint user_commerce_watches_canonical_url_len check (char_length(canonical_url) between 1 and 2048),
  constraint user_commerce_watches_provider_listing_id_len check (provider_listing_id is null or char_length(provider_listing_id) <= 200),
  constraint user_commerce_watches_display_title_len check (char_length(display_title) between 1 and 200),
  constraint user_commerce_watches_display_image_url_len check (display_image_url is null or char_length(display_image_url) <= 2048),
  constraint user_commerce_watches_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint user_commerce_watches_watch_intent_enum check (watch_intent in ('just_watching', 'buy_under')),
  constraint user_commerce_watches_status_enum check (status in ('active', 'paused', 'deleted')),
  constraint user_commerce_watches_last_status_enum check (last_status in ('unchecked', 'available', 'unavailable', 'error')),
  constraint user_commerce_watches_initial_price_positive check (initial_price_amount is null or initial_price_amount > 0),
  constraint user_commerce_watches_current_price_positive check (current_price_amount is null or current_price_amount > 0),
  -- buy_under requires a positive target; just_watching must not carry one --
  -- an armed threshold nobody set would be a false trust signal.
  constraint user_commerce_watches_target_price_shape check (
    (watch_intent = 'buy_under' and target_price_amount is not null and target_price_amount > 0)
    or (watch_intent = 'just_watching' and target_price_amount is null)
  ),
  constraint user_commerce_watches_consecutive_failures_bound check (consecutive_failures >= 0 and consecutive_failures <= 1000),
  constraint user_commerce_watches_schema_version_positive check (schema_version >= 1),
  constraint user_commerce_watches_row_version_positive check (row_version >= 1)
);

comment on table public.user_commerce_watches is
  'Build 34 K+ Smart Watchlist V1 (K5-C2). One row per watched retailer listing per user. K+ gated for create/resume/refresh/monitor/alert; view/pause/delete are not K+ gated. All writes route through the SECURITY DEFINER RPCs below -- no client INSERT/UPDATE/DELETE policy exists on this table.';
comment on column public.user_commerce_watches.source is
  'Watch-eligible provider label (''farfetch'' | ''kickscrew'' in V1 -- see watchlistCapability.ts WATCH_PROVIDER_REGISTRY). Display/refresh-routing only, never a ranking input.';
comment on column public.user_commerce_watches.canonical_url is
  'The governed, normalized HTTPS listing URL -- the sole identity authority for this Watch. Always the output of normalizePersistedCommerceUrl at write time, never client-supplied free text.';
comment on column public.user_commerce_watches.current_price_amount is
  'Latest observed price for this exact listing. For KicksCrew this is the adapter''s product-family MINIMUM price, never a claim about the user''s selected size -- see kicksCrewProvider.ts.';
comment on column public.user_commerce_watches.target_reached_at is
  'Set once, the first time an observed price is seen at or below target_price_amount. If the target was already met at watch-creation time this is stamped at creation with no corresponding watch_event row, so "target already met" is never presented as a historical price drop.';
comment on column public.user_commerce_watches.consecutive_failures is
  'Consecutive refresh cycles that failed to resolve this listing. Only after this crosses the configured degradation threshold (commerceWatchRefreshConfig.ts) does last_status become ''unavailable'' -- a single timeout/429/outage must never present as "no longer listed" (C0 audit §40, §53).';
comment on column public.user_commerce_watches.deleted_at is
  'Tombstone marker. Set by delete_user_commerce_watch(), which also hard-deletes this watch''s user_commerce_watch_events rows in the same transaction.';

create unique index if not exists user_commerce_watches_user_url_uidx
  on public.user_commerce_watches (user_id, canonical_url)
  where deleted_at is null;

create index if not exists user_commerce_watches_refresh_eligible_idx
  on public.user_commerce_watches (status, last_checked_at)
  where deleted_at is null and status = 'active';

create index if not exists user_commerce_watches_user_list_idx
  on public.user_commerce_watches (user_id, deleted_at, created_at desc);

alter table public.user_commerce_watches enable row level security;

-- Only a raw-table SELECT is exposed to clients, and deliberately not K+
-- gated: an expired-K+ user must still see (and pause/delete) a Watch they
-- already made (master build brief §26, §6).
drop policy if exists "select own commerce watches" on public.user_commerce_watches;
create policy "select own commerce watches"
  on public.user_commerce_watches
  for select
  to authenticated
  using (user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policy for any client role: every write is
-- mediated by a SECURITY DEFINER RPC below, each enforcing its own K+
-- requirement. This is the "server-mediated Watch creation" the build brief
-- requires (§21), extended uniformly to every other state transition rather
-- than mixing raw client UPDATE with per-column gating.
revoke all on public.user_commerce_watches from anon, authenticated, public;
grant select on public.user_commerce_watches to authenticated;
grant select, insert, update, delete on public.user_commerce_watches to service_role;
revoke truncate, references, trigger, maintain on public.user_commerce_watches
  from anon, authenticated, service_role;

-- ── Server-controlled fields ──────────────────────────────────────────---
-- Deliberately does NOT stamp user_id from auth.uid(), unlike the
-- user_closet_items template: every insert into this table happens through
-- create_user_commerce_watch() (below), called by the commerce-watch-refresh
-- Edge Function via the service_role key -- a context where auth.uid() is
-- null (there is no end-user JWT session), not the caller's identity. The
-- RPC receives its user id as an explicit argument, populated exclusively
-- from the Edge Function's own JWT verification (requireUser), never from
-- client-supplied request-body JSON. No client role holds INSERT on this
-- table (see the grants above), so this trigger only needs to fill in the
-- fields a service-role insert should not have to specify by hand.
create or replace function public.set_user_commerce_watches_insert_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is null then
    raise exception 'user_id required' using errcode = '23502';
  end if;
  new.created_at = now();
  new.updated_at = now();
  new.row_version = 1;
  return new;
end;
$$;

revoke all on function public.set_user_commerce_watches_insert_authority() from public, anon, authenticated;

drop trigger if exists user_commerce_watches_insert_authority on public.user_commerce_watches;
create trigger user_commerce_watches_insert_authority
  before insert on public.user_commerce_watches
  for each row
  execute function public.set_user_commerce_watches_insert_authority();

create or replace function public.set_user_commerce_watches_update_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_id = old.user_id;
  new.canonical_url = old.canonical_url;
  new.source = old.source;
  new.created_at = old.created_at;
  new.updated_at = now();
  new.row_version = old.row_version + 1;
  return new;
end;
$$;

revoke all on function public.set_user_commerce_watches_update_authority() from public, anon, authenticated;

drop trigger if exists user_commerce_watches_update_authority on public.user_commerce_watches;
create trigger user_commerce_watches_update_authority
  before update on public.user_commerce_watches
  for each row
  execute function public.set_user_commerce_watches_update_authority();
