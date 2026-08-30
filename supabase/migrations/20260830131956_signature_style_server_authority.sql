-- Build 34 / Track B integration closure: Signature Style server authority.
--
-- `upsert_style_dna_profile` was an identity-safe but payload-unsafe RPC: an
-- authenticated caller could still provide the profile and evidence revision
-- that it persisted.  This migration removes authenticated access to that
-- contract and replaces it with the sole public write path below.  The new
-- function accepts no payload or user id: it derives both from auth.uid() and
-- that actor's live Closet evidence inside the trusted database boundary.

revoke all on function public.upsert_style_dna_profile(integer, text, jsonb)
  from public, anon, authenticated;

-- One deterministic building block for the bounded frequency lists in the
-- persisted profile.  This is server-only implementation detail; it receives
-- values selected by recompute_signature_style, never client JSON.
create or replace function public.signature_style_frequency(p_values text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('value', ranked.display_value, 'count', ranked.value_count)
      order by ranked.value_count desc, ranked.display_value asc
    ),
    '[]'::jsonb
  )
  from (
    select
      min(btrim(raw_value)) as display_value,
      count(*)::integer as value_count
    from unnest(coalesce(p_values, '{}'::text[])) as values(raw_value)
    where nullif(btrim(raw_value), '') is not null
    group by lower(btrim(raw_value))
    order by count(*) desc, min(btrim(raw_value)) asc
    limit 10
  ) as ranked;
$$;

revoke all on function public.signature_style_frequency(text[])
  from public, anon, authenticated;

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
     and v_existing.evidence_revision = v_evidence_revision then
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
