/**
 * Staging hard guard for the VTO E2E harness.
 *
 * Thin, VTO-specific wrapper over the repository's existing staging/
 * production identity guard (scripts/lib/staging-helpers.mjs /
 * staging-constants.mjs) — reused rather than re-implemented, so the VTO
 * harness can never drift from the same fail-closed target check every
 * other staging deployment script already uses.
 */
'use strict';

import {
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  STAGING_URL,
  PRODUCTION_URL,
} from '../../lib/staging-constants.mjs';
import { assertStagingTarget, StagingGuardError } from '../../lib/staging-helpers.mjs';

export { STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF, STAGING_URL, PRODUCTION_URL, StagingGuardError };

/**
 * Asserts the harness is pointed at the governed K Scan staging project and
 * nowhere else — explicitly rejects production and any unrecognized ref.
 * Throws StagingGuardError on any mismatch; callers must let that abort the
 * run rather than catching it and continuing.
 */
export function assertVtoStagingTarget(env = process.env) {
  return assertStagingTarget({
    projectRef: env.SUPABASE_STAGING_PROJECT_REF,
    url: env.SUPABASE_STAGING_URL,
    anonKey: env.SUPABASE_STAGING_PUBLISHABLE_KEY,
  });
}
