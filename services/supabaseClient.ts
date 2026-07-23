import { createClient, processLock } from '@supabase/supabase-js';
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

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: secureSessionStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    lock: processLock,
  },
});
