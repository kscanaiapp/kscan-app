-- Close a large unintended anon EXECUTE surface found by the new live
-- RLS/grant verification job (security/scripts/anon-grant-guard.js +
-- security/scripts/query-staging-metadata.js).
--
-- Context: this project's default privileges grant EXECUTE on newly
-- created public-schema functions to anon/public unless explicitly
-- revoked -- already observed and fixed twice (provider_request_* in PR
-- #43, a further batch in 20260803214145_harden_public_rpc_execution_grants.sql
-- and its follow-up). Live introspection against K Scan AI Staging on
-- 2026-08-06 found 24 more public-schema functions where `anon` still had
-- EXECUTE, only 2 of which (get_public_room_preview, get_item_reaction_counts)
-- are on the reviewed allowlist in security/scripts/anon-grant-guard.js.
--
-- Every one of the remaining 22 non-trigger functions was traced to its
-- actual caller in supabase/functions/ before this migration was written:
--   - reserve_elise_generation_operation, mark_elise_generation_generating,
--     revalidate_elise_generation_context, finalize_elise_generation_operation
--     (stylechat-generate/generationSafety.ts) and
--     increment_stylechat_daily_usage_idempotent (stylechat-generate/index.ts)
--     are all called via `userClient.rpc(...)` -- a client built from the
--     caller's own JWT, so they run as `authenticated`, never `anon`.
--   - check_and_increment_scan_identify_daily_usage (scan-identify/index.ts)
--     is called via a catalog/service client; its own source comment
--     confirms "Service-role clients have auth.uid() = null and bypass this
--     guard" -- the intended null-auth.uid() caller is service_role, which
--     bypasses grants entirely and never needed the anon grant. Left as-is,
--     this function let ANY unauthenticated caller pass an arbitrary
--     p_user_id and manipulate or probe that user's scan-identify daily
--     quota -- the most serious of the confirmed findings.
--   - claim_deletion_requests_for_purge, heartbeat_deletion_request_lease,
--     mark_deletion_request_purged, schedule_deletion_retry_or_fail,
--     reconcile_orphaned_purging_requests, list_deletion_purge_candidates,
--     preview_pending_deletion_backfill, append_deletion_state_transition,
--     revoke_user_sessions, revoke_user_device_sessions,
--     restore_account_by_token_hash, peek_restoration_resend_by_email, and
--     rotate_restoration_token_by_email are all called exclusively from
--     process-account-deletions/index.ts, restore-account/index.ts, and
--     resend-restoration-email/index.ts (via _shared/deletion/common.ts's
--     rpc() helper), all of which authenticate with SUPABASE_SERVICE_ROLE_KEY
--     -- service_role bypasses grants entirely, so anon EXECUTE on any of
--     these was never required for the app to function. Left as-is,
--     revoke_user_sessions/revoke_user_device_sessions let any
--     unauthenticated caller forcibly sign out an arbitrary user by ID --
--     the "p_worker_id" parameter on the deletion-worker functions is a
--     bare string with no real credential check, so those were reachable
--     by any caller able to guess an 8+ character string.
--   - get_public_room_decision_preview is the one exception: it is
--     STABLE SECURITY DEFINER, validates its share-token argument by regex
--     before any query, and is gated entirely by an active/non-revoked/
--     non-expired room_shares row -- the identical opaque-token pattern
--     already reviewed and allowlisted for get_public_room_preview. Added
--     to ANON_EXECUTE_ALLOWLIST in the same commit as this migration
--     instead of revoked.
--
-- No client in this codebase calls any of the revoked functions using the
-- anon/publishable key alone (confirmed by grepping app/, components/,
-- services/, contexts/, hooks/, and supabase/functions/ for every name
-- below before this migration was written) -- this is privilege reduction
-- with zero functional impact on any real caller, not a behavior change.
--
-- Catalogue-lookup form (not bare REVOKE statements) for the same reason as
-- the migrations this follows: some of these functions may not exist on
-- every lineage this file replays against, and a bare REVOKE on a
-- non-existent function raises 42883 and aborts the whole migration.

