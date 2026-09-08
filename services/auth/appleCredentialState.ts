/**
 * Sign in with Apple credential-state lifecycle (iOS only).
 *
 * WHAT THIS OWNS: noticing that Apple no longer considers THIS device's Sign in
 * with Apple credential valid for the currently authenticated actor, and
 * invalidating that actor's K Scan AI session when so.
 *
 * WHAT THIS DELIBERATELY DOES NOT OWN:
 *  - Account deletion. A revoked Apple credential means "this sign-in is no
 *    longer authorized", never "destroy this account". Nothing here submits a
 *    deletion request, purges Recent Scans, deletes Closet records, or touches
 *    account-deletion state.
 *  - Apple's server-side token revocation (`/auth/revoke`). That is the
 *    terminal-deletion path's job (supabase/functions/apple-revoke-credential),
 *    and it is not reached from here.
 *  - Logout mechanics. There is exactly one logout authority in this app —
 *    AuthSessionContext's signOut — and it is INJECTED here rather than
 *    reproduced. It already seals the actor, retires this device's Watchlist
 *    push route, stops avatar speech, advances the actor epoch, resets
 *    actor-scoped runtime state, and destroys local session material.
 *
 * The identifier this needs is Apple's stable subject id for the user. It is
 * NOT captured at sign-in (app/auth/index.tsx consumes only the identity token
 * and the authorization code), so it is recovered from the restored Supabase
 * session's Apple identity — see resolveAppleUserId. It is never inferred from
 * an email address, a K Scan AI user id, a display name, or an authorization code.
 */
import { Platform } from 'react-native';
import type { User } from '@supabase/supabase-js';
import { createActorRequest, isActorRequestCurrent } from '../actorContext';

/**
 * Bounded outcome vocabulary. Deliberately a closed set of opaque tokens: no
 * Apple identifier, session material, or raw error text may leave this module.
 */
export type AppleCredentialCheckOutcome =
  /** Not an iOS runtime — Android and every other platform never call Apple. */
  | 'unsupported_platform'
  /** No Apple identity on this actor (Google/email/anonymous) — never calls Apple. */
  | 'not_apple_actor'
  /** Apple still authorizes this credential. The session is kept as-is. */
  | 'authorized'
  /** Apple reports the credential revoked. The session was invalidated. */
  | 'revoked'
  /** Apple no longer knows this credential. The session was invalidated. */
  | 'not_found'
  /** Apple reports an app-transfer state. Treated as requiring re-authentication. */
  | 'transferred'
  /** The credential-state call failed, or answered with something unusable. */
  | 'check_failed'
  /** The actor changed while the check was in flight; the answer was discarded. */
  | 'stale_actor'
  /** A check for this actor was already running; this caller did not start a second. */
  | 'in_flight';

/** Outcomes that invalidate the current session. Nothing else may sign a user out. */
const INVALIDATING_OUTCOMES: ReadonlySet<AppleCredentialCheckOutcome> = new Set([
  'revoked',
  'not_found',
  'transferred',
] as const);

export function isInvalidatingOutcome(outcome: AppleCredentialCheckOutcome): boolean {
  return INVALIDATING_OUTCOMES.has(outcome);
}

/**
 * Apple's stable user identifier for this actor, or null when this actor did
 * not sign in with Apple.
 *
 * Supabase stores the provider's `sub` claim from the identity token as the
 * Apple identity's `id`, which is exactly the value
 * `AppleAuthentication.getCredentialStateAsync(user)` expects. `identity_data.sub`
 * is accepted as a fallback for the same value; nothing else is ever used, so a
 * session that cannot produce a genuine Apple subject id yields null and the
 * caller does no Apple work at all (rather than guessing from an email or a
 * K Scan AI user id, which would be a different identifier entirely).
 */
export function resolveAppleUserId(user: User | null | undefined): string | null {
  const identities = user?.identities;
  if (!Array.isArray(identities)) return null;
  for (const identity of identities) {
    if (!identity || identity.provider !== 'apple') continue;
    const fromId = typeof identity.id === 'string' ? identity.id.trim() : '';
    if (fromId) return fromId;
    const sub = identity.identity_data?.sub;
    const fromSub = typeof sub === 'string' ? sub.trim() : '';
    if (fromSub) return fromSub;
  }
  return null;
}

/**
 * The subset of expo-apple-authentication this module uses. Declared
 * structurally so tests can supply it without the native module, and so the
 * real SDK's own exported enum — never a hardcoded numeric literal — is what
 * classifies a response.
 */
export interface AppleAuthenticationModuleLike {
  getCredentialStateAsync: (user: string) => Promise<unknown>;
  AppleAuthenticationCredentialState: {
    REVOKED: unknown;
    AUTHORIZED: unknown;
    NOT_FOUND: unknown;
    TRANSFERRED?: unknown;
  };
}

