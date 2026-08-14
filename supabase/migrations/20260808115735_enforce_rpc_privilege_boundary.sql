-- Enforce the explicit staging RPC privilege boundary.
--
-- Policy of record: security/staging/rpc-access-policy.json
--
-- Root cause of the drift this migration closes:
-- This project carries a project-wide ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon. A "revoke all on function ... from public" therefore does NOT remove the direct anon grant created at CREATE time, so every function added after the 20260803214145/20260803214253 hardening pass arrived anon-executable. Documented in 20260803020100_provider_request_security_revoke_anon.sql:3-16 and 20260803214253:1-8.
--
-- This migration only REVOKES execute privileges from client roles, with one
-- exception (section D) that repairs a live defect. It creates no functions, drops
-- nothing, and changes no function body or signature. Every statement is idempotent.
--
-- Deliberately NOT revoked: get_public_room_preview, get_public_room_decision_preview
-- and get_item_reaction_counts remain anon-executable. They are the public share-link
-- contract used by the unauthenticated /rooms/:token route and the external kscan.app
-- backend. Functions used inside RLS predicates also keep authenticated EXECUTE,
-- because RLS predicates evaluate as the querying role.

-- ── A. SERVICE_ROLE_ONLY: administrative / worker surface with no client contract ──
--
-- These are SECURITY DEFINER and several accept an arbitrary caller-supplied user id
-- while performing no authorization check of their own, so a direct client call would
-- act on another account. Their only callers are Edge Functions holding service_role.

-- append_deletion_state_transition: [HIGH] SECURITY DEFINER with no authorization check of any kind; writes caller-supplied rows into the append-only deletion audit ledger. Client EXECUTE would allow forging or poisoning deletion audit history.
--   caller: service_role: supabase/functions/process-account-deletions/index.ts:445, _shared/deletion/common.ts:346; also PERFORMed inside other SECURITY DEFINER functions (runs as owner, unaffected by these grants)
revoke execute on function public.append_deletion_state_transition(uuid,uuid,text,text,text,text,text,jsonb) from anon;
revoke execute on function public.append_deletion_state_transition(uuid,uuid,text,text,text,text,text,jsonb) from authenticated;

-- check_and_increment_scan_identify_daily_usage: [HIGH] Its own guard is anon-bypassable: 20260709130346:69 only compares auth.uid() to p_user_id when auth.uid() is not null, and for anon auth.uid() is null, so any uuid quota can be read and exhausted. Only caller is service-role.
--   caller: service_role: supabase/functions/scan-identify/index.ts:1153 via catalogClient (index.ts:1799)
revoke execute on function public.check_and_increment_scan_identify_daily_usage(uuid,text,integer) from anon;
revoke execute on function public.check_and_increment_scan_identify_daily_usage(uuid,text,integer) from authenticated;

-- claim_deletion_requests_for_purge: [MEDIUM] Deletion purge worker claim. No authorization check beyond a worker_id length test.
--   caller: service_role: supabase/functions/process-account-deletions/index.ts:673
revoke execute on function public.claim_deletion_requests_for_purge(text,integer,interval) from anon;
revoke execute on function public.claim_deletion_requests_for_purge(text,integer,interval) from authenticated;

-- heartbeat_deletion_request_lease: [MEDIUM] Deletion worker lease heartbeat. No authorization check.
--   caller: service_role: supabase/functions/process-account-deletions/index.ts:400
revoke execute on function public.heartbeat_deletion_request_lease(uuid,text,interval) from anon;
revoke execute on function public.heartbeat_deletion_request_lease(uuid,text,interval) from authenticated;

-- list_deletion_purge_candidates: [HIGH] Returns SETOF deletion_requests including restoration_token_hash. No authorization check.
--   caller: service_role: supabase/functions/process-account-deletions/index.ts:574
revoke execute on function public.list_deletion_purge_candidates(integer) from anon;
revoke execute on function public.list_deletion_purge_candidates(integer) from authenticated;

