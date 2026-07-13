-- Android backend runtime fixes (2026-07-09)
-- 1) Grant narrow app_config SELECT so mobile_feature_freeze can be read by anon/authenticated.
-- 2) Fix usage_date ambiguity in check_and_increment_scan_identify_daily_usage.
-- 3) Create scan_intelligence_events table for best-effort telemetry (non-blocking).

-- ── 1. app_config narrow public read ──────────────────────────────────────────

-- The existing RLS policy limits reads to mobile_feature_freeze, but policies
-- alone do not grant table access. Explicit SELECT grants are required.
grant select on public.app_config to anon, authenticated;

alter table public.app_config enable row level security;

drop policy if exists "Public read app config" on public.app_config;

drop policy if exists "Allow public read for mobile feature freeze config" on public.app_config;

drop policy if exists "Public read safe mobile config" on public.app_config;

create policy "Public read safe mobile config"
  on public.app_config
  for select
  to anon, authenticated
  using (key in ('mobile_feature_freeze'));

-- Ensure the safe public mobile config row exists.
insert into public.app_config (key, value)
values (
  'mobile_feature_freeze',
  '{
    "schemaVersion": 1,
    "featureFreeze": false,
    "freezeMessage": "Feature temporarily frozen — focusing on closet organization.",
    "updatedAt": "2026-05-23T00:00:00Z"
  }'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = timezone('utc', now());

-- ── 2. Fix scan-identify daily usage RPC ambiguity ────────────────────────────

-- The previous definition referenced current_date / unqualified usage_date in
-- multiple places, which conflicted with the returned column named usage_date.
-- This replacement qualifies all table references and uses a local variable.
create or replace function public.check_and_increment_scan_identify_daily_usage(
  p_user_id uuid,
  p_mode text,
  p_daily_limit integer
)
returns table (
  allowed     boolean,
  count       integer,
  "limit"     integer,
  remaining   integer,
  usage_date  date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count      integer;
  v_allowed    boolean;
  v_usage_date date := current_date;
begin
  -- Direct authenticated callers may only check their own quota.
  -- Service-role clients have auth.uid() = null and bypass this guard.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'Quota user mismatch' using errcode = '28000';
  end if;

  -- Ensure limit is sane.
  if p_daily_limit is null or p_daily_limit < 1 then
    p_daily_limit := 30;
  end if;

  -- Atomic upsert: only increment if under the daily limit.
  -- Qualify every table reference with the alias "s" to avoid ambiguity
  -- between the table column usage_date and the returned column usage_date.
  insert into public.scan_identify_usage_daily as s
    (user_id, usage_date, mode, count)
  values
    (p_user_id, v_usage_date, p_mode, 1)
  on conflict on constraint scan_identify_usage_daily_user_id_usage_date_mode_key
  do update set
    count = s.count + 1,
    updated_at = now()
  where s.count < p_daily_limit
  returning s.count into v_count;

  if v_count is null then
    -- Quota already exhausted; read current count without incrementing.
    select s.count
      into v_count
      from public.scan_identify_usage_daily s
     where s.user_id = p_user_id
       and s.usage_date = v_usage_date
       and s.mode = p_mode;

    v_count := coalesce(v_count, p_daily_limit);
    v_allowed := false;
  else
    v_allowed := true;
  end if;

  return query select
    v_allowed,
    v_count,
    p_daily_limit,
    greatest(0, p_daily_limit - v_count),
    v_usage_date;
end;
$$;

revoke execute on function public.check_and_increment_scan_identify_daily_usage(uuid, text, integer) from public;

grant execute on function public.check_and_increment_scan_identify_daily_usage(uuid, text, integer) to authenticated;

grant execute on function public.check_and_increment_scan_identify_daily_usage(uuid, text, integer) to service_role;

-- ── 3. scan_intelligence_events telemetry table ───────────────────────────────

-- Best-effort telemetry table written only by the scan-identify Edge Function
-- via service-role client. Missing table is handled gracefully in app code and
-- must never block the scan flow.
create table if not exists public.scan_intelligence_events (
  id                            uuid        primary key default gen_random_uuid(),
  scan_id                       text        not null,
  user_id                       uuid        references auth.users(id) on delete set null,
  mode                          text        not null,
  is_fashion                    boolean     not null default false,
  category                      text,
  item_type                     text,
  subtype                       text,
  brand_guess                   text,
  visible_brand_text            text,
  primary_color                 text,
  material                      text,
  silhouette                    text,
  pattern                       text,
  style_tags                    text[],
  search_queries                text[],
  confidence                    jsonb,
  commerce_query                text,
  commerce_provider             text,
  providers_tried               text[],
  commerce_result_count         integer,
  catalog_count                 integer,
  recommended_product_sources   text[],
  recommended_product_types     text[],
  image_hash                    text,
  app_platform                  text,
  app_version                   text,
  created_at                    timestamptz not null default now()
);

create index if not exists scan_intelligence_events_user_id_idx
  on public.scan_intelligence_events (user_id);

create index if not exists scan_intelligence_events_created_at_idx
  on public.scan_intelligence_events (created_at desc);

alter table public.scan_intelligence_events enable row level security;

-- Only service_role (Edge Function) may write/read telemetry.
revoke all on public.scan_intelligence_events from anon, authenticated;

grant insert, select on public.scan_intelligence_events to service_role;

drop policy if exists "Service role can manage scan intelligence events" on public.scan_intelligence_events;

create policy "Service role can manage scan intelligence events"
  on public.scan_intelligence_events
  for all
  to service_role
  using (true)
  with check (true);
