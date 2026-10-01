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
import { revokeAllWearableSessions } from '../services/wearables/bridge';

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
    try {
      await revokeAllWearableSessions();
    } catch {
      // Sessions are short-lived server-side; sign-out must not be held hostage by a network outage.
    }
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
