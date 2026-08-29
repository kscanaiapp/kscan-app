-- Migration provenance (restored by maintenance/staging-migration-authority-reconciliation, 2026-08-29).
--
-- Owning repository: kscan-app
-- Original authored file: supabase/migrations/20260813222000_backfill_legacy_pending_deletion_requests.sql
-- Original source commit: eacd64e
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version: 20260813224918
-- Renamed to the ledger-assigned version by commit 0fc7cfb, whose message explains: the Management API assigns its own version at apply time rather than honouring the authored filename.
--
-- SQL below reproduces the exact statements Postgres executed on staging
-- (recovered from supabase_migrations.schema_migrations.statements).
-- See docs/staging-rebuild/recovered-migrations/LEDGER_INTEGRITY_CHECK.md
-- for source/ledger SHA-256 hashes and full verification detail.

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
      and dr.purged_at is null
      and dr.restored_at is null
    returning dr.id, dr.subject_ref
  loop
    transitioned := transitioned + 1;

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
