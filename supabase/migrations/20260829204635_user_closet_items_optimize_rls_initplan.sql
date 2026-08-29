-- Follow-up to 20260829203657_user_closet_items.sql: wrap auth.uid()/
-- has_active_k_plus() calls in (select ...) so the planner evaluates them
-- once per statement (InitPlan) instead of once per row -- same predicate,
-- matches this repo's established RLS convention (e.g.
-- 20260716000001_shared_room_memberships.sql), and resolves the
-- auth_rls_init_plan performance advisory raised against all three policies
-- on public.user_closet_items.

drop policy "select own closet items when k+ active" on public.user_closet_items;
create policy "select own closet items when k+ active"
  on public.user_closet_items
  for select
  to authenticated
  using (user_id = (select auth.uid()) and (select public.has_active_k_plus()));

drop policy "insert own closet items when k+ active" on public.user_closet_items;
create policy "insert own closet items when k+ active"
  on public.user_closet_items
  for insert
  to authenticated
  with check (user_id = (select auth.uid()) and (select public.has_active_k_plus()));

drop policy "update own closet items when k+ active" on public.user_closet_items;
create policy "update own closet items when k+ active"
  on public.user_closet_items
  for update
  to authenticated
  using (user_id = (select auth.uid()) and (select public.has_active_k_plus()))
  with check (user_id = (select auth.uid()) and (select public.has_active_k_plus()));