-- mark_deletion_request_purged: [MEDIUM] Deletion worker completion; a null p_worker_id bypasses the worker match.
--   caller: service_role: supabase/functions/process-account-deletions/index.ts:524
revoke execute on function public.mark_deletion_request_purged(uuid,text) from anon;
revoke execute on function public.mark_deletion_request_purged(uuid,text) from authenticated;

-- peek_restoration_resend_by_email: [HIGH] SECURITY DEFINER, no authorization check; returns matched true/false for an arbitrary email. Client EXECUTE is an account-enumeration oracle that bypasses the deliberately enumeration-safe Edge Function wrapper.
--   caller: service_role: supabase/functions/resend-restoration-email/index.ts:82
revoke execute on function public.peek_restoration_resend_by_email(text) from anon;
revoke execute on function public.peek_restoration_resend_by_email(text) from authenticated;

-- preview_pending_deletion_backfill: [MEDIUM] Administrative backfill preview; exposes pending deletion requests and auth.users email existence. No callers at all.
--   caller: none
revoke execute on function public.preview_pending_deletion_backfill() from anon;
revoke execute on function public.preview_pending_deletion_backfill() from authenticated;

-- reconcile_orphaned_purging_requests: [MEDIUM] Deletion worker reconciliation. No authorization check.
--   caller: service_role: supabase/functions/process-account-deletions/index.ts:661
revoke execute on function public.reconcile_orphaned_purging_requests(integer) from anon;
revoke execute on function public.reconcile_orphaned_purging_requests(integer) from authenticated;

-- restore_account_by_token_hash: [MEDIUM] Gated by knowledge of a stored SHA-256 token hash rather than by role, and invoked only by the restore-account Edge Function with service_role.
--   caller: service_role: supabase/functions/restore-account/index.ts:32
revoke execute on function public.restore_account_by_token_hash(text) from anon;
revoke execute on function public.restore_account_by_token_hash(text) from authenticated;

-- revoke_user_device_sessions: [HIGH] SECURITY DEFINER, arbitrary p_user_id, no authorization check; revokes the device-session registry for any user.
--   caller: service_role, indirect via revoke_user_sessions (20260723021635:45)
revoke execute on function public.revoke_user_device_sessions(uuid) from anon;
revoke execute on function public.revoke_user_device_sessions(uuid) from authenticated;

-- revoke_user_sessions: [HIGH] SECURITY DEFINER, takes an arbitrary p_user_id and performs NO authorization check: deletes auth.refresh_tokens and auth.sessions for that user. Client EXECUTE would allow forced global sign-out of any account by UUID.
--   caller: service_role: supabase/functions/_shared/deletion/common.ts:310, supabase/functions/restore-account/index.ts:102
revoke execute on function public.revoke_user_sessions(uuid) from anon;
revoke execute on function public.revoke_user_sessions(uuid) from authenticated;

-- rotate_restoration_token_by_email: [HIGH] SECURITY DEFINER, no authorization check; writes a caller-supplied restoration_token_hash for any deactivated account, which combined with restore_account_by_token_hash allows cancelling another user account deletion.
--   caller: service_role: supabase/functions/resend-restoration-email/index.ts:100
revoke execute on function public.rotate_restoration_token_by_email(text,text) from anon;
revoke execute on function public.rotate_restoration_token_by_email(text,text) from authenticated;

-- schedule_deletion_retry_or_fail: [MEDIUM] Deletion worker retry scheduling. No authorization check.
--   caller: service_role: supabase/functions/process-account-deletions/index.ts:697
revoke execute on function public.schedule_deletion_retry_or_fail(uuid,text,text,text,integer) from anon;
revoke execute on function public.schedule_deletion_retry_or_fail(uuid,text,text,text,integer) from authenticated;

-- ── B. AUTHENTICATED_INTENTIONAL: legitimate signed-in contracts, stray anon grant ──
--
-- Each of these is a real authenticated application contract and keeps its
-- authenticated EXECUTE. Only the unintended anon grant is removed. Most already
-- raise 28000 when auth.uid() is null, so this closes reachability rather than a
-- live data path.