export interface AppleCredentialCheckDeps {
  /** Resolves the Apple SDK. Lazy by default: the native module never loads for a non-Apple actor. */
  loadAppleAuthentication?: () => Promise<AppleAuthenticationModuleLike>;
  /** The canonical logout authority. Invoked at most once per invalidating outcome. */
  signOut: () => Promise<void>;
  /** Platform override for tests. Defaults to the real runtime. */
  platformOS?: string;
}

async function defaultLoadAppleAuthentication(): Promise<AppleAuthenticationModuleLike> {
  // Lazy, matching services/watchlist/pushRegistration.ts: expo-apple-authentication
  // pulls in native code that must never load for an actor who never used Apple.
  const module = await import('expo-apple-authentication');
  return module as unknown as AppleAuthenticationModuleLike;
}

/**
 * Idempotency guard. Simultaneous lifecycle events (a session restoration that
 * lands while a foreground transition fires, or two 'active' events in a row)
 * must not produce a second Apple call or a second logout for the same actor.
 */
let inFlightAppleUserId: string | null = null;

/** Test seam only. Not used by production code. */
export function __resetAppleCredentialCheckForTests(): void {
  inFlightAppleUserId = null;
}

/**
 * Checks Apple's credential state for the authenticated Apple actor and, when
 * Apple no longer authorizes it, invalidates the K Scan AI session through the
 * injected canonical logout path.
 *
 * Never throws. Every failure mode resolves to a bounded outcome, and only the
 * three explicitly-invalidating Apple answers can end a session:
 *
 *  - AUTHORIZED  -> nothing happens; the user sees no interruption.
 *  - REVOKED     -> canonical sign-out.
 *  - NOT_FOUND   -> canonical sign-out.
 *  - TRANSFERRED -> canonical sign-out. Apple returns this when the app has moved
 *                   between developer accounts and the credential must be
 *                   re-established; the existing credential is not usable as-is,
 *                   so the conservative handling the SDK contract supports is to
 *                   require re-authentication. It is NOT silently treated as
 *                   authorized, and it deletes nothing — this lane deliberately
 *                   does not build an app-transfer migration system.
 *  - anything else, or a thrown error -> 'check_failed', session preserved. A
 *    network fault, a system error, or an unrecognised answer must never be
 *    able to sign a user out.
 */
export async function runAppleCredentialStateCheck(
  user: User | null | undefined,
  deps: AppleCredentialCheckDeps,
): Promise<AppleCredentialCheckOutcome> {
  const platformOS = deps.platformOS ?? Platform.OS;
  // iOS-only by construction. Android reaches this line and stops: no Apple
  // import, no Apple call, no behavior change of any kind.
  if (platformOS !== 'ios') return 'unsupported_platform';

  const appleUserId = resolveAppleUserId(user);
  // A Google, email, or anonymous actor has no Apple identity, so Apple is
  // never consulted about them.
  if (!appleUserId) return 'not_apple_actor';

  if (inFlightAppleUserId === appleUserId) return 'in_flight';
  inFlightAppleUserId = appleUserId;

  // Captured BEFORE the first await. If the actor changes while Apple is
  // answering, this request stops being current and the answer is discarded —
  // which is what stops actor A's REVOKED response from signing out actor B.
  const actorRequest = createActorRequest();

  try {
    const loadModule = deps.loadAppleAuthentication ?? defaultLoadAppleAuthentication;
    const AppleAuthentication = await loadModule();
    const state = await AppleAuthentication.getCredentialStateAsync(appleUserId);

    // The actor may have changed during the await (sign-out, or a switch to a
    // different account). A stale answer has no authority over whoever is
    // signed in now.
    if (!isActorRequestCurrent(actorRequest)) return 'stale_actor';

    const states = AppleAuthentication.AppleAuthenticationCredentialState;
    // Classified against the SDK's own exported constants, never against
    // hardcoded numeric values.
    let outcome: AppleCredentialCheckOutcome;
    if (state === states.AUTHORIZED) {
      outcome = 'authorized';
    } else if (state === states.REVOKED) {
      outcome = 'revoked';
    } else if (state === states.NOT_FOUND) {
      outcome = 'not_found';
    } else if (states.TRANSFERRED !== undefined && state === states.TRANSFERRED) {
      outcome = 'transferred';
    } else {
      // An answer this SDK version does not define. Failing safe preserves the
      // session; classifying an unknown value as revoked would sign users out
      // on an SDK change alone.
      return 'check_failed';
    }

    if (!isInvalidatingOutcome(outcome)) return outcome;

    await deps.signOut();
    return outcome;
  } catch {
    // Network fault, system error, missing native module, or a logout that
    // itself threw. Non-destructive by design: the session stands and a later
    // lifecycle boundary re-checks.
    return 'check_failed';
  } finally {
    inFlightAppleUserId = null;
  }
}
