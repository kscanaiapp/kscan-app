// Pairing-frame fields that the wearable backend stores under a CHECK
// constraint, clamped on the device so a pairing can never be rejected by the
// database for a shape the client controls.
//
// THE PROBLEM THIS SOLVES. `pair.create` writes the frame's payload straight
// into `wearable_pairings`:
//
//   device_model:       String(payload?.model ?? '').slice(0, 80)
//   device_app_version: String(payload?.appVersion ?? '').slice(0, 40)
//
// and K Scan AI Staging enforces (verified 2026-08-23 against pg_constraint):
//
//   wearable_pairings_device_model_check
//     CHECK (char_length(device_model)       >= 1 AND char_length(device_model)       <= 80)
//   wearable_pairings_device_app_version_check
//     CHECK (char_length(device_app_version) >= 1 AND char_length(device_app_version) <= 40)
//
// The Meta companion sent `appVersion: ''`, which is zero-length and therefore
// violates the second constraint. Every pair.create failed with a generic
// `PAIR_CREATE_FAILED`, with the real cause visible only in the Postgres log:
//
//   new row for relation "wearable_pairings" violates check constraint
//   "wearable_pairings_device_app_version_check"
//
// Neither constraint appears in the committed migration
// (kscan-glasses-webapp supabase/migrations/20260819000001_…sql), so this
// failure is invisible in any environment built from that migration and shows
// up only against real staging. Clamping here means the client satisfies the
// constraint that is actually deployed, whatever the migration says.
//
// No runtime imports: loaded by the Node test harness in a sandbox whose
// `require` throws.

/** Live `wearable_pairings_device_model_check` bounds. */
export const DEVICE_MODEL_MIN = 1;
export const DEVICE_MODEL_MAX = 80;

/** Live `wearable_pairings_device_app_version_check` bounds. */
export const APP_VERSION_MIN = 1;
export const APP_VERSION_MAX = 40;

/** Used when the caller supplies nothing usable. Never empty. */
export const DEFAULT_DEVICE_MODEL = 'K Scan Meta HUD';
export const DEFAULT_APP_VERSION = 'unknown';

function clamp(raw: unknown, max: number, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  // A whitespace-only value collapses to empty and would violate the >= 1
  // bound exactly like '' did, so it falls back too.
  const bounded = value.slice(0, max).trim();
  return bounded.length >= 1 ? bounded : fallback;
}

/** Device model for a pair.request payload. Always 1..80 characters. */
export function toPairingDeviceModel(raw: unknown): string {
  return clamp(raw, DEVICE_MODEL_MAX, DEFAULT_DEVICE_MODEL);
}

/** App version for a pair.request payload. Always 1..40 characters. */
export function toPairingAppVersion(raw: unknown): string {
  return clamp(raw, APP_VERSION_MAX, DEFAULT_APP_VERSION);
}