-- finalize_elise_generation_operation: Elise generation internals; auth.uid() required.
revoke execute on function public.finalize_elise_generation_operation(uuid,text,uuid,text) from anon;

-- get_my_deletion_status: Scoped to auth.uid(); harmless for anon but not an anonymous contract.
revoke execute on function public.get_my_deletion_status() from anon;

-- increment_stylechat_daily_usage_idempotent: StyleChat quota accounting; auth.uid() required (raises 28000).
revoke execute on function public.increment_stylechat_daily_usage_idempotent(text) from anon;

-- mark_elise_generation_generating: Elise generation internals; auth.uid() required.
revoke execute on function public.mark_elise_generation_generating(uuid) from anon;

-- register_user_device_session: Self-authorizing (auth.uid() + is_active_account) but never an anonymous contract.
revoke execute on function public.register_user_device_session(text,text,text,uuid) from anon;

-- reserve_elise_generation_operation: Elise generation internals. Raises 28000 when auth.uid() is null, so anon EXECUTE is dead but should not be reachable.
revoke execute on function public.reserve_elise_generation_operation(uuid,uuid,text,text,text) from anon;

-- revalidate_elise_generation_context: Elise generation internals; auth.uid() required.
revoke execute on function public.revalidate_elise_generation_context(uuid,uuid,uuid) from anon;

-- ── C. TRIGGER_ONLY: no role needs EXECUTE ──
--
-- Trigger execution never consults EXECUTE grants, and PostgREST does not expose
-- RETURNS trigger functions on /rest/v1/rpc. service_role EXECUTE is left untouched
-- to avoid unnecessary privilege churn.

revoke execute on function public.enforce_minor_privacy_defaults() from authenticated;
revoke execute on function public.normalize_dressing_room_note() from authenticated;
revoke execute on function public.set_profiles_updated_at() from authenticated;
revoke execute on function public.set_provider_request_limits_updated_at() from authenticated;
revoke execute on function public.set_saved_scans_updated_at() from anon;
revoke execute on function public.set_saved_scans_updated_at() from authenticated;
revoke execute on function public.set_style_objects_updated_at() from authenticated;
revoke execute on function public.set_updated_at() from authenticated;
revoke execute on function public.set_user_stylist_preferences_updated_at() from anon;
revoke execute on function public.set_user_stylist_preferences_updated_at() from authenticated;

-- These two trigger functions exist on the evolved staging lineage but are not
-- created by the active repository migration chain. A direct REVOKE aborts a
-- clean database rebuild before the remaining hardening migrations can run.
-- Absence is already the strictest privilege state, so preserve the reviewed
-- revoke when each legacy object exists and otherwise continue fail-closed.
do $$
begin
  if to_regprocedure('public.handle_new_user_privacy()') is not null then
    execute 'revoke execute on function public.handle_new_user_privacy() from authenticated';
  end if;
  if to_regprocedure('public.update_privacy_settings_updated_at()') is not null then
    execute 'revoke execute on function public.update_privacy_settings_updated_at() from authenticated';
  end if;
end;
$$;

-- ── D. Repair: authenticated USAGE on the internal schema ──
--
-- Live-staging defect found while establishing migration provenance. The applied
-- version of 20260806153233_dressing_room_user_blocking grants authenticated EXECUTE
-- on internal.is_dressing_room_pair_blocked but never grants USAGE on the internal
-- schema, and calling a function requires both. Verified on staging as the
-- authenticated role: ERROR 42501 permission denied for schema internal.
--
-- Two RLS policies call that helper and therefore fail closed today:
--   content_reports.content_reports_insert_own            (WITH CHECK)
--   dressing_rooms."Recipients can select rooms via active shares" (USING)
-- so authenticated users cannot file content reports or read rooms shared with them.
--
-- USAGE on a schema exposes nothing by itself: object-level privileges still apply,
-- anon is explicitly left without USAGE, and internal is absent from the PostgREST
-- exposed-schema list so nothing here becomes reachable over the Data API.

revoke all on schema internal from public;
revoke all on schema internal from anon;
grant usage on schema internal to authenticated;
