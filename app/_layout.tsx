import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, router, useNavigationContainerRef, usePathname } from 'expo-router';
import * as Linking from 'expo-linking';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  bridgeAllTelemetrySinks,
  PostHogAnalyticsProvider,
  syncPostHogIdentity,
} from '../services/analytics/posthogClient';
import { AuthSessionProvider } from '../contexts/AuthSessionContext';
import { FeatureFreezeProvider } from '../contexts/FeatureFreezeContext';
import { PrivacyPreferencesProvider } from '../contexts/PrivacyPreferencesContext';
import { AiOutputReportProvider } from '../contexts/AiOutputReportingContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { usePrivacyPreferences } from '../contexts/PrivacyPreferencesContext';
import { COLORS, SPACING, TYPOGRAPHY } from '../constants/theme';
import { DEV_INITIAL_ROUTE } from '../constants/featureFlags';
import { resolveOnboardingCompletion, subscribeOnboardingCompletion } from '../services/onboardingCompletion';
import {
  getRoutingGuardState,
  isAuthCallbackUrl,
  shouldCommitRouteNavigation,
} from '../services/routingGuard';
import { traceAuthLifecycle } from '../services/authLifecycleTrace';
import ErrorBoundary from '../src/components/ErrorBoundary';
import { logError } from '../src/utils/errorLogger';
import { cleanupOrphanedStylistSpeechFiles } from '../services/avatars/stylistSpeechFiles';
import { sweepOrphanedVtoMedia } from '../services/vto/vtoMediaCache';
import { installWatchNotificationRouting } from '../services/watchlist/watchNotificationRouting';
import { attachPushTokenRefreshListener } from '../services/watchlist/pushRegistration';
import { runAppleCredentialStateCheck } from '../services/auth/appleCredentialState';
import { reconcileTerminalDeletions } from '../services/deletion/terminalDeletionReconciler';

type GlobalErrorHandler = (error: Error, isFatal?: boolean) => void;

type GlobalWithErrorUtils = typeof globalThis & {
  __KSCAN_ERROR_UTILS_ATTACHED__?: boolean;
  ErrorUtils?: {
    getGlobalHandler: () => GlobalErrorHandler;
    setGlobalHandler: (handler: GlobalErrorHandler) => void;
  };
};

const rnGlobal = globalThis as GlobalWithErrorUtils;

if (rnGlobal.ErrorUtils && !rnGlobal.__KSCAN_ERROR_UTILS_ATTACHED__) {
  const defaultHandler = rnGlobal.ErrorUtils.getGlobalHandler();

  rnGlobal.ErrorUtils.setGlobalHandler((error, isFatal) => {
    logError('Unhandled JavaScript exception', error, { isFatal });
    defaultHandler(error, isFatal);
  });

  rnGlobal.__KSCAN_ERROR_UTILS_ATTACHED__ = true;
}

