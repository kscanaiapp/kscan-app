-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260813224918
-- name: backfill_legacy_pending_deletion_requests
-- statement_count: 1
-- Data-only backfill (not a schema change) -- references migration:20260813222000 by name.

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
