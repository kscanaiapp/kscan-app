import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../services/supabaseClient';
import { AUTH_CALLBACK_URL } from '../services/authConfig';
import { isSessionUsable } from '../services/routingGuard';
import { invalidateAllMemoryCache } from '../services/style-chat/styleMemoryCache';
import { currentDevicePlatform, getOrCreateDeviceKey } from '../services/deviceIdentity';

/**
 * Returned by signUp so the caller can distinguish between an immediate
 * authenticated session (Case A) and an email-confirmation-required state
 * where no session exists yet (Case B).
 */
export interface SignUpResult {
  /** Null when Supabase requires email confirmation before granting a session. */
  session: Session | null;
  confirmationRequired: boolean;
}

export interface AuthSessionContextValue {
  session: Session | null;
  user: User | null;
  /** True while the initial getSession() call is in flight. */
  loading: boolean;
  isAuthenticated: boolean;
  /** True during a background token refresh. Writes should be deferred. */
  isRefreshing: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

// Registers/refreshes this install's row in user_device_sessions so the
// server-side max-5-active-sessions enforcement (register_user_device_session)
// actually has data to enforce against. Previously this RPC was correctly
// written in SQL but never called from any client -- the five-session cap
// was dead code. Best-effort: a failure here must never block sign-in.
async function registerDeviceSession(): Promise<void> {
  try {
    const deviceKey = await getOrCreateDeviceKey();
    const { error } = await supabase.rpc('register_user_device_session', {
      p_device_key: deviceKey,
      p_platform: currentDevicePlatform(),
    });
    if (error) {
      console.warn('[AuthSession] register_user_device_session failed', error.message);
    }
  } catch (err) {
    console.warn('[AuthSession] register_user_device_session threw', err);
  }
}

export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(async ({ data }) => {
      const bootSession = data.session ?? null;
      const usableSession = isSessionUsable(bootSession) ? bootSession : null;
      if (bootSession && !usableSession) {
        invalidateAllMemoryCache();
        await supabase.auth.signOut();
      }
      if (!mounted) return;
      setSession(usableSession);
      setLoading(false);
      if (usableSession) void registerDeviceSession();
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      const usableSession = isSessionUsable(newSession) ? newSession : null;
      if (event === 'TOKEN_REFRESHED') {
        setIsRefreshing(false);
      } else {
        invalidateAllMemoryCache();
      }
      setSession(usableSession);
      // Runs on SIGNED_IN and on every TOKEN_REFRESHED -- the RPC is an
      // upsert keyed on (user_id, device_key), so this both registers new
      // devices and keeps last_seen_at fresh for already-registered ones,
      // which is what protects an actively-used device from being evicted
      // as "oldest" by the 5-session cap.
      if (usableSession) void registerDeviceSession();
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signUp = useCallback(async (email: string, password: string): Promise<SignUpResult> => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: AUTH_CALLBACK_URL },
    });
    if (error) throw error;
    return {
      session: data.session ?? null,
      confirmationRequired: !data.session,
    };
  }, []);

  const signOut = useCallback(async () => {
    invalidateAllMemoryCache();
    setSession(null);
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthSessionContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      isAuthenticated: !loading && isSessionUsable(session),
      isRefreshing,
      signIn,
      signUp,
      signOut,
    }),
    [session, loading, isRefreshing, signIn, signUp, signOut],
  );

  return (
    <AuthSessionContext.Provider value={value}>
      {children}
    </AuthSessionContext.Provider>
  );
}

export function useAuthSession(): AuthSessionContextValue {
  const ctx = useContext(AuthSessionContext);
  if (!ctx) throw new Error('useAuthSession must be used within AuthSessionProvider');
  return ctx;
}
