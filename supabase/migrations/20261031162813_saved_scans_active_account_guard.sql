-- Build 35 B35-F-017: still-valid tokens must not retain saved-scan access
-- after account deactivation. Ownership policies alone do not enforce it.

-- Keep the existing ownership/tombstone policies. AND the canonical account
-- guard across every authenticated command, just as for Looks and Rooms.
drop policy if exists "Account must be active (deletion guard)" on public.saved_scans;
create policy "Account must be active (deletion guard)"
  on public.saved_scans
  as restrictive
  for all
  to authenticated
  using ((select public.is_active_account()))
  with check ((select public.is_active_account()));
