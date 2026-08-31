import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useNavigationContainerRef, usePathname } from 'expo-router';
import * as Linking from 'expo-linking';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthSessionProvider } from '../contexts/AuthSessionContext';
import { FeatureFreezeProvider } from '../contexts/FeatureFreezeContext';
import { PrivacyPreferencesProvider } from '../contexts/PrivacyPreferencesContext';
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
import { installWatchNotificationRouting } from '../services/watchlist/watchNotificationRouting';

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

export default function Layout() {
  useEffect(() => {
    void cleanupOrphanedStylistSpeechFiles();
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
    <ErrorBoundary>
      <SafeAreaProvider>
        <AuthSessionProvider>
          <PrivacyPreferencesProvider>
            <FeatureFreezeProvider>
              <AuthGate />
            </FeatureFreezeProvider>
          </PrivacyPreferencesProvider>
        </AuthSessionProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
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
