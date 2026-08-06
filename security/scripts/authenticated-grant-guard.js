#!/usr/bin/env node
'use strict';

/**
 * Perimeter-drift detection for the `authenticated` role, mirroring
 * anon-grant-guard.js. Added 2026-08-06 alongside
 * supabase/migrations/20260806140000_close_unintended_anon_rpc_surface.sql,
 * which found that several worker/session-management functions had
 * unintended `authenticated` EXECUTE, not just `anon` -- meaning any
 * logged-in user (not only unauthenticated callers) could invoke them.
 *
 * Unlike anon-grant-guard.js's allowlist model (deny by default, allow a
 * reviewed few), this is a denylist: these specific functions are
 * SERVICE_ROLE-ONLY by design (called exclusively from Edge Functions using
 * SUPABASE_SERVICE_ROLE_KEY -- confirmed by tracing every caller in
 * supabase/functions/ before this list was written), so `authenticated`
 * should never have EXECUTE on any of them, in addition to `anon`. Most of
 * this project's RPC surface legitimately needs `authenticated` access
 * (that's the normal case), so a denylist of the specific worker-only
 * exceptions is the right shape here, not a second allowlist to maintain
 * in lockstep with every ordinary authenticated RPC.
 *
 * Pure functions only -- a CI step collects the live
 * has_function_privilege('authenticated', ...) snapshot and passes it in.
 */

const SERVICE_ROLE_ONLY_FUNCTIONS = [
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
  'schedule_deletion_retry_or_fail',
];

// liveGrants: [{ functionName, authenticatedCanExecute }]. Returns any
// service-role-only function that still shows authenticated EXECUTE live --
// a regression of the 2026-08-06 fix (e.g. a future migration accidentally
// re-granting default privileges).
function detectUnexpectedAuthenticatedGrants(liveGrants, denylist = SERVICE_ROLE_ONLY_FUNCTIONS) {
  const denied = new Set(denylist);
  return liveGrants
    .filter((g) => g.authenticatedCanExecute && denied.has(g.functionName))
    .map((g) => g.functionName);
}

module.exports = {
  SERVICE_ROLE_ONLY_FUNCTIONS,
  detectUnexpectedAuthenticatedGrants,
};
