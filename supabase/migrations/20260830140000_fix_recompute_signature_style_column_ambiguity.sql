-- Build 34 / Track B integration closure — live bug fix.
--
-- CAUGHT ON STAGING: recompute_signature_style() (20260830131956) failed on
-- its very first query for every caller:
--
--   ERROR:  42702: column reference "user_id" is ambiguous
--   DETAIL:  It could refer to either a PL/pgSQL variable or a table column.
--   QUERY:  select count(*), max(updated_at)
--                                          from public.user_closet_items
--      where user_id = v_user_id
--            and deleted_at is null
--
-- Root cause is the SAME class the earlier upsert_style_dna_profile fix
-- (20260830070000 -> its own follow-up fix) already closed once: a
-- `RETURNS TABLE(user_id uuid, ...)` declares `user_id` as an implicit
-- PL/pgSQL OUT-parameter/variable, and Postgres's default plpgsql behavior
-- (`#variable_conflict error`) refuses ANY bare `user_id` reference inside
-- the function body that could mean either that variable or a same-named
-- table column — not only inside RETURNING/ON CONFLICT, as the earlier fix's
-- comment implied, but in an ordinary `where user_id = ...` clause too. This
-- function has FOUR such bare references (`user_closet_items.user_id`
-- three times across the evidence query and the frequency subqueries) plus
-- the `insert ... (user_id, ...) ... on conflict (user_id)` from the earlier
-- fix's own precedent.
--
-- Repair: the same `#variable_conflict use_column` pragma, which tells
-- PL/pgSQL to prefer the table column on any such collision within this
-- function body -- verified live afterward (see the staging authority proof
-- in docs/build34-trackb-b4-style-dna-ledger.md) with a real
-- K+ actor's own Closet evidence.

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
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if not public.has_active_k_plus() then
    raise exception 'active K+ entitlement required' using errcode = '42501';
  end if;

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
  'Build 34 Track B integration closure. Authenticated K+ actor only; derives a bounded Signature Style profile and evidence revision from auth.uid()''s live user_closet_items rows. Accepts no client-authored profile payload or revision.';

revoke all on function public.recompute_signature_style() from public, anon;
grant execute on function public.recompute_signature_style() to authenticated;
