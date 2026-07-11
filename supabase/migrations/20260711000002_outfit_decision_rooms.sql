-- AI Stylist expansion: Dressing Room outfit decisions.
--
-- MIGRATION SOURCE ONLY — not applied to any remote environment in this build.
--
-- Adds versioned/immutable outfit decision sharing to existing Dressing Rooms:
--   outfit_decision_groups        one question per share ("Which option works best?")
--   outfit_decision_options       1–3 complete outfit options (snapshot of a Look)
--   outfit_decision_option_items  ordered bounded item snapshots per option
--   outfit_decision_votes         one active vote per participant per group
--
-- Deletion semantics (documented per Part 10):
--   * Room deletion        → groups cascade → options cascade → items + votes cascade.
--   * Account deletion     → auth.users cascade removes the user's rooms (and
--                            therefore their decisions) plus any votes the user
--                            cast in other people's rooms. created_by is set
--                            null so a deleted creator never erases a decision
--                            in a legitimately remaining room.
--   * Participant deletion → only that user's vote rows are removed (user_id
--                            cascade); groups/options/snapshots are untouched.
--   * Source Look deletion → source_look_id set null; option snapshot remains.
--   * Source-item deletion → snapshots are copies; option items are untouched.
--
-- Immutability: RLS grants SELECT only. There are no client INSERT/UPDATE/
-- DELETE policies on groups/options/items; all writes flow through the
-- SECURITY DEFINER RPCs below. Editing a source Look never rewrites a shared
-- snapshot. Votes are written only through cast_outfit_decision_vote.
--
-- Reactions vs votes: existing dressing_room_item_reactions are untouched and
-- remain a separate, informal signal. Votes are the only formal decision input.

create extension if not exists pgcrypto;

-- ── Tables ────────────────────────────────────────────────────────────────────

