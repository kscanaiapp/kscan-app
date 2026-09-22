-- Build 34 entitlement boundary repair — Signature Style is FREE.
--
-- OWNER PRODUCT AUTHORITY (Build 34): SIGNATURE_STYLE_ENTITLEMENT=FREE.
--
-- APPLIED LEDGER IDENTITY: staging (yzqjvdfgefveprobvvyw) recorded this file as
-- version 20260915214857 on 2026-09-15. The filename carries that exact version
-- so the governed migration workflow reconciles on it. It was authored as 20260915213000 and
-- renamed BEFORE any ledger anywhere recorded that number — staging holds only
-- 20260915214857, and production (wyyuqfdxucjksghsmhry, confirmed read-only via
-- list_migrations 2026-09-15) holds neither — so nothing can double-apply.
--
-- public.recompute_signature_style() has required an active K+ entitlement
-- since 20260830131956 introduced it (and 20260830140000 carried that gate
-- forward verbatim while fixing the column-shadowing bug). That requirement
-- is the defect: an authenticated free user calling the only public Signature
-- Style write path received
--
--     42501  active K+ entitlement required
--
-- so Signature Style could neither be generated nor viewed on the free
-- product it belongs to.
--
-- THIS MIGRATION REMOVES THE K+ REQUIREMENT AND NOTHING ELSE.
--
-- Every other control this function carries is preserved byte-for-byte:
--
--   * `auth.uid()` is still the sole source of the actor's identity, and a
--     null uid still raises 28000 — signed-out behaviour is unchanged.
--   * The function still accepts NO arguments, so a caller can request work
--     but can never supply a user id, a profile payload or an evidence
--     revision.  The forged-payload control from 20260830131956 stands.
--   * It still reads ONLY `user_id = v_user_id` rows from
--     public.user_closet_items, so one actor's call can never observe or
--     write another actor's evidence.  Cross-user isolation is unchanged.
--   * It still upserts exactly one row keyed by that same uid, and RLS on
--     public.user_style_profiles (`auth.uid() = user_id`, SELECT only,
--     20260830060000) is untouched — a free user reads their own profile and
--     no one else's.
--   * `security definer` + `set search_path = ''` + the
--     `#variable_conflict use_column` pragma (20260830140000) are unchanged.
--   * The stored-profile integrity re-validation and the bounded `limit 10`
--     aggregate shape are unchanged.
--   * Grants are unchanged: revoked from public/anon, executable by
--     `authenticated`.  anon gains nothing here.
--
-- NOT CHANGED BY THIS MIGRATION, deliberately:
--
--   * public.has_active_k_plus() itself, and every OTHER gate that consumes
--     it.  Closet RLS on public.user_closet_items stays
--     `user_id = auth.uid() and has_active_k_plus()`; Voice Scan, Virtual
--     Try-On, Packing Intelligence, Wardrobe Concierge and Smart Watchlist
--     keep their K+ boundaries exactly as they are.
--   * public.signature_style_frequency(text[]), which stays server-only
--     (revoked from public, anon and authenticated) and is still only ever
--     reached through this SECURITY DEFINER function.
--
-- CONSEQUENCE, STATED PLAINLY: because the Closet remains K+ gated for
-- writes, a free actor who has never held K+ has no Closet evidence, so this
-- function returns `evidenceCount: 0` for them and the caller renders no
-- Signature Style block.  An actor whose K+ lapsed can now read a bounded
-- aggregate summary OF THEIR OWN wardrobe evidence — which is precisely what
-- "Signature Style is part of the free product" means, and is their own data
-- in both directions.  No other user's data is reachable through this path.

