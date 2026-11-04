-- OC-01 reference store v2: maximum reference lifetime 2 minutes.
--
-- Owner decision 2026-11-04 (Build 35): the 30-second lifetime of
-- 20261104193023 expired product references before a customer could read the
-- cards and ask to refine/compare (live Staging evidence: three Elise turns
-- take ~30 s). The limit is raised to 2 minutes.
--
-- Additive by design: the v1 table's 30-second CHECK cannot be relaxed without
-- a destructive ALTER, so v2 is a new table with identical security and the
-- two existing RPCs are re-pointed to it (same signatures, so callers are
-- unchanged). The empty v1 table is no longer written or read; removing it is
-- left to a separately approved destructive migration.
--
-- Every other guarantee is unchanged: service_role only (RLS on, no policy, no
-- anon/authenticated grant), actor + OWNED conversation binding, at most 32
-- references per conversation and 16 per write, advisory-lock serialized
-- writes with the batch timestamp taken after the lock, expiry cleanup on
-- every read/write, cascade on conversation/account deletion.

create table public.elise_commerce_session_refs_v2 (
  actor_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.style_chat_sessions(id) on delete cascade,
  ref text not null check (ref ~ '^p_[a-f0-9-]{36}$'),
  batch_position smallint not null check (batch_position between 1 and 8),
  record jsonb not null check (jsonb_typeof(record) = 'object' and octet_length(record::text) <= 4096),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (actor_id, session_id, ref),
  constraint elise_commerce_session_refs_v2_lifetime check (expires_at > created_at and expires_at <= created_at + interval '2 minutes')
);

create index elise_commerce_session_refs_v2_expiry on public.elise_commerce_session_refs_v2 (expires_at);

alter table public.elise_commerce_session_refs_v2 enable row level security;
revoke all on table public.elise_commerce_session_refs_v2 from public, anon, authenticated;
grant select, insert, delete on table public.elise_commerce_session_refs_v2 to service_role;

create or replace function public.elise_commerce_refs_load(p_actor uuid, p_session uuid)
returns table (ref text, batch_position smallint, record jsonb, created_at timestamptz, expires_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_actor is null or p_session is null then raise exception 'actor and session required' using errcode = '22023'; end if;
  delete from public.elise_commerce_session_refs_v2 r where r.actor_id = p_actor and r.expires_at <= now();
  if not exists (select 1 from public.style_chat_sessions s where s.id = p_session and s.user_id = p_actor) then
    return;
  end if;
  return query
    select r.ref, r.batch_position, r.record, r.created_at, r.expires_at
      from public.elise_commerce_session_refs_v2 r
     where r.actor_id = p_actor and r.session_id = p_session and r.expires_at > now()
     order by r.created_at desc, r.batch_position asc
     limit 32;
end $$;

create or replace function public.elise_commerce_refs_store(p_actor uuid, p_session uuid, p_records jsonb)
returns int
language plpgsql security invoker set search_path = '' as $$
declare item jsonb; stored int := 0; requested timestamptz; batch_at timestamptz;
begin
  if p_actor is null or p_session is null then raise exception 'actor and session required' using errcode = '22023'; end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 16 then raise exception 'record limit exceeded' using errcode = '22023'; end if;
  if not exists (select 1 from public.style_chat_sessions s where s.id = p_session and s.user_id = p_actor) then
    raise exception 'conversation not owned by actor' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('elise_commerce_refs:' || p_actor::text || ':' || p_session::text, 0));
  -- Taken AFTER the lock, so concurrent writes for one conversation keep their real order.
  batch_at := clock_timestamp();
  delete from public.elise_commerce_session_refs_v2 r where r.actor_id = p_actor and r.expires_at <= now();
  for item in select value from jsonb_array_elements(p_records) loop
    if jsonb_typeof(item) <> 'object' or jsonb_typeof(item->'record') <> 'object' then raise exception 'invalid record' using errcode = '22023'; end if;
    requested := to_timestamp((item->>'expiresAtMs')::double precision / 1000.0);
    if requested <= batch_at then continue; end if;
    insert into public.elise_commerce_session_refs_v2 (actor_id, session_id, ref, batch_position, record, created_at, expires_at)
      values (p_actor, p_session, item->>'ref', (item->>'position')::smallint, item->'record', batch_at, least(requested, batch_at + interval '2 minutes'))
      on conflict (actor_id, session_id, ref) do nothing;
    stored := stored + 1;
  end loop;
  delete from public.elise_commerce_session_refs_v2 r
   where r.actor_id = p_actor and r.session_id = p_session
     and r.ref not in (
       select k.ref from public.elise_commerce_session_refs_v2 k
        where k.actor_id = p_actor and k.session_id = p_session
        order by k.created_at desc, k.batch_position asc limit 32);
  -- Opportunistic global cleanup, bounded so a write never does unbounded work.
  delete from public.elise_commerce_session_refs_v2 r
   where r.ctid in (select g.ctid from public.elise_commerce_session_refs_v2 g where g.expires_at <= now() limit 200);
  return stored;
end $$;

revoke all on function public.elise_commerce_refs_load(uuid, uuid) from public, anon, authenticated;
grant execute on function public.elise_commerce_refs_load(uuid, uuid) to service_role;
revoke all on function public.elise_commerce_refs_store(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.elise_commerce_refs_store(uuid, uuid, jsonb) to service_role;
