import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

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
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