function AuthGate() {
  const pathname = usePathname();
  const { loading, session, isRecoveringSession, retrySessionRecovery, signOut } = useAuthSession();
  const { bootStatus, profile } = usePrivacyPreferences();
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const [initialUrlChecked, setInitialUrlChecked] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const lastRedirectRef = useRef<string | null>(null);
  // DEVELOPMENT-ONLY: makes the QA route jump strictly one-shot.
  const devJumpRef = useRef(false);
  const authCallbackSeenRef = useRef(false);
  const navigationRef = useNavigationContainerRef();
  const [navReady, setNavReady] = useState(false);
  const lastAuthTraceRef = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    Linking.getInitialURL()
      .then((url) => {
        if (!mounted) return;
        setInitialUrl(url);
      })
      .finally(() => {
        if (mounted) setInitialUrlChecked(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user?.id;

    if (!userId) {
      setOnboardingComplete(null);
      return () => {
        mounted = false;
      };
    }

    setOnboardingComplete(null);
    resolveOnboardingCompletion(userId)
      .then((complete) => {
        if (mounted) setOnboardingComplete(complete);
      })
      .catch((error) => {
        logError('Unable to resolve onboarding completion', error);
        if (mounted) setOnboardingComplete(false);
      });

    return () => {
      mounted = false;
    };
  }, [session?.user?.id]);

  useEffect(() => {
    const unsubscribe = subscribeOnboardingCompletion((completedUserId) => {
      if (completedUserId === session?.user?.id) {
        setOnboardingComplete(true);
      }
    });

    return unsubscribe;
  }, [session?.user?.id]);

  useEffect(() => {
    if (!navigationRef) return;
    if (navigationRef.isReady()) {
      setNavReady(true);
      return;
    }
    const check = () => {
      if (navigationRef.isReady()) {
        setNavReady(true);
      }
    };
    const id = setInterval(check, 50);
    const timeout = setTimeout(() => clearInterval(id), 2000);
    return () => {
      clearInterval(id);
      clearTimeout(timeout);
    };
  }, [navigationRef]);

  const waitingForAuthCallbackRoute =
    initialUrlChecked && isAuthCallbackUrl(initialUrl) && pathname !== '/auth/callback';

  // Freeze expiry evaluation for this render so AuthGate cannot oscillate solely
  // because Date.now() advances across rapid re-renders.
  const nowSeconds = Math.floor(Date.now() / 1000);

  const guardState = getRoutingGuardState({
    pathname,
    loading: loading || !initialUrlChecked,
    session,
    profile,
    profileLoading: Boolean(session && bootStatus !== 'ready'),
    onboardingComplete,
    nowSeconds,
    recoveryPending: isRecoveringSession,
  });

  useEffect(() => {
    if (pathname === '/auth/callback') {
      authCallbackSeenRef.current = true;
    } else if (!session || guardState.action !== 'loading') {
      authCallbackSeenRef.current = false;
    }
  }, [guardState.action, pathname, session]);

  // Always keep the root navigator mounted during loading. Unmounting <Stack>
  // on ordinary bootstrap/login caused pathname churn and maximum-update-depth
  // failures that also aborted in-flight auth network requests.

  useEffect(() => {
    const onboardingState = onboardingComplete === null
      ? 'pending'
      : onboardingComplete
        ? 'complete'
        : 'incomplete';
    const signature = [
      pathname,
      loading,
      Boolean(session),
      guardState.action,
      guardState.redirectTo,
      onboardingState,
    ].join('|');
    if (lastAuthTraceRef.current === signature) return;
    lastAuthTraceRef.current = signature;
    traceAuthLifecycle('auth-gate-state', {
      guardAction: guardState.action,
      loading,
      onboardingState,
      redirectTo: guardState.redirectTo,
      route: pathname,
      sessionPresent: Boolean(session),
    });
  }, [guardState.action, guardState.redirectTo, loading, onboardingComplete, pathname, session]);

  useEffect(() => {
    if (waitingForAuthCallbackRoute || guardState.action !== 'redirect' || !guardState.redirectTo || !navReady) {
      return;
    }

    const redirectTo =
      guardState.redirectTo === '/auth'
        ? '/onboarding'
        : guardState.redirectTo;
    if (!shouldCommitRouteNavigation({
      pathname,
      previousRequestedDestination: lastRedirectRef.current,
      requestedDestination: redirectTo,
    })) {
      return;
    }
    lastRedirectRef.current = redirectTo;
    traceAuthLifecycle('auth-gate-navigation', {
      outcome: 'replace',
      redirectTo,
      route: pathname,
    });
    router.replace(redirectTo);
  }, [guardState.action, guardState.redirectTo, pathname, waitingForAuthCallbackRoute, navReady]);

  useEffect(() => {
    // Only clear redirect dedupe after a settled allow. Clearing on transient
    // loading re-arms router.replace for the same destination and loops.
    if (guardState.action === 'allow') {
      lastRedirectRef.current = null;
    }
  }, [guardState.action]);

  /**
   * DEVELOPMENT-ONLY one-shot route jump for runtime QA harnesses.
   *
   * `DEV_INITIAL_ROUTE` is null in any release build, so this effect is inert
   * there and the branch folds. It runs AFTER the auth gate settles to `allow`,
   * so it can never race the guard or send an unauthenticated actor into a
   * protected route — the guard keeps full authority over routing, and this only
   * asks for one push once the guard has already decided the actor may be here.
   *
   * `devJumpRef` makes it strictly one-shot: without it, `pathname` changing
   * would re-arm the push and fight any later navigation the user performs.
   */
  useEffect(() => {
    if (!DEV_INITIAL_ROUTE || devJumpRef.current) return;
    if (!navReady || waitingForAuthCallbackRoute) return;
    if (guardState.action !== 'allow') return;
    devJumpRef.current = true;
    traceAuthLifecycle('dev-initial-route', { outcome: 'push', redirectTo: DEV_INITIAL_ROUTE, route: pathname });
    router.push(DEV_INITIAL_ROUTE as never);
  }, [guardState.action, navReady, waitingForAuthCallbackRoute, pathname]);

  if (waitingForAuthCallbackRoute) {
    return <Stack screenOptions={{ headerShown: false }} />;
  }

  if (guardState.action === 'loading') {
    return (
      <>
        <Stack screenOptions={{ headerShown: false }} />
        <View testID="auth-gate-loading" style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.loadingText}>K-SCAN</Text>
        </View>
      </>
    );
  }

  if (guardState.action === 'recovering') {
    // The actor is signed in but their session has not been re-validated yet.
    // Never presented as a full session, and never a dead end: recovery retries
    // on its own, and signing in remains one tap away.
    return (
      <>
        <Stack screenOptions={{ headerShown: false }} />
        <View testID="auth-gate-recovering" style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.recoveryTitle}>Reconnecting your account</Text>
          <Text style={styles.recoveryBody}>
            We couldn&apos;t reach K Scan AI just now. You&apos;re still signed in — this will
            finish on its own once you&apos;re back online.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try reconnecting now"
            testID="auth-gate-recovery-retry"
            style={styles.recoveryAction}
            onPress={() => {
              void retrySessionRecovery();
            }}
          >
            <Text style={styles.recoveryActionText}>Try again</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign in with a different account instead"
            testID="auth-gate-recovery-signin"
            style={styles.recoverySecondaryAction}
            onPress={() => {
              void signOut();
            }}
          >
            <Text style={styles.recoverySecondaryText}>Sign in instead</Text>
          </Pressable>
        </View>
      </>
    );
  }

  if (guardState.action === 'redirect') {
    return (
      <>
        <Stack screenOptions={{ headerShown: false }} />
        <View testID="auth-gate-redirecting" style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.loadingText}>K-SCAN</Text>
        </View>
      </>
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

function PostHogBridge() {
  const { session } = useAuthSession();

  useEffect(() => {
    bridgeAllTelemetrySinks();
  }, []);

  useEffect(() => {
    // Always resets before establishing a different identity — covers
    // logout, account deletion, and an actor switch alike, since all three
    // land here as session.user.id becoming null (then, for a switch, a
    // different id). See syncPostHogIdentityWith for the isolation guarantee.
    syncPostHogIdentity(session?.user?.id ?? null);
  }, [session?.user?.id]);

  return null;
}

/**
 * Sign in with Apple credential-state lifecycle (iOS only).
 *
 * Apple can decide that this device's Sign in with Apple credential is no
 * longer authorized for the signed-in user, and nothing in the app noticed:
 * the K Scan AI session simply continued. This bridge closes that gap by asking
 * Apple at the two boundaries that already exist, and handing an invalidating
 * answer to the ONE canonical logout authority (AuthSessionContext's signOut).
 *
 * Bounded on purpose — no timer, no polling, no background execution, and
 * nothing on the render path:
 *  - when an authenticated actor first becomes available (session restoration,
 *    and equally the completion of a fresh Apple sign-in), and
 *  - on a real background/inactive -> active transition.
 *
 * A non-Apple actor never reaches Apple at all: runAppleCredentialStateCheck
 * resolves the Apple identity from the session first and returns
 * 'not_apple_actor' without importing or calling the SDK. Android returns
 * 'unsupported_platform' the same way.
 */
function AppleCredentialStateBridge() {
  const { user, signOut } = useAuthSession();
  const userId = user?.id ?? null;

  // Boundary 1 — an authenticated actor became available. Covers session
  // restoration on launch and the completion of a fresh Apple sign-in alike,
  // since both surface here as the actor id becoming set.
  useEffect(() => {
    if (!userId) return;
    void runAppleCredentialStateCheck(user, { signOut });
  }, [userId, user, signOut]);

  // Boundary 2 — a real background/inactive -> active transition. Deliberately
  // holds no ref: the subscription is rebuilt when the actor or the logout
  // authority changes, so the listener can never close over a departed actor.
  // `appState` is per-subscription, and a rebuild re-reads the live value, so a
  // resume is still classified correctly.
  useEffect(() => {
    if (!userId) return;
    let appState: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      const cameForward = /inactive|background/.test(appState) && next === 'active';
      appState = next;
      if (!cameForward) return;
      // The module's own in-flight guard makes overlapping lifecycle events
      // collapse into a single Apple call and a single logout.
      void runAppleCredentialStateCheck(user, { signOut });
    });
    return () => subscription.remove();
  }, [userId, user, signOut]);

  return null;
}

