import { createClient } from '@supabase/supabase-js';
import { createAuthBootstrapStorage } from './authSessionBootstrap';
import { secureSessionStorage } from './secureSessionStorage';

const configuredUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const configuredAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabaseConfigError =
  !configuredUrl || !configuredAnonKey
    ? 'Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY.'
    : null;

if (supabaseConfigError && typeof __DEV__ !== 'undefined' && __DEV__) {
  console.warn(`[K Scan Supabase] ${supabaseConfigError}`);
}

const url = configuredUrl || 'https://missing-supabase-url.supabase.co';
const anonKey = configuredAnonKey || 'missing-supabase-anon-key';

let authBootstrapStorageError: unknown = null;
let bootstrapRefreshClient: ReturnType<typeof createClient> | null = null;

function getBootstrapRefreshClient() {
  if (!bootstrapRefreshClient) {
    bootstrapRefreshClient = createClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
        storageKey: 'kscan-auth-bootstrap-refresh',
      },
    });
  }
  return bootstrapRefreshClient;
}

const authStorage = createAuthBootstrapStorage({
  // Native Supabase sessions carry a refresh token, so the bootstrap-refresh
  // layer is backed by the platform keystore/keychain (with safe migration from
  // legacy AsyncStorage) rather than AsyncStorage directly.
  storage: secureSessionStorage,
  refreshSession: async (refreshToken) => {
    const { data, error } = await getBootstrapRefreshClient().auth.refreshSession({
      refresh_token: refreshToken,
    });
    return { session: data.session, error };
  },
  onRecoveryError: (error) => {
    authBootstrapStorageError = error;
  },
});

export function takeAuthBootstrapStorageError(): unknown {
  const error = authBootstrapStorageError;
  authBootstrapStorageError = null;
  return error;
}

/**
 * Durable-logout backstop. Supabase skips its own local cleanup when the global
 * sign-out request fails (offline, 5xx), which would leave restorable session
 * material behind for the next launch.
 */
export function clearPersistedAuthSessions(): Promise<void> {
  return authStorage.clearPersistedSessions();
}

/**
 * True when session material is still persisted but could not be renewed
 * because of a transient failure — an actor awaiting recovery, not a signed-out
 * one.
 */
export function hasPendingAuthSessionRecovery(): boolean {
  return authStorage.hasPendingSessionRecovery();
}

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: authStorage,
    persistSession: true,
    // Bootstrap explicitly before starting the background refresher so a
    // handled stale refresh token can be cleared without auth-js emitting a
    // React Native LogBox error during client construction.
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
