import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { Session, User } from '@supabase/supabase-js';
import {
  clearPersistedAuthSessions,
  hasPendingAuthSessionRecovery,
  supabase,
  takeAuthBootstrapStorageError,
} from '../services/supabaseClient';
import { AUTH_CALLBACK_URL } from '../services/authConfig';
import { AUTH_STATE, getSessionAuthState, isSessionUsable } from '../services/routingGuard';
import { invalidateAllMemoryCache } from '../services/style-chat/styleMemoryCache';
import { resetAttachmentStore } from '../services/style-chat/styleChatAttachmentStore';
import { clearStyleChatDrafts } from '../services/style-chat/styleChatDraftPersistence';
import { resetVisualContextStore } from '../services/style-chat/eliseVisualContextStore';
import { cleanupSanitizedImage } from '../services/privacyImageUpload';
import { resetVtoRequestState } from '../services/vto/vtoRequestStore';
import {
  createAuthBootstrapGenerationGuard,
  createAuthActorBoundaryGuard,
  isHandledStaleRefreshTokenError,
  isTerminalRefreshFailure,
} from '../services/authSessionBootstrap';
import { traceAuthLifecycle } from '../services/authLifecycleTrace';
import { logError } from '../src/utils/errorLogger';
import { stopAvatarSpeechPlayback } from '../services/avatarSpeech';
import { resetStylistIdentityStore } from '../stores/stylistIdentityStore';
import { resetStylistVoicePreferenceState } from '../stores/stylistVoicePreferenceStore';
import { clearStyleChatHandoffContext } from '../services/style-chat/styleChatHandoffContext';
import { resetStyleChatGreetingState } from '../services/style-chat/styleChatGreeting';
import { advanceActorEpoch } from '../services/actorContext';
import { clearTodayWeather } from '../services/weather/todayWeatherStore';
import { resetKPlusEntitlementCache } from '../services/kplus/kplusEntitlementStore';
import {
  claimDeviceForCurrentActor,
  revokeWatchAlertsForThisDevice,
} from '../services/watchlist/pushRegistration';
import { resetPackingPlanState } from '../services/packing/packingPlanStore';
import { buildSignupNameMetadata, type SignupNameInput } from '../services/userFirstName';

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

export type AuthState = (typeof AUTH_STATE)[keyof typeof AUTH_STATE];

export interface AuthSessionContextValue {
  session: Session | null;
  user: User | null;
  /** True while the initial getSession() call is in flight. */
  loading: boolean;
  isAuthenticated: boolean;
  /** True during a background token refresh. Writes should be deferred. */
  isRefreshing: boolean;
  /**
   * Truthful launch/lifecycle state. AUTHENTICATED_RECOVERY_PENDING means the
   * actor is not signed out but the session has not been server-validated yet —
   * it must never be presented as a fully validated session.
   */
  authState: AuthState;
  /** True when a stored session is awaiting renewal after a transient failure. */
  isRecoveringSession: boolean;
  /** Re-attempts a pending recovery, e.g. from an offline retry action. */
  retrySessionRecovery: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, profile?: SignupNameInput) => Promise<SignUpResult>;
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
  // Durable composer drafts hold the previous actor's unsent words. Dropped
  // here alongside the in-memory drafts; fire-and-forget, because a storage
  // failure must never delay an auth transition -- and cannot leak either, since
  // every read of that store requires the expected actor and fails closed.
  void clearStyleChatDrafts();
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
  // K+ status is account-scoped: never let it survive a sign-out or leak
  // into the next signed-in actor on this device.
  resetKPlusEntitlementCache();
  // A Packing plan names garments from ONE account's Closet. It must not stay
  // visible, refinable, or even readable after the actor changes -- and the
  // trip itself (destination, dates, notes) is personal too. Cleared here
  // rather than in a Packing-specific auth listener: this is the one place
  // this project resets actor-scoped runtime state.
  resetPackingPlanState();
  // Virtual Try-On holds the strongest media in the app: a photo the user
  // chose of themselves, plus a visualization made from it. Both are dropped
  // here, and the cache derivatives backing them are deleted -- an in-flight
  // generation started by the previous actor also loses presentation
  // authority at this line, before any of it can reach the next actor.
  resetVtoRequestState();
  // Defense in depth: the store already refuses to return a reading whose
  // actorId does not match the caller, so this cannot be the only thing keeping
  // weather from crossing accounts — it just stops the previous actor's reading
  // from sitting in storage after they leave. Fire-and-forget: an AsyncStorage
  // failure must never delay or fail a sign-out.
  void clearTodayWeather();
}

