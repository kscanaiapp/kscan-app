import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../services/supabaseClient';
import { AUTH_CALLBACK_URL } from '../services/authConfig';
import { isSessionUsable } from '../services/routingGuard';
import { invalidateAllMemoryCache } from '../services/style-chat/styleMemoryCache';

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
  signUp: (email: string, password: string, name?: string) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const initialAuthResolvedRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    let getSessionResolved = false;
    let authEventSeen = false;

    const completeInitialAuth = (nextSession: Session | null) => {
      if (!mounted || initialAuthResolvedRef.current) return;
      initialAuthResolvedRef.current = true;
      setSession(nextSession);
      setLoading(false);
    };

    const completeIfBothNullSourcesResolved = () => {
      // A transient null from either startup source is not enough to mark the
      // user signed out; cold-start storage hydration can report the session
      // from the other source a moment later.
      if (getSessionResolved && authEventSeen) {
        completeInitialAuth(null);
      }
    };

    supabase.auth.getSession().then(async ({ data }) => {
      const bootSession = data.session ?? null;
      const usableSession = isSessionUsable(bootSession) ? bootSession : null;
      if (bootSession && !usableSession) {
        invalidateAllMemoryCache();
        await supabase.auth.signOut();
      }
      if (!mounted) return;
      getSessionResolved = true;
      if (usableSession) {
        completeInitialAuth(usableSession);
      } else {
        completeIfBothNullSourcesResolved();
      }
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
      authEventSeen = true;

      if (!mounted) return;

      if (initialAuthResolvedRef.current) {
        setSession(usableSession);
      } else if (usableSession) {
        completeInitialAuth(usableSession);
      } else {
        completeIfBothNullSourcesResolved();
      }
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

  const signUp = useCallback(
    async (email: string, password: string, name?: string): Promise<SignUpResult> => {
      const trimmedName = (name ?? '').trim();
      // Persist the optional display name into user metadata so Home can greet
      // the user by name. Mirrors the keys Google/Apple populate so the Home
      // name resolver (full_name → name → display_name) works uniformly.
      const metadata = trimmedName
        ? { full_name: trimmedName, name: trimmedName, display_name: trimmedName }
        : undefined;
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: AUTH_CALLBACK_URL,
          ...(metadata ? { data: metadata } : {}),
        },
      });
      if (error) throw error;
      return {
        session: data.session ?? null,
        confirmationRequired: !data.session,
      };
    },
    [],
  );

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
