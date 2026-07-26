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
import { supabase, takeAuthBootstrapStorageError } from '../services/supabaseClient';
import { AUTH_CALLBACK_URL } from '../services/authConfig';
import { isSessionUsable } from '../services/routingGuard';
import { invalidateAllMemoryCache } from '../services/style-chat/styleMemoryCache';
import { resetAttachmentStore } from '../services/style-chat/styleChatAttachmentStore';
import { resetVisualContextStore } from '../services/style-chat/eliseVisualContextStore';
import { cleanupSanitizedImage } from '../services/privacyImageUpload';
import {
  createAuthBootstrapGenerationGuard,
  createAuthActorBoundaryGuard,
  isHandledStaleRefreshTokenError,
} from '../services/authSessionBootstrap';
import { traceAuthLifecycle } from '../services/authLifecycleTrace';
import { logError } from '../src/utils/errorLogger';
import { stopAvatarSpeechPlayback } from '../services/avatarSpeech';
import { resetStylistIdentityStore } from '../stores/stylistIdentityStore';
import { resetStylistVoicePreferenceState } from '../stores/stylistVoicePreferenceStore';
import { clearStyleChatHandoffContext } from '../services/style-chat/styleChatHandoffContext';
import { resetStyleChatGreetingState } from '../services/style-chat/styleChatGreeting';
import { advanceActorEpoch } from '../services/actorContext';

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

function resetActorScopedRuntimeState(nextActorId: string | null): void {
  // Advance the Recent Scan actor epoch FIRST. Every in-flight scanner save,
  // library refresh, cloud hydration and media write captured the previous
  // epoch, so advancing here is what causes their late completions (including
  // stale `catch`/`finally` handlers) to be rejected instead of repopulating
  // the new actor's state.
  advanceActorEpoch(nextActorId);
  invalidateAllMemoryCache();
  resetAttachmentStore();
  // Actor change (sign-in / sign-out / user update): drop any composer
  // attachment drafts, pending visual context, and un-consumed handoff so
  // this device's local image URIs and resolved references never cross
  // between accounts.
  for (const uri of resetVisualContextStore()) {
    void cleanupSanitizedImage(uri);
  }
  clearStyleChatHandoffContext();
  resetStyleChatGreetingState();
  resetStylistIdentityStore();
  resetStylistVoicePreferenceState();
}

export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const authEventGenerationGuardRef = useRef(createAuthBootstrapGenerationGuard());
  const authActorBoundaryGuardRef = useRef(createAuthActorBoundaryGuard());

  useEffect(() => {
    let mounted = true;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!mounted) return;
      authEventGenerationGuardRef.current.noteAuthEvent();
      const usableSession = isSessionUsable(newSession) ? newSession : null;
      traceAuthLifecycle('auth-state-event', {
        authEvent: event,
        sessionPresent: Boolean(newSession),
        sessionUsable: Boolean(usableSession),
      });
      if (event === 'TOKEN_REFRESHED') {
        setIsRefreshing(false);
      }
      if (authActorBoundaryGuardRef.current.noteActor(usableSession?.user.id ?? null)) {
        // Any actor boundary invalidates pending generation and native playback
        // before the new auth state can become visible to app consumers.
        void stopAvatarSpeechPlayback();
        resetActorScopedRuntimeState(usableSession?.user.id ?? null);
      }
      setSession(usableSession);
      if (event === 'SIGNED_IN') {
        setLoading(false);
      }
    });

    const initializeSession = async () => {
      const startGeneration = authEventGenerationGuardRef.current.beginBootstrap();
      traceAuthLifecycle('bootstrap-start', { loading: true });
      try {
        const { data, error } = await supabase.auth.getSession();
        const storageRecoveryError = takeAuthBootstrapStorageError();

        if (storageRecoveryError) {
          const handledStaleRefreshToken = isHandledStaleRefreshTokenError(storageRecoveryError);
          const bootstrapIsCurrent = authEventGenerationGuardRef.current.isBootstrapCurrent(
            startGeneration,
          );
          if (!handledStaleRefreshToken) {
            logError('Unable to restore auth session', storageRecoveryError);
          } else if (
            bootstrapIsCurrent &&
            authActorBoundaryGuardRef.current.noteActor(null)
          ) {
            void stopAvatarSpeechPlayback();
            resetActorScopedRuntimeState(null);
          }
          traceAuthLifecycle('bootstrap-result', {
            ignoredAsStale: !bootstrapIsCurrent,
            outcome: handledStaleRefreshToken ? 'stale-refresh-cleared' : 'error',
            sessionPresent: false,
          });
          if (mounted && bootstrapIsCurrent) setSession(null);
          return;
        }

        if (error) {
          const handledStaleRefreshToken = isHandledStaleRefreshTokenError(error);
          if (!handledStaleRefreshToken) {
            logError('Unable to restore auth session', error);
          }
          const bootstrapIsCurrent = authEventGenerationGuardRef.current.isBootstrapCurrent(startGeneration);
          traceAuthLifecycle('bootstrap-result', {
            ignoredAsStale: !bootstrapIsCurrent,
            outcome: handledStaleRefreshToken ? 'stale-refresh-cleared' : 'error',
            sessionPresent: false,
          });
          if (mounted && bootstrapIsCurrent) setSession(null);
          return;
        }

        const bootSession = data.session ?? null;
        const usableSession = isSessionUsable(bootSession) ? bootSession : null;
        if (bootSession && !usableSession) {
          invalidateAllMemoryCache();
        }
        const bootstrapIsCurrent = authEventGenerationGuardRef.current.isBootstrapCurrent(startGeneration);
        traceAuthLifecycle('bootstrap-result', {
          ignoredAsStale: !bootstrapIsCurrent,
          outcome: usableSession ? 'session-restored' : 'no-usable-session',
          sessionPresent: Boolean(bootSession),
          sessionUsable: Boolean(usableSession),
        });
        if (mounted && bootstrapIsCurrent) setSession(usableSession);
      } catch (error) {
        logError('Unable to initialize auth session', error);
        const bootstrapIsCurrent = authEventGenerationGuardRef.current.isBootstrapCurrent(startGeneration);
        traceAuthLifecycle('bootstrap-result', {
          ignoredAsStale: !bootstrapIsCurrent,
          outcome: 'unexpected-error',
          sessionPresent: false,
        });
        if (mounted && bootstrapIsCurrent) setSession(null);
      } finally {
        try {
          await supabase.auth.startAutoRefresh();
        } catch (error) {
          logError('Unable to start auth session refresh', error);
        }
        if (mounted) {
          setLoading(false);
          traceAuthLifecycle('bootstrap-finished', { loading: false });
        }
      }
    };

    void initializeSession();

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
    await stopAvatarSpeechPlayback();
    resetActorScopedRuntimeState(null);
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
