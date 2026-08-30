-- Build 34 / Track B / Phase B5 — Style DNA profile write RPC.
--
-- B4's user_style_profiles migration (20260830060000) deliberately grants
-- INSERT/UPDATE only to service_role, not authenticated -- the same posture
-- public.user_entitlements already established. B5 is the first real caller
-- (stylechat-generate's Style DNA read-or-recompute path,
-- supabase/functions/_shared/styleDna/styleDnaProfileStore.ts), and it must
-- write using the caller's own JWT-scoped client, never a raw service-role
-- key inside an Edge Function that never needed one before.
--
-- The resolution is the SAME SECURITY DEFINER RPC pattern
-- public.has_active_k_plus() and public.grant_kplus_early_access() already
-- established: one narrow function, callable only by `authenticated`, that
-- derives the caller's identity from auth.uid() itself so no argument can
-- ever forge another user's profile write.

create or replace function public.upsert_style_dna_profile(
  p_profile_version   integer,
  p_evidence_revision text,
  p_profile_data      jsonb
)
returns table (
  user_id           uuid,
  profile_version   integer,
  evidence_revision text,
  derived_at        timestamptz,
  profile_data      jsonb
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
-- Without this pragma, the RETURNS TABLE column names (user_id,
-- profile_version, ...) become PL/pgSQL variables that shadow the identically
-- named table columns, making `on conflict (user_id)` and the `returning`
-- list ambiguous (caught live on staging: 42702 "column reference user_id is
-- ambiguous"). This directive tells PL/pgSQL to prefer the table column on
-- any such collision within this function body.
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  return query
  insert into public.user_style_profiles (user_id, profile_version, evidence_revision, profile_data, derived_at)
  values (v_user_id, p_profile_version, p_evidence_revision, p_profile_data, now())
  on conflict (user_id) do update
    set profile_version   = excluded.profile_version,
        evidence_revision = excluded.evidence_revision,
        profile_data      = excluded.profile_data,
        derived_at         = excluded.derived_at
  returning
    user_style_profiles.user_id,
    user_style_profiles.profile_version,
    user_style_profiles.evidence_revision,
    user_style_profiles.derived_at,
    user_style_profiles.profile_data;
end;
$$;

comment on function public.upsert_style_dna_profile(integer, text, jsonb) is
  'Build 34 Track B B5. The only way an authenticated caller may write their own user_style_profiles row. Identity is derived from auth.uid(), never a parameter -- a caller can only ever write their own row.';

revoke all on function public.upsert_style_dna_profile(integer, text, jsonb) from public, anon;
grant execute on function public.upsert_style_dna_profile(integer, text, jsonb) to authenticated;
