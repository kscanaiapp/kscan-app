-- RECOVERED FROM supabase_migrations.schema_migrations LEDGER (staging: yzqjvdfgefveprobvvyw)
-- version: 20260823170850
-- name: reconcile_wearable_schema_with_staging
-- statement_count: 1
-- Same cross-repo provenance note: likely belongs to kscan-glasses-webapp.
-- Its own comment describes reconciling a "committed wearable schema" (i.e.
-- one that DOES exist committed somewhere) with what staging's live
-- constraints actually are -- meaning even ITS author found staging and the
-- (other repo's) committed migration had already diverged before this ran.

-- Reconciles the committed wearable schema with K Scan AI Staging's verified
-- constraint and column contract. This is deliberately additive/idempotent:
-- it repairs environments built from the old migration without weakening
-- staging's already-enforced limits.

ALTER TABLE public.wearable_pairings
  ALTER COLUMN device_model DROP DEFAULT,
  ALTER COLUMN device_app_version DROP DEFAULT,
  ALTER COLUMN protocol_version DROP DEFAULT;

ALTER TABLE public.wearable_pairings
  DROP CONSTRAINT IF EXISTS wearable_pairings_device_model_check,
  ADD CONSTRAINT wearable_pairings_device_model_check
    CHECK (char_length(device_model) BETWEEN 1 AND 80),
  DROP CONSTRAINT IF EXISTS wearable_pairings_device_app_version_check,
  ADD CONSTRAINT wearable_pairings_device_app_version_check
    CHECK (char_length(device_app_version) BETWEEN 1 AND 40),
  DROP CONSTRAINT IF EXISTS wearable_pairings_check,
  ADD CONSTRAINT wearable_pairings_check CHECK (expires_at > created_at),
  DROP CONSTRAINT IF EXISTS wearable_pairings_check1,
  ADD CONSTRAINT wearable_pairings_check1 CHECK (status <> 'pending' OR user_id IS NULL),
  DROP CONSTRAINT IF EXISTS wearable_pairings_protocol_version_check,
  ADD CONSTRAINT wearable_pairings_protocol_version_check CHECK (protocol_version = 1);

UPDATE public.wearable_sessions
  SET last_seen_at = created_at
  WHERE last_seen_at IS NULL;

ALTER TABLE public.wearable_sessions
  ALTER COLUMN last_seen_at SET DEFAULT now(),
  ALTER COLUMN last_seen_at SET NOT NULL,
  ALTER COLUMN protocol_version DROP DEFAULT;

ALTER TABLE public.wearable_sessions
  DROP CONSTRAINT IF EXISTS wearable_sessions_check,
  ADD CONSTRAINT wearable_sessions_check CHECK (expires_at > created_at),
  DROP CONSTRAINT IF EXISTS wearable_sessions_check1,
  ADD CONSTRAINT wearable_sessions_check1
    CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS wearable_sessions_protocol_version_check,
  ADD CONSTRAINT wearable_sessions_protocol_version_check CHECK (protocol_version = 1),
  DROP CONSTRAINT IF EXISTS wearable_sessions_revoke_reason_check,
  ADD CONSTRAINT wearable_sessions_revoke_reason_check
    CHECK (revoke_reason IS NULL OR revoke_reason IN ('user_revoked', 'expired', 'replaced', 'sign_out', 'error'));

ALTER TABLE public.wearable_messages
  DROP CONSTRAINT IF EXISTS wearable_messages_check,
  ADD CONSTRAINT wearable_messages_check CHECK (expires_at > created_at),
  DROP CONSTRAINT IF EXISTS wearable_messages_frame_check,
  ADD CONSTRAINT wearable_messages_frame_check CHECK (octet_length(frame::text) <= 65536),
  DROP CONSTRAINT IF EXISTS wearable_messages_message_type_check,
  ADD CONSTRAINT wearable_messages_message_type_check CHECK (char_length(message_type) BETWEEN 3 AND 48);

ALTER TABLE public.wearable_results
  DROP CONSTRAINT IF EXISTS wearable_results_payload_check,
  ADD CONSTRAINT wearable_results_payload_check CHECK (octet_length(payload::text) <= 49152),
  DROP CONSTRAINT IF EXISTS wearable_results_revision_check,
  ADD CONSTRAINT wearable_results_revision_check CHECK (revision BETWEEN 1 AND 1000),
  DROP CONSTRAINT IF EXISTS wearable_results_status_check,
  ADD CONSTRAINT wearable_results_status_check CHECK (status IN ('completed', 'partial', 'failed'));

ALTER TABLE public.wearable_actions
  ALTER COLUMN result_id DROP NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE public.wearable_actions
  DROP CONSTRAINT IF EXISTS wearable_actions_action_type_check,
  ADD CONSTRAINT wearable_actions_action_type_check CHECK (action_type IN ('save', 'open_on_phone', 'cancel', 'retry')),
  DROP CONSTRAINT IF EXISTS wearable_actions_status_check,
  ADD CONSTRAINT wearable_actions_status_check CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  DROP CONSTRAINT IF EXISTS wearable_actions_safe_error_code_check,
  ADD CONSTRAINT wearable_actions_safe_error_code_check CHECK (safe_error_code IS NULL OR char_length(safe_error_code) <= 48);

-- ── Residual staging divergences ───────────────────────────────────────────
-- Found by diffing live staging (pg_constraint / pg_index / pg_default_acl /
-- information_schema) against the committed migration. The constraint-level
-- reconciliation above did not cover these, and each one changes behaviour in
-- an environment built from source.

-- 1. wearable_auth_attempts was never committed at all. wearable-bridge's
--    throttlePairAttempt() throws SAFE_BACKEND_FAILURE when the query errors,
--    so a source-built environment cannot complete pair.approve or pair.deny —
--    pairing is dead, not merely unthrottled.
CREATE TABLE IF NOT EXISTS public.wearable_auth_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wearable_auth_attempts
  DROP CONSTRAINT IF EXISTS wearable_auth_attempts_operation_check,
  ADD CONSTRAINT wearable_auth_attempts_operation_check
    CHECK (operation IN ('pair.approve', 'pair.deny'));

CREATE INDEX IF NOT EXISTS wearable_auth_attempts_window
  ON public.wearable_auth_attempts(user_id, operation, attempted_at);

ALTER TABLE public.wearable_auth_attempts ENABLE ROW LEVEL SECURITY;

-- 2. The phone action-poll index staging runs was never committed.
CREATE INDEX IF NOT EXISTS wearable_actions_phone_poll
  ON public.wearable_actions(user_id, status, created_at) WHERE status = 'pending';

-- 3. Staging deliberately has no default on wearable_results.status; the
--    committed migration defaulted it to 'completed', which would let an
--    incomplete write land as a finished result.
ALTER TABLE public.wearable_results ALTER COLUMN status DROP DEFAULT;

-- 4. Supabase's default privileges grant anon/authenticated INSERT/SELECT/
--    UPDATE/DELETE on every new public table. Staging revoked that for the
--    wearable tables; the committed migration did not, so a source-built
--    environment stands one dropped RLS policy away from public exposure.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wearable_pairings','wearable_sessions','wearable_messages',
                           'wearable_results','wearable_actions','wearable_auth_attempts']
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END $$;
