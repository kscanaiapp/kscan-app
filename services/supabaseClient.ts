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
