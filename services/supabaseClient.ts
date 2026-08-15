import { createClient } from '@supabase/supabase-js';
import { createAuthBootstrapStorage } from './authSessionBootstrap';
import { secureSessionStorage } from './secureSessionStorage';
import { validateSupabaseConfig } from './supabaseConfig';

const configuredUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const configuredAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

const configValidation = validateSupabaseConfig(configuredUrl, configuredAnonKey);

export const supabaseRuntimeProjectRef = configValidation.urlProjectRef;
export const supabaseConfigError = configValidation.ok
  ? null
  : `Supabase configuration error [${configValidation.code}]: ${configValidation.message}`;

export function assertSupabaseConfigured(): void {
  if (supabaseConfigError) {
    throw new Error(supabaseConfigError);
  }
}

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

/**
 * Remove this device's persisted Supabase auth material, unconditionally.
 *
 * KSB29-057. `supabase.auth.signOut()` only reaches its local `_removeSession()`
 * step if the remote revocation call succeeds or fails with 401/403/404 — a
 * network failure returns early, leaving the persisted session intact. A user
 * who pressed Logout offline would then be restored as authenticated on the
 * next cold start.
 *
 * Logout is an explicit security decision by the user, so it cannot depend on
 * connectivity. This clears the material directly, through the same storage
 * adapter the client reads (so `hiddenKeys` is reset and both the keystore and
 * the legacy AsyncStorage location are cleared).
 *
 * The key is read off the client itself, which is authoritative; the fallback
 * is auth-js's own default derivation, used only if that internal field is ever
 * renamed.
 */
export async function clearPersistedAuthSession(): Promise<void> {
  const storageKey =
    (supabase.auth as unknown as { storageKey?: string }).storageKey ||
    `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;

  await authStorage.removeItem(storageKey);
  // auth-js writes the PKCE verifier beside the session and removes it in the
  // same step that the network failure skips.
  await authStorage.removeItem(`${storageKey}-code-verifier`);
}

export function takeAuthBootstrapStorageError(): unknown {
  const error = authBootstrapStorageError;
  authBootstrapStorageError = null;
  return error;
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
