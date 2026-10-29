-- B35-C-005: current permission is revocable; historical legal receipts stay immutable.
-- Source only. Apply through the protected migration promotion workflow before
-- deploying the Gemini gate that reads this table. No receipt backfill or rewrite.
begin;

create table public.ai_processing_permissions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  policy_version text not null check (policy_version = 'v2_google_gemini'),
  granted boolean not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);
alter table public.ai_processing_permissions enable row level security;
create policy ai_processing_permission_own_read on public.ai_processing_permissions
  for select to authenticated using (user_id = auth.uid());
revoke all on public.ai_processing_permissions from public, anon, authenticated;
grant select on public.ai_processing_permissions to authenticated, service_role;

create function public.get_ai_processing_permission(p_expected_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_granted boolean;
begin
  if v_actor is null or p_expected_user_id is distinct from v_actor then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select exists(select 1 from public.legal_acceptances l
    where l.user_id = v_actor and l.acceptance_type = 'ai_processing'
      and l.policy_version = 'v2_google_gemini')
    and coalesce((select p.granted from public.ai_processing_permissions p where p.user_id = v_actor), true)
    into v_granted;
  return jsonb_build_object('user_id', v_actor, 'policy_version', 'v2_google_gemini', 'granted', v_granted,
    'revision', coalesce((select p.revision from public.ai_processing_permissions p where p.user_id = v_actor), 0));
end;
$$;

create function public.set_ai_processing_permission(p_expected_user_id uuid, p_granted boolean, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_revision bigint; v_changed integer;
begin
  -- Expected identity is an account-switch fence, never an ownership selector.
  if v_actor is null or p_expected_user_id is distinct from v_actor then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_granted is null then raise exception 'Invalid permission' using errcode = '22023'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid revision' using errcode = '22023';
  end if;
  if p_granted and not exists(select 1 from public.legal_acceptances l
    where l.user_id = v_actor and l.acceptance_type = 'ai_processing'
      and l.policy_version = 'v2_google_gemini') then
    raise exception 'Current disclosure acknowledgment required' using errcode = '42501';
  end if;
  select p.revision into v_revision from public.ai_processing_permissions p where p.user_id = v_actor;
  if v_revision is null and p_expected_revision <> 0 then
    raise exception 'Permission changed; refresh status' using errcode = '40001';
  end if;
  insert into public.ai_processing_permissions(user_id, policy_version, granted)
    values(v_actor, 'v2_google_gemini', p_granted)
    on conflict(user_id) do update set granted = excluded.granted,
      policy_version = excluded.policy_version, updated_at = now(),
      revision = public.ai_processing_permissions.revision + 1
    where public.ai_processing_permissions.revision = p_expected_revision
      or (not p_granted and not public.ai_processing_permissions.granted);
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'Permission changed; refresh status' using errcode = '40001';
  end if;
  return public.get_ai_processing_permission(v_actor);
end;
$$;
revoke all on function public.get_ai_processing_permission(uuid) from public, anon;
revoke all on function public.set_ai_processing_permission(uuid, boolean, bigint) from public, anon;
grant execute on function public.get_ai_processing_permission(uuid) to authenticated;
grant execute on function public.set_ai_processing_permission(uuid, boolean, bigint) to authenticated;
commit;
