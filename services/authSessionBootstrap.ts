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
 * Terminal stale-token failures are removed. Retryable/unrelated failures are
 * retained for a later launch, hidden from this client instance, and reported
 * to AuthSessionContext for safe diagnostics. One recovery runs per key, which
 * prevents construction-time duplicate listeners from creating a retry loop.
 */
export function createAuthBootstrapStorage({
  storage,
  refreshSession,
  onRecoveryError,
  now = Date.now,
  refreshMarginMs = SUPABASE_SESSION_REFRESH_MARGIN_MS,
}: AuthBootstrapStorageOptions): AuthStorage {
  const hiddenKeys = new Set<string>();
  const activeRecoveries = new Map<string, Promise<string | null>>();

  const recover = async (key: string): Promise<string | null> => {
    if (hiddenKeys.has(key)) return null;

    const raw = await storage.getItem(key);
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

    if (result.error) {
      onRecoveryError(result.error);
      hiddenKeys.add(key);
      if (isHandledStaleRefreshTokenError(result.error)) {
        try {
          await storage.removeItem(key);
        } catch (storageError) {
          onRecoveryError(storageError);
        }
      }
      return null;
    }

    if (!result.session) {
      const error = new Error('Supabase refresh completed without a session.');
      onRecoveryError(error);
      hiddenKeys.add(key);
      return null;
    }

    const refreshedRaw = JSON.stringify(result.session);
    await storage.setItem(key, refreshedRaw);
    return refreshedRaw;
  };

  return {
    getItem(key) {
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
      hiddenKeys.delete(key);
      await storage.setItem(key, value);
    },
    async removeItem(key) {
      hiddenKeys.delete(key);
      await storage.removeItem(key);
    },
  };
}
