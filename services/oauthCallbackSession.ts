import type { Session } from '@supabase/supabase-js';

import { supabase } from './supabaseClient';
import {
  clearAuthCallbackRequest,
  peekAuthCallbackRequest,
  readUnverifiedSubjectClaim,
} from './authCallbackOrigin';

export type ParsedOAuthCallback = {
  accessToken?: string | null;
  code?: string | null;
  hasSessionTokens?: boolean;
  refreshToken?: string | null;
};

export type ParsedTokenHashCallback = {
  tokenHash?: string | null;
  type?: string | null;
};

export type OAuthCallbackSessionResult = {
  error: unknown | null;
  session: Session | null;
  source: 'code' | 'tokens' | 'otp' | 'missing';
};

/**
 * SEC-AUTH-CB-001. Why a token-bearing callback is refused. Both are security
 * outcomes, not transport failures, and both surface to the user as the
 * ordinary "this link could not be used" error -- a refusal never tells a
 * caller which account a token belonged to.
 */
export class AuthCallbackOriginError extends Error {
  readonly reason: 'unsolicited_callback' | 'identity_substitution';

  constructor(reason: 'unsolicited_callback' | 'identity_substitution', message: string) {
    super(message);
    this.name = 'AuthCallbackOriginError';
    this.reason = reason;
  }
}

type AuthClient = Pick<typeof supabase, 'auth'>;

let currentCallback:
  | { fingerprint: string; result: Promise<OAuthCallbackSessionResult> }
  | null = null;
let lastCompletedCallback: { fingerprint: string; completedAt: number } | null = null;

const DUPLICATE_CALLBACK_WINDOW_MS = 10000;

