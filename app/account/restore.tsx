import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { goBackOrAuth } from '../../services/navigationExit';
import {
  resendRestorationEmail,
  restoreAccountWithToken,
} from '../../services/accountDeletion';
import { supabase } from '../../services/supabaseClient';

type RestoreState = 'idle' | 'restoring' | 'restored' | 'restored_pending_unban' | 'failed' | 'resending';

export default function AccountRestoreScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = useMemo(() => {
    const raw = params.token;
    if (Array.isArray(raw)) return String(raw[0] || '').trim();
    return String(raw || '').trim();
  }, [params.token]);

  // P2-8: strip the token from the route params (and, on web builds, the URL)
  // as soon as it is captured, so it does not linger in navigation state,
  // deep-link history, or a Referer header.
  useEffect(() => {
    if (token) {
      router.setParams({ token: undefined } as Record<string, string | undefined>);
    }
    // Intentionally runs once on mount after the initial capture above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [state, setState] = useState<RestoreState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [email, setEmail] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!token || token.length < 32) {
        setState('failed');
        setMessage('This restoration link is missing or invalid.');
        return;
      }
      setState('restoring');
      try {
        const result = await restoreAccountWithToken(supabase, token);
        if (cancelled) return;
        if (result.status === 'restored_pending_unban') {
          setState('restored_pending_unban');
          setMessage(
            result.message ||
              'Your account data has been restored, but re-enabling sign-in is taking longer than expected. Please try again shortly.',
          );
          return;
        }
        setState('restored');
        setMessage(result.message || 'Your account has been restored. Please sign in again.');
      } catch {
        if (cancelled) return;
        setState('failed');
        setMessage('This restoration link is invalid, expired, or already used.');
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleResend = async () => {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
      setMessage('Enter the email on your account to request a new restoration link.');
      return;
    }
    setState('resending');
    try {
      const result = await resendRestorationEmail(supabase, normalized);
      setMessage(
        result.message ||
          'If an eligible deletion request exists for that email, a restoration message has been sent.',
      );
      setState('failed');
    } catch {
      setMessage('Unable to resend right now. Try again later.');
      setState('failed');
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + SPACING.xl }]}>
      <StatusBar style="light" />
      <Pressable
        style={styles.exitButton}
        onPress={() => goBackOrAuth(router)}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        testID="restore-exit"
      >
        <Text style={styles.exitText}>Back</Text>
      </Pressable>
      <Text style={styles.title}>Restore account</Text>
      <Text style={styles.body}>
        Use your emailed restoration link within 30 days of requesting deletion. After restore, you
        must sign in again — previous sessions stay revoked.
      </Text>

      {(state === 'restoring' || state === 'resending') && (
        <ActivityIndicator color={COLORS.electricCyan} style={styles.spinner} />
      )}

      {message ? <Text style={styles.message}>{message}</Text> : null}

      {state === 'restored' || state === 'restored_pending_unban' ? (
        <Pressable
          style={styles.primaryButton}
          onPress={() => router.replace('/auth')}
          testID="restore-sign-in"
        >
          <Text style={styles.primaryButtonText}>Sign in</Text>
        </Pressable>
      ) : null}

      {state === 'failed' ? (
        <View style={styles.resendBlock}>
          <Text style={styles.resendLabel}>Need a new link?</Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholder="you@email.com"
            placeholderTextColor={COLORS.chromeMuted}
            value={email}
            onChangeText={setEmail}
            testID="restore-resend-email"
          />
          <Pressable style={styles.secondaryButton} onPress={handleResend} testID="restore-resend">
            <Text style={styles.secondaryButtonText}>Resend restoration email</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.obsidian,
    paddingHorizontal: SPACING.lg,
  },
  title: {
    ...TYPOGRAPHY.title,
    color: COLORS.chrome,
    marginBottom: SPACING.sm,
  },
  exitButton: {
    minWidth: 44,
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    marginBottom: SPACING.sm,
  },
  exitText: {
    ...TYPOGRAPHY.body,
    color: COLORS.electricCyan,
  },
  body: {
    ...TYPOGRAPHY.body,
    color: COLORS.chromeMuted,
    marginBottom: SPACING.lg,
  },
  spinner: {
    marginVertical: SPACING.md,
  },
  message: {
    ...TYPOGRAPHY.body,
    color: COLORS.chrome,
    marginBottom: SPACING.lg,
  },
  primaryButton: {
    backgroundColor: COLORS.electricCyan,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  primaryButtonText: {
    ...TYPOGRAPHY.body,
    fontWeight: '700',
    color: COLORS.obsidian,
  },
  resendBlock: {
    marginTop: SPACING.lg,
    gap: SPACING.sm,
  },
  resendLabel: {
    ...TYPOGRAPHY.body,
    color: COLORS.chrome,
  },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(248,250,252,0.16)',
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    color: COLORS.chrome,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: COLORS.electricCyan,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  secondaryButtonText: {
    ...TYPOGRAPHY.body,
    fontWeight: '600',
    color: COLORS.electricCyan,
  },
});
