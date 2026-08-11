-- Fixture: false positive guard. Purely additive: new table, new policy,
-- new grant scoped to the new table. Contains the word "policy" and GRANT
-- statements, which are review-worthy shapes in general, but nothing
-- destructive. Must never be reported as DETECTED_RISK.
create table if not exists public.image_scan_verdicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  verdict text not null,
  created_at timestamptz not null default now()
);

alter table public.image_scan_verdicts enable row level security;

create policy "image_scan_verdicts_select_own"
  on public.image_scan_verdicts
  for select
  using ((select auth.uid()) = user_id);

revoke all on public.image_scan_verdicts from anon;
grant select on public.image_scan_verdicts to authenticated;
