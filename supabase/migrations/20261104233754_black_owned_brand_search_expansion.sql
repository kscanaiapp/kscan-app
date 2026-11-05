-- Ordinary shopping source hints, deliberately independent of discovery_*.
-- Pending governed Staging migration; this file does not authorize Production.
alter table public.user_stylist_preferences
  add column include_black_owned_brand_search boolean not null default false;

create sequence public.brand_search_source_revision;
create table public.black_owned_brand_search_sources (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  brand_name text not null check (length(brand_name) between 1 and 60),
  official_website text not null,
  canonical_domain text not null unique check (canonical_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$'),
  alternate_domains text[] not null default '{}',
  social_references text[] not null default '{}',
  categories text[] not null default '{}' check (categories <@ array['outerwear','blazer','dress','pants','top','footwear','bag','accessory']),
  keywords text[] not null default '{}' check (cardinality(keywords) <= 20),
  us_eligible boolean not null default false,
  enabled boolean not null default false,
  review_status text not null default 'review' check (review_status in ('review','qualified','excluded')),
  reviewed_at timestamptz,
  source_notes text not null default '',
  provenance_references text[] not null default '{}',
  rotation_weight integer not null default 1 check (rotation_weight between 1 and 10),
  revision bigint not null default nextval('public.brand_search_source_revision'),
  updated_at timestamptz not null default now(),
  check (official_website = 'https://' || canonical_domain || '/'),
  check (not enabled or (us_eligible and review_status = 'qualified' and reviewed_at is not null and cardinality(categories) > 0 and cardinality(provenance_references) > 0))
);
create unique index brand_search_name_unique on public.black_owned_brand_search_sources (lower(trim(brand_name)));
create index brand_search_categories on public.black_owned_brand_search_sources using gin (categories) where enabled;

-- Coverage contains no shopper identifiers or customer content.
create table public.brand_search_source_coverage (
  source_id text primary key references public.black_owned_brand_search_sources(id) on delete cascade,
  search_count bigint not null default 0 check (search_count >= 0),
  valid_product_count bigint not null default 0 check (valid_product_count >= 0),
  last_successful_search_at timestamptz,
  last_search_at timestamptz
);
create table public.brand_search_source_audit (
  id bigint generated always as identity primary key,
  source_id text not null,
  operation text not null,
  before_record jsonb,
  after_record jsonb,
  changed_at timestamptz not null default now(),
  database_actor text not null default session_user
);

alter table public.black_owned_brand_search_sources enable row level security;
alter table public.brand_search_source_coverage enable row level security;
alter table public.brand_search_source_audit enable row level security;
revoke all on public.black_owned_brand_search_sources, public.brand_search_source_coverage, public.brand_search_source_audit from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.black_owned_brand_search_sources to service_role;
grant select on public.brand_search_source_coverage, public.brand_search_source_audit to service_role;
revoke all on sequence public.brand_search_source_revision from public, anon, authenticated;
grant usage on sequence public.brand_search_source_revision to service_role;

-- No public RPC or mobile writer. Trusted operations use service-only administration;
-- the trigger captures before/after records even for SQL updates and removals.
create function public.audit_brand_search_source() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'DELETE' then
    perform pg_advisory_xact_lock(734351);
    if exists (select 1 from unnest(array[new.canonical_domain] || new.alternate_domains) as d
      where d !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$'
        or d ~ '(^|\.)(localhost|local|internal|test|invalid|onion)(\.|$)') then
      raise exception 'invalid source domain';
    end if;
    if exists (
      select 1 from public.black_owned_brand_search_sources s
      where s.id <> new.id and
      (s.canonical_domain = any(new.alternate_domains)
       or new.canonical_domain = any(s.alternate_domains)
       or s.alternate_domains && new.alternate_domains)
    ) then raise exception 'duplicate source domain'; end if;
    new.revision := nextval('public.brand_search_source_revision');
    new.updated_at := now();
    if new.enabled and (new.reviewed_at > now() or new.reviewed_at < now() - interval '180 days') then
      raise exception 'source review is stale';
    end if;
  end if;
  insert into public.brand_search_source_audit(source_id, operation, before_record, after_record)
    values (case when tg_op = 'DELETE' then old.id else new.id end, tg_op,
      case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.audit_brand_search_source() from public, anon, authenticated, service_role;
create trigger brand_search_source_changes before insert or update or delete
  on public.black_owned_brand_search_sources for each row execute function public.audit_brand_search_source();

create function public.record_brand_search_coverage(p_source_id text, p_revision bigint, p_valid_count integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_valid_count < 0 or p_valid_count > 10 then raise exception 'invalid count'; end if;
  if not exists (select 1 from public.black_owned_brand_search_sources where id = p_source_id and revision = p_revision and enabled) then return; end if;
  insert into public.brand_search_source_coverage(source_id, search_count, valid_product_count, last_search_at, last_successful_search_at)
  values (p_source_id, 1, p_valid_count, now(), case when p_valid_count > 0 then now() end)
  on conflict (source_id) do update set search_count = public.brand_search_source_coverage.search_count + 1,
    valid_product_count = public.brand_search_source_coverage.valid_product_count + p_valid_count,
    last_search_at = now(), last_successful_search_at = case when p_valid_count > 0 then now() else public.brand_search_source_coverage.last_successful_search_at end;
end $$;
revoke all on function public.record_brand_search_coverage(text,bigint,integer) from public, anon, authenticated;
grant execute on function public.record_brand_search_coverage(text,bigint,integer) to service_role;
