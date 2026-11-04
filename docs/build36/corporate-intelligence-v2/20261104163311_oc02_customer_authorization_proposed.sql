-- OC-02 PROPOSED ONLY. Created with the Supabase migration CLI, then moved out
-- of supabase/migrations to prevent deployment/replay by existing release tooling.
-- Requires integration-owner review, governed migration registration and an
-- authorized transactional backend connection. DO NOT APPLY in this workstream.
begin;
create schema oc02_authorization;
revoke all on schema oc02_authorization from public, anon, authenticated;
grant usage on schema oc02_authorization to service_role;

create table oc02_authorization.limits (
  actor_id uuid primary key,
  minute timestamptz not null,
  count integer not null check(count between 1 and 30)
);
create table oc02_authorization.proposals (
  id uuid primary key,
  actor_id uuid not null,
  account_id uuid not null,
  retain_until double precision not null,
  document jsonb not null,
  unique(id,actor_id,account_id),
  check(document ?& array['snapshot','snapshotHash','state','revision','challengeHash','updatedAt']),
  check(document - array['snapshot','snapshotHash','state','revision','challengeHash','updatedAt'] = '{}'::jsonb),
  check(jsonb_typeof(document->'state')='string' and jsonb_typeof(document->'snapshotHash')='string' and jsonb_typeof(document->'revision')='number' and jsonb_typeof(document->'updatedAt')='number'),
  check((document->'snapshot') ?& array['version','policy','id','actorId','accountId','capability','arguments','target','permissionRevision','createdAt','expiresAt','retainUntil']),
  check((document->'snapshot') - array['version','policy','id','actorId','accountId','capability','arguments','target','permissionRevision','createdAt','expiresAt','retainUntil'] = '{}'::jsonb),
  check(jsonb_typeof(document->'snapshot'->'id')='string' and jsonb_typeof(document->'snapshot'->'actorId')='string' and jsonb_typeof(document->'snapshot'->'accountId')='string'),
  check(jsonb_typeof(document->'snapshot'->'version')='string' and jsonb_typeof(document->'snapshot'->'policy')='string' and jsonb_typeof(document->'snapshot'->'capability')='string' and jsonb_typeof(document->'snapshot'->'permissionRevision')='string'),
  check(jsonb_typeof(document->'snapshot'->'createdAt')='number' and jsonb_typeof(document->'snapshot'->'expiresAt')='number' and jsonb_typeof(document->'snapshot'->'retainUntil')='number'),
  check(jsonb_typeof(document->'snapshot'->'arguments')='object' and jsonb_typeof(document->'snapshot'->'target')='object'),
  check(document->'snapshot'->>'id'=id::text),
  check(document->'snapshot'->>'actorId'=actor_id::text),
  check(document->'snapshot'->>'accountId'=account_id::text),
  check((document->'snapshot'->>'retainUntil')::double precision=retain_until),
  check(document->'snapshot'->>'version'='oc02-authorization-v1'),
  check(document->'snapshot'->>'policy'='oc02-policy-v1'),
  check(document->'snapshot'->>'capability' in ('save_watchlist','save_closet','update_saved_preference','pause_watch','remove_watch')),
  check(document->>'snapshotHash' ~ '^[a-f0-9]{64}$'),
  check((document->>'revision')::integer >= 0),
  check(document->>'state' in ('proposed','awaiting_customer_approval','approved','rejected','expired','revoked','consumed')),
  check(jsonb_typeof(document->'snapshot')='object')
);
create index proposals_retention on oc02_authorization.proposals(retain_until);
create index proposals_actor on oc02_authorization.proposals(actor_id,account_id);
create table oc02_authorization.receipts (
  actor_id uuid not null,
  account_id uuid not null,
  operation_id uuid not null,
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  proposal_id uuid not null,
  foreign key(proposal_id,actor_id,account_id) references oc02_authorization.proposals(id,actor_id,account_id) on delete cascade,
  primary key(actor_id,account_id,operation_id)
);
create table oc02_authorization.audit (
  id bigint generated always as identity primary key,
  proposal_id uuid not null references oc02_authorization.proposals(id) on delete cascade,
  metadata jsonb not null,
  check(metadata->>'version'='oc02-audit-v1'),
  check(metadata ?& array['version','capability','from','to','revision']),
  check(jsonb_typeof(metadata->'version')='string' and jsonb_typeof(metadata->'capability')='string' and jsonb_typeof(metadata->'from')='string' and jsonb_typeof(metadata->'to')='string' and jsonb_typeof(metadata->'revision')='number'),
  check(metadata->>'capability' in ('save_watchlist','save_closet','update_saved_preference','pause_watch','remove_watch')),
  check(metadata->>'from' in ('none','proposed','awaiting_customer_approval','approved','rejected','expired','revoked','consumed')),
  check(metadata->>'to' in ('proposed','awaiting_customer_approval','approved','rejected','expired','revoked','consumed')),
  check((metadata->>'revision')::integer >= 0),
  check(metadata - array['version','capability','from','to','revision'] = '{}'::jsonb)
);