export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const authEventGenerationGuardRef = useRef(createAuthBootstrapGenerationGuard());
  const authActorBoundaryGuardRef = useRef(createAuthActorBoundaryGuard());
  // Seals the actor across an explicit logout so a result that resolves later —
  // a refresh, a sign-in event — can never be applied to the actor who left.
  const signedOutRef = useRef(false);

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
      if (usableSession) {
        // Any authoritative session ends a pending recovery.
        setRecoveryPending(false);
      }
      if (event === 'SIGNED_IN') {
        signedOutRef.current = false;
      }
      // A late TOKEN_REFRESHED/SIGNED_IN that resolves after a deliberate logout
      // must never reauthenticate the actor who signed out.
      if (signedOutRef.current && usableSession) {
        traceAuthLifecycle('auth-state-event', {
          authEvent: event,
          ignoredAsStale: true,
          outcome: 'ignored-after-signout',
          sessionPresent: true,
        });
        return;
      }
      if (authActorBoundaryGuardRef.current.noteActor(usableSession?.user.id ?? null)) {
        // Any actor boundary invalidates pending generation and native playback
        // before the new auth state can become visible to app consumers.
        void stopAvatarSpeechPlayback();
        resetActorScopedRuntimeState(usableSession?.user.id ?? null);
        // SEC-KPLUS-001 — an ARRIVING actor claims custody of this device, so
        // the departed actor's Watch-alert route stops being deliverable here
        // even if their sign-out revocation never ran (force-quit, crash,
        // reinstall, expired session) and even if this actor never enables
        // alerts themselves. Fire-and-forget: never delays the auth transition.
        if (usableSession?.user.id) {
          void claimDeviceForCurrentActor();
        }
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
          const terminal = isTerminalRefreshFailure(storageRecoveryError);
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
          // A transient failure leaves recoverable material in storage. The
          // actor is awaiting renewal, not signed out, so nothing is cleared and
          // Supabase's own retrying refresh owns the recovery.
          const pendingRecovery = !terminal && hasPendingAuthSessionRecovery();
          traceAuthLifecycle('bootstrap-result', {
            ignoredAsStale: !bootstrapIsCurrent,
            outcome: terminal
              ? 'stale-refresh-cleared'
              : pendingRecovery
                ? 'recovery-pending'
                : 'error',
            sessionPresent: false,
          });
          if (mounted && bootstrapIsCurrent) {
            setRecoveryPending(pendingRecovery);
            if (terminal || !pendingRecovery) setSession(null);
          }
          return;
        }

        if (error) {
          const handledStaleRefreshToken = isHandledStaleRefreshTokenError(error);
          const terminal = isTerminalRefreshFailure(error);
          if (!handledStaleRefreshToken) {
            logError('Unable to restore auth session', error);
          }
          const bootstrapIsCurrent = authEventGenerationGuardRef.current.isBootstrapCurrent(startGeneration);
          const pendingRecovery = !terminal && hasPendingAuthSessionRecovery();
          traceAuthLifecycle('bootstrap-result', {
            ignoredAsStale: !bootstrapIsCurrent,
            outcome: terminal
              ? 'stale-refresh-cleared'
              : pendingRecovery
                ? 'recovery-pending'
                : 'error',
            sessionPresent: false,
          });
          if (mounted && bootstrapIsCurrent) {
            setRecoveryPending(pendingRecovery);
            if (terminal || !pendingRecovery) setSession(null);
          }
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
        if (mounted && bootstrapIsCurrent) {
          setRecoveryPending(false);
          setSession(usableSession);
        }
      } catch (error) {
        logError('Unable to initialize auth session', error);
        const bootstrapIsCurrent = authEventGenerationGuardRef.current.isBootstrapCurrent(startGeneration);
        // An unexpected bootstrap fault is not proof the actor is signed out.
        // Recoverable material still in storage keeps them in recovery instead.
        const pendingRecovery = hasPendingAuthSessionRecovery();
        traceAuthLifecycle('bootstrap-result', {
          ignoredAsStale: !bootstrapIsCurrent,
          outcome: pendingRecovery ? 'recovery-pending' : 'unexpected-error',
          sessionPresent: false,
        });
        if (mounted && bootstrapIsCurrent) {
          setRecoveryPending(pendingRecovery);
          if (!pendingRecovery) setSession(null);
        }
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

  /**
   * iOS suspends JavaScript timers while the app is backgrounded, so Supabase's
   * refresh ticker cannot be trusted to have run across a resume. Exactly one
   * listener drives the SDK's own refresh owner: stop the ticker on background
   * so no duplicate loop survives, and restart it on foreground — startAutoRefresh
   * replaces any existing ticker and runs an immediate expiry check, so a stale
   * access token is renewed through the single authoritative path.
   *
   * Nothing here clears session material: a foreground refresh that fails is a
   * transient failure, and Supabase preserves a recoverable session itself.
   */
  useEffect(() => {
    // Never act before hydration completes, or a foreground event could race
    // the initial storage read.
    if (loading) return;

    let disposed = false;

    const applyAppState = (nextState: AppStateStatus) => {
      if (disposed || signedOutRef.current) return;
      if (nextState === 'active') {
        void supabase.auth
          .startAutoRefresh()
          .catch((error) => logError('Unable to resume auth session refresh', error));
        return;
      }
      void supabase.auth
        .stopAutoRefresh()
        .catch((error) => logError('Unable to pause auth session refresh', error));
    };

    const subscription = AppState.addEventListener('change', applyAppState);

    return () => {
      disposed = true;
      subscription.remove();
    };
  }, [loading]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signUp = useCallback(async (
    email: string,
    password: string,
    profile?: SignupNameInput,
  ): Promise<SignUpResult> => {
    // Carried in options.data so the name survives email confirmation: Supabase
    // persists it on the user at sign-up, before any session exists.
    const nameMetadata = buildSignupNameMetadata(profile ?? {});
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: AUTH_CALLBACK_URL,
        ...(Object.keys(nameMetadata).length > 0 ? { data: nameMetadata } : {}),
      },
    });
    if (error) throw error;
    return {
      session: data.session ?? null,
      confirmationRequired: !data.session,
    };
  }, []);

  const signOut = useCallback(async () => {
    // Seal first: the actor boundary is invalidated before any await, so a
    // refresh that resolves later cannot reauthenticate this actor and cannot
    // re-persist their session.
    signedOutRef.current = true;
    // DEF-WL-01: retire this device's Watchlist push registration while the
    // departing actor's session is still valid. A Watch alert's notification
    // body carries the watched item and its price, so a registration left
    // live after sign-out delivers that text to whoever holds the handset
    // next. Awaited but never allowed to fail or stall sign-out (the helper
    // swallows every error and no-ops when this device never registered).
    await revokeWatchAlertsForThisDevice();
    await stopAvatarSpeechPlayback();
    resetActorScopedRuntimeState(null);
    setSession(null);
    setRecoveryPending(false);

    let signOutFailed = false;
    try {
      const { error } = await supabase.auth.signOut();
      if (error) signOutFailed = true;
    } catch (error) {
      signOutFailed = true;
      logError('Sign-out request failed', error);
    }

    if (signOutFailed) {
      // Supabase skips its own local cleanup when the global sign-out request
      // fails, which would let the next launch restore a deliberately
      // logged-out actor. Destroy the local material unconditionally.
      try {
        await clearPersistedAuthSessions();
      } catch (error) {
        logError('Unable to clear stored session after sign-out', error);
      }
    }
  }, []);

  const retrySessionRecovery = useCallback(async () => {
    if (signedOutRef.current) return;
    try {
      // Routed through the SDK so recovery keeps a single refresh owner.
      await supabase.auth.startAutoRefresh();
    } catch (error) {
      logError('Unable to retry auth session recovery', error);
    }
  }, []);

  const value = useMemo<AuthSessionContextValue>(() => {
    const baseState = getSessionAuthState(session, undefined, { loading });
    const authState: AuthState =
      baseState === AUTH_STATE.UNAUTHENTICATED && recoveryPending
        ? AUTH_STATE.RECOVERY_PENDING
        : baseState;

    return {
      session,
      user: session?.user ?? null,
      loading,
      isAuthenticated: !loading && isSessionUsable(session),
      isRefreshing,
      authState,
      // Precisely: no session to route on, but recoverable material is still
      // stored. This is what holds the actor out of the login flow.
      isRecoveringSession: !loading && !session && recoveryPending,
      retrySessionRecovery,
      signIn,
      signUp,
      signOut,
    };
  }, [
    session,
    loading,
    isRefreshing,
    recoveryPending,
    retrySessionRecovery,
    signIn,
    signUp,
    signOut,
  ]);

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
