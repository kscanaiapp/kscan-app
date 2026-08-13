-- Un-stick legacy `pending` deletion requests.
--
-- THE DEFECT. Rows created by the pre-Build-29 request-based handler carry
-- status='pending' with a NULL grace_period_ends_at and no restoration token.
-- Every governed path in the current lifecycle keys on status='deactivated':
--
--   * peek_restoration_resend_by_email  -> requires 'deactivated'
--   * rotate_restoration_token_by_email -> requires 'deactivated'
--   * restore_account_by_token_hash     -> requires 'deactivated'
--   * list_deletion_purge_candidates    -> requires 'deactivated'
--
-- and profiles.account_status is 'pending_deletion', which routingGuard and
-- assertAccountActive both treat as locked out. The result is a dead end: the
-- account cannot be used, cannot be restored, and cannot be purged. Build 29
-- cannot ship an account-deletion feature that leaves a user in a state with
-- no exit in any direction.
--
-- THE FIX. A one-time, idempotent transition of legacy pending rows into the
-- governing deactivated lifecycle. Deliberately a migration and not a new RPC:
-- the repository carries a project-wide
-- `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon`, so every
-- new function arrives anon-executable and must be individually revoked and
-- registered in security/staging/rpc-access-policy.json. A backfill that runs
-- exactly once needs none of that permanent privilege surface.
--
-- GRACE WINDOW. `greatest(requested_at + 30 days, now() + 7 days)` -- identical
-- to the deadline already proposed by this repository's own read-only
-- preview_pending_deletion_backfill(). The 30-day term honours the originally
-- advertised window; the 7-day floor guarantees that a request whose 30 days
-- already elapsed still gets real notice, and is never transitioned straight
-- into purge eligibility by this migration.
--
-- SCOPE. Rows with user_id IS NULL are deliberately excluded. Their Auth user
-- is already gone (the FK is ON DELETE SET NULL), so there is no account to
-- restore and no data to purge -- list_deletion_purge_candidates ignores them
-- for the same reason. Those rows stay exactly as they are, as historical
-- ledger records.

do $$
declare
  affected record;
  transitioned integer := 0;
begin
  for affected in
    update public.deletion_requests dr
    set
      status = 'deactivated',
      deactivated_at = coalesce(dr.deactivated_at, dr.requested_at),
      grace_period_ends_at = greatest(
        dr.requested_at + interval '30 days',
        now() + interval '7 days'
      ),
      updated_at = now()
    where dr.status = 'pending'
      and dr.user_id is not null
      -- Never touch a row that already reached a terminal state.
      and dr.purged_at is null
      and dr.restored_at is null
    returning dr.id, dr.subject_ref
  loop
    transitioned := transitioned + 1;

    -- Append-only ledger, same as every other lifecycle transition. The reason
    -- code keeps this backfill distinguishable from a user-initiated request
    -- for anyone auditing the history later.
    perform public.append_deletion_state_transition(
      affected.id,
      affected.subject_ref,
      'pending',
      'deactivated',
      'system',
      'migration:20260813222000',
      'LEGACY_PENDING_BACKFILL',
      '{}'::jsonb
    );
  end loop;

  raise notice 'legacy pending deletion requests transitioned: %', transitioned;
end $$;
