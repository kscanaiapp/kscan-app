-- Private, tamper-evident account-lifecycle evidence store.
--
-- This migration is intentionally additive. It does not enable the deletion
-- worker, choose a legal retention period, or grant client access. A legal or
-- privacy approver must insert an effective retention policy before evidence
-- generation can begin.

-- ---------------------------------------------------------------------------
-- 1. Private Storage bucket (service-role access only; no object policies)
-- ---------------------------------------------------------------------------

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'account-lifecycle-evidence',
  'account-lifecycle-evidence',
  false,
  52428800,
  array['application/json', 'application/x-ndjson', 'text/csv', 'text/html', 'text/plain']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Deliberately create no storage.objects policy for this bucket. The service
-- role bypasses Storage RLS; anon/authenticated receive no bucket access.

-- ---------------------------------------------------------------------------
-- 2. Reviewer authorization and retention policy
-- ---------------------------------------------------------------------------

create table if not exists public.account_lifecycle_reviewers (
  reviewer_id text primary key,
  display_name text not null,
  capabilities text[] not null default array['view']::text[],
  enabled boolean not null default true,
  valid_until timestamptz,
  approved_by text not null,
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint account_lifecycle_reviewers_id_check
    check (reviewer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  constraint account_lifecycle_reviewers_capabilities_check
    check (
      cardinality(capabilities) > 0
      and capabilities <@ array['view', 'export', 'retention_admin']::text[]
    )
);

create table if not exists public.evidence_retention_policies (
  id uuid primary key default gen_random_uuid(),
  environment text not null,
  evidence_type text not null default 'account_lifecycle',
  retention_days integer not null,
  legal_hold_enabled boolean not null default true,
  policy_version text not null,
  effective_at timestamptz not null,
  retired_at timestamptz,
  approved_by text not null,
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint evidence_retention_environment_check
    check (environment in ('development', 'staging', 'production')),
  constraint evidence_retention_days_check
    check (retention_days between 1 and 3650),
  constraint evidence_retention_policy_version_check
    check (policy_version ~ '^v[1-9][0-9]*$'),
  constraint evidence_retention_effective_range_check
    check (retired_at is null or retired_at > effective_at),
  unique (environment, evidence_type, policy_version)
);

create unique index if not exists evidence_retention_one_active_idx
  on public.evidence_retention_policies (environment, evidence_type)
  where retired_at is null;

-- ---------------------------------------------------------------------------
-- 3. Searchable evidence index (no raw email)
-- ---------------------------------------------------------------------------

create table if not exists public.account_lifecycle_evidence_index (
  id uuid primary key default gen_random_uuid(),
  deletion_request_id uuid not null references public.deletion_requests(id) on delete restrict,
  subject_ref uuid not null,
  subject_user_id uuid,
  normalized_email_hash text not null,
  environment text not null,
  request_date timestamptz not null,
  lifecycle_state text not null,
  evidence_bundle_path text not null,
  evidence_version integer not null,
  generation_status text not null default 'generating',
  checksum_status text not null default 'pending',
  checksum_verified_at timestamptz,
  legal_hold boolean not null default false,
  legal_hold_at timestamptz,
  legal_hold_reason text,
  legal_hold_by text,
  retention_policy_id uuid not null references public.evidence_retention_policies(id) on delete restrict,
  retention_expires_at timestamptz not null,
  finalized_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_lifecycle_evidence_email_hash_check
    check (normalized_email_hash ~ '^[a-f0-9]{64}$'),
  constraint account_lifecycle_evidence_environment_check
    check (environment in ('development', 'staging', 'production')),
  constraint account_lifecycle_evidence_version_check
    check (evidence_version between 1 and 9999),
  constraint account_lifecycle_evidence_generation_status_check
    check (generation_status in ('generating', 'complete', 'failed', 'deleted')),
  constraint account_lifecycle_evidence_checksum_status_check
    check (checksum_status in ('pending', 'verified', 'failed', 'missing')),
  constraint account_lifecycle_evidence_path_check
    check (
      split_part(evidence_bundle_path, '/', 1) = environment
      and split_part(evidence_bundle_path, '/', 2) = extract(year from request_date at time zone 'UTC')::integer::text
      and split_part(evidence_bundle_path, '/', 3) = lpad(extract(month from request_date at time zone 'UTC')::integer::text, 2, '0')
      and split_part(evidence_bundle_path, '/', 4) = deletion_request_id::text
      and split_part(evidence_bundle_path, '/', 5) = 'v' || evidence_version::text
      and split_part(evidence_bundle_path, '/', 6) = ''
    ),
  constraint account_lifecycle_evidence_hold_fields_check
    check (
      (legal_hold = false and legal_hold_at is null and legal_hold_reason is null and legal_hold_by is null)
      or
      (legal_hold = true and legal_hold_at is not null and legal_hold_reason is not null and legal_hold_by is not null)
    ),
  constraint account_lifecycle_evidence_retention_check
    check (retention_expires_at > created_at),
  unique (deletion_request_id, evidence_version),
  unique (evidence_bundle_path)
);

create index if not exists account_lifecycle_evidence_subject_ref_idx
  on public.account_lifecycle_evidence_index (subject_ref, request_date desc);

create index if not exists account_lifecycle_evidence_email_hash_idx
  on public.account_lifecycle_evidence_index (normalized_email_hash, request_date desc);

create index if not exists account_lifecycle_evidence_state_idx
  on public.account_lifecycle_evidence_index (lifecycle_state, request_date desc);

create index if not exists account_lifecycle_evidence_retention_idx
  on public.account_lifecycle_evidence_index (retention_expires_at)
  where legal_hold = false and deleted_at is null;

create or replace function public.set_account_lifecycle_evidence_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_account_lifecycle_evidence_updated_at
  on public.account_lifecycle_evidence_index;
create trigger trg_account_lifecycle_evidence_updated_at
  before update on public.account_lifecycle_evidence_index
  for each row execute function public.set_account_lifecycle_evidence_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Tamper-evident lifecycle ledger and append-only access ledger
-- ---------------------------------------------------------------------------

create table if not exists public.account_lifecycle_events (
  event_id uuid primary key default gen_random_uuid(),
  chain_sequence bigint generated always as identity unique,
  deletion_request_id uuid not null references public.deletion_requests(id) on delete restrict,
  correlation_id uuid not null,
  subject_user_id uuid,
  previous_event_hash text,
  event_hash text not null,
  occurred_at timestamptz not null,
  event_type text not null,
  source text not null,
  actor_type text not null,
  platform text,
  app_version text,
  function_name text,
  function_version text,
  state_before text,
  state_after text,
  outcome text not null,
  template_version text,
  provider_message_id text,
  evidence_reference text,
  sanitized_metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint account_lifecycle_events_hash_check
    check (event_hash ~ '^[a-f0-9]{64}$'),
  constraint account_lifecycle_events_previous_hash_check
    check (previous_event_hash is null or previous_event_hash ~ '^[a-f0-9]{64}$'),
  constraint account_lifecycle_events_actor_type_check
    check (actor_type in ('user', 'system', 'worker', 'admin', 'scheduler', 'reviewer')),
  constraint account_lifecycle_events_metadata_check
    check (jsonb_typeof(sanitized_metadata) = 'object'),
  unique (deletion_request_id, event_hash),
  unique (idempotency_key)
);

create index if not exists account_lifecycle_events_request_timeline_idx
  on public.account_lifecycle_events (deletion_request_id, occurred_at, event_id);

create table if not exists public.evidence_access_events (
  event_id uuid primary key default gen_random_uuid(),
  evidence_index_id uuid not null references public.account_lifecycle_evidence_index(id) on delete restrict,
  deletion_request_id uuid not null references public.deletion_requests(id) on delete restrict,
  evidence_version integer not null,
  event_type text not null,
  reviewer_identity text not null,
  occurred_at timestamptz not null default now(),
  reason text not null,
  case_number text,
  files_accessed jsonb not null default '[]'::jsonb,
  export_checksum text,
  outcome text not null,
  idempotency_key text not null,
  constraint evidence_access_event_type_check
    check (event_type in (
      'EVIDENCE_BUNDLE_VIEWED',
      'EVIDENCE_BUNDLE_DOWNLOADED',
      'EVIDENCE_EXPORT_CREATED',
      'EVIDENCE_CHECKSUM_FAILED'
    )),
  constraint evidence_access_files_check
    check (jsonb_typeof(files_accessed) = 'array'),
  constraint evidence_access_export_checksum_check
    check (export_checksum is null or export_checksum ~ '^[a-f0-9]{64}$'),
  unique (idempotency_key)
);

create index if not exists evidence_access_events_request_timeline_idx
  on public.evidence_access_events (deletion_request_id, occurred_at, event_id);

create or replace function public.prevent_account_lifecycle_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'account lifecycle evidence events are append-only';
end;
$$;

drop trigger if exists trg_account_lifecycle_events_append_only
  on public.account_lifecycle_events;
create trigger trg_account_lifecycle_events_append_only
  before update or delete on public.account_lifecycle_events
  for each row execute function public.prevent_account_lifecycle_event_mutation();

drop trigger if exists trg_evidence_access_events_append_only
  on public.evidence_access_events;
create trigger trg_evidence_access_events_append_only
  before update or delete on public.evidence_access_events
  for each row execute function public.prevent_account_lifecycle_event_mutation();

-- ---------------------------------------------------------------------------
-- 5. Sanitization and append APIs
-- ---------------------------------------------------------------------------

create or replace function public.sanitize_account_lifecycle_text(p_value text)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select left(
    regexp_replace(
      regexp_replace(
        coalesce(p_value, ''),
        '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
        '[redacted-email]',
        'gi'
      ),
      '(Bearer[[:space:]]+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}',
      '[redacted-token]',
      'gi'
    ),
    1000
  );
$$;

create or replace function public.sanitize_account_lifecycle_json(p_value jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public
as $$
declare
  v_result jsonb;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select coalesce(jsonb_object_agg(entry.key, public.sanitize_account_lifecycle_json(entry.value)), '{}'::jsonb)
      into v_result
      from jsonb_each(p_value) as entry
      where entry.key !~* '(^email$|(^|_)(password|jwt|token|access_token|refresh_token|restoration_token|provider_token|service_role|authorization|raw_email|email_body|raw_content|image|conversation|prompt|message_content)(_|$))';
      return v_result;
    when 'array' then
      select coalesce(
        jsonb_agg(public.sanitize_account_lifecycle_json(item.value) order by item.ordinality),
        '[]'::jsonb
      )
      into v_result
      from jsonb_array_elements(p_value) with ordinality as item(value, ordinality);
      return v_result;
    when 'string' then
      return to_jsonb(public.sanitize_account_lifecycle_text(p_value #>> '{}'));
    else
      return p_value;
  end case;
end;
$$;

create or replace function public.sanitize_account_lifecycle_metadata(p_metadata jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public
as $$
declare
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
begin
  if jsonb_typeof(v_metadata) is distinct from 'object' then
    raise exception 'sanitized metadata must be a JSON object';
  end if;
  return public.sanitize_account_lifecycle_json(v_metadata);
end;
$$;

create or replace function public.append_account_lifecycle_event(
  p_deletion_request_id uuid,
  p_correlation_id uuid,
  p_event_type text,
  p_source text,
  p_actor_type text,
  p_outcome text,
  p_idempotency_key text,
  p_subject_user_id uuid default null,
  p_platform text default null,
  p_app_version text default null,
  p_function_name text default null,
  p_function_version text default null,
  p_state_before text default null,
  p_state_after text default null,
  p_template_version text default null,
  p_provider_message_id text default null,
  p_evidence_reference text default null,
  p_sanitized_metadata jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_event_id uuid := gen_random_uuid();
  v_previous_hash text;
  v_event_hash text;
  v_occurred_at timestamptz := coalesce(p_occurred_at, clock_timestamp());
  v_metadata jsonb := public.sanitize_account_lifecycle_metadata(p_sanitized_metadata);
  v_canonical jsonb;
begin
  if p_deletion_request_id is null or p_correlation_id is null then
    raise exception 'deletion_request_id and correlation_id are required';
  end if;
  if nullif(trim(p_event_type), '') is null
     or nullif(trim(p_source), '') is null
     or nullif(trim(p_outcome), '') is null
     or nullif(trim(p_idempotency_key), '') is null then
    raise exception 'event_type, source, outcome, and idempotency_key are required';
  end if;

  -- Serialize appends per deletion request so the previous hash is stable.
  perform pg_advisory_xact_lock(hashtextextended(p_deletion_request_id::text, 0));

  select event_hash into v_previous_hash
  from public.account_lifecycle_events
  where deletion_request_id = p_deletion_request_id
  order by chain_sequence desc
  limit 1;

  v_canonical := jsonb_build_object(
    'event_id', v_event_id,
    'deletion_request_id', p_deletion_request_id,
    'correlation_id', p_correlation_id,
    'subject_user_id', p_subject_user_id,
    'previous_event_hash', v_previous_hash,
    'occurred_at', v_occurred_at,
    'event_type', trim(p_event_type),
    'source', trim(p_source),
    'actor_type', p_actor_type,
    'platform', p_platform,
    'app_version', p_app_version,
    'function_name', p_function_name,
    'function_version', p_function_version,
    'state_before', p_state_before,
    'state_after', p_state_after,
    'outcome', trim(p_outcome),
    'template_version', p_template_version,
    'provider_message_id', p_provider_message_id,
    'evidence_reference', p_evidence_reference,
    'sanitized_metadata', v_metadata,
    'idempotency_key', trim(p_idempotency_key)
  );

  v_event_hash := encode(
    extensions.digest(coalesce(v_previous_hash, '') || v_canonical::text, 'sha256'),
    'hex'
  );

  insert into public.account_lifecycle_events (
    event_id,
    deletion_request_id,
    correlation_id,
    subject_user_id,
    previous_event_hash,
    event_hash,
    occurred_at,
    event_type,
    source,
    actor_type,
    platform,
    app_version,
    function_name,
    function_version,
    state_before,
    state_after,
    outcome,
    template_version,
    provider_message_id,
    evidence_reference,
    sanitized_metadata,
    idempotency_key
  ) values (
    v_event_id,
    p_deletion_request_id,
    p_correlation_id,
    p_subject_user_id,
    v_previous_hash,
    v_event_hash,
    v_occurred_at,
    trim(p_event_type),
    trim(p_source),
    p_actor_type,
    p_platform,
    p_app_version,
    p_function_name,
    p_function_version,
    p_state_before,
    p_state_after,
    trim(p_outcome),
    p_template_version,
    p_provider_message_id,
    p_evidence_reference,
    v_metadata,
    trim(p_idempotency_key)
  )
  on conflict (idempotency_key) do nothing
  returning event_id into v_event_id;

  if v_event_id is null then
    select event_id into v_event_id
    from public.account_lifecycle_events
    where idempotency_key = trim(p_idempotency_key);
  end if;

  return v_event_id;
end;
$$;

create or replace function public.verify_account_lifecycle_hash_chain(
  p_deletion_request_id uuid
)
returns table (
  valid boolean,
  event_count integer,
  first_invalid_event_id uuid
)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_row public.account_lifecycle_events;
  v_expected_previous text := null;
  v_expected_hash text;
  v_count integer := 0;
  v_canonical jsonb;
begin
  for v_row in
    select *
    from public.account_lifecycle_events
    where deletion_request_id = p_deletion_request_id
    order by chain_sequence
  loop
    v_count := v_count + 1;
    v_canonical := jsonb_build_object(
      'event_id', v_row.event_id,
      'deletion_request_id', v_row.deletion_request_id,
      'correlation_id', v_row.correlation_id,
      'subject_user_id', v_row.subject_user_id,
      'previous_event_hash', v_row.previous_event_hash,
      'occurred_at', v_row.occurred_at,
      'event_type', v_row.event_type,
      'source', v_row.source,
      'actor_type', v_row.actor_type,
      'platform', v_row.platform,
      'app_version', v_row.app_version,
      'function_name', v_row.function_name,
      'function_version', v_row.function_version,
      'state_before', v_row.state_before,
      'state_after', v_row.state_after,
      'outcome', v_row.outcome,
      'template_version', v_row.template_version,
      'provider_message_id', v_row.provider_message_id,
      'evidence_reference', v_row.evidence_reference,
      'sanitized_metadata', v_row.sanitized_metadata,
      'idempotency_key', v_row.idempotency_key
    );
    v_expected_hash := encode(
      extensions.digest(coalesce(v_expected_previous, '') || v_canonical::text, 'sha256'),
      'hex'
    );
    if v_row.previous_event_hash is distinct from v_expected_previous
       or v_row.event_hash is distinct from v_expected_hash then
      return query select false, v_count, v_row.event_id;
      return;
    end if;
    v_expected_previous := v_row.event_hash;
  end loop;

  return query select true, v_count, null::uuid;
end;
$$;

create or replace function public.is_account_lifecycle_reviewer_authorized(
  p_reviewer_id text,
  p_capability text default 'view'
)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.account_lifecycle_reviewers r
    where r.reviewer_id = p_reviewer_id
      and r.enabled = true
      and (r.valid_until is null or r.valid_until > now())
      and p_capability = any(r.capabilities)
  );
$$;

create or replace function public.record_evidence_access_event(
  p_evidence_index_id uuid,
  p_event_type text,
  p_reviewer_identity text,
  p_reason text,
  p_case_number text,
  p_files_accessed jsonb,
  p_export_checksum text,
  p_outcome text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_index public.account_lifecycle_evidence_index;
  v_event_id uuid;
  v_capability text;
  v_reason text;
  v_case_number text;
begin
  v_capability := case when p_event_type = 'EVIDENCE_EXPORT_CREATED' then 'export' else 'view' end;
  if not public.is_account_lifecycle_reviewer_authorized(p_reviewer_identity, v_capability) then
    raise exception 'reviewer is not authorized for %', v_capability;
  end if;

  select * into v_index
  from public.account_lifecycle_evidence_index
  where id = p_evidence_index_id;
  if not found then
    raise exception 'evidence index not found';
  end if;

  v_reason := public.sanitize_account_lifecycle_text(p_reason);
  v_case_number := nullif(public.sanitize_account_lifecycle_text(p_case_number), '');
  if nullif(trim(v_reason), '') is null then
    raise exception 'access reason is required';
  end if;

  insert into public.evidence_access_events (
    evidence_index_id,
    deletion_request_id,
    evidence_version,
    event_type,
    reviewer_identity,
    reason,
    case_number,
    files_accessed,
    export_checksum,
    outcome,
    idempotency_key
  ) values (
    v_index.id,
    v_index.deletion_request_id,
    v_index.evidence_version,
    p_event_type,
    p_reviewer_identity,
    v_reason,
    v_case_number,
    coalesce(p_files_accessed, '[]'::jsonb),
    p_export_checksum,
    left(coalesce(p_outcome, 'unknown'), 100),
    p_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning event_id into v_event_id;

  if v_event_id is null then
    select event_id into v_event_id
    from public.evidence_access_events
    where idempotency_key = p_idempotency_key;
  end if;

  perform public.append_account_lifecycle_event(
    v_index.deletion_request_id,
    v_index.deletion_request_id,
    p_event_type,
    'evidence-review-cli',
    'reviewer',
    left(coalesce(p_outcome, 'unknown'), 100),
    'lifecycle:' || p_idempotency_key,
    null,
    null,
    null,
    null,
    null,
    v_index.lifecycle_state,
    v_index.lifecycle_state,
    null,
    null,
    v_index.evidence_bundle_path,
    jsonb_build_object(
      'reviewer_identity', p_reviewer_identity,
      'reason', v_reason,
      'case_number', v_case_number,
      'files_accessed', coalesce(p_files_accessed, '[]'::jsonb),
      'export_checksum', p_export_checksum,
      'evidence_version', v_index.evidence_version
    )
  );

  return v_event_id;
end;
$$;

-- Failure handling is intentionally independent of event insertion: pausing
-- must still succeed if the evidence ledger itself is the failing component.
create or replace function public.pause_account_deletion_automation(
  p_reason text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_reason text := public.sanitize_account_lifecycle_text(p_reason);
begin
  insert into public.app_config (key, value)
  values (
    'account_deletion_automation_mode',
    jsonb_build_object('mode', 'PAUSED', 'reason', v_reason, 'updatedAt', now())
  )
  on conflict (key) do update set value = excluded.value;

  insert into public.app_config (key, value)
  values (
    'account_deletion_worker_enabled',
    jsonb_build_object('enabled', false, 'updatedAt', now(), 'reason', v_reason)
  )
  on conflict (key) do update set value = excluded.value;

  insert into public.app_config (key, value)
  values (
    'account_deletion_worker_dry_run',
    jsonb_build_object('enabled', true, 'updatedAt', now(), 'reason', v_reason)
  )
  on conflict (key) do update set value = excluded.value;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Internal review views
-- ---------------------------------------------------------------------------

create or replace view public.v_account_lifecycle_summary
with (security_invoker = true)
as
select
  dr.id as deletion_request_id,
  dr.subject_ref,
  dr.user_id as subject_user_id,
  dr.requested_at,
  dr.status as lifecycle_state,
  dr.deactivated_at,
  dr.grace_period_ends_at,
  dr.restored_at,
  dr.purge_started_at,
  dr.purged_at,
  dr.legal_hold_until,
  ei.id as evidence_index_id,
  ei.environment,
  ei.evidence_bundle_path,
  ei.evidence_version,
  ei.generation_status,
  ei.checksum_status,
  ei.checksum_verified_at,
  ei.legal_hold as evidence_legal_hold,
  ei.retention_expires_at,
  ei.finalized_at
from public.deletion_requests dr
left join lateral (
  select e.*
  from public.account_lifecycle_evidence_index e
  where e.deletion_request_id = dr.id
  order by e.evidence_version desc
  limit 1
) ei on true;

create or replace view public.v_account_lifecycle_timeline
with (security_invoker = true)
as
select
  e.deletion_request_id,
  e.occurred_at,
  e.event_id,
  e.event_type,
  e.source,
  e.actor_type,
  e.state_before,
  e.state_after,
  e.outcome,
  e.event_hash,
  e.previous_event_hash,
  e.evidence_reference,
  e.sanitized_metadata
from public.account_lifecycle_events e
union all
select
  t.request_id as deletion_request_id,
  t.occurred_at,
  t.id as event_id,
  coalesce(t.reason_code, 'STATE_TRANSITION') as event_type,
  'legacy-deletion-state-transitions'::text as source,
  t.actor_type,
  t.from_state as state_before,
  t.to_state as state_after,
  t.to_state as outcome,
  null::text as event_hash,
  null::text as previous_event_hash,
  null::text as evidence_reference,
  coalesce(t.sanitized_metadata, '{}'::jsonb) as sanitized_metadata
from public.deletion_state_transitions t;

-- ---------------------------------------------------------------------------
-- 7. RLS and grants: internal service role only
-- ---------------------------------------------------------------------------

alter table public.account_lifecycle_reviewers enable row level security;
alter table public.evidence_retention_policies enable row level security;
alter table public.account_lifecycle_evidence_index enable row level security;
alter table public.account_lifecycle_events enable row level security;
alter table public.evidence_access_events enable row level security;

revoke all on table public.account_lifecycle_reviewers from public, anon, authenticated;
revoke all on table public.evidence_retention_policies from public, anon, authenticated;
revoke all on table public.account_lifecycle_evidence_index from public, anon, authenticated;
revoke all on table public.account_lifecycle_events from public, anon, authenticated;
revoke all on table public.evidence_access_events from public, anon, authenticated;
revoke all on table public.v_account_lifecycle_summary from public, anon, authenticated;
revoke all on table public.v_account_lifecycle_timeline from public, anon, authenticated;
revoke all on sequence public.account_lifecycle_events_chain_sequence_seq from public, anon, authenticated;

grant select, insert, update on table public.account_lifecycle_reviewers to service_role;
grant select, insert, update on table public.evidence_retention_policies to service_role;
grant select, insert, update on table public.account_lifecycle_evidence_index to service_role;
grant select, insert on table public.account_lifecycle_events to service_role;
grant select, insert on table public.evidence_access_events to service_role;
grant select on table public.v_account_lifecycle_summary to service_role;
grant select on table public.v_account_lifecycle_timeline to service_role;
grant usage, select on sequence public.account_lifecycle_events_chain_sequence_seq to service_role;

revoke all on function public.set_account_lifecycle_evidence_updated_at() from public;
revoke all on function public.prevent_account_lifecycle_event_mutation() from public;
revoke all on function public.sanitize_account_lifecycle_text(text) from public;
revoke all on function public.sanitize_account_lifecycle_json(jsonb) from public;
revoke all on function public.sanitize_account_lifecycle_metadata(jsonb) from public;
revoke all on function public.append_account_lifecycle_event(
  uuid, uuid, text, text, text, text, text, uuid, text, text, text, text,
  text, text, text, text, text, jsonb, timestamptz
) from public;
revoke all on function public.verify_account_lifecycle_hash_chain(uuid) from public;
revoke all on function public.is_account_lifecycle_reviewer_authorized(text, text) from public;
revoke all on function public.record_evidence_access_event(
  uuid, text, text, text, text, jsonb, text, text, text
) from public;
revoke all on function public.pause_account_deletion_automation(text) from public;

grant execute on function public.sanitize_account_lifecycle_text(text) to service_role;
grant execute on function public.sanitize_account_lifecycle_json(jsonb) to service_role;
grant execute on function public.sanitize_account_lifecycle_metadata(jsonb) to service_role;
grant execute on function public.append_account_lifecycle_event(
  uuid, uuid, text, text, text, text, text, uuid, text, text, text, text,
  text, text, text, text, text, jsonb, timestamptz
) to service_role;
grant execute on function public.verify_account_lifecycle_hash_chain(uuid) to service_role;
grant execute on function public.is_account_lifecycle_reviewer_authorized(text, text) to service_role;
grant execute on function public.record_evidence_access_event(
  uuid, text, text, text, text, jsonb, text, text, text
) to service_role;
grant execute on function public.pause_account_deletion_automation(text) to service_role;

-- Add a mode vocabulary without changing the existing production guardrails.
insert into public.app_config (key, value)
values (
  'account_deletion_automation_mode',
  jsonb_build_object('mode', 'OFF', 'updatedAt', now())
)
on conflict (key) do nothing;

insert into public.app_config (key, value)
values (
  'account_deletion_evidence_pipeline_ready',
  jsonb_build_object('enabled', false, 'updatedAt', now())
)
on conflict (key) do nothing;

comment on table public.account_lifecycle_evidence_index is
  'Service-role-only search index for private, immutable account-lifecycle evidence bundles. Raw email is prohibited.';
comment on table public.account_lifecycle_events is
  'Append-only per-request SHA-256 hash-chain ledger. Client roles have no access.';
comment on table public.evidence_access_events is
  'Append-only reviewer access log for lifecycle evidence retrieval and export.';

-- Terminal purge is now evidence-gated at the database boundary as well as in
-- the worker. This closes crash-recovery and direct-RPC bypasses: no caller can
-- mark a request purged until an immutable bundle has completed round-trip
-- checksum verification.
create or replace function public.mark_deletion_request_purged(
  p_request_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.deletion_requests;
begin
  update public.deletion_requests dr
  set
    status = 'purged',
    purged_at = now(),
    processed_at = now(),
    failure_code = null,
    failure_message = null,
    worker_id = null,
    worker_lease_expires_at = null,
    worker_heartbeat_at = null,
    current_step = null,
    restoration_token_hash = null,
    updated_at = now()
  where dr.id = p_request_id
    and dr.status = 'purging'
    and (p_worker_id is null or dr.worker_id = p_worker_id)
    and exists (
      select 1
      from public.account_lifecycle_evidence_index ei
      where ei.deletion_request_id = dr.id
        and ei.generation_status = 'complete'
        and ei.checksum_status = 'verified'
        and ei.finalized_at is not null
        and ei.deleted_at is null
    )
  returning dr.* into claimed;

  if claimed.id is null then
    return false;
  end if;

  perform public.append_deletion_state_transition(
    claimed.id,
    claimed.subject_ref,
    'purging',
    'purged',
    'worker',
    p_worker_id,
    'PURGED',
    jsonb_build_object('evidence_gate', 'verified')
  );
  return true;
end;
$$;

revoke all on function public.mark_deletion_request_purged(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_deletion_request_purged(uuid, text) to service_role;

-- Crash reconciliation may close only the narrow window where the bundle was
-- finalized but the worker died before the terminal RPC. Orphans without a
-- complete verified bundle remain non-terminal for explicit recovery.
create or replace function public.reconcile_orphaned_purging_requests(
  p_limit integer default 25
)
returns setof public.deletion_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_row public.deletion_requests;
begin
  for rec in
    select dr.id
    from public.deletion_requests dr
    where dr.status = 'purging'
      and dr.user_id is null
      and dr.purged_at is null
      and dr.worker_lease_expires_at is not null
      and dr.worker_lease_expires_at <= now()
      and exists (
        select 1
        from public.account_lifecycle_evidence_index ei
        where ei.deletion_request_id = dr.id
          and ei.generation_status = 'complete'
          and ei.checksum_status = 'verified'
          and ei.finalized_at is not null
          and ei.deleted_at is null
      )
    order by dr.updated_at asc
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  loop
    perform public.mark_deletion_request_purged(rec.id, null);
    select * into v_row from public.deletion_requests where id = rec.id;
    if v_row.id is not null then return next v_row; end if;
  end loop;
  return;
end;
$$;

revoke all on function public.reconcile_orphaned_purging_requests(integer) from public, anon, authenticated;
grant execute on function public.reconcile_orphaned_purging_requests(integer) to service_role;