/**
 * Terminal account-deletion local cleanup (iOS Repair 07, Android Repair 09).
 *
 * THE GAP THIS CLOSES. Account deletion has always been asynchronous and
 * restorable: submitting it opens a 30-day lifecycle, and the permanent purge
 * happens later in a backend worker. Until now nothing on the device ever
 * learned that the purge had actually happened, so a user whose account was
 * genuinely and irreversibly deleted still had their Recent Scans, Closet,
 * Style DNA and Dressing Room data sitting on the handset indefinitely.
 *
 * WHY IT CANNOT BE DONE FROM A SESSION. Intake revokes the caller's sessions
 * and bans the Auth user for the whole grace window, and the purge worker
 * deletes the Auth identity outright. By the time the interesting answer exists
 * there is nothing left to authenticate as. The device instead holds an opaque
 * capability it created BEFORE submitting the request, and that capability —
 * not a session — is what resolves the lifecycle.
 *
 * DELIBERATELY NOT GATED ON A SIGNED-IN USER, and that is the point. Actor A's
 * purge is confirmed after A is gone: the device may be signed out, or signed
 * in as a completely different actor B. Every purge is driven by the marker's
 * own stored owner scope, so only A's records are removed and B is untouched.
 * Gating this on `user` — the obvious-looking guard — would make terminal
 * cleanup structurally impossible.
 *
 * Bounded exactly like AppleCredentialStateBridge above: cold start, and a real
 * background/inactive -> active transition. No timer, no polling, no background
 * fetch, no background task, no new platform capability, and nothing on the
 * render path. The reconciler holds its own in-flight guard, so overlapping
 * lifecycle events collapse into one pass.
 *
 * ONE SHARED PATH, NO PLATFORM GUARD. Every primitive this bridge calls
 * (services/deletion/*, the owner-scoped purge targets in ownerTerminalPurge.ts)
 * is platform-neutral: expo-secure-store backs onto the Android Keystore the
 * same way it backs onto the iOS Keychain, expo-crypto/Web Crypto supply CSPRNG
 * bytes identically on both runtimes, and every purge primitive takes its
 * target owner as an explicit argument rather than reading the live actor. iOS
 * carried the destructive half alone only until the Repair 06 backend contract
 * existed to certify against; Android Repair 09 verified the same primitives
 * against that contract and removed the platform guard rather than fork a
 * second implementation. Until a project's backend has Repair 06 deployed, the
 * intake response carries no `statusReceiptBound` field, every marker records
 * `unsupported`, and this bridge's reconciliation pass never queries the
 * network or purges anything on either platform — this is what keeps the path
 * safe to enable on Android ahead of Repair 06 reaching production.
 */
