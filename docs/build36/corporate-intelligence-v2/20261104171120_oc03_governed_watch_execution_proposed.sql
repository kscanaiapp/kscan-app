-- PROPOSED ONLY. Kept outside supabase/migrations. Requires OC-02 proposed schema.
-- Do not apply to Staging or Production in this workstream.
begin;
create schema oc03_execution;
revoke all on schema oc03_execution from public,anon,authenticated;
grant usage on schema oc03_execution to service_role;

create table oc03_execution.bindings (
  proposal_id uuid primary key references oc02_authorization.proposals(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null check(account_id=actor_id),
  snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),
  binding jsonb not null,
  binding_hash text not null check(binding_hash ~ '^[a-f0-9]{64}$'),
  approved_revision integer,
  approval_operation_id uuid,
  check((approved_revision is null and approval_operation_id is null) or (approved_revision>=2 and approval_operation_id is not null)),
  check(binding ?& array['version','source','canonicalUrl','providerListingId','title','imageUrl','initialPrice','currency','watchIntent','targetPrice']),
  check(binding - array['version','source','canonicalUrl','providerListingId','title','imageUrl','initialPrice','currency','watchIntent','targetPrice']='{}'::jsonb),
  check(binding->>'version'='oc03-watch-save-v1' and binding->>'watchIntent'='just_watching' and binding->'targetPrice'='null'::jsonb),
  check(jsonb_typeof(binding->'version')='string' and jsonb_typeof(binding->'watchIntent')='string'),
  check(binding->>'source' in ('farfetch','kickscrew')),
  check(char_length(binding->>'canonicalUrl') between 1 and 2048),
  check(char_length(binding->>'title') between 1 and 200),
  check(jsonb_typeof(binding->'initialPrice')='number' and (binding->>'initialPrice')::numeric>0),
  check(binding->>'currency' ~ '^[A-Z]{3}$')
);
create table oc03_execution.limits (
  actor_id uuid primary key references auth.users(id) on delete cascade,
  minute timestamptz not null,
  count integer not null check(count between 1 and 20)
);
-- Independent evidence remains available after OC-02 proposal retention cleanup.
-- Service role has no DELETE grant; archival/deletion policy requires separate review.
create table oc03_execution.ledger (
  proposal_id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null check(account_id=actor_id),
  handoff_id uuid not null unique,
  proposal_revision integer not null check(proposal_revision>=3),
  snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),
  binding_hash text not null check(binding_hash ~ '^[a-f0-9]{64}$'),
  request_id uuid not null,
  state text not null check(state in ('reserved','executing','completed','failed_no_effect','outcome_uncertain','reconciled')),
  effect text not null check(effect in ('none','created','already_watched')),
  reason text check(reason in ('disabled','unauthorized','invalid_request','not_found','authorization_invalid','unsupported_capability','target_changed','unsupported_listing','confirmation_required','existing_watch_change_requires_approval','watch_limit','rate_limited','storage_unavailable','no_commit_evidence','watch_changed','mutation_unverified','conflict')),
  watch_id uuid,
  evidence jsonb,
  evidence_hash text check(evidence_hash ~ '^[a-f0-9]{64}$'),
  revision integer not null check(revision>=0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(actor_id,request_id),
  check((effect='none' and watch_id is null and evidence is null and evidence_hash is null) or
    (effect<>'none' and watch_id is not null and evidence is not null and evidence_hash is not null and state in ('completed','reconciled'))),
  check(state<>'completed' or effect<>'none')
);
create table oc03_execution.audit (
  id bigint generated always as identity primary key,
  proposal_id uuid not null references oc03_execution.ledger(proposal_id) on delete cascade,
  metadata jsonb not null,
  check(metadata ?& array['version','state','effect','reason']),
  check(metadata-array['version','state','effect','reason']='{}'::jsonb),
  check(metadata->>'version'='oc03-watch-save-v1'),
  check(metadata->>'state' in ('reserved','executing','completed','failed_no_effect','outcome_uncertain','reconciled')),
  check(metadata->>'effect' in ('none','created','already_watched'))
);
create function oc03_execution.binding_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare p jsonb;
begin
  select document into p from oc02_authorization.proposals where id=new.proposal_id and actor_id=new.actor_id and account_id=new.account_id;
  if p is null or (p->>'snapshotHash') is distinct from new.snapshot_hash or (p->'snapshot'->>'capability') is distinct from 'save_watchlist' then raise exception 'oc03_binding_invalid'; end if;
  if TG_OP='INSERT' then
    if (p->>'state') is distinct from 'proposed' or new.approved_revision is not null or new.approval_operation_id is not null then raise exception 'oc03_binding_requires_proposed';end if;
  else
    if new.proposal_id<>old.proposal_id or new.actor_id<>old.actor_id or new.account_id<>old.account_id or new.snapshot_hash<>old.snapshot_hash
      or new.binding is distinct from old.binding or new.binding_hash<>old.binding_hash or old.approved_revision is not null
      then raise exception 'oc03_binding_immutable';end if;
    if (p->>'state') is distinct from 'approved' or (p->>'revision')::integer is distinct from new.approved_revision or
      not exists(select 1 from oc02_authorization.receipts where proposal_id=new.proposal_id and actor_id=new.actor_id and account_id=new.account_id and operation_id=new.approval_operation_id)
      then raise exception 'oc03_binding_requires_customer_approval';end if;
  end if;
  return new;
