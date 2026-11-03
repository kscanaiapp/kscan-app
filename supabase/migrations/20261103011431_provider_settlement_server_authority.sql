-- B35-F-025: only the governed backend may settle provider cost accounting.
-- Source-only until separately approved single-version migration application.
revoke execute on function public.complete_provider_request(uuid) from public, anon, authenticated;
revoke execute on function public.release_provider_request(uuid, text) from public, anon, authenticated;

create or replace function public.settle_provider_request_for_actor(
  p_user_id uuid,
  p_reservation_id uuid,
  p_function_name text,
  p_billable boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_user_id is null or p_reservation_id is null or p_function_name is null
     or p_billable is null then
    return false;
  end if;
  update public.provider_request_reservations
     set status = case when p_billable then 'completed' else 'released' end,
         completed_at = now()
   where id = p_reservation_id
     and user_id = p_user_id
     and function_name = p_function_name
     and status = 'reserved';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke execute on function public.settle_provider_request_for_actor(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.settle_provider_request_for_actor(uuid, uuid, text, boolean)
  to service_role;
