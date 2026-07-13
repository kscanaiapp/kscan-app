-- Restore service-role Data API access for server-side Supabase clients.
--
-- Several hardening migrations revoke broad public grants from app tables. That
-- is correct for anon/authenticated clients, but Supabase service-role clients
-- still need explicit table privileges in addition to BYPASSRLS. Without these
-- grants, Edge Functions and deletion tooling that use SUPABASE_SERVICE_ROLE_KEY
-- fail with PostgREST 42501 permission errors before ownership checks run.

grant usage on schema public to service_role;

-- Restore the minimum Data API privileges service-role clients need.
-- Edge Functions and deletion tooling read, insert, update, and delete rows;
-- they do not need TRUNCATE, REFERENCES, or TRIGGER on app tables, and the
-- current schema uses gen_random_uuid() rather than sequences.
grant select, insert, update, delete on all tables in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

-- The preceding room-share remediation migration owns the complete nullable
-- redemption contract. Do not restate or narrow it in this grant repair.

-- Expose existing RLS-protected Look tables to authenticated REST clients.
-- The policies already restrict every operation to rows owned by auth.uid().
grant select, insert, update, delete on table public.looks, public.look_items to authenticated;

-- Fix a PL/pgSQL variable/alias collision that makes decision sharing fail
-- at runtime with "column reference \"look_id\" is ambiguous".
create or replace function public.share_looks_to_outfit_decision(
  p_room_id uuid,
  p_look_ids uuid[],
  p_question text,
  p_title text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  look_count integer;
  distinct_count integer;
  created_group_id uuid;
  requested_look_id uuid;
  created_option_id uuid;
  look_row public.looks;
  look_index integer := 0;
  first_occasion text := null;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_room_id is null then
    raise exception 'Dressing room is required' using errcode = '22023';
  end if;

  if length(btrim(coalesce(p_question, ''))) = 0 then
    raise exception 'A question is required' using errcode = '22023';
  end if;

  look_count := coalesce(array_length(p_look_ids, 1), 0);
  if look_count < 1 or look_count > 3 then
    raise exception 'Share between 1 and 3 Looks' using errcode = '22023';
  end if;

  select count(distinct requested.value) into distinct_count
  from unnest(p_look_ids) as requested(value);
  if distinct_count <> look_count then
    raise exception 'Duplicate Looks are not allowed' using errcode = '22023';
  end if;

  -- Only the room owner shares decisions.
  if not exists (
    select 1 from public.dressing_rooms dr
    where dr.id = p_room_id and dr.user_id = current_user_id
  ) then
    raise exception 'Dressing room not found' using errcode = '42501';
  end if;

  insert into public.outfit_decision_groups (dressing_room_id, created_by, title, question)
  values (
    p_room_id,
    current_user_id,
    nullif(btrim(coalesce(p_title, '')), ''),
    btrim(p_question)
  )
  returning id into created_group_id;

  foreach requested_look_id in array p_look_ids
  loop
    select * into look_row
    from public.looks l
    where l.id = requested_look_id
      and l.user_id = current_user_id;

    if not found then
      raise exception 'One or more Looks are unavailable' using errcode = '42501';
    end if;

    if not exists (select 1 from public.look_items li where li.look_id = look_row.id) then
      raise exception 'One or more Looks have no items' using errcode = '22023';
    end if;

    if first_occasion is null then
      first_occasion := look_row.occasion;
    end if;

    insert into public.outfit_decision_options (
      group_id, source_type, source_look_id, title, explanation, variation, sort_order
    )
    values (
      created_group_id,
      case when look_row.source = 'ai' then 'ai_suggestion' else 'manual_look' end,
      look_row.id,
      look_row.title,
      look_row.explanation,
      null,
      look_index
    )
    returning id into created_option_id;

    insert into public.outfit_decision_option_items (
      option_id, source_type, source_saved_scan_id, source_inspiration_item_id,
      item_role, sort_order, snapshot_version, snapshot_payload,
      image_url, storage_bucket, storage_path
    )
    select
      created_option_id,
      coalesce(li.source_type, 'dressing_room_item'),
      li.source_saved_scan_id,
      li.source_inspiration_item_id,
      li.item_role,
      li.sort_order,
      li.snapshot_version,
      li.snapshot_payload,
      case when li.image_url ~* '^https?://' then li.image_url else null end,
      li.storage_bucket,
      li.storage_path
    from public.look_items li
    where li.look_id = look_row.id
    order by li.sort_order asc, li.created_at asc;

    look_index := look_index + 1;
  end loop;

  update public.outfit_decision_groups
  set occasion = first_occasion
  where id = created_group_id;

  return created_group_id;
end;
$$;

revoke all on function public.share_looks_to_outfit_decision(uuid, uuid[], text, text) from public;
revoke all on function public.share_looks_to_outfit_decision(uuid, uuid[], text, text) from anon;
grant execute on function public.share_looks_to_outfit_decision(uuid, uuid[], text, text) to authenticated;
