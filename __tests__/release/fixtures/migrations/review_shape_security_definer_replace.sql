-- Fixture: review shape. Redefines a pre-existing SECURITY DEFINER function
-- body under an unchanged signature -- the dominant real-world risk shape in
-- this repository, which a signature-only diff would miss entirely.
create or replace function public.get_item_reaction_counts(p_item_id uuid)
returns table (reaction text, count bigint)
language sql
security definer
set search_path = public
as $$
  select r.reaction, count(*)::bigint
  from public.dressing_room_item_reactions r
  where r.item_id = p_item_id
  group by r.reaction;
$$;
