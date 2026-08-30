type AuthErrorLike = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
  status?: unknown;
};

type AuthStorage = {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem: (key: string) => void | Promise<void>;
};

export type AuthBootstrapStorage = AuthStorage & {
  /** Removes every session key this adapter has observed. */
  clearPersistedSessions: () => Promise<void>;
  /**
   * True when a parseable session is still persisted but could not be renewed
   * because of a transient failure. Lets the app show a truthful recovery state
   * instead of a login screen for an actor who is not actually signed out.
   */
  hasPendingSessionRecovery: () => boolean;
};

type PersistedSession = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
};

type RefreshPersistedSessionResult = {
  session: PersistedSession | null;
  error: unknown;
};

type AuthBootstrapStorageOptions = {
  storage: AuthStorage;
  refreshSession: (refreshToken: string) => Promise<RefreshPersistedSessionResult>;
  onRecoveryError: (error: unknown) => void;
  now?: () => number;
  refreshMarginMs?: number;
};

const SUPABASE_SESSION_REFRESH_MARGIN_MS = 90_000;

const STALE_REFRESH_TOKEN_CODES = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'refresh_token_reuse_detected',
]);

/**
 * Server-side rejections that permanently invalidate stored session material,
 * including the deleted-account case. A pre-deletion token that reaches one of
 * these must never be retained for a later restoration attempt.
 */
const REVOKED_SESSION_CODES = new Set([
  'session_not_found',
  'session_expired',
  'user_not_found',
  'user_banned',
]);

/**
 * Tracks whether an auth-state event has made an in-flight bootstrap result
 * obsolete. A newer SIGNED_IN/TOKEN_REFRESHED event is authoritative and must
 * never be overwritten by the older getSession() result that started first.
 */
export function createAuthBootstrapGenerationGuard() {
  let authEventGeneration = 0;

  return {
    beginBootstrap(): number {
      return authEventGeneration;
    },
    noteAuthEvent(): number {
      authEventGeneration += 1;
      return authEventGeneration;
    },
    isBootstrapCurrent(startGeneration: number): boolean {
      return startGeneration === authEventGeneration;
    },
  };
}

/**
 * Deduplicates Supabase's INITIAL_SESSION/SIGNED_IN event pairs so actor-owned
 * runtime stores are reset once per actual actor boundary, not once per event.
 */
export function createAuthActorBoundaryGuard() {
  let activeActorId: string | null | undefined;

  return {
    noteActor(nextActorId: string | null): boolean {
      if (activeActorId === nextActorId) return false;
      activeActorId = nextActorId;
      return true;
    },
  };
}

/**
 * The bootstrap storage adapter removes a terminal stale refresh token before
 * Supabase's initial listener can load it. This classifier keeps that expected
 * recovery path quiet while allowing every other auth failure to be reported.
 */
export function isHandledStaleRefreshTokenError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as AuthErrorLike;
  const code = typeof candidate.code === 'string' ? candidate.code.toLowerCase() : '';
  if (STALE_REFRESH_TOKEN_CODES.has(code)) return true;

  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const message = typeof candidate.message === 'string'
    ? candidate.message.trim().toLowerCase()
    : '';
  const status = typeof candidate.status === 'number' ? candidate.status : null;

  return (
    name === 'AuthApiError' &&
    (status === 400 || status === 401) &&
    /^invalid refresh token(?:: (?:refresh token not found|refresh token already used))?$/.test(message)
  );
}

/**
 * A refresh failure is terminal only when the server actually rejected the
 * refresh token or the actor behind it. Everything else — offline, DNS, TLS,
 * timeout, cancellation, 5xx, rate limiting, an unrecognised fault — is
 * transient, because discarding a recoverable credential for a transport fault
 * signs out a valid user while the server remains the authority that would
 * reject a genuinely revoked token on the next attempt.
 */
export function isTerminalRefreshFailure(error: unknown): boolean {
  if (isHandledStaleRefreshTokenError(error)) return true;
  if (!error || typeof error !== 'object') return false;

  const candidate = error as AuthErrorLike;
  const code = typeof candidate.code === 'string' ? candidate.code.toLowerCase() : '';
  if (REVOKED_SESSION_CODES.has(code)) return true;

  // A retryable fetch failure is never an authorization decision, even when
  // Supabase surfaces it as an AuthError with a status of 0.
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  if (name === 'AuthRetryableFetchError') return false;

  return false;
}

function parsePersistedSession(raw: string): PersistedSession | null {
  try {
    const candidate = JSON.parse(raw) as Partial<PersistedSession> | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.access_token !== 'string' ||
      typeof candidate.refresh_token !== 'string'
    ) {
      return null;
    }
    return candidate as PersistedSession;
  } catch {
    return null;
  }
}

/**
 * Supabase installs an internal INITIAL_SESSION listener while createClient()
 * is running. For an expired persisted session that listener refreshes and
 * console.errors before app bootstrap can classify the result. This storage
 * adapter validates only near-expiry startup sessions first, through the same
 * Supabase refresh API, so the internal listener sees either a refreshed
 * session or a clean signed-out state.
 *
 * Terminal stale-token failures — a rejected refresh token, a revoked session,
 * a deleted actor — are removed. Every other failure is transient: the stored
 * session is left fully intact, only the current read resolves empty, and the
 * key is never hidden, so the next read (Supabase's refresh tick, a foreground
 * resume, an explicit retry) recovers the actor without a relaunch. Failures
 * are reported to AuthSessionContext for safe diagnostics.
 *
 * Reads for the same key share one in-flight recovery, so a refresh token is
 * never rotated twice concurrently, and a recovery whose result arrives after a
 * newer authoritative write is discarded rather than applied.
 */
