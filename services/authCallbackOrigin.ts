import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * SEC-AUTH-CB-001 -- origin binding for token-bearing auth callbacks.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * The Supabase client runs the implicit flow (auth-js defaults flowType to
 * 'implicit' and services/supabaseClient.ts does not override it), so a
 * legitimate Google OAuth / password-reset / email-confirmation callback
 * arrives as `kscan://auth/callback#access_token=...&refresh_token=...`.
 * `supabase.auth.setSession()` validates that pair SERVER-SIDE, so forged or
 * random tokens are correctly rejected -- but a pair that is genuinely valid
 * for SOME account is accepted no matter who sent the link. Anyone who can
 * get a `kscan://` URL in front of a user (SMS, email, a web page, a QR code)
 * could therefore sign that user's device into an account of the attacker's
 * choosing, silently replacing the identity already signed in. That is login
 * CSRF / forced login: the victim then files their scans, closet and photos
 * into an account the attacker controls.
 *
 * WHAT THIS MODULE ADDS
 *
 * A short-lived marker recording that THIS DEVICE started an auth flow which
 * can legitimately land tokens on kscan://auth/callback. A token-bearing
 * callback is only honoured while such a marker is live. An unsolicited link
 * -- the whole attack -- finds no marker and is refused.
 *
 * WHY IT IS DURABLE, NOT IN-MEMORY
 *
 * A password-reset or email-confirmation link is opened from a mail client,
 * possibly long after the app was killed, so an in-memory marker would fail a
 * legitimate cold start. It is persisted with a per-kind TTL that mirrors how
 * long the matching link can stay valid, so the marker never outlives the flow
 * it authorises. Nothing secret is stored: the marker is a flow kind and a
 * timestamp, never a token, code or email address, which is why AsyncStorage
 * is the right home for it and the keystore (secureSessionStorage) is not.
 *
 * FAIL-CLOSED
 *
 * Every storage failure reads as "no pending request". A device that cannot
 * read its own marker refuses the token callback rather than accepting an
 * unverified identity; the user retries the flow, which is a recoverable
 * inconvenience, where the alternative is a silent account takeover.
 */

export type AuthCallbackRequestKind = 'oauth' | 'password_reset' | 'email_confirmation';

export interface PendingAuthCallbackRequest {
  kind: AuthCallbackRequestKind;
  startedAt: number;
}

const STORAGE_KEY = 'kscan-auth-callback-request';

/**
 * How long a started flow may still claim a callback. Each value tracks the
 * lifetime of the link that flow produces, so the marker closes no later than
 * the link it authorises:
 *   oauth               a browser round trip the user is actively inside.
 *   password_reset      Supabase recovery links live up to 24h.
 *   email_confirmation  Supabase confirmation links live up to 24h.
 */
export const AUTH_CALLBACK_REQUEST_TTL_MS: Readonly<Record<AuthCallbackRequestKind, number>> =
  Object.freeze({
    oauth: 15 * 60 * 1000,
    password_reset: 24 * 60 * 60 * 1000,
    email_confirmation: 24 * 60 * 60 * 1000,
  });

const KINDS: readonly AuthCallbackRequestKind[] = Object.freeze([
  'oauth',
  'password_reset',
  'email_confirmation',
]);

type Store = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

let store: Store = AsyncStorage;

/** Test seam only. Production wiring never calls this. */
export function __setAuthCallbackRequestStoreForTests(next: Store): void {
  store = next;
}

function isExpired(request: PendingAuthCallbackRequest, now: number): boolean {
  const ttl = AUTH_CALLBACK_REQUEST_TTL_MS[request.kind];
  // An unusable or non-monotonic timestamp is treated as expired, never as a
  // permanent licence to accept token callbacks.
  if (!Number.isFinite(request.startedAt) || request.startedAt > now) return true;
  return now - request.startedAt >= ttl;
}

function parse(raw: string | null): PendingAuthCallbackRequest | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { kind, startedAt } = parsed as Partial<PendingAuthCallbackRequest>;
  if (!KINDS.includes(kind as AuthCallbackRequestKind)) return null;
  if (typeof startedAt !== 'number') return null;
  return { kind: kind as AuthCallbackRequestKind, startedAt };
}

/**
 * Records that this device just started `kind`. Called immediately BEFORE the
 * request that produces a callback URL, so a callback can never arrive ahead
 * of its own marker.
 */
export async function beginAuthCallbackRequest(
  kind: AuthCallbackRequestKind,
  now: number = Date.now(),
): Promise<void> {
  const request: PendingAuthCallbackRequest = { kind, startedAt: now };
  try {
    await store.setItem(STORAGE_KEY, JSON.stringify(request));
  } catch {
    // A device that cannot record the marker will refuse its own callback and
    // surface the ordinary "link could not be used" error. Never throw here:
    // failing to write must not abort the sign-in attempt itself.
  }
}

/**
 * The live pending request, or null. Reading does NOT consume it: on Android
 * the browser caller and the /auth/callback route can both receive the same
 * URL, and both must see the same answer. It is cleared on success by
 * `clearAuthCallbackRequest`, and bounded by its TTL otherwise.
 */
export async function peekAuthCallbackRequest(
  now: number = Date.now(),
): Promise<PendingAuthCallbackRequest | null> {
  let raw: string | null;
  try {
    raw = await store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  const request = parse(raw);
  if (!request) return null;
  if (isExpired(request, now)) {
    await clearAuthCallbackRequest();
    return null;
  }
  return request;
}

/** Drops the marker. Called once a callback has actually established a session. */
export async function clearAuthCallbackRequest(): Promise<void> {
  try {
    await store.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: an un-cleared marker still expires on its own TTL.
  }
}

/**
 * The `sub` claim of an access token, or null when the token is not a decodable
 * JWT carrying one.
 *
 * NOT A VERIFICATION. The signature is never checked here and the claim is
 * never trusted as identity -- Supabase's own server-side validation in
 * setSession/_getUser remains the only thing that decides whether a token is
 * real. This is used for exactly one comparison: "does the incoming token even
 * CLAIM to be the user already signed in on this device?". A mismatch (or an
 * undecodable token) refuses the callback before any session is written, so an
 * attacker's honestly-labelled token never reaches setSession; a token that
 * LIES about `sub` to get past this check still has to survive Supabase's
 * validation, which it cannot do for an identity it does not own.
 */
export function readUnverifiedSubjectClaim(accessToken: string | null | undefined): string | null {
  if (typeof accessToken !== 'string') return null;
  const segments = accessToken.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(
      typeof atob === 'function'
        ? decodeURIComponent(
            atob(padded)
              .split('')
              .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
              .join(''),
          )
        : Buffer.from(padded, 'base64').toString('utf8'),
    ) as { sub?: unknown };
    return typeof decoded.sub === 'string' && decoded.sub ? decoded.sub : null;
  } catch {
    return null;
  }
}