-- Snapshot/actor/account/expiry cannot be changed even by a mistaken service update.
-- This is SECURITY INVOKER; no public RPC or SECURITY DEFINER surface is created.
create function oc02_authorization.enforce_transition() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $$
declare prior text; following text; legal boolean;
begin
  if TG_OP='INSERT' then
    if (new.document->>'state') is distinct from 'proposed' or (new.document->>'revision')::integer is distinct from 0
       or new.document->'challengeHash' is distinct from 'null'::jsonb then
      raise exception 'oc02_illegal_initial_state';
    end if;
  else
    if new.id<>old.id or new.actor_id<>old.actor_id or new.account_id<>old.account_id
      or new.retain_until<>old.retain_until or new.document->'snapshot' is distinct from old.document->'snapshot'
      or new.document->>'snapshotHash' is distinct from old.document->>'snapshotHash'
      or (new.document->>'revision')::integer <> (old.document->>'revision')::integer+1 then
      raise exception 'oc02_immutable_or_revision_conflict';
    end if;
    prior:=old.document->>'state'; following:=new.document->>'state';
    legal:=case prior
      when 'proposed' then following in ('awaiting_customer_approval','expired','revoked')
      when 'awaiting_customer_approval' then following in ('awaiting_customer_approval','approved','rejected','expired','revoked')
      when 'approved' then following in ('consumed','expired','revoked')
      else false end;
    if not legal then raise exception 'oc02_illegal_transition'; end if;
    if prior=following and new.document->'challengeHash' is not distinct from old.document->'challengeHash'
      then raise exception 'oc02_confirmation_not_rotated'; end if;
  end if;
  if new.document->>'state' not in ('expired','revoked') and
    (new.document->'snapshot'->>'expiresAt')::double precision <= extract(epoch from clock_timestamp())*1000
    then raise exception 'oc02_expired'; end if;
  if new.document->>'state'='awaiting_customer_approval' then
    if coalesce(new.document->>'challengeHash','') !~ '^[a-f0-9]{64}$' then raise exception 'oc02_invalid_confirmation'; end if;
  elsif new.document->'challengeHash' is distinct from 'null'::jsonb then raise exception 'oc02_unexpected_confirmation';
  end if;
  return new;
end $$;
revoke all on function oc02_authorization.enforce_transition() from public, anon, authenticated;
create trigger proposal_transition before insert or update on oc02_authorization.proposals
for each row execute function oc02_authorization.enforce_transition();

alter table oc02_authorization.proposals enable row level security;
alter table oc02_authorization.proposals force row level security;
alter table oc02_authorization.receipts enable row level security;
alter table oc02_authorization.receipts force row level security;
alter table oc02_authorization.audit enable row level security;
alter table oc02_authorization.audit force row level security;
alter table oc02_authorization.limits enable row level security;
alter table oc02_authorization.limits force row level security;
create policy backend_only on oc02_authorization.proposals to service_role using(true) with check(true);
create policy backend_only on oc02_authorization.receipts to service_role using(true) with check(true);
create policy backend_only on oc02_authorization.audit to service_role using(true) with check(true);
create policy backend_only on oc02_authorization.limits to service_role using(true) with check(true);
revoke all on all tables in schema oc02_authorization from public,anon,authenticated;
revoke all on all sequences in schema oc02_authorization from public,anon,authenticated;
grant select,insert,update,delete on all tables in schema oc02_authorization to service_role;
grant usage,select on all sequences in schema oc02_authorization to service_role;
commit;