function TerminalDeletionBridge() {
  useEffect(() => {
    void reconcileTerminalDeletions();
  }, []);

  useEffect(() => {
    let appState: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      const cameForward = /inactive|background/.test(appState) && next === 'active';
      appState = next;
      if (!cameForward) return;
      void reconcileTerminalDeletions();
    });
    return () => subscription.remove();
  }, []);

  return null;
}

export default function Layout() {
  useEffect(() => {
    void cleanupOrphanedStylistSpeechFiles();
  }, []);

  // RP-107. VTO's person-image ownership lives in module memory, so a crash or
  // an OOM kill mid-generation erased the list and left the derivative in the
  // cache. On a cold start nothing in VTO's namespace can still be referenced,
  // so anything there is an orphan. Scoped to that one directory, bounded, and
  // fail-soft: it cannot reach other features' media and cannot break startup.
  useEffect(() => {
    void sweepOrphanedVtoMedia();
  }, []);

  useEffect(() => {
    let disposed = false;
    let removeListener: (() => void) | null = null;

    void attachPushTokenRefreshListener()
      .then((remove) => {
        if (disposed) {
          remove();
          return;
        }
        removeListener = remove;
      })
      .catch(() => {
        // Push refresh support is best-effort and must not break app startup.
      });

    return () => {
      disposed = true;
      removeListener?.();
      removeListener = null;
    };
  }, []);

  // DEF-WL-03: the consumer for the Watchlist push payload. Without it a
  // tapped price alert opened the app on its default route and a foreground
  // alert was never presented. Routing is derived only from a validated
  // watchId — never from the payload's URL-shaped field — and the destination
  // screen still resolves ownership through its own RLS-scoped read.
  useEffect(() => {
    const handle = installWatchNotificationRouting((route) => {
      router.push(route as never);
    });
    return () => handle.remove();
  }, []);

  return (
    <PostHogAnalyticsProvider>
      <ErrorBoundary>
        <SafeAreaProvider>
          <AuthSessionProvider>
            <AiOutputReportProvider>
              <PrivacyPreferencesProvider>
                <FeatureFreezeProvider>
                  <PostHogBridge />
                  <AppleCredentialStateBridge />
                  <TerminalDeletionBridge />
                  <AuthGate />
                </FeatureFreezeProvider>
              </PrivacyPreferencesProvider>
            </AiOutputReportProvider>
          </AuthSessionProvider>
        </SafeAreaProvider>
      </ErrorBoundary>
    </PostHogAnalyticsProvider>
  );
}

const styles = StyleSheet.create({
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
    backgroundColor: COLORS.bg,
  },
  loadingText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
  },
  recoveryTitle: {
    ...TYPOGRAPHY.body,
    color: COLORS.textPrimary,
    textAlign: 'center',
  },
  recoveryBody: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
    textAlign: 'center',
    paddingHorizontal: SPACING.xl,
  },
  recoveryAction: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  recoveryActionText: {
    ...TYPOGRAPHY.body,
    color: COLORS.accent,
  },
  recoverySecondaryAction: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  recoverySecondaryText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
  },
});
