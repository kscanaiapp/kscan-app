import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack, router, usePathname } from 'expo-router';
import * as Linking from 'expo-linking';
import { AuthSessionProvider } from '../contexts/AuthSessionContext';
import { FeatureFreezeProvider } from '../contexts/FeatureFreezeContext';
import { PrivacyPreferencesProvider } from '../contexts/PrivacyPreferencesContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { COLORS, SPACING, TYPOGRAPHY } from '../constants/theme';
import { getRoutingGuardState, isAuthCallbackUrl } from '../services/routingGuard';

function AuthGate() {
  const pathname = usePathname();
  const { loading, session } = useAuthSession();
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const [initialUrlChecked, setInitialUrlChecked] = useState(false);

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

  const waitingForAuthCallbackRoute =
    initialUrlChecked && isAuthCallbackUrl(initialUrl) && pathname !== '/auth/callback';

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
    <AuthSessionProvider>
      <PrivacyPreferencesProvider>
        <FeatureFreezeProvider>
          <AuthGate />
        </FeatureFreezeProvider>
      </PrivacyPreferencesProvider>
    </AuthSessionProvider>
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
