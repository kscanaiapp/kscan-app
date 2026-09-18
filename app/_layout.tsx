import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack, router, usePathname } from 'expo-router';
import * as Linking from 'expo-linking';
import { AuthSessionProvider } from '../contexts/AuthSessionContext';
import { FeatureFreezeProvider } from '../contexts/FeatureFreezeContext';
import { PrivacyPreferencesProvider } from '../contexts/PrivacyPreferencesContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { COLORS, SPACING, TYPOGRAPHY } from '../constants/theme';
import {
  getRoutingGuardState,
  isAuthCallbackUrl,
  shouldDeferToAuthCallbackRoute,
} from '../services/routingGuard';
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

// Upper bound on how long the auth guard may stay open waiting for expo-router
// to land on the cold-start auth-callback route. expo-router resolves the
// initial deep link immediately, so this only ever fires when routing failed.
const AUTH_CALLBACK_ROUTE_GRACE_MS = 5000;

function AuthGate() {
  const pathname = usePathname();
  const { loading, session } = useAuthSession();
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const [initialUrlChecked, setInitialUrlChecked] = useState(false);
  const [callbackRouteSettled, setCallbackRouteSettled] = useState(false);

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

  // Linking.getInitialURL() keeps returning the cold-start URL for the whole
  // process, so the deferral must be latched shut once the callback route has
  // been reached. Otherwise a session that began at kscan://auth/callback leaves
  // the guard disabled for every later navigation, and an expiring session
  // strands the user on a protected screen with no redirect to /auth.
  useEffect(() => {
    if (pathname === '/auth/callback') setCallbackRouteSettled(true);
  }, [pathname]);

  useEffect(() => {
    if (callbackRouteSettled) return undefined;
    if (!initialUrlChecked || !isAuthCallbackUrl(initialUrl)) return undefined;
    const timer = setTimeout(() => setCallbackRouteSettled(true), AUTH_CALLBACK_ROUTE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [callbackRouteSettled, initialUrl, initialUrlChecked]);

  const waitingForAuthCallbackRoute = shouldDeferToAuthCallbackRoute({
    initialUrlChecked,
    initialUrl,
    pathname,
    callbackRouteSettled,
  });

  const guardState = getRoutingGuardState({
    pathname,
    loading: loading || !initialUrlChecked,
    session,
    nowSeconds: undefined,
  });

  useEffect(() => {
    if (!waitingForAuthCallbackRoute && guardState.action === 'redirect' && guardState.redirectTo) {
      router.replace(guardState.redirectTo);
    }
  }, [guardState.action, guardState.redirectTo, waitingForAuthCallbackRoute]);

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
