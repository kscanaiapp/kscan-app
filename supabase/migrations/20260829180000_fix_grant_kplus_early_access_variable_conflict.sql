-- Fix a real bug in grant_kplus_early_access found during staging runtime
-- validation of the K+ complimentary foundation (2026-08-29), never caught
-- locally because the pgTAP suite could not run without a local Docker
-- stack: `v_row public.user_entitlements;` is a row-typed variable, and
-- PL/pgSQL's default `variable_conflict = error` behavior treats any bare
-- reference to one of that row type's field names (here, `entitlement_key`,
-- used in the ON CONFLICT target and the INSERT column list) as ambiguous
-- between the table column and the row variable's field -- raising
-- "42702: column reference entitlement_key is ambiguous" on every call.
--
-- `#variable_conflict use_column` tells PL/pgSQL to prefer the table column
-- in exactly that ambiguous case. Safe here because every other reference to
-- v_row's fields in this function is already dot-qualified (v_row.status,
-- v_row.expires_at, etc.), so this pragma changes nothing about how those
-- resolve -- it only resolves the previously-broken bare references.
--
-- Forward-only. 20260829120000_kplus_entitlements.sql is not edited.

create or replace function public.grant_kplus_early_access(p_user_id uuid)
returns table (
  entitlement_key text,
  status          text,
  grant_reason    text,
  campaign_key    text,
  granted_at      timestamptz,
  expires_at      timestamptz,
  newly_granted   boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_campaign_key    constant text := 'kplus_early_access_2026';
  v_entitlement_key constant text := 'k_plus';
  v_terms_version   constant text := 'kplus_early_access_v1';
  v_now             timestamptz := now();
  v_row             public.user_entitlements;
  v_inserted        boolean := false;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22004';
  end if;

  insert into public.user_entitlements (
    user_id, entitlement_key, status, grant_reason, campaign_key,
    granted_at, expires_at, acknowledged_at, terms_version, external_sync_status
  )
  values (
    p_user_id, v_entitlement_key, 'active', 'complimentary_early_access', v_campaign_key,
    v_now, v_now + interval '6 months', v_now, v_terms_version, 'pending'
  )
  on conflict (user_id, entitlement_key) do nothing
  returning * into v_row;

  if found then
    v_inserted := true;
  else
    select * into v_row
      from public.user_entitlements
     where user_id = p_user_id and entitlement_key = v_entitlement_key;
  end if;

  insert into public.kplus_activation_events (user_id, event_type, campaign_key, entitlement_key, detail)
  values (
    p_user_id,
    case
      when v_inserted then 'activation_granted'
      when v_row.status = 'active' and v_row.expires_at is not null and v_row.expires_at > v_now
        then 'activation_already_active'
      else 'activation_campaign_consumed'
    end,
    v_campaign_key,
    v_entitlement_key,
    jsonb_build_object('newly_granted', v_inserted)
  );

  return query select
    v_row.entitlement_key, v_row.status, v_row.grant_reason, v_row.campaign_key,
    v_row.granted_at, v_row.expires_at, v_inserted;
end;
$$;

revoke all on function public.grant_kplus_early_access(uuid) from public, anon, authenticated;
grant execute on function public.grant_kplus_early_access(uuid) to service_role;
