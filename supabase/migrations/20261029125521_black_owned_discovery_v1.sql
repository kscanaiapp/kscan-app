-- K Scan secondary commerce infrastructure. New, unapplied source; no rollout authority.
-- No brands, products, reviewers, commercial agreements or campaigns are seeded.

create table public.discovery_reviewers (
  actor_id uuid primary key references auth.users(id) on delete cascade,
  authority text not null check (authority in ('reviewer','administrator')),
  enabled boolean not null default false
);
create table public.discovery_brands (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 160),
  description text check (length(description) <= 2000),
  website text not null,
  categories text[] not null default '{}',
  markets text[] not null default '{}',
  operating_status text not null default 'inactive' check (operating_status in ('inactive','active','suspended','ended')),
  ownership_status text not null default 'unverified' check (ownership_status in ('unverified','pending_review','verified','rejected','expired','suspended','revoked')),
  verified_at timestamptz,
  verified_until timestamptz,
  public_label_allowed boolean not null default false,
  public_permission_ref text,
  evidence_id uuid,
  -- Historical staff authority reference, not a customer-owned record or FK.
  reviewer_id uuid,
  policy_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not public_label_allowed or (public_permission_ref is not null and length(public_permission_ref) between 4 and 256)),
  check (ownership_status <> 'verified' or (verified_at is not null and verified_until is not null and verified_until > verified_at and reviewer_id is not null and evidence_id is not null and policy_version is not null))
);
create table public.discovery_evidence (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.discovery_brands(id) on delete cascade,
  method text not null check (method in ('authorized_attestation','independent_certification')),
  -- Opaque reference into a restricted evidence store, never a document or owner profile.
  provenance_ref text not null check (length(provenance_ref) between 4 and 256),
  submitted_by uuid not null,
  authorized_submission boolean not null default false,
  corroboration_ref text check (length(corroboration_ref) between 4 and 256),
  expires_at timestamptz not null,
  retain_until timestamptz not null,
  created_at timestamptz not null default now(),
  check (retain_until >= expires_at)
);
alter table public.discovery_brands add foreign key (evidence_id) references public.discovery_evidence(id) on delete set null;

