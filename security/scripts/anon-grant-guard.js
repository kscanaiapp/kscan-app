#!/usr/bin/env node
'use strict';

/**
 * Perimeter-drift detection: flags any public-schema function with `anon`
 * EXECUTE that is not on the explicit allowlist below. This project's
 * default privileges grant EXECUTE on newly created public-schema
 * functions to anon/public unless revoked (already observed and fixed
 * twice: provider_request_* in PR #43, the remaining RPCs in this pass) --
 * this guard exists so a THIRD occurrence is caught in CI instead of a
 * live audit.
 *
 * Pure functions only -- no DB access here. A CI step reads
 * `has_function_privilege('anon', ...)` for every public-schema function
 * and passes the result in.
 */

// Functions where anon EXECUTE is deliberate and reviewed. Adding a name
// here is a reviewable one-line diff -- exactly the same shape as
// security/scripts/staging-deployment-allowlist.js's approval gate.
const ANON_EXECUTE_ALLOWLIST = [
  // Public shared-room preview -- scoped entirely by an opaque share token,
  // validated by regex before any query; never leaks existence beyond a
  // generic 'unavailable'. See docs/security/supabase-exposure-audit.md.
  'get_public_room_preview',
  // Aggregate reaction counts for the public room-preview screen -- fixed
  // and applied to staging to require the caller either own the room or
  // the room have an active, non-revoked, non-expired share. See
  // supabase/migrations/20260803214145_harden_public_rpc_execution_grants.sql.
  'get_item_reaction_counts',
  // public.get_public_room_decision_preview(text) -- the outfit-decision half
  // of the same unauthenticated public room-preview screen
  // (app/(public)/rooms/[token].tsx, via services/outfitDecisions.ts). Anon
  // EXECUTE here is deliberate and was granted twice on purpose:
  // 20260711000002_outfit_decision_rooms.sql created it with
  // `grant execute ... to anon, authenticated`, 20260712010000_audit_hardening_
  // ai_stylist_stylechat.sql re-affirmed that grant during an audit-hardening
  // pass, and 20260808115735_enforce_rpc_privilege_boundary.sql names it in
  // its "Deliberately NOT revoked" list. This entry closes the last gap
  // between that decision and the governed allowlist -- the grant was never
  // unintended, only unrecorded here.
  //
  // Why public access is necessary: a shared dressing room is opened from an
  // SMS/link by a recipient who has no K Scan account. Requiring auth would
  // break the share feature outright. The function is a capability-scoped
  // read: it takes only the opaque share token, regex-validates it
  // (`^[A-Za-z0-9_-]+$`) before touching a table, and resolves a room only
  // through a room_shares row that is access_level='view', is_active,
  // revoked_at IS NULL and unexpired. Anything else returns a generic
  // 'malformed'/'unavailable' -- no enumeration oracle, no private room, no
  // voter or owner identity (votes are count(*) only), all free text
  // HTML-stripped and length-capped, and the result bounded to 10 decision
  // groups x 3 options x 6 items. See
  // __tests__/security/publicRoomDecisionPreviewGrant.test.js.
  'get_public_room_decision_preview',
];

// liveGrants: [{ functionName, anonCanExecute }]. Returns functions with
// anon EXECUTE that are not on the allowlist -- an unintended grant that
// needs either a revoke or a deliberate, reviewed allowlist addition.
function detectUnintendedAnonGrants(liveGrants, allowlist = ANON_EXECUTE_ALLOWLIST) {
  const approved = new Set(allowlist);
  return liveGrants
    .filter((g) => g.anonCanExecute && !approved.has(g.functionName))
    .map((g) => g.functionName);
}

// Allowlist entries that no longer show anon EXECUTE live -- not a
// failure, but worth surfacing so a stale allowlist entry can be cleaned
// up (keeps the allowlist an accurate reflection of live grants).
function detectStaleAllowlistEntries(liveGrants, allowlist = ANON_EXECUTE_ALLOWLIST) {
  const liveAnonExecutable = new Set(liveGrants.filter((g) => g.anonCanExecute).map((g) => g.functionName));
  return allowlist.filter((name) => !liveAnonExecutable.has(name));
}

module.exports = {
  ANON_EXECUTE_ALLOWLIST,
  detectUnintendedAnonGrants,
  detectStaleAllowlistEntries,
};