create or replace function public.recompute_signature_style()
returns table (
  user_id uuid,
  profile_version integer,
  evidence_revision text,
  derived_at timestamptz,
  profile_data jsonb,
  recomputed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_evidence_revision text;
  v_existing public.user_style_profiles%rowtype;
  v_profile_data jsonb;
  v_count bigint;
  v_max_updated_at timestamptz;
begin
  -- AUTHENTICATION IS STILL REQUIRED. The repair removes the K+ requirement,
  -- never the authorization boundary: with no auth.uid() there is no actor to
  -- derive a profile for, and this must stay a hard failure rather than
  -- degrade into an anonymous or ambient computation.
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- (The `if not public.has_active_k_plus() then raise 42501` gate that stood
  --  here in 20260830131956 / 20260830140000 is deliberately absent:
  --  SIGNATURE_STYLE_ENTITLEMENT=FREE.)

  select count(*), max(updated_at)
    into v_count, v_max_updated_at
    from public.user_closet_items
   where user_id = v_user_id
     and deleted_at is null;

  v_evidence_revision := case
    when v_count = 0 then 'empty:0'
    else to_char(v_max_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ':' || v_count::text
  end;

  select *
    into v_existing
    from public.user_style_profiles
   where user_id = v_user_id;

  if found
     and v_existing.profile_version = 1
     and v_existing.evidence_revision = v_evidence_revision
     -- A legacy or otherwise corrupt row must never be echoed back merely
     -- because its revision matches.  Rebuild it from Closet evidence below.
     and jsonb_typeof(v_existing.profile_data) = 'object'
     and jsonb_typeof(v_existing.profile_data -> 'evidenceCount') = 'number'
     and jsonb_typeof(v_existing.profile_data -> 'colorFrequency') = 'array'
     and jsonb_typeof(v_existing.profile_data -> 'categoryFrequency') = 'array'
     and jsonb_typeof(v_existing.profile_data -> 'garmentTypeFrequency') = 'array'
     and jsonb_typeof(v_existing.profile_data -> 'brandFrequency') = 'array'
     and jsonb_typeof(v_existing.profile_data -> 'materialFrequency') = 'array' then
    return query
      select v_existing.user_id, v_existing.profile_version, v_existing.evidence_revision,
             v_existing.derived_at, v_existing.profile_data, false;
    return;
  end if;

  select jsonb_build_object(
    'evidenceCount', v_count::integer,
    'colorFrequency', public.signature_style_frequency(array(
      select raw_value from (
        select primary_color as raw_value
          from public.user_closet_items
         where user_id = v_user_id and deleted_at is null
        union all
        select unnest(secondary_colors) as raw_value
          from public.user_closet_items
         where user_id = v_user_id and deleted_at is null
      ) as colors
    )),
    'categoryFrequency', public.signature_style_frequency(array(
      select category from public.user_closet_items
       where user_id = v_user_id and deleted_at is null
    )),
    'garmentTypeFrequency', public.signature_style_frequency(array(
      select clothing_type from public.user_closet_items
       where user_id = v_user_id and deleted_at is null
    )),
    'brandFrequency', public.signature_style_frequency(array(
      select brand from public.user_closet_items
       where user_id = v_user_id and deleted_at is null
    )),
    'materialFrequency', public.signature_style_frequency(array(
      select unnest(material) from public.user_closet_items
       where user_id = v_user_id and deleted_at is null
    ))
  ) into v_profile_data;

  insert into public.user_style_profiles (
    user_id, profile_version, evidence_revision, profile_data, derived_at
  ) values (
    v_user_id, 1, v_evidence_revision, v_profile_data, now()
  )
  on conflict (user_id) do update
    set profile_version = excluded.profile_version,
        evidence_revision = excluded.evidence_revision,
        profile_data = excluded.profile_data,
        derived_at = excluded.derived_at
  returning * into v_existing;

  return query
    select v_existing.user_id, v_existing.profile_version, v_existing.evidence_revision,
           v_existing.derived_at, v_existing.profile_data, true;
end;
$$;

comment on function public.recompute_signature_style() is
  'Build 34 entitlement boundary repair. SIGNATURE_STYLE_ENTITLEMENT=FREE: any AUTHENTICATED actor, K+ or free, may recompute their own Signature Style. Derives a bounded profile and evidence revision from auth.uid()''s own live user_closet_items rows. Accepts no client-authored profile payload, revision or user id, and can never read or write another actor''s data.';

-- Grants restated verbatim (idempotent): anon and public still cannot execute
-- this function, and nothing below broadens any privilege.
revoke all on function public.recompute_signature_style() from public, anon;
grant execute on function public.recompute_signature_style() to authenticated;