do $$
declare
  v_target text;
  v_ident text;
  v_targets constant text[] := array[
    'append_deletion_state_transition',
    'check_and_increment_scan_identify_daily_usage',
    'claim_deletion_requests_for_purge',
    'finalize_elise_generation_operation',
    'heartbeat_deletion_request_lease',
    'increment_stylechat_daily_usage_idempotent',
    'list_deletion_purge_candidates',
    'mark_deletion_request_purged',
    'mark_elise_generation_generating',
    'peek_restoration_resend_by_email',
    'preview_pending_deletion_backfill',
    'reconcile_orphaned_purging_requests',
    'register_user_device_session',
    'reserve_elise_generation_operation',
    'restore_account_by_token_hash',
    'revalidate_elise_generation_context',
    'revoke_user_device_sessions',
    'revoke_user_sessions',
    'rotate_restoration_token_by_email',
    'schedule_deletion_retry_or_fail',
    -- Trigger functions: same treatment as the earlier hardening pass --
    -- triggers always execute as the defining role regardless of caller
    -- grants, direct invocation fails structurally on a missing NEW/OLD
    -- record, and PostgREST never exposes a RETURNS trigger function on its
    -- RPC surface (confirmed live previously via a 404). Harmless either
    -- way, but should not remain grantable.
    'set_saved_scans_updated_at',
    'set_user_stylist_preferences_updated_at'
  ];
begin
  foreach v_target in array v_targets loop
    for v_ident in
      select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_target
    loop
      execute format('revoke execute on function %s from anon', v_ident);
      execute format('revoke execute on function %s from public', v_ident);
    end loop;
  end loop;
end;
$$;

-- Second pass, same day: live introspection of `authenticated` (not just
-- `anon`) grants on the same function family found the SAME unintended
-- default-privilege leak one role up -- more severe here, since it means
-- ANY logged-in user (not only unauthenticated callers) could invoke these.
-- Confirmed live via has_function_privilege('authenticated', ...) before
-- writing this block. Scoped to exactly the subset with NO internal
-- ownership/auth check on their caller-supplied argument:
--   - revoke_user_sessions / revoke_user_device_sessions take a bare
--     p_user_id with no ownership check at all -- any authenticated user
--     could force-logout an arbitrary OTHER user by ID. The most serious
--     finding in this migration.
--   - The deletion-worker family (claim/heartbeat/mark/schedule/reconcile/
--     list/preview/append_deletion_state_transition) trust a bare
--     p_worker_id string with no real credential check -- any authenticated
--     user could interfere with the account-deletion pipeline for ANY
--     account, not just their own.
--   - peek_restoration_resend_by_email / rotate_restoration_token_by_email
--     take an arbitrary email with no auth.uid() check at all -- being
--     logged in as yourself grants no protection against querying or
--     resend-spamming someone else's restoration status.
--   - restore_account_by_token_hash is gated entirely by the token hash
--     itself (the real credential here), so this is defense-in-depth
--     matching the "service_role only" intent rather than a live exploit,
--     applied for consistency with the rest of this family.
--
-- Deliberately NOT revoked from authenticated: register_user_device_session
-- and check_and_increment_scan_identify_daily_usage both scope themselves
-- to auth.uid() internally (register_user_device_session always acts on
-- the caller's own session; check_and_increment_scan_identify_daily_usage
-- raises 'Quota user mismatch' when an authenticated caller's auth.uid()
-- disagrees with p_user_id -- only the null-auth.uid() anon path was
-- exploitable, already closed above) -- both are genuinely meant to be
-- called by the logged-in user themselves and remain safe with this grant.
do $$
declare
  v_target text;
  v_ident text;
  v_authenticated_targets constant text[] := array[
    'append_deletion_state_transition',
    'claim_deletion_requests_for_purge',
    'heartbeat_deletion_request_lease',
    'list_deletion_purge_candidates',
    'mark_deletion_request_purged',
    'peek_restoration_resend_by_email',
    'preview_pending_deletion_backfill',
    'reconcile_orphaned_purging_requests',
    'restore_account_by_token_hash',
    'revoke_user_device_sessions',
    'revoke_user_sessions',
    'rotate_restoration_token_by_email',
    'schedule_deletion_retry_or_fail'
  ];
begin
  foreach v_target in array v_authenticated_targets loop
    for v_ident in
      select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_target
    loop
      execute format('revoke execute on function %s from authenticated', v_ident);
    end loop;
  end loop;
end;
$$;

-- get_my_deletion_status is intentionally left untouched: it filters
-- entirely on `dr.user_id = auth.uid()`, so an anon caller (auth.uid() is
-- null) matches zero rows -- a controlled empty result, not a leak -- and
-- it is not on the confirmed-unused list above (no caller trace was needed
-- since the function itself is already safe by construction). Revoking it
-- would be pure churn with no security benefit.
