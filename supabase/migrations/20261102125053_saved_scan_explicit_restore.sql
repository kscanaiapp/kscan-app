-- Build 35 E018: explicit re-save must be able to restore an owned scan.
-- Keep both identity and current account authority on either side of UPDATE.

alter policy "saved_scans_update_own_active" on public.saved_scans
  using (auth.uid() = user_id and (select public.is_active_account()))
  with check (auth.uid() = user_id and (select public.is_active_account()));