end $$;
create trigger binding_guard before insert or update on oc03_execution.bindings for each row execute function oc03_execution.binding_guard();

create function oc03_execution.ledger_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare legal boolean;
begin
  if TG_OP='INSERT' then
    if new.state<>'reserved' or new.effect<>'none' or new.revision<>0 then raise exception 'oc03_initial_state';end if;
  else
    if new.proposal_id<>old.proposal_id or new.actor_id<>old.actor_id or new.account_id<>old.account_id or new.handoff_id<>old.handoff_id
      or new.proposal_revision<>old.proposal_revision or new.snapshot_hash<>old.snapshot_hash or new.binding_hash<>old.binding_hash or new.request_id<>old.request_id
      or new.revision<>old.revision+1 or new.created_at<>old.created_at then raise exception 'oc03_immutable_execution';end if;
    legal:=case old.state
      when 'reserved' then new.state in ('executing','failed_no_effect','outcome_uncertain','reconciled')
      when 'executing' then new.state='completed'
      when 'completed' then new.state='reconciled'
      when 'failed_no_effect' then new.state='reconciled'
      when 'outcome_uncertain' then new.state='reconciled'
      else false end;
    if not legal then raise exception 'oc03_illegal_transition';end if;
    if old.evidence is not null and (new.evidence is distinct from old.evidence or new.evidence_hash is distinct from old.evidence_hash or new.watch_id is distinct from old.watch_id or new.effect<>old.effect)
      then raise exception 'oc03_evidence_immutable';end if;
  end if;
  new.updated_at:=clock_timestamp();return new;
end $$;
create trigger ledger_guard before insert or update on oc03_execution.ledger for each row execute function oc03_execution.ledger_guard();
create function oc03_execution.no_partial_commit() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare l oc03_execution.ledger; p jsonb; b oc03_execution.bindings;
begin
  select * into l from oc03_execution.ledger where proposal_id=new.proposal_id;
  if l.state='executing' then raise exception 'oc03_incomplete_execution';end if;
  if l.state='completed' then
    select document into p from oc02_authorization.proposals where id=l.proposal_id and actor_id=l.actor_id and account_id=l.account_id;
    select * into b from oc03_execution.bindings where proposal_id=l.proposal_id and actor_id=l.actor_id and account_id=l.account_id;
    if p is null or (p->>'state') is distinct from 'consumed' or (p->>'revision')::integer is distinct from l.proposal_revision
      or (p->>'snapshotHash') is distinct from l.snapshot_hash or (p->'snapshot'->>'capability') is distinct from 'save_watchlist'
      or (p->'snapshot'->>'expiresAt')::double precision<=extract(epoch from clock_timestamp())*1000
      or b.binding_hash is distinct from l.binding_hash or b.approved_revision is distinct from l.proposal_revision-1
      then raise exception 'oc03_invalid_completion_authorization';end if;
    if not public.watchlist_actor_is_active(l.actor_id) or not coalesce((select has_access from public.kplus_effective_access_state(l.actor_id,'k_plus',clock_timestamp())),false)
      then raise exception 'oc03_completion_permission_expired';end if;
    if not exists(select 1 from public.user_commerce_watches w where w.id=l.watch_id and w.user_id=l.actor_id
      and w.source=b.binding->>'source' and w.canonical_url=b.binding->>'canonicalUrl' and w.currency=b.binding->>'currency'
      and w.watch_intent='just_watching' and w.target_price_amount is null and w.status='active' and w.deleted_at is null
      and (l.evidence->>'watchId')=w.id::text and (l.evidence->>'userId')=w.user_id::text
      and (l.evidence->>'canonicalUrl')=w.canonical_url and (l.evidence->>'source')=w.source
      and (l.evidence->>'bindingHash')=l.binding_hash and (l.evidence->>'currency')=w.currency
      and (l.evidence->>'intent')='just_watching' and l.evidence->'targetPrice'='null'::jsonb
      and (l.evidence->>'rowVersion')::bigint=w.row_version)
      then raise exception 'oc03_missing_mutation_evidence';end if;
  end if;
  return null;
end $$;
create constraint trigger no_partial_commit after insert or update on oc03_execution.ledger deferrable initially deferred for each row execute function oc03_execution.no_partial_commit();

alter table oc03_execution.bindings enable row level security;
alter table oc03_execution.bindings force row level security;
alter table oc03_execution.ledger enable row level security;
alter table oc03_execution.ledger force row level security;
alter table oc03_execution.limits enable row level security;
alter table oc03_execution.limits force row level security;
alter table oc03_execution.audit enable row level security;
alter table oc03_execution.audit force row level security;
create policy backend_only on oc03_execution.bindings to service_role using(true) with check(true);
create policy backend_only on oc03_execution.ledger to service_role using(true) with check(true);
create policy backend_only on oc03_execution.limits to service_role using(true) with check(true);
create policy backend_only on oc03_execution.audit to service_role using(true) with check(true);
revoke all on all functions in schema oc03_execution from public,anon,authenticated;
revoke all on all tables in schema oc03_execution from public,anon,authenticated,service_role;
revoke all on all sequences in schema oc03_execution from public,anon,authenticated;
grant select,insert,update on oc03_execution.bindings,oc03_execution.ledger,oc03_execution.limits to service_role;
grant select,insert on oc03_execution.audit to service_role;
grant usage,select on all sequences in schema oc03_execution to service_role;
commit;
