-- KS-REL-005E follow-up
-- Allow owner soft-delete updates by keeping ownership as the saved_scans
-- SELECT RLS boundary. Active lists must query deleted_at is null explicitly.

drop policy if exists "saved_scans_select_own_active" on public.saved_scans;
drop policy if exists "saved_scans_select_own" on public.saved_scans;

create policy "saved_scans_select_own"
on public.saved_scans
for select
to authenticated
using (
  auth.uid() = user_id
);