create table public.discovery_merchants (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.discovery_brands(id) on delete cascade,
  sandbox_only boolean not null default false,
  legal_identity_ref text,
  identity_verified_at timestamptz,
  identity_expires_at timestamptz,
  status text not null default 'inactive' check (status in ('inactive','active','paused','ended')),
  catalog_status text not null default 'pending' check (catalog_status in ('pending','testing','approved','paused','rejected')),
  approved_domains text[] not null default '{}',
  image_domains text[] not null default '{}',
  markets text[] not null default '{}',
  source_kind text check (source_kind in ('authorized_json','shopify_storefront')),
  source_authorization_ref text,
  source_authorized_until timestamptz,
  credential_ref text,
  -- Only an opaque server-side credential reference is stored, never a token.
  checkout_capabilities text[] not null default array['product_destination'],
  updated_at timestamptz not null default now(),
  unique (id, brand_id),
  check (status <> 'active' or (identity_verified_at is not null and identity_expires_at is not null and identity_expires_at > identity_verified_at and legal_identity_ref is not null and catalog_status = 'approved' and source_kind is not null and source_authorization_ref is not null and source_authorized_until is not null and cardinality(approved_domains) > 0 and cardinality(image_domains) > 0))
);
create table public.discovery_partnerships (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.discovery_merchants(id) on delete cascade,
  brand_id uuid not null references public.discovery_brands(id) on delete cascade,
  status text not null default 'prospect' check (status in ('prospect','contacted','evaluating','onboarding','active','paused','ended')),
  model text not null default 'organic' check (model in ('organic','inventory','affiliate','co_marketing','merchant_offer','sponsored')),
  contact_ref text, terms_ref text, contract_status text not null default 'none' check (contract_status in ('none','review','signed','expired','terminated')),
  effective_from timestamptz, effective_until timestamptz,
  approved_markets text[] not null default '{}',
  attribution_ref text, internal_notes text check (length(internal_notes) <= 2000),
  updated_at timestamptz not null default now(),
  foreign key (merchant_id,brand_id) references public.discovery_merchants(id,brand_id),
  unique(id,merchant_id),
  check (status <> 'active' or (contract_status = 'signed' and terms_ref is not null and effective_from is not null and effective_until is not null and effective_until > effective_from))
);
create table public.discovery_campaigns (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.discovery_partnerships(id) on delete cascade,
  merchant_id uuid not null references public.discovery_merchants(id) on delete cascade,
  approval_state text not null default 'draft' check (approval_state in ('draft','in_review','approved','rejected','paused','ended')),
  active boolean not null default false check (active = false),
  sandbox_only boolean not null default false,
  -- Approval can be certified in a sandbox; live activation requires a migration.
  product_ids uuid[] not null default '{}', categories text[] not null default '{}', markets text[] not null default '{}',
  starts_at timestamptz, ends_at timestamptz,
  placement_type text not null default 'separate_featured' check (placement_type = 'separate_featured'),
  budget_ref text, terms_ref text, attribution_ref text,
  disclosure_status text not null default 'unreviewed' check (disclosure_status in ('unreviewed','reviewed','rejected')),
  disclosure_text text,
  foreign key(partner_id,merchant_id) references public.discovery_partnerships(id,merchant_id),
  check (ends_at is null or ends_at > starts_at)
);
create table public.discovery_prospects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 160),
  website text,
  brand_id uuid references public.discovery_brands(id) on delete set null,
  merchant_id uuid references public.discovery_merchants(id) on delete set null,
  status text not null default 'prospect' check (status in ('prospect','contacted','evaluating','onboarding','active','paused','ended')),
  contact_ref text check (length(contact_ref) <= 256),
  contact_channel text check (contact_channel in ('email','phone','social','referral','other')),
  first_contact_at timestamptz, last_contact_at timestamptz, next_followup_at timestamptz,
  outreach_notes text check (length(outreach_notes) <= 2000),
  intake_checklist jsonb not null default '{}' check (jsonb_typeof(intake_checklist)='object' and octet_length(intake_checklist::text)<=4000),
  updated_at timestamptz not null default now()
);
create table public.discovery_products (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  brand_id uuid not null,
  sandbox_only boolean not null default false,
  source_product_id text not null check (length(source_product_id) between 1 and 160),
  variant_id text not null default '' check (length(variant_id) <= 160),
  sku text check (length(sku) <= 160),
  title text not null check (length(title) between 4 and 240),
  category text not null check (category in ('outerwear','blazer','dress','pants','top','footwear','bag','accessory')),
  subtype text check (length(subtype) <= 160),
  attributes jsonb not null default '{}' check (jsonb_typeof(attributes) = 'object' and octet_length(attributes::text) <= 4000),
  image_url text,
  product_url text not null,
  price_amount numeric(14,4) check (price_amount > 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  availability text not null default 'unknown' check (availability in ('in_stock','out_of_stock','unknown')),
  sizes text[] not null default '{}', markets text[] not null default '{}',
  source_provenance_ref text not null check (length(source_provenance_ref) between 4 and 256),
  validation_state text not null default 'pending' check (validation_state in ('pending','valid','rejected','withdrawn')),
  synced_at timestamptz not null default now(), expires_at timestamptz not null,
  foreign key (merchant_id,brand_id) references public.discovery_merchants(id,brand_id) on delete cascade,
  unique (merchant_id,source_product_id,variant_id),
  check (expires_at > synced_at and expires_at <= synced_at + interval '24 hours')
);
create unique index discovery_sku_unique on public.discovery_products(merchant_id,sku) where sku is not null and sku <> '';
create index discovery_candidate_lookup on public.discovery_products(category, subtype, expires_at) where validation_state = 'valid' and availability = 'in_stock';
create index discovery_product_brand on public.discovery_products(brand_id);
create table public.discovery_sync_runs (
  id uuid primary key default gen_random_uuid(), merchant_id uuid not null references public.discovery_merchants(id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 8 and 160),
  payload_hash text not null default '',
  status text not null check (status in ('running','succeeded','failed')),
  product_count int not null default 0 check (product_count between 0 and 500),
  error_code text check (error_code in ('source_unavailable','invalid_feed','quota_exceeded')),
  attempt_count int not null default 1 check (attempt_count between 1 and 3),
  retry_after timestamptz,
  created_at timestamptz not null default now(),
  unique (merchant_id,idempotency_key)
);
create index discovery_sync_quota on public.discovery_sync_runs(merchant_id,created_at);
create table public.discovery_audit (
  id bigint generated always as identity primary key,
  actor_id uuid, entity_type text not null, entity_id uuid not null,
  action text not null, from_state text, to_state text,
  created_at timestamptz not null default now()
);
create table public.discovery_catalog_revision (singleton boolean primary key default true check (singleton), revision bigint not null default 0);
insert into public.discovery_catalog_revision values (true,0);
-- DB-owner-controlled environment guard. A fresh database assumes production;
-- service credentials cannot turn it into a sandbox. No fixture seed is included.
create table public.discovery_runtime_guard (singleton boolean primary key default true check(singleton), environment text not null default 'production' check(environment in ('production','staging','test','development')));
insert into public.discovery_runtime_guard values(true,'production');
alter table public.discovery_runtime_guard enable row level security;
revoke all on public.discovery_runtime_guard from public,anon,authenticated,service_role;
grant select on public.discovery_runtime_guard to service_role;
create policy service_read on public.discovery_runtime_guard for select to service_role using(true);
create table public.discovery_request_limits (
  actor_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null default now(), requests int not null default 0
);

-- Public customers have no raw-table access, including through default grants.
do $$ declare t text; begin
  foreach t in array array['discovery_reviewers','discovery_brands','discovery_evidence','discovery_merchants','discovery_partnerships','discovery_campaigns','discovery_prospects','discovery_products','discovery_sync_runs','discovery_audit','discovery_catalog_revision','discovery_request_limits'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant select, insert, update, delete on public.%I to service_role',t);
    execute format('create policy service_only on public.%I for all to service_role using (true) with check (true)',t);
  end loop;
end $$;
revoke update,delete on public.discovery_audit from service_role;
grant usage,select on sequence public.discovery_audit_id_seq to service_role;
revoke all on sequence public.discovery_audit_id_seq from public,anon,authenticated;

create function public.discovery_guard_sandbox_data() returns trigger
language plpgsql security invoker set search_path='' as $$ declare merchant_sandbox boolean; begin
  if tg_op='UPDATE' and new.sandbox_only is distinct from old.sandbox_only then raise exception 'fixture mode is immutable'; end if;
  if tg_table_name in ('discovery_products','discovery_campaigns') then
    select sandbox_only into merchant_sandbox from public.discovery_merchants where id=new.merchant_id;
    if new.sandbox_only is distinct from merchant_sandbox then raise exception 'catalog/campaign fixture mode must match merchant'; end if;
  end if;
  if new.sandbox_only and not exists(select 1 from public.discovery_runtime_guard where singleton and environment in ('staging','test','development')) then
    raise exception 'fixture data forbidden in production' using errcode='42501';
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['discovery_merchants','discovery_campaigns','discovery_products'] loop
    execute format('create trigger discovery_sandbox_data before insert or update on public.%I for each row execute function public.discovery_guard_sandbox_data()',t);
  end loop;
end $$;

create function public.discovery_safe_url(p_url text, p_domains text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(length(p_url) <= 2048
    and p_url ~ '^https://[a-z0-9.-]+(/|$)'
    and split_part(split_part(p_url,'/',3),':',1) = any(p_domains)
    and p_url !~ '[[:space:]\\@]'
    and p_url !~* 'https://([0-9.]+|localhost|[^/]+\.(local|internal|test|invalid))(/|$)'
    and p_url !~* '(^|[?&])(redirect|redirect_uri|redirect_url|return|returnto|return_url|next|url|target|destination|continue)='
    and p_url !~* '/(redirect|out|go|login|account|checkout|cart)(/|[?#]|$)', false)
$$;

create function public.discovery_touch_revision() returns trigger
language plpgsql security invoker set search_path = '' as $$ begin
  update public.discovery_catalog_revision set revision = revision + 1 where singleton;
  return null;
end $$;
do $$ declare t text; begin
  foreach t in array array['discovery_brands','discovery_merchants','discovery_products'] loop
    execute format('create trigger discovery_revision after insert or update or delete on public.%I for each statement execute function public.discovery_touch_revision()',t);
  end loop;
end $$;

create function public.discovery_audit_change() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare actor uuid; old_state text; new_state text;
begin
  actor := nullif(current_setting('discovery.actor_id',true),'')::uuid;
  if actor is null or not exists(select 1 from public.discovery_reviewers where actor_id = actor and enabled) then
    raise exception 'review authority required' using errcode = '42501';
  end if;
  old_state := case when tg_op = 'INSERT' then null else coalesce(to_jsonb(old)->>'ownership_status',to_jsonb(old)->>'status',to_jsonb(old)->>'approval_state') end;
  new_state := coalesce(to_jsonb(new)->>'ownership_status',to_jsonb(new)->>'status',to_jsonb(new)->>'approval_state');
  insert into public.discovery_audit(actor_id,entity_type,entity_id,action,from_state,to_state) values(actor,tg_table_name,new.id,tg_op,old_state,new_state);
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['discovery_brands','discovery_merchants','discovery_partnerships','discovery_campaigns','discovery_prospects'] loop
    execute format('create trigger discovery_audit after insert or update on public.%I for each row execute function public.discovery_audit_change()',t);
  end loop;
end $$;

create function public.discovery_guard_verification() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.ownership_status = 'verified' then
    if not exists(select 1 from public.discovery_evidence e
      join public.discovery_reviewers r on r.actor_id = new.reviewer_id and r.enabled
      where e.id = new.evidence_id and e.brand_id = new.id and e.authorized_submission
        and e.submitted_by <> new.reviewer_id and e.expires_at >= new.verified_until
        and e.expires_at > now() and e.retain_until >= e.expires_at
        and (e.method = 'independent_certification' or e.corroboration_ref is not null)) then
      raise exception 'reviewable authorized evidence required' using errcode = '23514';
    end if;
    if new.policy_version is distinct from 'kscan-ownership-review-v1-draft' or new.verified_until is null or new.verified_until <= now() or new.verified_until > now() + interval '365 days' then
      raise exception 'unsupported review policy or verification expiry' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger discovery_verification before insert or update on public.discovery_brands for each row execute function public.discovery_guard_verification();

-- Service-only administration: actor is looked up in a protected authority table,
-- never inferred from a client JWT's user_metadata. Bootstrap reviewers separately.
create function public.discovery_manage(p_actor uuid,p_action text,p_data jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare authority text; entity uuid; b public.discovery_brands; m public.discovery_merchants; previous text;
begin
  select r.authority into authority from public.discovery_reviewers r where actor_id = p_actor and enabled;
  if authority is null then raise exception 'administrative authority required' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 12000 then raise exception 'invalid management payload'; end if;
  if p_action <> 'review_ownership' and authority <> 'administrator' then raise exception 'administrator required' using errcode = '42501'; end if;
  perform set_config('discovery.actor_id',p_actor::text,true);
  entity := coalesce((p_data->>'id')::uuid,gen_random_uuid());
  if p_action = 'prospect' then
    select status into previous from public.discovery_prospects where id=entity for update;
    if not public.discovery_valid_pipeline_transition(previous,coalesce(p_data->>'status','prospect')) then raise exception 'invalid prospect transition'; end if;
    insert into public.discovery_prospects(id,name,website,brand_id,merchant_id,status,contact_ref,contact_channel,first_contact_at,last_contact_at,next_followup_at,outreach_notes,intake_checklist)
      values(entity,p_data->>'name',p_data->>'website',(p_data->>'brand_id')::uuid,(p_data->>'merchant_id')::uuid,coalesce(p_data->>'status','prospect'),p_data->>'contact_ref',p_data->>'contact_channel',(p_data->>'first_contact_at')::timestamptz,(p_data->>'last_contact_at')::timestamptz,(p_data->>'next_followup_at')::timestamptz,p_data->>'outreach_notes',coalesce(p_data->'intake_checklist','{}'))
      on conflict(id) do update set name=excluded.name,website=excluded.website,brand_id=excluded.brand_id,merchant_id=excluded.merchant_id,status=excluded.status,contact_ref=excluded.contact_ref,contact_channel=excluded.contact_channel,first_contact_at=excluded.first_contact_at,last_contact_at=excluded.last_contact_at,next_followup_at=excluded.next_followup_at,outreach_notes=excluded.outreach_notes,intake_checklist=excluded.intake_checklist,updated_at=now();
  elsif p_action = 'campaign' then
    insert into public.discovery_campaigns(id,partner_id,merchant_id,sandbox_only,approval_state,product_ids,categories,markets,starts_at,ends_at,budget_ref,terms_ref,attribution_ref,disclosure_status,disclosure_text)
      values(entity,(p_data->>'partner_id')::uuid,(p_data->>'merchant_id')::uuid,coalesce((p_data->>'sandbox_only')::boolean,false),coalesce(p_data->>'approval_state','draft'),array(select jsonb_array_elements_text(coalesce(p_data->'product_ids','[]')))::uuid[],array(select jsonb_array_elements_text(coalesce(p_data->'categories','[]'))),array(select jsonb_array_elements_text(coalesce(p_data->'markets','[]'))),(p_data->>'starts_at')::timestamptz,(p_data->>'ends_at')::timestamptz,p_data->>'budget_ref',p_data->>'terms_ref',p_data->>'attribution_ref',coalesce(p_data->>'disclosure_status','unreviewed'),p_data->>'disclosure_text')
      on conflict(id) do update set approval_state=excluded.approval_state,product_ids=excluded.product_ids,categories=excluded.categories,markets=excluded.markets,starts_at=excluded.starts_at,ends_at=excluded.ends_at,budget_ref=excluded.budget_ref,terms_ref=excluded.terms_ref,attribution_ref=excluded.attribution_ref,disclosure_status=excluded.disclosure_status,disclosure_text=excluded.disclosure_text;
  elsif p_action = 'register_brand' then
    if not public.discovery_safe_url(p_data->>'website',array[split_part(p_data->>'website','/',3)]) then raise exception 'invalid official website'; end if;
    insert into public.discovery_brands(id,name,website,description,categories,markets) values(entity,p_data->>'name',p_data->>'website',p_data->>'description',array(select jsonb_array_elements_text(coalesce(p_data->'categories','[]'))),array(select jsonb_array_elements_text(coalesce(p_data->'markets','[]'))));
  elsif p_action = 'submit_evidence' then
    insert into public.discovery_evidence(id,brand_id,method,provenance_ref,submitted_by,authorized_submission,corroboration_ref,expires_at,retain_until)
      values(entity,(p_data->>'brand_id')::uuid,p_data->>'method',p_data->>'provenance_ref',p_actor,coalesce((p_data->>'authorized_submission')::boolean,false),p_data->>'corroboration_ref',(p_data->>'expires_at')::timestamptz,(p_data->>'retain_until')::timestamptz);
    insert into public.discovery_audit(actor_id,entity_type,entity_id,action) values(p_actor,'discovery_evidence',entity,'submitted');
  elsif p_action = 'request_review' then
    update public.discovery_brands set ownership_status = 'pending_review',updated_at=now() where id=entity and ownership_status in ('unverified','rejected','expired','suspended','revoked');
    if not found then raise exception 'invalid ownership transition'; end if;
  elsif p_action = 'review_ownership' then
    select * into strict b from public.discovery_brands where id=entity for update;
    if p_data->>'status' not in ('verified','rejected','expired','suspended','revoked') or (p_data->>'status' in ('verified','rejected') and b.ownership_status <> 'pending_review') then raise exception 'invalid review transition'; end if;
    update public.discovery_brands set ownership_status=p_data->>'status',reviewer_id=p_actor,evidence_id=(p_data->>'evidence_id')::uuid,
      verified_at=case when p_data->>'status'='verified' then now() else verified_at end,
      verified_until=case when p_data->>'status'='verified' then (p_data->>'verified_until')::timestamptz else verified_until end,
      policy_version=case when p_data->>'status'='verified' then p_data->>'policy_version' else policy_version end,updated_at=now() where id=entity;
  elsif p_action = 'brand_visibility' then
    update public.discovery_brands set public_label_allowed=coalesce((p_data->>'public_label_allowed')::boolean,false),public_permission_ref=p_data->>'public_permission_ref',
      operating_status=coalesce(p_data->>'operating_status',operating_status),updated_at=now() where id=entity;
    if not found then raise exception 'brand not found'; end if;
  elsif p_action = 'merchant' then
    select * into m from public.discovery_merchants where id=entity for update;
    if m.id is not null and m.brand_id <> (p_data->>'brand_id')::uuid then raise exception 'immutable merchant brand'; end if;
    insert into public.discovery_merchants(id,brand_id,sandbox_only,legal_identity_ref,identity_verified_at,identity_expires_at,status,catalog_status,approved_domains,image_domains,markets,source_kind,source_authorization_ref,source_authorized_until,credential_ref)
      values(entity,(p_data->>'brand_id')::uuid,coalesce((p_data->>'sandbox_only')::boolean,false),p_data->>'legal_identity_ref',(p_data->>'identity_verified_at')::timestamptz,(p_data->>'identity_expires_at')::timestamptz,coalesce(p_data->>'status','inactive'),coalesce(p_data->>'catalog_status','pending'),array(select jsonb_array_elements_text(coalesce(p_data->'approved_domains','[]'))),array(select jsonb_array_elements_text(coalesce(p_data->'image_domains','[]'))),array(select jsonb_array_elements_text(coalesce(p_data->'markets','[]'))),p_data->>'source_kind',p_data->>'source_authorization_ref',(p_data->>'source_authorized_until')::timestamptz,p_data->>'credential_ref')
      on conflict(id) do update set legal_identity_ref=excluded.legal_identity_ref,identity_verified_at=excluded.identity_verified_at,identity_expires_at=excluded.identity_expires_at,status=excluded.status,catalog_status=excluded.catalog_status,approved_domains=excluded.approved_domains,image_domains=excluded.image_domains,markets=excluded.markets,source_kind=excluded.source_kind,source_authorization_ref=excluded.source_authorization_ref,source_authorized_until=excluded.source_authorized_until,credential_ref=excluded.credential_ref,updated_at=now();
  elsif p_action = 'partnership' then
    select status into previous from public.discovery_partnerships where id=entity for update;
    if previous is null and coalesce(p_data->>'status','prospect') <> 'prospect' then raise exception 'partnership must start as prospect'; end if;
    if previous is not null and previous <> p_data->>'status' and not (
      (previous='prospect' and p_data->>'status' in ('contacted','ended')) or
      (previous='contacted' and p_data->>'status' in ('evaluating','ended')) or
      (previous='evaluating' and p_data->>'status' in ('onboarding','paused','ended')) or
      (previous='onboarding' and p_data->>'status' in ('active','paused','ended')) or
      (previous='active' and p_data->>'status' in ('paused','ended')) or
      (previous='paused' and p_data->>'status' in ('evaluating','onboarding','active','ended'))) then raise exception 'invalid partnership transition'; end if;
    insert into public.discovery_partnerships(id,merchant_id,brand_id,status,model,contact_ref,terms_ref,contract_status,effective_from,effective_until,approved_markets,attribution_ref,internal_notes)
      values(entity,(p_data->>'merchant_id')::uuid,(p_data->>'brand_id')::uuid,coalesce(p_data->>'status','prospect'),coalesce(p_data->>'model','organic'),p_data->>'contact_ref',p_data->>'terms_ref',coalesce(p_data->>'contract_status','none'),(p_data->>'effective_from')::timestamptz,(p_data->>'effective_until')::timestamptz,array(select jsonb_array_elements_text(coalesce(p_data->'approved_markets','[]'))),p_data->>'attribution_ref',p_data->>'internal_notes')
      on conflict(id) do update set status=excluded.status,model=excluded.model,contact_ref=excluded.contact_ref,terms_ref=excluded.terms_ref,contract_status=excluded.contract_status,effective_from=excluded.effective_from,effective_until=excluded.effective_until,approved_markets=excluded.approved_markets,attribution_ref=excluded.attribution_ref,internal_notes=excluded.internal_notes,updated_at=now();
  elsif p_action = 'withdraw_product' then
    update public.discovery_products set validation_state='withdrawn',availability='out_of_stock' where id=entity;
    if not found then raise exception 'product not found'; end if;
    insert into public.discovery_audit(actor_id,entity_type,entity_id,action) values(p_actor,'discovery_products',entity,'withdrawn');
  else raise exception 'unsupported management action'; end if;
  return entity;
end $$;

create function public.discovery_begin_sync(p_merchant uuid,p_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m public.discovery_merchants; prior public.discovery_sync_runs;
begin
  select * into strict m from public.discovery_merchants where id=p_merchant for update;
  if m.status <> 'active' or m.catalog_status <> 'approved' or m.identity_expires_at <= now() or m.source_authorized_until <= now() then raise exception 'merchant not authorized' using errcode='42501'; end if;
  select * into prior from public.discovery_sync_runs where merchant_id=p_merchant and idempotency_key=p_key;
  if prior.status='succeeded' then return jsonb_build_object('status','succeeded','productCount',prior.product_count); end if;
  if prior.id is not null then
    if prior.attempt_count>=3 or (prior.status='running' and prior.created_at>now()-interval '1 minute') or prior.retry_after>now() then raise exception 'retry not permitted'; end if;
    update public.discovery_sync_runs set status='running',attempt_count=attempt_count+1,created_at=now(),retry_after=null where id=prior.id;
  else
    if (select count(*) from public.discovery_sync_runs where merchant_id=p_merchant and created_at>now()-interval '1 hour')>=5 then raise exception 'sync quota exceeded'; end if;
    insert into public.discovery_sync_runs(merchant_id,idempotency_key,status) values(p_merchant,p_key,'running');
  end if;
  return jsonb_build_object('status','running','productCount',0);
end $$;
create function public.discovery_sync_failed(p_merchant uuid,p_key text,p_code text) returns void
language plpgsql security invoker set search_path='' as $$ begin
  update public.discovery_sync_runs set status='failed',error_code=p_code,retry_after=now()+interval '1 minute' where merchant_id=p_merchant and idempotency_key=p_key and status='running';
end $$;

create function public.discovery_ingest(p_merchant uuid,p_key text,p_products jsonb,p_complete boolean default false) returns int
language plpgsql security invoker set search_path = '' as $$
declare m public.discovery_merchants; prior public.discovery_sync_runs; n int; hash text; p jsonb; ids uuid[] := '{}'; inserted_id uuid;
begin
  select * into strict m from public.discovery_merchants where id=p_merchant for update;
  if m.status <> 'active' or m.catalog_status <> 'approved' or m.identity_expires_at <= now() or m.source_authorized_until <= now() then raise exception 'merchant not authorized' using errcode='42501'; end if;
  if jsonb_typeof(p_products) <> 'array' or jsonb_array_length(p_products) > 500 or octet_length(p_products::text) > 2000000 then raise exception 'feed limit exceeded'; end if;
  hash := md5(p_products::text || p_complete::text);
  select * into prior from public.discovery_sync_runs where merchant_id=p_merchant and idempotency_key=p_key;
  if prior.id is null then raise exception 'sync reservation required'; end if;
  if prior.payload_hash <> '' then
    if prior.payload_hash <> hash then raise exception 'idempotency key reused with different payload'; end if;
    if prior.status='succeeded' then return prior.product_count; end if;
  end if;
  if prior.status <> 'running' then raise exception 'sync not running'; end if;
  for p in select value from jsonb_array_elements(p_products) loop
    if not public.discovery_safe_url(p->>'product_url',m.approved_domains) or (p->>'image_url' is not null and not public.discovery_safe_url(p->>'image_url',m.image_domains)) then raise exception 'unsafe catalog destination'; end if;
    if not array(select jsonb_array_elements_text(p->'markets')) <@ m.markets then raise exception 'unapproved market'; end if;
    insert into public.discovery_products(merchant_id,brand_id,sandbox_only,source_product_id,variant_id,sku,title,category,subtype,attributes,image_url,product_url,price_amount,currency,availability,sizes,markets,source_provenance_ref,validation_state,synced_at,expires_at)
      values(m.id,m.brand_id,m.sandbox_only,p->>'source_product_id',coalesce(p->>'variant_id',''),nullif(p->>'sku',''),p->>'title',p->>'category',p->>'subtype',coalesce(p->'attributes','{}'),p->>'image_url',p->>'product_url',(p->>'price_amount')::numeric,p->>'currency',coalesce(p->>'availability','unknown'),array(select jsonb_array_elements_text(coalesce(p->'sizes','[]'))),array(select jsonb_array_elements_text(coalesce(p->'markets','[]'))),p->>'source_provenance_ref','valid',now(),now()+interval '24 hours')
      on conflict(merchant_id,source_product_id,variant_id) do update set sku=excluded.sku,title=excluded.title,category=excluded.category,subtype=excluded.subtype,attributes=excluded.attributes,image_url=excluded.image_url,product_url=excluded.product_url,price_amount=excluded.price_amount,currency=excluded.currency,availability=excluded.availability,sizes=excluded.sizes,markets=excluded.markets,source_provenance_ref=excluded.source_provenance_ref,validation_state='valid',synced_at=excluded.synced_at,expires_at=excluded.expires_at returning id into inserted_id;
    ids := array_append(ids,inserted_id);
  end loop;
  if p_complete then update public.discovery_products set validation_state='withdrawn',availability='out_of_stock' where merchant_id=m.id and not(id=any(ids)) and validation_state <> 'withdrawn'; end if;
  n := jsonb_array_length(p_products);
  update public.discovery_sync_runs set payload_hash=hash,status='succeeded',product_count=n,error_code=null,retry_after=null where id=prior.id;
  return n;
end $$;

-- Fail-closed eligibility evaluated at query time. Partnership and campaign
-- tables are intentionally absent from all organic retrieval joins.
create view public.discovery_eligible_inventory with (security_invoker=true) as
select p.*,b.name as brand_name,b.verified_until,m.approved_domains,m.image_domains,
  least(b.verified_until,m.identity_expires_at,m.source_authorized_until,p.expires_at) as eligible_until
from public.discovery_products p join public.discovery_brands b on b.id=p.brand_id
join public.discovery_merchants m on m.id=p.merchant_id and m.brand_id=b.id
where b.operating_status='active' and b.ownership_status='verified' and b.verified_until>now() and b.public_label_allowed
  and m.status='active' and m.catalog_status='approved' and m.identity_expires_at>now() and m.source_authorized_until>now()
  and p.markets <@ m.markets
  and p.validation_state='valid' and p.availability='in_stock' and p.expires_at>now()
  and p.synced_at<=now() and p.synced_at>now()-interval '24 hours'
  and public.discovery_safe_url(p.product_url,m.approved_domains) and public.discovery_safe_url(p.image_url,m.image_domains);
revoke all on public.discovery_eligible_inventory from public,anon,authenticated;
grant select on public.discovery_eligible_inventory to service_role;
create view public.discovery_eligible_products with (security_invoker=true) as select * from public.discovery_eligible_inventory where not sandbox_only;
revoke all on public.discovery_eligible_products from public,anon,authenticated;
grant select on public.discovery_eligible_products to service_role;

create function public.discovery_candidates(p_category text,p_subtype text,p_market text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('revision',(select revision from public.discovery_catalog_revision where singleton),'rows',coalesce((
    select jsonb_agg(to_jsonb(c) - array['sku','source_provenance_ref','validation_state']) from (
      select * from public.discovery_eligible_products where category=p_category and lower(subtype)=lower(p_subtype) and p_market=any(markets)
      order by synced_at desc,id limit 160
    ) c),'[]'::jsonb),'ownership','{}'::jsonb)
$$;
create function public.discovery_valid_pipeline_transition(p_previous text,p_next text) returns boolean
language sql immutable set search_path='' as $$ select case
  when p_previous is null then p_next='prospect'
  when p_previous=p_next then true
  when p_previous='prospect' then p_next in ('contacted','ended')
  when p_previous='contacted' then p_next in ('evaluating','ended')
  when p_previous='evaluating' then p_next in ('onboarding','paused','ended')
  when p_previous='onboarding' then p_next in ('active','paused','ended')
  when p_previous='active' then p_next in ('paused','ended')
  when p_previous='paused' then p_next in ('evaluating','onboarding','active','ended')
  else false end $$;
create function public.discovery_staff_authority(p_actor uuid) returns boolean
language sql stable security invoker set search_path='' as $$ select exists(select 1 from public.discovery_reviewers where actor_id=p_actor and enabled) $$;
create function public.discovery_sponsorship_snapshot(p_category text,p_subtype text,p_market text,p_sandbox boolean default false) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(r)) from(select * from public.discovery_eligible_inventory where sandbox_only=p_sandbox and category=p_category and lower(subtype)=lower(p_subtype) and p_market=any(markets) order by id limit 160)r),'[]'::jsonb),
    'campaigns',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'partnerId',c.partner_id,'merchantId',c.merchant_id,'state',c.approval_state,'productIds',c.product_ids,'categories',c.categories,'markets',c.markets,'startsAt',c.starts_at,'endsAt',c.ends_at,'disclosureApproved',c.disclosure_status='reviewed','disclosureText',c.disclosure_text)) from (select * from public.discovery_campaigns where sandbox_only=p_sandbox order by id limit 20)c),'[]'::jsonb),
    'partners',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'merchantId',p.merchant_id,'status',p.status,'contractStatus',p.contract_status,'agreementRef',p.terms_ref,'effectiveFrom',p.effective_from,'effectiveUntil',p.effective_until)) from public.discovery_partnerships p where p.id in(select partner_id from public.discovery_campaigns where sandbox_only=p_sandbox order by id limit 20)),'[]'::jsonb))