function fingerprintSecret(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function getCallbackFingerprint(parsed: ParsedOAuthCallback): string {
  if (parsed.code) return `code:${fingerprintSecret(parsed.code)}`;
  if (parsed.hasSessionTokens && parsed.accessToken && parsed.refreshToken) {
    return `tokens:${fingerprintSecret(`${parsed.accessToken}:${parsed.refreshToken}`)}`;
  }
  return 'missing';
}

async function establishOAuthCallbackSession(
  parsed: ParsedOAuthCallback,
  client: AuthClient,
): Promise<OAuthCallbackSessionResult> {
  if (parsed.code) {
    const { data, error } = await client.auth.exchangeCodeForSession(parsed.code);
    return {
      error: error ?? null,
      session: data.session ?? null,
      source: 'code',
    };
  }

  if (parsed.hasSessionTokens && parsed.accessToken && parsed.refreshToken) {
    // ── SEC-AUTH-CB-001: gate 1 -- never swap one signed-in user for another ─
    // Decided before anything else, and before any session is written, so no
    // SIGNED_IN event for a substituted account can fire. A callback that only
    // re-states the identity already signed in changes nothing, so it settles
    // as the existing session (this is also how a duplicate Android delivery
    // lands once the marker has been spent). A callback naming ANY other
    // account is refused outright, marker or not.
    const { data: currentData } = await client.auth.getSession();
    const currentSession = currentData.session ?? null;
    const currentUserId = currentSession?.user?.id ?? null;
    if (currentUserId) {
      if (readUnverifiedSubjectClaim(parsed.accessToken) !== currentUserId) {
        return {
          error: new AuthCallbackOriginError(
            'identity_substitution',
            'Auth callback would have replaced the signed-in account with a different one.',
          ),
          session: null,
          source: 'tokens',
        };
      }
      return { error: null, session: currentSession, source: 'tokens' };
    }

    // ── SEC-AUTH-CB-001: gate 2 -- was this callback asked for? ──────────────
    // setSession validates a token pair server-side, so forged tokens already
    // fail. What it cannot tell is whether THIS DEVICE asked for the pair: a
    // pair that is genuinely valid for the attacker's own account is accepted
    // exactly like the user's own. Requiring a live device-initiated marker is
    // what separates the two. Fails closed -- no marker, no session.
    if (!(await peekAuthCallbackRequest())) {
      return {
        error: new AuthCallbackOriginError(
          'unsolicited_callback',
          'Auth callback carried session tokens for a sign-in this device never started.',
        ),
        session: null,
        source: 'tokens',
      };
    }

    const { data, error } = await client.auth.setSession({
      access_token: parsed.accessToken,
      refresh_token: parsed.refreshToken,
    });
    const session = data.session ?? null;
    // The marker authorises one completed sign-in, not a standing licence: once
    // a session exists, a later unsolicited link finds nothing to spend. A
    // failed attempt deliberately keeps it so an ordinary retry still works
    // inside the original TTL.
    if (!error && session) {
      await clearAuthCallbackRequest();
    }
    return {
      error: error ?? null,
      session,
      source: 'tokens',
    };
  }

  return {
    error: new Error('OAuth callback did not contain session credentials.'),
    session: null,
    source: 'missing',
  };
}

/**
 * Completes a browser callback once per callback payload. Both the browser
 * caller and the deep-link route can receive the same URL on Android; sharing
 * this promise prevents a duplicate PKCE exchange and duplicate auth event.
 */
export function completeOAuthCallbackSession(
  parsed: ParsedOAuthCallback,
  client: AuthClient = supabase,
): Promise<OAuthCallbackSessionResult> {
  const fingerprint = getCallbackFingerprint(parsed);
  if (currentCallback?.fingerprint === fingerprint) {
    return currentCallback.result;
  }
  if (
    lastCompletedCallback?.fingerprint === fingerprint &&
    Date.now() - lastCompletedCallback.completedAt <= DUPLICATE_CALLBACK_WINDOW_MS
  ) {
    return client.auth.getSession().then(({ data, error }) => ({
      error: error ?? (data.session ? null : new Error('Accepted OAuth session is no longer available.')),
      session: data.session ?? null,
      source: parsed.code ? 'code' as const : parsed.hasSessionTokens ? 'tokens' as const : 'missing' as const,
    }));
  }

  const result = establishOAuthCallbackSession(parsed, client).catch((error) => ({
    error,
    session: null,
    source: parsed.code ? 'code' as const : parsed.hasSessionTokens ? 'tokens' as const : 'missing' as const,
  }));
  currentCallback = { fingerprint, result };
  void result.then((completed) => {
    if (!completed.error && completed.session) {
      lastCompletedCallback = { fingerprint, completedAt: Date.now() };
    }
    if (currentCallback?.result === result) {
      currentCallback = null;
    }
  });
  return result;
}

/**
 * SEC-AUTH-CB-001 -- the OTP half of the same callback.
 *
 * A `token_hash` + `type` link is server-verified and single-use, so it cannot
 * be forged either. It carries the SAME forced-login shape as the token
 * fragment, though: an attacker can start a password reset on their OWN
 * account and forward the resulting kscan:// link, and verifyOtp would sign the
 * victim's device into the attacker's account. Unlike an access token a
 * token_hash names no subject, so the identity check cannot run in advance --
 * the device-initiated marker is the gate, and a substitution that somehow gets
 * past it is undone locally rather than left standing.
 */
export async function completeTokenHashCallbackSession(
  parsed: ParsedTokenHashCallback,
  client: AuthClient = supabase,
): Promise<OAuthCallbackSessionResult> {
  if (!parsed.tokenHash || !parsed.type) {
    return {
      error: new Error('Auth callback did not contain a usable one-time token.'),
      session: null,
      source: 'missing',
    };
  }

  const { data: before } = await client.auth.getSession();
  const priorUserId = before.session?.user?.id ?? null;

  if (!(await peekAuthCallbackRequest())) {
    return {
      error: new AuthCallbackOriginError(
        'unsolicited_callback',
        'Auth callback carried a one-time token for a flow this device never started.',
      ),
      session: null,
      source: 'otp',
    };
  }

  const { data, error } = await client.auth.verifyOtp({
    token_hash: parsed.tokenHash,
    type: parsed.type,
  } as never);
  if (error) {
    return { error, session: null, source: 'otp' };
  }

  const session = data.session ?? null;
  if (priorUserId && session && session.user?.id !== priorUserId) {
    // verifyOtp has already written a session for a different account. Local
    // scope only: this clears THIS device, and never reaches out to revoke
    // tokens on an account we do not own.
    await client.auth.signOut({ scope: 'local' });
    return {
      error: new AuthCallbackOriginError(
        'identity_substitution',
        'Auth callback would have replaced the signed-in account with a different one.',
      ),
      session: null,
      source: 'otp',
    };
  }

  if (session) {
    await clearAuthCallbackRequest();
  }
  return { error: null, session, source: 'otp' };
}
