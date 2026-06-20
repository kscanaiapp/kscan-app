import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack, router, usePathname } from 'expo-router';
import * as Linking from 'expo-linking';
import { AuthSessionProvider } from '../contexts/AuthSessionContext';
import { FeatureFreezeProvider } from '../contexts/FeatureFreezeContext';
import { PrivacyPreferencesProvider } from '../contexts/PrivacyPreferencesContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { usePrivacyPreferences } from '../contexts/PrivacyPreferencesContext';
import { COLORS, SPACING, TYPOGRAPHY } from '../constants/theme';
import { ONBOARDING_FRAMEWORK_V1_ENABLED } from '../constants/featureFlags';
import { getRoutingGuardState, isAuthCallbackUrl } from '../services/routingGuard';
import ErrorBoundary from '../src/components/ErrorBoundary';
import { logError } from '../src/utils/errorLogger';
import {
  isOnboardingComplete,
  clearLegacyInvalidOnboardingKey,
} from '../services/onboardingCompletion';

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
  const { loading, session } = useAuthSession();
  const { bootStatus, profile } = usePrivacyPreferences();
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const [initialUrlChecked, setInitialUrlChecked] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState(false);

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

  // One-time cleanup of the stale shared "unknown" onboarding key.
  useEffect(() => {
    void clearLegacyInvalidOnboardingKey();
  }, []);

  // Check onboarding completion after auth resolves.
  useEffect(() => {
    if (loading || !initialUrlChecked) return;

    // No session at all: nothing to check; let the routing guard send the
    // user to auth/sign-in.
    if (!session) {
      setOnboardingComplete(false);
      setOnboardingChecked(true);
      return;
    }

    // Session exists but the user id has not hydrated yet. Hold in the safe
    // loading state (onboardingChecked stays false) until it resolves rather
    // than reading/writing under an invalid key or flashing the permissions UI.
    const userId = session.user?.id;
    if (!userId) {
      setOnboardingChecked(false);
      return;
    }

    let mounted = true;
    isOnboardingComplete(userId)
      .then((complete) => {
        if (mounted) setOnboardingComplete(complete);
      })
      .finally(() => {
        if (mounted) setOnboardingChecked(true);
      });
    return () => {
      mounted = false;
    };
  }, [loading, initialUrlChecked, session]);

  const waitingForAuthCallbackRoute =
    initialUrlChecked && isAuthCallbackUrl(initialUrl) && pathname !== '/auth/callback';

  const guardState = getRoutingGuardState({
    pathname,
    loading: loading || !initialUrlChecked || !onboardingChecked,
    session,
    profile,
    profileLoading: Boolean(session && bootStatus !== 'ready'),
    nowSeconds: undefined,
  });

  useEffect(() => {
    if (!waitingForAuthCallbackRoute && guardState.action === 'redirect' && guardState.redirectTo) {
      let redirectTo = guardState.redirectTo;

      // Authenticated users without completed onboarding go to permissions page
      if (session && !onboardingComplete && redirectTo === '/') {
        redirectTo = '/onboarding/permissions';
      }

      if (ONBOARDING_FRAMEWORK_V1_ENABLED && redirectTo === '/auth') {
        redirectTo = '/onboarding';
      }
      router.replace(redirectTo);
    }
  }, [guardState.action, guardState.redirectTo, waitingForAuthCallbackRoute, session, onboardingComplete]);

  // Defensive: redirect authenticated users away from onboarding routes.
  useEffect(() => {
    if (loading || !onboardingChecked) return;
    const userId = session?.user?.id;
    if (!userId) return;

    // Stay out of the way while the user is on the permissions screen.
    if (pathname === '/onboarding/permissions') return;

    // Known-complete: just normalize the bare /onboarding entry route to home.
    if (onboardingComplete) {
      if (pathname === '/onboarding') router.replace('/');
      return;
    }

    // The in-memory snapshot says incomplete, but it is only read once at
    // startup. The permissions screen writes completion and then navigates
    // home, so re-verify against storage before bouncing the user back —
    // otherwise a just-completed user is trapped on the permissions screen.
    let cancelled = false;
    isOnboardingComplete(userId).then((complete) => {
      if (cancelled) return;
      if (complete) {
        setOnboardingComplete(true);
        if (pathname === '/onboarding') router.replace('/');
        return;
      }
      router.replace('/onboarding/permissions');
    });
    return () => {
      cancelled = true;
    };
  }, [loading, onboardingChecked, session, pathname, onboardingComplete]);

  if (waitingForAuthCallbackRoute) {
    return <Stack screenOptions={{ headerShown: false }} />;
  }

  if (guardState.action !== 'allow') {
    return (
      <View testID="auth-gate-loading" style={styles.loadingRoot}>
        <ActivityIndicator size="large" color="#00FFFF" />
        <Text style={styles.loadingText}>K-SCAN</Text>
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function Layout() {
  return (
    <ErrorBoundary>
      <AuthSessionProvider>
        <PrivacyPreferencesProvider>
          <FeatureFreezeProvider>
            <AuthGate />
          </FeatureFreezeProvider>
        </PrivacyPreferencesProvider>
      </AuthSessionProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  loadingRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
    backgroundColor: COLORS.bg,
  },
  loadingText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
  },
});
