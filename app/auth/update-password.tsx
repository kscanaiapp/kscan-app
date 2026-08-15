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
import { goBackOrAuth } from '../../services/navigationExit';
import { supabase } from '../../services/supabaseClient';
import { validateNewPassword } from '../../services/passwordReset';
import { mapAuthError } from '../../services/authValidation';

export default function UpdatePasswordScreen() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const validationError = validateNewPassword(password);
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setBusy(false);
      setError(mapAuthError(updateError.message, 'update-password'));
      return;
    }

    // A password change is a security boundary. Global sign-out revokes refresh
    // capability on every device, including this recovery session, so an old
    // securely stored token cannot silently restore access.
    const { error: revokeError } = await supabase.auth.signOut({ scope: 'global' });
    setBusy(false);

    if (revokeError) {
      setError('Password changed, but we could not revoke existing sessions. Reconnect and try again.');
      return;
    }

    router.replace('/auth');
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.header}>
        <Pressable
          style={styles.headerSide}
          onPress={() => goBackOrAuth(router)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Cancel and go back"
          accessibilityState={{ disabled: busy }}
        >
          <Text style={[styles.cancelText, busy && styles.disabled]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.brand}>K-SCAN</Text>
          <Text style={styles.screenTitle}>UPDATE PASSWORD</Text>
        </View>
        <View style={styles.headerSide} />
      </SafeAreaView>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Set New Password</Text>
          <Text style={styles.cardBody}>
            Choose a new password. For your security, you’ll sign in again on every device.
          </Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>NEW PASSWORD</Text>
            <TextInput
              testID="auth-new-password-input"
              value={password}
              onChangeText={setPassword}
              placeholder="Minimum 8 characters"
              placeholderTextColor={COLORS.textTertiary}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="new-password"
              autoCorrect={false}
              editable={!busy}
              onSubmitEditing={submit}
              style={[styles.input, busy && styles.inputDisabled]}
            />
          </View>

          <Pressable
            testID="auth-update-password-submit"
            style={[styles.primaryButton, busy && styles.primaryButtonBusy]}
            onPress={submit}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color={COLORS.textInverse} />
            ) : (
              <Text style={styles.primaryButtonText}>UPDATE PASSWORD</Text>
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
  headerSide: {
    minWidth: 56,
    minHeight: 44,
    justifyContent: 'center',
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  brand: { ...TYPOGRAPHY.brand, fontSize: 16 },
  screenTitle: { ...TYPOGRAPHY.caption, marginTop: SPACING.xs, color: COLORS.accent },
  cancelText: { ...TYPOGRAPHY.caption, color: COLORS.textSecondary, textTransform: 'none' },
  disabled: { opacity: 0.5 },
  body: { flex: 1, padding: LAYOUT.screenPadding, justifyContent: 'center' },
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    // Contrast repair. This used COLORS.surface, which is a DARK GLASS token
    // (rgba(18,16,26,0.88), compositing to ~#2d2b33) while the text on it uses
    // the light-theme tokens — near-black on near-black, measured at 1.34:1
    // against a 4.5:1 requirement. Effectively invisible.
    //
    // The giveaway that this was a mistake rather than a design: the input
    // INSIDE this same card already uses a light background, and these three
    // recovery screens are the only places in the app that use the dark-glass
    // token as a card surface.
    //
    // surfaceCard is the existing light card token. No new colour is
    // introduced and authentication is not redesigned.
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.xl,
    gap: SPACING.lg,
  },
  cardTitle: { ...TYPOGRAPHY.title, fontSize: 20 },
  cardBody: { ...TYPOGRAPHY.body, fontSize: 13, lineHeight: 20 },
  errorText: { ...TYPOGRAPHY.body, color: COLORS.errorSoft, fontSize: 13 },
  fieldGroup: { gap: SPACING.xs },
  // textTertiary lands at 4.38:1 on the light card — a hair under the
  // 4.5:1 normal-text requirement. textSecondary is an existing token and
  // clears it at 8.71:1.
  fieldLabel: { ...TYPOGRAPHY.caption, color: COLORS.textSecondary },
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
