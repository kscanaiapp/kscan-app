/**
 * Unified commerce outcome capture control (v123).
 *
 * OFF → no new database persistence; console telemetry unchanged
 * ON  → scrubbed outcome events persisted (best-effort, non-blocking)
 *
 * Rollback without redeploy: set BACKEND_COMMERCE_OUTCOME_CAPTURE_ENABLED=false
 * Do not drop the analytics table during emergency rollback.
 */

export const COMMERCE_OUTCOME_CAPTURE_VERSION = 'v123';

/** Bounded capture budget — must not block client response. */
export const COMMERCE_OUTCOME_CAPTURE_TIMEOUT_MS = 300;

/**
 * Default ON after validation. Env override wins.
 */
export const COMMERCE_OUTCOME_CAPTURE_DEFAULT_ENABLED = true;

export function isCommerceOutcomeCaptureEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('BACKEND_COMMERCE_OUTCOME_CAPTURE_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return COMMERCE_OUTCOME_CAPTURE_DEFAULT_ENABLED;
}
