import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
import { completeOAuthCallbackSession } from '../../services/oauthCallbackSession';
import { traceAuthLifecycle } from '../../services/authLifecycleTrace';

type CallbackState = 'loading' | 'error';

const AUTH_CALLBACK_FAILED_MESSAGE = 'Sign-in failed. Please try again or use email sign-in.';
const AUTH_SESSION_FAILED_MESSAGE =
  "Sign-in completed, but we couldn't start your session. Please try again.";

export default function AuthCallbackScreen() {
  const router = useRouter();
  const warmUrl = Linking.useURL();
  const routeParams = useLocalSearchParams();
  const handledRef = useRef(false);
  const routedRef = useRef(false);
  const [state, setState] = useState<CallbackState>('loading');
  const [message, setMessage] = useState('Finishing secure sign-in...');

  const replaceOnce = useCallback(
    (target: string) => {
      if (routedRef.current) return;
      routedRef.current = true;
      router.replace(target);
    },
    [router],
  );

  const routeRecoveryOnce = useCallback(
    (parsed: ReturnType<typeof parseAuthCallbackUrl>) => {
      if (!parsed.isRecovery) return;
      replaceOnce(getAuthCallbackRedirect(parsed));
    },
    [replaceOnce],
  );

  const handleUrl = useCallback(
    async (url: string | null) => {
      if (!url || handledRef.current) return;
      handledRef.current = true;

      const parsed = parseAuthCallbackUrl(url);
      traceAuthLifecycle('callback-route-parsed', {
        callbackKind: parsed.code
          ? 'code'
          : parsed.hasSessionTokens
            ? 'tokens'
            : parsed.hasTokenHash
              ? 'otp'
              : 'missing',
      });
      try {
        if (parsed.error) {
          console.error('Auth callback returned an error', parsed.error);
          setMessage(AUTH_CALLBACK_FAILED_MESSAGE);
          setState('error');
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
          routeRecoveryOnce(parsed);
          return;
        }

        if (!parsed.code && !parsed.hasSessionTokens) {
          setMessage(AUTH_CALLBACK_FAILED_MESSAGE);
          setState('error');
          return;
        }

        const callbackResult = await completeOAuthCallbackSession(parsed);
        traceAuthLifecycle('callback-route-session-establishment', {
          callbackKind: callbackResult.source,
          outcome: callbackResult.error || !callbackResult.session ? 'failed' : 'accepted',
          sessionPresent: Boolean(callbackResult.session),
        });
        if (callbackResult.error || !callbackResult.session) {
          console.error('Auth callback session start failed', callbackResult.error);
          setMessage(AUTH_SESSION_FAILED_MESSAGE);
          setState('error');
          return;
        }
        routeRecoveryOnce(parsed);
        return;
      } catch (error) {
        console.error('Auth callback failed unexpectedly', error);
        setMessage(AUTH_CALLBACK_FAILED_MESSAGE);
        setState('error');
      }
    },
    [routeRecoveryOnce],
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
      if (handledRef.current) return;
      handledRef.current = true;
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session) {
          return;
        }
        setMessage(AUTH_CALLBACK_FAILED_MESSAGE);
        setState('error');
      });
    }, 10000);

    return () => clearTimeout(timeout);
  }, []);

  const openAuth = () => replaceOnce('/auth');

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
  // The card is COLORS.surface — dark glass. TYPOGRAPHY carries light-surface
  // inks, so every text style on this card states its own dark-surface colour.
  cardTitle: {
    ...TYPOGRAPHY.title,
    fontSize: 20,
    textAlign: 'center',
    color: COLORS.textInverse,
  },
  cardBody: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    color: COLORS.chrome,
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
