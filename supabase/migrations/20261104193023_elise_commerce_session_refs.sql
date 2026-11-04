-- OC-01 read-only commerce tools: bounded server-side product-reference store.
--
-- Edge Function isolates do not preserve memory between requests, so the
-- refine/compare follow-up of an Elise shopping turn cannot rely on the
-- broker's in-memory session. This table is the smallest server-side store
-- that keeps OC-01's limits across separate authenticated HTTP requests:
--
--   * actor + conversation binding (the session must belong to the actor);
--   * at most 32 references per actor/conversation;
--   * at most a 30-second lifetime per reference (earlier eligibility expiry
--     is supplied by the server and kept, never extended);
--   * written and read ONLY by the server (service_role). No anon or
--     authenticated grant, RLS enabled with no policy: the mobile client and
--     the model can never create, read or alter an authoritative record.
--
-- Rows hold public merchant/product display data only (title, merchant label,
-- validated URL, listed price, provenance). No conversation text, prompt,
-- image or account data is stored. Expired rows are deleted on every read and
-- write; conversation and account deletion cascade.

create table public.elise_commerce_session_refs (
  actor_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.style_chat_sessions(id) on delete cascade,
  ref text not null check (ref ~ '^p_[a-f0-9-]{36}$'),
  batch_position smallint not null check (batch_position between 1 and 8),
  record jsonb not null check (jsonb_typeof(record) = 'object' and octet_length(record::text) <= 4096),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (actor_id, session_id, ref),
  constraint elise_commerce_session_refs_lifetime check (expires_at > created_at and expires_at <= created_at + interval '30 seconds')
);

create index elise_commerce_session_refs_expiry on public.elise_commerce_session_refs (expires_at);

alter table public.elise_commerce_session_refs enable row level security;
revoke all on table public.elise_commerce_session_refs from public, anon, authenticated;
grant select, insert, delete on table public.elise_commerce_session_refs to service_role;

-- Returns the unexpired references of ONE actor's OWN conversation, newest
-- batch first. A conversation the actor does not own returns nothing.
create function public.elise_commerce_refs_load(p_actor uuid, p_session uuid)
returns table (ref text, batch_position smallint, record jsonb, created_at timestamptz, expires_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_actor is null or p_session is null then raise exception 'actor and session required' using errcode = '22023'; end if;
  delete from public.elise_commerce_session_refs r where r.actor_id = p_actor and r.expires_at <= now();
  if not exists (select 1 from public.style_chat_sessions s where s.id = p_session and s.user_id = p_actor) then
    return;
  end if;
  return query
    select r.ref, r.batch_position, r.record, r.created_at, r.expires_at
      from public.elise_commerce_session_refs r
     where r.actor_id = p_actor and r.session_id = p_session and r.expires_at > now()
     order by r.created_at desc, r.batch_position asc
     limit 32;
end $$;

-- Stores one server-produced batch (at most 16 records: two tool requests of
-- eight products). Serialized per actor/conversation, lifetime capped at 30
-- seconds whatever the caller supplies, then trimmed to the newest 32.
create function public.elise_commerce_refs_store(p_actor uuid, p_session uuid, p_records jsonb)
returns int
language plpgsql security invoker set search_path = '' as $$
declare item jsonb; stored int := 0; requested timestamptz;
begin
  if p_actor is null or p_session is null then raise exception 'actor and session required' using errcode = '22023'; end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 16 then raise exception 'record limit exceeded' using errcode = '22023'; end if;
  if not exists (select 1 from public.style_chat_sessions s where s.id = p_session and s.user_id = p_actor) then
    raise exception 'conversation not owned by actor' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('elise_commerce_refs:' || p_actor::text || ':' || p_session::text, 0));
  delete from public.elise_commerce_session_refs r where r.actor_id = p_actor and r.expires_at <= now();
  for item in select value from jsonb_array_elements(p_records) loop
    if jsonb_typeof(item) <> 'object' or jsonb_typeof(item->'record') <> 'object' then raise exception 'invalid record' using errcode = '22023'; end if;
    requested := to_timestamp((item->>'expiresAtMs')::double precision / 1000.0);
    if requested <= now() then continue; end if;
    insert into public.elise_commerce_session_refs (actor_id, session_id, ref, batch_position, record, created_at, expires_at)
      values (p_actor, p_session, item->>'ref', (item->>'position')::smallint, item->'record', now(), least(requested, now() + interval '30 seconds'))
      on conflict (actor_id, session_id, ref) do nothing;
    stored := stored + 1;
  end loop;
  delete from public.elise_commerce_session_refs r
   where r.actor_id = p_actor and r.session_id = p_session
     and r.ref not in (
       select k.ref from public.elise_commerce_session_refs k
        where k.actor_id = p_actor and k.session_id = p_session
        order by k.created_at desc, k.batch_position asc limit 32);
  -- Opportunistic global cleanup, bounded so a write never does unbounded work.
  delete from public.elise_commerce_session_refs r
   where r.ctid in (select g.ctid from public.elise_commerce_session_refs g where g.expires_at <= now() limit 200);
  return stored;
end $$;

revoke all on function public.elise_commerce_refs_load(uuid, uuid) from public, anon, authenticated;
grant execute on function public.elise_commerce_refs_load(uuid, uuid) to service_role;
revoke all on function public.elise_commerce_refs_store(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.elise_commerce_refs_store(uuid, uuid, jsonb) to service_role;
