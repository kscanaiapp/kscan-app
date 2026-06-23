import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack, router, usePathname } from 'expo-router';
import * as Linking from 'expo-linking';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthSessionProvider } from '../contexts/AuthSessionContext';
import { FeatureFreezeProvider } from '../contexts/FeatureFreezeContext';
import { PrivacyPreferencesProvider } from '../contexts/PrivacyPreferencesContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { usePrivacyPreferences } from '../contexts/PrivacyPreferencesContext';
import { COLORS, SPACING, TYPOGRAPHY } from '../constants/theme';
import { ONBOARDING_FRAMEWORK_V1_ENABLED } from '../constants/featureFlags';
import { isOnboardingComplete, subscribeOnboardingCompletion } from '../services/onboardingCompletion';
import { getRoutingGuardState, isAuthCallbackUrl } from '../services/routingGuard';
import ErrorBoundary from '../src/components/ErrorBoundary';
import { logError } from '../src/utils/errorLogger';

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
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const lastRedirectRef = useRef<string | null>(null);

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
    isOnboardingComplete(userId)
      .then((complete) => {
        if (mounted) setOnboardingComplete(complete);
      })
      .catch((error) => {
        logError('Unable to read onboarding completion flag', error, { userId });
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
    lastRedirectRef.current = null;
  }, [pathname]);

  const waitingForAuthCallbackRoute =
    initialUrlChecked && isAuthCallbackUrl(initialUrl) && pathname !== '/auth/callback';

  const guardState = getRoutingGuardState({
    pathname,
    loading: loading || !initialUrlChecked,
    session,
    profile,
    profileLoading: Boolean(session && bootStatus !== 'ready'),
    onboardingComplete,
    nowSeconds: undefined,
  });

  useEffect(() => {
    if (waitingForAuthCallbackRoute || guardState.action !== 'redirect' || !guardState.redirectTo) {
      return;
    }

    const redirectTo =
      ONBOARDING_FRAMEWORK_V1_ENABLED && guardState.redirectTo === '/auth'
        ? '/onboarding'
        : guardState.redirectTo;
    if (pathname === '/onboarding' && redirectTo.startsWith('/onboarding')) {
      return;
    }
    if (lastRedirectRef.current === redirectTo) {
      return;
    }
    lastRedirectRef.current = redirectTo;
    router.replace(redirectTo);
  }, [guardState.action, guardState.redirectTo, pathname, waitingForAuthCallbackRoute]);

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
