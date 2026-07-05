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
import { supabase } from '../../services/supabaseClient';
import { validateNewPassword, verifySessionAfterPasswordUpdate } from '../../services/passwordReset';
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

    try {
      await verifySessionAfterPasswordUpdate(supabase);
      router.replace('/privacy');
    } catch {
      await supabase.auth.signOut();
      router.replace('/auth');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.header}>
        <View style={styles.headerSide} />
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
            Choose a new password. Your recovery session will stay signed in after the update.
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
  headerSide: { width: 56 },
  headerCenter: { flex: 1, alignItems: 'center' },
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
