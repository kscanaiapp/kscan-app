import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';

import { COLORS, LAYOUT, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { AUTH_CALLBACK_URL } from '../../services/authConfig';
import { mapAuthError } from '../../services/authValidation';
import { goBackOrAuth } from '../../services/navigationExit';
import { supabase } from '../../services/supabaseClient';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setError('Enter a valid email address.');
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(trimmed, {
      redirectTo: AUTH_CALLBACK_URL,
    });
    setBusy(false);

    if (resetError) {
      setError(mapAuthError(resetError.message, 'reset'));
      return;
    }
    setMessage('Password reset link sent. Open it on this device to continue.');
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.header}>
        <Pressable
          style={styles.backButton}
          onPress={() => goBackOrAuth(router)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={[styles.backText, busy && styles.disabled]}>Back</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.brand}>K-SCAN</Text>
          <Text style={styles.screenTitle}>PASSWORD RESET</Text>
        </View>
        <View style={styles.headerRight} />
      </SafeAreaView>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recover Access</Text>
          <Text style={styles.cardBody}>
            Enter your account email and we will send a secure reset link.
          </Text>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          {message ? <Text style={styles.messageText}>{message}</Text> : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>EMAIL</Text>
            <TextInput
              testID="auth-reset-email-input"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={COLORS.textTertiary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={!busy}
              style={[styles.input, busy && styles.inputDisabled]}
            />
          </View>

          <Pressable
            testID="auth-reset-submit"
            style={[styles.primaryButton, busy && styles.primaryButtonBusy]}
            onPress={submit}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color={COLORS.textInverse} />
            ) : (
              <Text style={styles.primaryButtonText}>SEND RESET LINK</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: LAYOUT.safeTop,
    paddingHorizontal: LAYOUT.screenPadding,
    paddingBottom: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: { width: 56 },
  backText: { color: COLORS.accent, fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerRight: { width: 56 },
  brand: { ...TYPOGRAPHY.brand, fontSize: 16 },
  screenTitle: { ...TYPOGRAPHY.caption, marginTop: SPACING.xs, color: COLORS.accent },
  body: { flex: 1, padding: LAYOUT.screenPadding, justifyContent: 'center' },
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    padding: SPACING.xl,
    gap: SPACING.lg,
  },
  cardTitle: { ...TYPOGRAPHY.title, fontSize: 20 },
  cardBody: { ...TYPOGRAPHY.body, fontSize: 13, lineHeight: 20 },
  errorText: { ...TYPOGRAPHY.body, color: COLORS.errorSoft, fontSize: 13 },
  messageText: { ...TYPOGRAPHY.bodyStrong, color: COLORS.success, fontSize: 13 },
  fieldGroup: { gap: SPACING.xs },
  fieldLabel: { ...TYPOGRAPHY.caption, color: COLORS.textTertiary },
  input: {
    height: 50,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.lg,
    color: COLORS.textPrimary,
    backgroundColor: COLORS.bgElevated,
    fontSize: 15,
  },
  inputDisabled: { opacity: 0.6 },
  primaryButton: {
    height: 52,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonBusy: { opacity: 0.7 },
  primaryButtonText: { ...TYPOGRAPHY.cta, color: COLORS.textInverse, fontSize: 13 },
});
