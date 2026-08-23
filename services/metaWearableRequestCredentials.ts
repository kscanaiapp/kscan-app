// Which public API key the wearable Edge Functions are called with.
//
// THE PROBLEM THIS SOLVES. `wearable-bridge` is served through
// `withSupabase({ auth: ['publishable', 'secret'] })` from @supabase/server.
// That gate compares the request's `apikey` HEADER against the project's
// `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` values — nothing else. It
// does not accept the project's LEGACY anon key (the `eyJ…` JWT), and it never
// looks at the Authorization header when deciding.
//
// The K Scan app is still configured with the legacy anon key
// (EXPO_PUBLIC_SUPABASE_ANON_KEY), which supabase-js sends as `apikey` on every
// request. Against wearable-bridge that is rejected before any operation runs:
//
//   apikey=<legacy anon>       -> 401 {"code":"INVALID_CREDENTIALS"}
//   apikey=sb_publishable_…    -> 200
//
// (Verified against K Scan AI Staging, 2026-08-23. Every wearable-bridge
// operation was affected — pair.create, pair.approve, pair.poll,
// phone.sessions, phone.revoke, phone.revoke_all — so pairing could never
// complete and no wearable session could ever be issued.)
//
// Rather than swap the whole app onto a different key — which would change how
// every other Supabase call in K Scan authenticates, on a path this build
// cannot exercise end-to-end — the wearable functions get their own explicitly
// configured publishable key, applied ONLY as the `apikey` header on those four
// calls. The Authorization header is deliberately left alone: supabase-js keeps
// putting the signed-in user's JWT there, which is exactly what the bridge's
// `requireUser()` reads for pair.approve / phone.* operations.
//
// No runtime imports: this module is loaded by the Node test harness in a
// sandbox whose `require` throws, so the rule below stays testable off-device.

/** Env var carrying the modern publishable key used for wearable calls. */
export const WEARABLE_PUBLISHABLE_KEY_ENV = 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY';

/** Modern publishable keys are the only credential wearable-bridge accepts. */
export const PUBLISHABLE_KEY_PREFIX = 'sb_publishable_';

export type WearableCredentialFailure =
  /** Nothing configured — the build cannot talk to the bridge at all. */
  | 'WEARABLE_KEY_NOT_CONFIGURED'
  /** Configured, but with a key shape the bridge will reject (e.g. legacy anon). */
  | 'WEARABLE_KEY_WRONG_FORMAT';

/**
 * Why a configured key would be rejected, or `null` when it is usable.
 *
 * Deliberately a nullable code rather than a discriminated union: this project
 * typechecks without `strict`, so `strictNullChecks` is off and TypeScript will
 * NOT narrow an `{ ok: true } | { ok: false }` union at the call site. A safety
 * shape that silently does not narrow is worse than no shape at all.
 *
 * Fails LOUD and early rather than letting the request go out and come back as
 * an opaque 401: a misconfigured key is a build/configuration fault, and
 * reporting it as "the wearable request failed" is how this defect stayed
 * invisible in the first place.
 */
export function wearableCredentialFailure(
  rawKey: string | null | undefined,
): WearableCredentialFailure | null {
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!key) return 'WEARABLE_KEY_NOT_CONFIGURED';
  // A legacy `eyJ…` anon key here is the exact misconfiguration that broke
  // pairing, so it is rejected on the device instead of on the wire.
  if (!key.startsWith(PUBLISHABLE_KEY_PREFIX)) return 'WEARABLE_KEY_WRONG_FORMAT';
  return null;
}

/**
 * The `apikey` header for a wearable Edge Function call. Only meaningful once
 * {@link wearableCredentialFailure} has returned `null` for the same key.
 */
export function wearableInvokeHeaders(rawKey: string | null | undefined): { apikey: string } {
  return { apikey: typeof rawKey === 'string' ? rawKey.trim() : '' };
}

/** Human-readable, key-free explanation for a failed decision. */
export function describeWearableCredentialFailure(code: WearableCredentialFailure): string {
  return code === 'WEARABLE_KEY_NOT_CONFIGURED'
    ? `${WEARABLE_PUBLISHABLE_KEY_ENV} is not set. The Meta companion cannot reach the wearable bridge without it.`
    : `${WEARABLE_PUBLISHABLE_KEY_ENV} must be a modern publishable key (${PUBLISHABLE_KEY_PREFIX}…). The legacy anon key is rejected by wearable-bridge with INVALID_CREDENTIALS.`;
}
