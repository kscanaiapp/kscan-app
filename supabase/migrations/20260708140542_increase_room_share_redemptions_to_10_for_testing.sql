-- Temporary testing adjustment.
-- Increases Dressing Room share-link redemptions from 2 to 10 for closed-beta QA.
-- Generated after remote schema inspection because prior repo migrations did not contain the active redemption-limit source.
-- Revert to 2 or another owner-approved production value before broader public launch.

CREATE OR REPLACE FUNCTION public.create_or_get_room_share(p_room_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  current_user_id uuid := auth.uid();
  existing_token text;
  new_token text;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_room_id is null then
    raise exception 'Dressing room is required' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.dressing_rooms dr
    where dr.id = p_room_id
      and dr.user_id = current_user_id
  ) then
    raise exception 'Dressing room not found' using errcode = '42501';
  end if;

  select rs.share_token
  into existing_token
  from public.room_shares rs
  where rs.room_id = p_room_id
    and rs.owner_id = current_user_id
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  order by rs.created_at desc
  limit 1;

  if existing_token is not null then
    return existing_token;
  end if;

  new_token := gen_random_uuid()::text;

  begin
    insert into public.room_shares (room_id, owner_id, share_token, access_level, max_redemptions)
    values (p_room_id, current_user_id, new_token, 'view', 10)
    returning share_token into existing_token;
  exception
    when unique_violation then
      select rs.share_token
      into existing_token
      from public.room_shares rs
      where rs.room_id = p_room_id
        and rs.owner_id = current_user_id
        and rs.is_active = true
        and rs.revoked_at is null
        and (rs.expires_at is null or rs.expires_at > now())
      order by rs.created_at desc
      limit 1;
  end;

  if existing_token is null then
    raise exception 'Unable to create shared room link' using errcode = '40001';
  end if;

  return existing_token;
end;
$function$;
