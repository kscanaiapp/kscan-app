import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { COLORS, LAYOUT, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { supabase } from '../../services/supabaseClient';
import {
  buildAuthCallbackUrlFromParams,
  getAuthCallbackRedirect,
  parseAuthCallbackUrl,
} from '../../services/authDeepLink';

type CallbackState = 'loading' | 'error';

const AUTH_CALLBACK_FAILED_MESSAGE = 'Sign-in failed. Please try again or use email sign-in.';
const AUTH_SESSION_FAILED_MESSAGE =
  "Sign-in completed, but we couldn't start your session. Please try again.";

export default function AuthCallbackScreen() {
  const router = useRouter();
  const warmUrl = Linking.useURL();
  const routeParams = useLocalSearchParams();
  const hasHandledDeepLink = useRef(false);
  const [state, setState] = useState<CallbackState>('loading');
  const [message, setMessage] = useState('Finishing secure sign-in...');

  const handleUrl = useCallback(
    async (url: string | null) => {
      if (!url || hasHandledDeepLink.current) return;
      hasHandledDeepLink.current = true;

      const parsed = parseAuthCallbackUrl(url);
      try {
        if (parsed.error) {
          console.error('Auth callback returned an error', parsed.error);
          setMessage(AUTH_CALLBACK_FAILED_MESSAGE);
          setState('error');
          return;
        }

        if (parsed.code) {
          const { error } = await supabase.auth.exchangeCodeForSession(parsed.code);
          if (error) {
            console.error('Auth callback code exchange failed', error);
            setMessage(AUTH_SESSION_FAILED_MESSAGE);
            setState('error');
            return;
          }
          router.replace(getAuthCallbackRedirect(parsed));
          return;
        }

        if (parsed.hasTokenHash) {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: parsed.tokenHash,
            type: parsed.type,
          } as any);
          if (error) {
            console.error('Auth callback OTP verification failed', error);
            setMessage(AUTH_SESSION_FAILED_MESSAGE);
            setState('error');
            return;
          }
          router.replace(getAuthCallbackRedirect(parsed));
          return;
        }

        if (!parsed.hasSessionTokens) {
          setMessage(AUTH_CALLBACK_FAILED_MESSAGE);
          setState('error');
          return;
        }

        const { error } = await supabase.auth.setSession({
          access_token: parsed.accessToken,
          refresh_token: parsed.refreshToken,
        });

        if (error) {
          console.error('Auth callback session start failed', error);
          setMessage(AUTH_SESSION_FAILED_MESSAGE);
          setState('error');
          return;
        }
        router.replace(getAuthCallbackRedirect(parsed));
        return;
      } catch (error) {
        console.error('Auth callback failed unexpectedly', error);
        setMessage(AUTH_CALLBACK_FAILED_MESSAGE);
        setState('error');
      }
    },
    [router],
  );

  useEffect(() => {
    void Linking.getInitialURL().then(handleUrl);
  }, [handleUrl]);

  useEffect(() => {
    void handleUrl(warmUrl);
  }, [handleUrl, warmUrl]);

  useEffect(() => {
    void handleUrl(buildAuthCallbackUrlFromParams(routeParams));
  }, [handleUrl, routeParams]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (hasHandledDeepLink.current) return;
      hasHandledDeepLink.current = true;
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session) {
          router.replace('/');
          return;
        }
        setMessage(AUTH_CALLBACK_FAILED_MESSAGE);
        setState('error');
      });
    }, 10000);

    return () => clearTimeout(timeout);
  }, [router]);

  const openAuth = () => router.replace('/auth');

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.header}>
        <View style={styles.headerSide} />
        <View style={styles.headerCenter}>
          <Text style={styles.brand}>K-SCAN</Text>
          <Text style={styles.screenTitle}>SECURE CALLBACK</Text>
        </View>
        <View style={styles.headerSide} />
      </SafeAreaView>

      <View style={styles.body}>
        {state === 'loading' ? (
          <View testID="auth-callback-loading" style={styles.card}>
            <ActivityIndicator size="large" color={COLORS.accent} />
            <Text style={styles.cardTitle}>Opening Account</Text>
            <Text style={styles.cardBody}>{message}</Text>
          </View>
        ) : (
          <View testID="auth-callback-error" style={styles.card}>
            <Text style={styles.cardTitle}>Link Could Not Be Used</Text>
            <Text style={styles.cardBody}>
              {message} Return to sign in when you are ready.
            </Text>
            <Pressable style={styles.primaryButton} onPress={openAuth}>
              <Text style={styles.primaryButtonText}>RETURN TO SIGN IN</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: LAYOUT.safeTop,
    paddingHorizontal: LAYOUT.screenPadding,
    paddingBottom: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerSide: {
    width: 56,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  brand: {
    ...TYPOGRAPHY.brand,
    fontSize: 16,
  },
  screenTitle: {
    ...TYPOGRAPHY.caption,
    marginTop: SPACING.xs,
    color: COLORS.accent,
  },
  body: {
    flex: 1,
    justifyContent: 'center',
    padding: LAYOUT.screenPadding,
  },
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    padding: SPACING.xl,
    gap: SPACING.lg,
    alignItems: 'center',
  },
  cardTitle: {
    ...TYPOGRAPHY.title,
    fontSize: 20,
    textAlign: 'center',
  },
  cardBody: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  primaryButton: {
    height: 52,
    alignSelf: 'stretch',
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    ...TYPOGRAPHY.cta,
    color: COLORS.textInverse,
    fontSize: 13,
  },
});
