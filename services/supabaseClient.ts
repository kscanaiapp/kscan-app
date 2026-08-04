import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { validateSupabaseConfig } from './supabaseConfig';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabaseConfigStatus = validateSupabaseConfig(url, anonKey);

// Fail closed and named. An unset or cross-project value previously reached
// createClient() and surfaced downstream as an ordinary auth error, which the
// sign-in screen then reported to the user as an incorrect password.
if (!supabaseConfigStatus.ok) {
  throw new Error(
    `Supabase configuration error [${supabaseConfigStatus.code}]: ${supabaseConfigStatus.message}`,
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
