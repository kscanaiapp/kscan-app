import type { Session } from '@supabase/supabase-js';

import { supabase } from './supabaseClient';

export type ParsedOAuthCallback = {
  accessToken?: string | null;
  code?: string | null;
  hasSessionTokens?: boolean;
  refreshToken?: string | null;
};

export type OAuthCallbackSessionResult = {
  error: unknown | null;
  session: Session | null;
  source: 'code' | 'tokens' | 'missing';
};

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
    const { data, error } = await client.auth.setSession({
      access_token: parsed.accessToken,
      refresh_token: parsed.refreshToken,
    });
    return {
      error: error ?? null,
      session: data.session ?? null,
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