create table if not exists public.outfit_decision_groups (
  id uuid primary key default gen_random_uuid(),
  dressing_room_id uuid not null references public.dressing_rooms(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  title text,
  question text not null,
  occasion text
    check (occasion is null or occasion in ('casual', 'work', 'date', 'event', 'travel', 'other')),
  status text not null default 'open'
    check (status in ('open', 'decided', 'closed')),
  chosen_option_id uuid,
  wearing_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outfit_decision_groups_question_not_blank check (length(btrim(question)) > 0),
  constraint outfit_decision_groups_question_bounded check (length(btrim(question)) <= 140),
  constraint outfit_decision_groups_title_bounded check (title is null or length(btrim(title)) <= 80)
);

create table if not exists public.outfit_decision_options (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.outfit_decision_groups(id) on delete cascade,
  source_type text not null default 'manual_look'
    check (source_type in ('manual_look', 'ai_suggestion')),
  source_look_id uuid references public.looks(id) on delete set null,
  source_suggestion_id uuid,
  title text,
  explanation text
    check (explanation is null or length(btrim(explanation)) <= 400),
  variation text
    check (variation is null or variation in ('reliable', 'elevated', 'something_different')),
  sort_order integer not null default 0,
  snapshot_version integer not null default 2
    check (snapshot_version > 0),
  created_at timestamptz not null default now(),
  -- Composite uniqueness lets votes carry a (option_id, group_id) pair that
  -- provably belongs together.
  constraint outfit_decision_options_id_group_key unique (id, group_id)
);

-- The chosen option must belong to the same group.
alter table public.outfit_decision_groups
  drop constraint if exists outfit_decision_groups_chosen_option_fk;
alter table public.outfit_decision_groups
  add constraint outfit_decision_groups_chosen_option_fk
  foreign key (chosen_option_id, id)
  references public.outfit_decision_options (id, group_id)
  on delete set null (chosen_option_id);

create table if not exists public.outfit_decision_option_items (
  id uuid primary key default gen_random_uuid(),
  option_id uuid not null references public.outfit_decision_options(id) on delete cascade,
  source_type text
    check (
      source_type is null
      or source_type in ('dressing_room_item', 'saved_scan', 'inspiration_item')
    ),
  source_saved_scan_id uuid references public.saved_scans(id) on delete set null,
  source_inspiration_item_id uuid references public.inspiration_items(id) on delete set null,
  item_role text,
  sort_order integer not null default 0,
  snapshot_version integer not null default 2 check (snapshot_version > 0),
  snapshot_payload jsonb not null,
  image_url text,
  storage_bucket text,
  storage_path text,
  created_at timestamptz not null default now(),
  constraint outfit_decision_option_items_snapshot_object
    check (jsonb_typeof(snapshot_payload) = 'object'),
  constraint outfit_decision_option_items_remote_image_only
    check (image_url is null or image_url ~* '^https?://')
);

create table if not exists public.outfit_decision_votes (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.outfit_decision_groups(id) on delete cascade,
  option_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One active vote per participant per decision group.
  constraint outfit_decision_votes_group_user_key unique (group_id, user_id),
  -- option_id and group_id cannot refer to different groups.
  constraint outfit_decision_votes_option_in_group_fk
    foreign key (option_id, group_id)
    references public.outfit_decision_options (id, group_id)
    on delete cascade
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

create index if not exists outfit_decision_groups_room_created_idx
  on public.outfit_decision_groups (dressing_room_id, created_at desc);

create index if not exists outfit_decision_options_group_sort_idx
  on public.outfit_decision_options (group_id, sort_order asc);

create index if not exists outfit_decision_option_items_option_sort_idx
  on public.outfit_decision_option_items (option_id, sort_order asc);

create index if not exists outfit_decision_votes_group_idx
  on public.outfit_decision_votes (group_id);

create index if not exists outfit_decision_votes_option_idx
  on public.outfit_decision_votes (option_id);

create index if not exists outfit_decision_votes_user_idx
  on public.outfit_decision_votes (user_id);

-- ── updated_at triggers (reuse existing helper) ───────────────────────────────

drop trigger if exists outfit_decision_groups_set_updated_at on public.outfit_decision_groups;
create trigger outfit_decision_groups_set_updated_at
before update on public.outfit_decision_groups
for each row
execute function public.set_style_objects_updated_at();

drop trigger if exists outfit_decision_votes_set_updated_at on public.outfit_decision_votes;
create trigger outfit_decision_votes_set_updated_at
before update on public.outfit_decision_votes
for each row
execute function public.set_style_objects_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Read access: room owner OR authenticated participant (reuses the existing
-- SECURITY DEFINER owner-or-participant helper). No client write policies:
-- with RLS enabled and no policy, all direct client writes are denied and all
-- mutations flow through the RPCs below. Public visitors never read these
-- tables directly; they use the sanitized token RPC.

alter table public.outfit_decision_groups enable row level security;
alter table public.outfit_decision_options enable row level security;
alter table public.outfit_decision_option_items enable row level security;
alter table public.outfit_decision_votes enable row level security;

revoke all on public.outfit_decision_groups from anon, public;
revoke all on public.outfit_decision_options from anon, public;
revoke all on public.outfit_decision_option_items from anon, public;
revoke all on public.outfit_decision_votes from anon, public;

grant select on public.outfit_decision_groups to authenticated;
grant select on public.outfit_decision_options to authenticated;
grant select on public.outfit_decision_option_items to authenticated;
grant select on public.outfit_decision_votes to authenticated;

drop policy if exists "Room members can read outfit decision groups" on public.outfit_decision_groups;
create policy "Room members can read outfit decision groups"
on public.outfit_decision_groups
for select
to authenticated
using (public.can_access_room_messages(dressing_room_id));

drop policy if exists "Room members can read outfit decision options" on public.outfit_decision_options;
create policy "Room members can read outfit decision options"
on public.outfit_decision_options
for select
to authenticated
using (
  exists (
    select 1 from public.outfit_decision_groups g
    where g.id = group_id
      and public.can_access_room_messages(g.dressing_room_id)
  )
);

drop policy if exists "Room members can read outfit decision option items" on public.outfit_decision_option_items;
create policy "Room members can read outfit decision option items"
on public.outfit_decision_option_items
for select
to authenticated
using (
  exists (
    select 1
    from public.outfit_decision_options o
    join public.outfit_decision_groups g on g.id = o.group_id
    where o.id = option_id
      and public.can_access_room_messages(g.dressing_room_id)
  )
);

-- Votes: a user may read only their own vote row. Aggregate counts come from
-- the SECURITY DEFINER counts RPC so voter identities are never enumerated.
drop policy if exists "Users can read own outfit decision votes" on public.outfit_decision_votes;
create policy "Users can read own outfit decision votes"
on public.outfit_decision_votes
for select
to authenticated
using (user_id = auth.uid());

-- ── RPC: share one or more Looks as an outfit decision ───────────────────────
-- Owner-only. p_look_ids preserves the order chosen by the owner (for AI
-- options the client passes canonical variation order). Snapshots are copied
-- from look_items at share time; later Look edits/deletes never rewrite them.

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
  group_id uuid;
  look_id uuid;
  option_id uuid;
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

  select count(distinct look_id) into distinct_count
  from unnest(p_look_ids) as look_id;
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
  returning id into group_id;

  foreach look_id in array p_look_ids
  loop
    select * into look_row
    from public.looks
    where id = look_id
      and user_id = current_user_id;

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
      group_id,
      case when look_row.source = 'ai' then 'ai_suggestion' else 'manual_look' end,
      look_row.id,
      look_row.title,
      look_row.explanation,
      null,
      look_index
    )
    returning id into option_id;

    insert into public.outfit_decision_option_items (
      option_id, source_type, source_saved_scan_id, source_inspiration_item_id,
      item_role, sort_order, snapshot_version, snapshot_payload,
      image_url, storage_bucket, storage_path
    )
    select
      option_id,
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
  where id = group_id;

  return group_id;
end;
$$;

revoke all on function public.share_looks_to_outfit_decision(uuid, uuid[], text, text) from public;
revoke all on function public.share_looks_to_outfit_decision(uuid, uuid[], text, text) from anon;
grant execute on function public.share_looks_to_outfit_decision(uuid, uuid[], text, text) to authenticated;

-- ── RPC: cast or change a vote ────────────────────────────────────────────────
-- Owner-or-participant only, open decisions only. Upsert keeps one active
-- vote per user per group; changing a vote updates the same row atomically.

create or replace function public.cast_outfit_decision_vote(
  p_group_id uuid,
  p_option_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  group_row public.outfit_decision_groups;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into group_row
  from public.outfit_decision_groups
  where id = p_group_id;

  if not found or not public.can_access_room_messages(group_row.dressing_room_id) then
    raise exception 'Decision not found' using errcode = '42501';
  end if;

  if group_row.status <> 'open' then
    raise exception 'This decision is closed' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.outfit_decision_options o
    where o.id = p_option_id and o.group_id = p_group_id
  ) then
    raise exception 'Option not found' using errcode = '22023';
  end if;

  insert into public.outfit_decision_votes (group_id, option_id, user_id)
  values (p_group_id, p_option_id, current_user_id)
  on conflict (group_id, user_id)
  do update set option_id = excluded.option_id, updated_at = now();
end;
$$;

revoke all on function public.cast_outfit_decision_vote(uuid, uuid) from public;
revoke all on function public.cast_outfit_decision_vote(uuid, uuid) from anon;
grant execute on function public.cast_outfit_decision_vote(uuid, uuid) to authenticated;

-- ── RPC: aggregate vote counts (no voter identities) ─────────────────────────

create or replace function public.get_outfit_decision_vote_counts(p_group_id uuid)
returns table (option_id uuid, vote_count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  room_id uuid;
begin
  select g.dressing_room_id into room_id
  from public.outfit_decision_groups g
  where g.id = p_group_id;

  if room_id is null or not public.can_access_room_messages(room_id) then
    raise exception 'Decision not found' using errcode = '42501';
  end if;

  return query
  select o.id, count(v.id)::bigint
  from public.outfit_decision_options o
  left join public.outfit_decision_votes v on v.option_id = o.id
  where o.group_id = p_group_id
  group by o.id;
end;
$$;

revoke all on function public.get_outfit_decision_vote_counts(uuid) from public;
revoke all on function public.get_outfit_decision_vote_counts(uuid) from anon;
grant execute on function public.get_outfit_decision_vote_counts(uuid) to authenticated;

-- ── RPC: owner decision (winner / wearing / close / reopen) ───────────────────

create or replace function public.set_outfit_decision_state(
  p_group_id uuid,
  p_action text,
  p_option_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  group_row public.outfit_decision_groups;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select g.* into group_row
  from public.outfit_decision_groups g
  join public.dressing_rooms dr on dr.id = g.dressing_room_id
  where g.id = p_group_id
    and dr.user_id = current_user_id
  for update;

  if not found then
    raise exception 'Only the room owner can decide' using errcode = '42501';
  end if;

  if p_action = 'choose_winner' then
    if p_option_id is null or not exists (
      select 1 from public.outfit_decision_options o
      where o.id = p_option_id and o.group_id = p_group_id
    ) then
      raise exception 'Option not found' using errcode = '22023';
    end if;
    update public.outfit_decision_groups
    set chosen_option_id = p_option_id, status = 'decided'
    where id = p_group_id;
  elsif p_action = 'confirm_wearing' then
    if group_row.chosen_option_id is null then
      raise exception 'Choose an option first' using errcode = '22023';
    end if;
    update public.outfit_decision_groups
    set wearing_confirmed_at = now(), status = 'decided'
    where id = p_group_id;
  elsif p_action = 'close' then
    update public.outfit_decision_groups
    set status = 'closed'
    where id = p_group_id;
  elsif p_action = 'reopen' then
    update public.outfit_decision_groups
    set status = 'open', chosen_option_id = null, wearing_confirmed_at = null
    where id = p_group_id;
  else
    raise exception 'Unknown action' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.set_outfit_decision_state(uuid, text, uuid) from public;
revoke all on function public.set_outfit_decision_state(uuid, text, uuid) from anon;
grant execute on function public.set_outfit_decision_state(uuid, text, uuid) to authenticated;

-- ── RPC: sanitized public decision preview (token-gated, read-only) ──────────
-- New function; the existing get_public_room_preview contract is unchanged so
-- current consumers (including the external kscan.app preview) keep working.
-- Returns aggregate counts only — never voter or participant identities, never
-- owner user ids, never snapshot internals beyond display fields.

create or replace function public.get_public_room_decision_preview(p_share_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_token text := nullif(btrim(coalesce(p_share_token, '')), '');
  target_room_id uuid;
  decisions jsonb := '[]'::jsonb;
begin
  if normalized_token is null or normalized_token !~ '^[A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 'malformed');
  end if;

  select rs.room_id into target_room_id
  from public.room_shares rs
  where rs.share_token = normalized_token
    and rs.access_level = 'view'
    and rs.is_active = true
    and rs.revoked_at is null
    and (rs.expires_at is null or rs.expires_at > now())
  limit 1;

  if target_room_id is null then
    return jsonb_build_object('status', 'unavailable');
  end if;

  select coalesce(jsonb_agg(decision_obj order by created_at desc), '[]'::jsonb)
  into decisions
  from (
    select
      g.created_at,
      jsonb_build_object(
        'groupId', g.id,
        'question', left(regexp_replace(coalesce(g.question, ''), '<[^>]*>', '', 'g'), 140),
        'status', g.status,
        'occasion', g.occasion,
        'chosenOptionId', g.chosen_option_id,
        'wearingConfirmed', g.wearing_confirmed_at is not null,
        'options', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'optionId', o.id,
              'title', left(regexp_replace(coalesce(o.title, ''), '<[^>]*>', '', 'g'), 80),
              'explanation', left(regexp_replace(coalesce(o.explanation, ''), '<[^>]*>', '', 'g'), 400),
              'variation', o.variation,
              'sortOrder', o.sort_order,
              'voteCount', (
                select count(*) from public.outfit_decision_votes v
                where v.option_id = o.id
              ),
              'items', (
                select coalesce(jsonb_agg(
                  jsonb_build_object(
                    'title', left(regexp_replace(coalesce(oi.snapshot_payload ->> 'title', ''), '<[^>]*>', '', 'g'), 80),
                    'category', nullif(btrim(coalesce(oi.snapshot_payload ->> 'category', '')), ''),
                    'color', nullif(btrim(coalesce(oi.snapshot_payload ->> 'color', '')), ''),
                    'itemRole', oi.item_role,
                    'sortOrder', oi.sort_order,
                    'imageUrl', case when oi.image_url ~* '^https?://' then oi.image_url else null end
                  )
                  order by oi.sort_order asc
                ), '[]'::jsonb)
                from public.outfit_decision_option_items oi
                where oi.option_id = o.id
              )
            )
            order by o.sort_order asc
          ), '[]'::jsonb)
          from public.outfit_decision_options o
          where o.group_id = g.id
        )
      ) as decision_obj
    from public.outfit_decision_groups g
    where g.dressing_room_id = target_room_id
  ) sub;

  return jsonb_build_object(
    'status', 'available',
    'decisions', decisions
  );
end;
$$;

revoke all on function public.get_public_room_decision_preview(text) from public;
grant execute on function public.get_public_room_decision_preview(text) to anon, authenticated;