$$;
create function public.discovery_primary_ownership(p_products jsonb) returns jsonb
language sql stable security invoker set search_path='' as $$
  -- Only exact, authorized catalog URL identities can label primary cards;
  -- a shared retailer host or guessed brand name is never sufficient.
  select coalesce(jsonb_object_agg(x.id,jsonb_build_object('brandId',x.brand_id,'brandName',x.brand_name,'ownershipVerificationStatus','verified','publicOwnershipLabelAllowed',true,'verifiedUntil',x.verified_until)),'{}'::jsonb)
  from (select distinct on (q->>'id') q->>'id' as id,p.brand_id,p.brand_name,p.verified_until
    from jsonb_array_elements(p_products) q join public.discovery_eligible_products p on p.product_url=split_part(q->>'productUrl','#',1)
    order by q->>'id',p.id) x
$$;
create function public.discovery_claim_request(p_actor uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n int; begin
  insert into public.discovery_request_limits(actor_id,requests) values(p_actor,1)
    on conflict(actor_id) do update set requests=case when public.discovery_request_limits.window_start<now()-interval '1 minute' then 1 else public.discovery_request_limits.requests+1 end,
      window_start=case when public.discovery_request_limits.window_start<now()-interval '1 minute' then now() else public.discovery_request_limits.window_start end returning requests into n;
  return n<=30;
end $$;

create function public.discovery_cleanup(p_actor uuid) returns void
language plpgsql security invoker set search_path='' as $$ begin
  if not exists(select 1 from public.discovery_reviewers where actor_id=p_actor and enabled and authority='administrator') then raise exception 'administrator required' using errcode='42501'; end if;
  perform set_config('discovery.actor_id',p_actor::text,true);
  update public.discovery_brands set ownership_status='expired',public_label_allowed=false where ownership_status='verified' and verified_until<=now();
  update public.discovery_brands set ownership_status='expired',public_label_allowed=false,evidence_id=null where evidence_id in(select id from public.discovery_evidence where retain_until<now());
  delete from public.discovery_evidence where retain_until<now();
  delete from public.discovery_products where expires_at<now()-interval '30 days';
  delete from public.discovery_sync_runs where created_at<now()-interval '30 days';
  delete from public.discovery_request_limits where window_start<now()-interval '1 day';
  update public.discovery_prospects set contact_ref=null,outreach_notes=null where status='ended' and updated_at<now()-interval '365 days' and (contact_ref is not null or outreach_notes is not null);
end $$;

-- New function EXECUTE is public by default: explicitly close every new routine.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'discovery_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',r.signature);
    execute format('grant execute on function %s to service_role',r.signature);
  end loop;
end $$;