export function createAuthBootstrapStorage({
  storage,
  refreshSession,
  onRecoveryError,
  now = Date.now,
  refreshMarginMs = SUPABASE_SESSION_REFRESH_MARGIN_MS,
}: AuthBootstrapStorageOptions): AuthBootstrapStorage {
  const hiddenKeys = new Set<string>();
  const observedKeys = new Set<string>();
  const activeRecoveries = new Map<string, Promise<string | null>>();
  const keysAwaitingRecovery = new Set<string>();
  // Bumped by every authoritative write. A recovery that started before the
  // bump is stale by definition and must not act on the newer session.
  const writeGenerations = new Map<string, number>();

  const currentGeneration = (key: string) => writeGenerations.get(key) ?? 0;
  const noteWrite = (key: string) => {
    writeGenerations.set(key, currentGeneration(key) + 1);
  };

  const recover = async (key: string): Promise<string | null> => {
    if (hiddenKeys.has(key)) return null;

    const startGeneration = currentGeneration(key);
    let raw: string | null;
    try {
      raw = await storage.getItem(key);
    } catch (storageError) {
      // A read fault is not an authorization decision. Report it and fail
      // closed for this read only — the stored session is left untouched so a
      // later read or launch can still recover the actor.
      onRecoveryError(storageError);
      return null;
    }
    if (!raw) return null;

    const session = parsePersistedSession(raw);
    const expiresAt = session?.expires_at;
    if (
      !session ||
      typeof expiresAt !== 'number' ||
      expiresAt * 1000 - now() >= refreshMarginMs
    ) {
      return raw;
    }

    let result: RefreshPersistedSessionResult;
    try {
      result = await refreshSession(session.refresh_token);
    } catch (error) {
      result = { session: null, error };
    }

    // A newer sign-in, rotation or logout landed while this refresh was in
    // flight. That write is authoritative; this result is stale and must not
    // clear, hide or overwrite it.
    const isStale = currentGeneration(key) !== startGeneration;

    if (result.error) {
      onRecoveryError(result.error);
      if (isStale) return null;
      if (isTerminalRefreshFailure(result.error)) {
        hiddenKeys.add(key);
        keysAwaitingRecovery.delete(key);
        try {
          await storage.removeItem(key);
        } catch (storageError) {
          onRecoveryError(storageError);
        }
        return null;
      }
      keysAwaitingRecovery.add(key);
      // Transient transport or server failure. The stored session is left fully
      // intact and this read alone resolves empty — deliberately without
      // hiding the key, so the very next read (Supabase's 30s refresh tick, a
      // foreground resume, or an explicit retry) attempts recovery again.
      //
      // Handing the expired session back instead would be worse: auth-js
      // refreshes it immediately and calls _removeSession() for any
      // non-retryable AuthError, which includes HTTP 429 and 500 — destroying
      // a valid credential for a rate limit or a blip.
      return null;
    }

    if (!result.session) {
      onRecoveryError(new Error('Supabase refresh completed without a session.'));
      if (!isStale) keysAwaitingRecovery.add(key);
      return null;
    }

    const refreshedRaw = JSON.stringify(result.session);
    if (isStale) {
      // Hand this launch the session it refreshed, but never persist it over
      // the newer one that arrived while the request was in flight.
      return refreshedRaw;
    }

    keysAwaitingRecovery.delete(key);
    noteWrite(key);
    try {
      await storage.setItem(key, refreshedRaw);
    } catch (storageError) {
      // Never silent: a failed persist is reported so the launch is diagnosable.
      // The refreshed session is still returned so this launch stays signed in.
      onRecoveryError(storageError);
    }
    return refreshedRaw;
  };

  return {
    getItem(key) {
      observedKeys.add(key);
      if (hiddenKeys.has(key)) return Promise.resolve(null);
      const existing = activeRecoveries.get(key);
      if (existing) return existing;

      const recovery = recover(key).finally(() => {
        if (activeRecoveries.get(key) === recovery) activeRecoveries.delete(key);
      });
      activeRecoveries.set(key, recovery);
      return recovery;
    },
    async setItem(key, value) {
      observedKeys.add(key);
      hiddenKeys.delete(key);
      keysAwaitingRecovery.delete(key);
      noteWrite(key);
      try {
        await storage.setItem(key, value);
      } catch (storageError) {
        onRecoveryError(storageError);
      }
    },
    async removeItem(key) {
      observedKeys.add(key);
      hiddenKeys.delete(key);
      keysAwaitingRecovery.delete(key);
      noteWrite(key);
      try {
        await storage.removeItem(key);
      } catch (storageError) {
        onRecoveryError(storageError);
      }
    },
    hasPendingSessionRecovery() {
      return keysAwaitingRecovery.size > 0;
    },
    async clearPersistedSessions() {
      // Durable-logout backstop. Supabase skips its own local cleanup when the
      // global sign-out request fails, which would otherwise let a deliberately
      // logged-out actor be restored on the next launch.
      keysAwaitingRecovery.clear();
      for (const key of observedKeys) {
        hiddenKeys.add(key);
        noteWrite(key);
        try {
          await storage.removeItem(key);
        } catch (storageError) {
          onRecoveryError(storageError);
        }
      }
    },
  };
}
