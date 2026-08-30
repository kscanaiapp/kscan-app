-- Build 34 / Track B / Phase B4 — server-derived Style DNA profile.
--
-- One compact, deterministic, versioned wardrobe-evidence summary per user,
-- derived entirely from this user's own non-tombstoned public.user_closet_items
-- rows (Build 34 Track B B1A/B1C). This table stores the DERIVED SUMMARY only:
-- aggregate frequencies and counts. It never stores item ids, storage paths,
-- raw notes, or any per-item record -- see the CHECK constraints below and
-- the application-layer derivation module
-- (supabase/functions/_shared/styleDna/styleDnaProfileDerivation.ts) that is
-- the only writer.
--
-- Mutation is service_role only, exactly like public.user_entitlements:
-- authenticated users may SELECT their own row; there is no INSERT/UPDATE/
-- DELETE policy for anon or authenticated at all. The profile is computed and
-- upserted by trusted server code (stylechat-generate's Style DNA read path)
-- using the service-role client, never by a client-supplied payload.
--
-- Evidence revision, not a naive item count: two Closets can share a count but
-- differ in content, so `evidence_revision` is a deterministic function of the
-- user's current non-tombstoned Closet evidence (see
-- styleDnaEvidenceRevision.ts) -- comparing it to the stored value is what lets
-- the read path decide "reuse" vs "recompute" without any scheduler, cron, or
-- per-edit recompute.
--
-- Deletion: `on delete cascade` from auth.users removes this row unconditionally
-- and independently of K+ status -- see supabase/functions/_shared/deletion/
-- userDataResources.ts, which this migration's own coverage-scan test requires
-- to list this table.

create table if not exists public.user_style_profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  -- Schema/derivation contract version. Bumped only when the SHAPE of
  -- profile_data changes in a way old readers cannot safely interpret.
  profile_version   integer not null default 1
                      check (profile_version > 0),
  -- Deterministic fingerprint of the non-tombstoned Closet evidence this
  -- profile was derived from (see styleDnaEvidenceRevision.ts). Never a raw
  -- row_version or a client-supplied value.
  evidence_revision text not null
                      check (char_length(evidence_revision) between 1 and 200),
  derived_at        timestamptz not null default now(),
  -- Bounded aggregate summary ONLY: color/category/garment-type/brand/material
  -- frequencies and an evidence count. No item ids, no storage paths, no raw
  -- notes, no per-item history. See styleDnaProfileDerivation.ts for the exact
  -- shape this application layer writes.
  profile_data      jsonb not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint user_style_profiles_data_is_object
    check (jsonb_typeof(profile_data) = 'object'),
  -- 64 KiB safety bound (Micro-addendum H). A soft engineering expectation,
  -- not a product target -- a compact aggregate summary should sit far below
  -- this. Enforced at the database layer as a belt-and-suspenders backstop to
  -- the application-layer bound the derivation module already applies.
  constraint user_style_profiles_data_bounded
    check (octet_length(profile_data::text) <= 65536)
);

comment on table public.user_style_profiles is
  'Build 34 Track B B4. One server-derived, versioned Style DNA summary per user, computed from their own non-tombstoned user_closet_items evidence. Mutation is service_role only.';
comment on column public.user_style_profiles.evidence_revision is
  'Deterministic fingerprint of the source Closet evidence (styleDnaEvidenceRevision.ts). Same evidence -> same revision; changed evidence -> changed revision. Never a raw count alone.';
comment on column public.user_style_profiles.profile_data is
  'Bounded (<=64 KiB) aggregate wardrobe evidence only: color/category/garment-type/brand/material frequencies and an evidence count. Never an item id, storage path, or raw note.';

alter table public.user_style_profiles enable row level security;

drop policy if exists "Users can select own style profile" on public.user_style_profiles;
create policy "Users can select own style profile"
  on public.user_style_profiles
  for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert/update/delete policy for authenticated or anon at all: mutation
-- exists only through trusted server code using the service-role client,
-- which bypasses RLS entirely -- the same pattern public.user_entitlements
-- already establishes.
revoke all on public.user_style_profiles from anon, authenticated, public;
grant select on public.user_style_profiles to authenticated;
grant select, insert, update, delete on public.user_style_profiles to service_role;
revoke truncate, references, trigger, maintain on public.user_style_profiles
  from anon, authenticated, service_role;

create or replace function public.set_user_style_profiles_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_user_style_profiles_updated_at() from public;
grant execute on function public.set_user_style_profiles_updated_at() to service_role;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'user_style_profiles_updated_at'
      and tgrelid = 'public.user_style_profiles'::regclass
  ) then
    create trigger user_style_profiles_updated_at
      before update on public.user_style_profiles
      for each row
      execute function public.set_user_style_profiles_updated_at();
  end if;
end;
$$;
