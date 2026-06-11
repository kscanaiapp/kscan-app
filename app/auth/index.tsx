import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';

import { useAuthSession } from '../../contexts/AuthSessionContext';
import { COLORS, LAYOUT, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { validateAuthInput, mapAuthError } from '../../services/authValidation';
import { AUTH_CALLBACK_URL } from '../../services/authConfig';
import { supabase } from '../../services/supabaseClient';
import {
  getAuthCallbackRedirect,
  parseAuthCallbackUrl,
} from '../../services/authDeepLink';

WebBrowser.maybeCompleteAuthSession();

type AuthMode = 'sign-in' | 'create-account';
type AuthStep = 'idle' | 'submitting' | 'google-oauth' | 'apple-oauth' | 'confirm-email';

function createRawNonce(length = 32) {
  const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._';
  const randomBytes = Crypto.getRandomBytes(length);
  return Array.from(randomBytes, (byte) => charset[byte % charset.length]).join('');
}

export default function AuthScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signIn, signUp, isAuthenticated } = useAuthSession();

  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [step, setStep] = useState<AuthStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [appleAuthAvailable, setAppleAuthAvailable] = useState(false);

  // Navigate away when a session appears (sign-in or immediate signup without email confirmation)
  useEffect(() => {
    if (isAuthenticated) {
      router.replace('/');
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    let mounted = true;
    void AppleAuthentication.isAvailableAsync().then((available) => {
      if (mounted) setAppleAuthAvailable(available);
    });

    return () => {
      mounted = false;
    };
  }, []);

  const busy = step === 'submitting' || step === 'google-oauth' || step === 'apple-oauth';
  const googleBusy = step === 'google-oauth';
  const appleBusy = step === 'apple-oauth';

  const switchMode = (newMode: AuthMode) => {
    if (newMode === mode) return;
    setMode(newMode);
    setError(null);
    setStep('idle');
    setConfirmPassword('');
    // Preserve email so the user doesn't have to retype it
  };

  const handleSubmit = async () => {
    const validation = validateAuthInput(mode, email, password, confirmPassword);
    if (!validation.valid) {
      setError(validation.error);
      return;
    }
    setError(null);
    setStep('submitting');
    try {
      if (mode === 'sign-in') {
        await signIn(email.trim(), password);
        // isAuthenticated useEffect handles navigation
      } else {
        const result = await signUp(email.trim(), password);
        if (result.confirmationRequired) {
          // Case B: email confirmation required — show inline panel
          setStep('confirm-email');
        }
        // Case A: session created — isAuthenticated useEffect handles navigation
      }
    } catch (err) {
      setStep('idle');
      const raw = err instanceof Error ? err.message : 'Something went wrong. Try again.';
      setError(mapAuthError(raw, mode));
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setStep('google-oauth');

    try {
      const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: AUTH_CALLBACK_URL,
          skipBrowserRedirect: true,
        },
      });

      if (oauthError) {
        throw oauthError;
      }

      if (!data.url) {
        throw new Error('Missing Google sign-in URL.');
      }

      const result = await WebBrowser.openAuthSessionAsync(data.url, AUTH_CALLBACK_URL);

      if (result.type === 'cancel' || result.type === 'dismiss') {
        setError('Sign-in cancelled.');
        setStep('idle');
        return;
      }

      if (result.type !== 'success' || !result.url) {
        setError('We could not complete Google sign-in. Please try again.');
        setStep('idle');
        return;
      }

      const parsed = parseAuthCallbackUrl(result.url);

      if (parsed.error) {
        const lowerError = String(parsed.error).toLowerCase();
        setError(
          lowerError.includes('access_denied')
            ? 'Google sign-in was denied.'
            : 'We could not complete Google sign-in. Please try again.',
        );
        setStep('idle');
        return;
      }

      if (parsed.code) {
        const { error } = await supabase.auth.exchangeCodeForSession(parsed.code);
        if (error) {
          setError('We could not complete Google sign-in. Please try again.');
          setStep('idle');
          return;
        }
        router.replace(getAuthCallbackRedirect(parsed));
        return;
      }

      if (parsed.hasSessionTokens) {
        const { error } = await supabase.auth.setSession({
          access_token: parsed.accessToken,
          refresh_token: parsed.refreshToken,
        });
        if (error) {
          setError('We could not complete Google sign-in. Please try again.');
          setStep('idle');
          return;
        }
        router.replace(getAuthCallbackRedirect(parsed));
        return;
      }

      setError('We could not complete Google sign-in. Please try again.');
      setStep('idle');
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setError(
        raw.toLowerCase().includes('network')
          ? 'Network error. Please try again.'
          : 'We could not launch Google sign-in. Please try again.',
      );
      setStep('idle');
    }
  };

  const handleAppleSignIn = async () => {
    if (Platform.OS !== 'ios') {
      setError('Apple sign-in is available on iOS devices.');
      return;
    }

    setError(null);
    setStep('apple-oauth');

    try {
      const rawNonce = createRawNonce();
      const hashedNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        rawNonce,
      );

      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedNonce,
      });

      if (!credential.identityToken) {
        setError('We could not complete Apple sign-in. Please try again.');
        setStep('idle');
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
        nonce: rawNonce,
      });

      if (signInError) {
        setError('We could not complete Apple sign-in. Please try again.');
        setStep('idle');
        return;
      }

      router.replace('/');
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
      const message = err instanceof Error ? err.message : '';
      const lowerMessage = message.toLowerCase();

      if (code === 'ERR_REQUEST_CANCELED') {
        setError('Sign-in cancelled.');
      } else if (lowerMessage.includes('network')) {
        setError('Network error. Please try again.');
      } else {
        setError('We could not complete Apple sign-in. Please try again.');
      }
      setStep('idle');
    }
  };

  // Invoked from the confirmation panel: return to sign-in mode
  const handleBackToSignIn = () => {
    setMode('sign-in');
    setStep('idle');
    setError(null);
    setPassword('');
    setConfirmPassword('');
  };

  // ── Email confirmation panel (Case B) ────────────────────────────────────────

  if (step === 'confirm-email') {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        <View style={[styles.header, { paddingTop: Math.max(insets.top, LAYOUT.safeTop) }]}>
          <Pressable style={styles.backButton} onPress={() => router.back()}>
            <Text style={styles.backText}>Cancel</Text>
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={styles.brand}>K-SCAN</Text>
            <Text style={styles.screenTitle}>ACCOUNT ACCESS</Text>
          </View>
          <View style={styles.headerRight} />
        </View>

        <KeyboardAvoidingView
          style={styles.body}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Check Your Email</Text>
            <Text style={styles.cardBody}>
              We sent a confirmation link to{' '}
              <Text style={styles.emailHighlight}>{email.trim()}</Text>. Open the link to verify
              your account and K Scan will sign you in automatically.
            </Text>
            <Pressable style={styles.primaryButton} onPress={handleBackToSignIn}>
              <Text style={styles.primaryButtonText}>SIGN IN</Text>
            </Pressable>
          </View>
          <Text style={styles.footNote}>
            Didn't receive it? Check your spam folder, or try creating the account again.
          </Text>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ── Main auth card ────────────────────────────────────────────────────────────

  const screenTitle = mode === 'sign-in' ? 'SIGN IN' : 'CREATE ACCOUNT';

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={[styles.header, { paddingTop: Math.max(insets.top, LAYOUT.safeTop) }]}>
        <Pressable style={styles.backButton} onPress={() => router.back()} disabled={busy}>
          <Text style={[styles.backText, busy && styles.disabled]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.brand}>K-SCAN</Text>
          <Text style={styles.screenTitle}>{screenTitle}</Text>
        </View>
        <View style={styles.headerRight} />
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.card}>
          {/* Mode switcher tabs */}
          <View style={styles.tabRow}>
            <Pressable
              testID="auth-mode-signin"
              style={styles.tab}
              onPress={() => switchMode('sign-in')}
              disabled={busy}
            >
              <Text style={[styles.tabText, mode === 'sign-in' && styles.tabTextActive]}>
                SIGN IN
              </Text>
              {mode === 'sign-in' ? <View style={styles.tabIndicator} /> : <View style={styles.tabIndicatorInvisible} />}
            </Pressable>
            <Pressable
              testID="auth-mode-create-account"
              style={styles.tab}
              onPress={() => switchMode('create-account')}
              disabled={busy}
            >
              <Text style={[styles.tabText, mode === 'create-account' && styles.tabTextActive]}>
                CREATE ACCOUNT
              </Text>
              {mode === 'create-account' ? <View style={styles.tabIndicator} /> : <View style={styles.tabIndicatorInvisible} />}
            </Pressable>
          </View>

          <Text style={styles.cardBody}>
            {mode === 'sign-in'
              ? 'Sign in to save your privacy preferences across devices and access account management.'
              : 'Create an account to sync your privacy preferences and manage your K Scan data.'}
          </Text>

          <Pressable
            testID="auth-google-button"
            style={[styles.googleButton, busy && styles.googleButtonDisabled]}
            onPress={handleGoogleSignIn}
            disabled={busy}
          >
            {googleBusy ? (
              <ActivityIndicator size="small" color={COLORS.textPrimary} />
            ) : (
              <>
                <View style={styles.googleIcon}>
                  <Text style={styles.googleIconText}>G</Text>
                </View>
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </>
            )}
          </Pressable>

          {appleAuthAvailable ? (
            <Pressable
              testID="auth-apple-button"
              style={[styles.appleButton, busy && styles.appleButtonDisabled]}
              onPress={handleAppleSignIn}
              disabled={busy}
            >
              {appleBusy ? (
                <ActivityIndicator size="small" color={COLORS.black} />
              ) : (
                <>
                  <Text style={styles.appleIconText}>Apple</Text>
                  <Text style={styles.appleButtonText}>Continue with Apple</Text>
                </>
              )}
            </Pressable>
          ) : null}

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>EMAIL</Text>
            <TextInput
              testID="auth-email-input"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={COLORS.textSecondary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={!busy}
              style={[styles.input, busy && styles.inputDisabled]}
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>PASSWORD</Text>
            <TextInput
              testID="auth-password-input"
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={COLORS.textSecondary}
              secureTextEntry
              autoCapitalize="none"
              autoComplete={mode === 'sign-in' ? 'password' : 'new-password'}
              autoCorrect={false}
              editable={!busy}
              onSubmitEditing={mode === 'sign-in' ? handleSubmit : undefined}
              style={[styles.input, busy && styles.inputDisabled]}
            />
          </View>

          {mode === 'create-account' ? (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>CONFIRM PASSWORD</Text>
              <TextInput
                testID="auth-confirm-password-input"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="••••••••"
                placeholderTextColor={COLORS.textSecondary}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="new-password"
                autoCorrect={false}
                editable={!busy}
                onSubmitEditing={handleSubmit}
                style={[styles.input, busy && styles.inputDisabled]}
              />
            </View>
          ) : null}

          <Pressable
            testID="auth-submit-button"
            style={[styles.primaryButton, busy && styles.primaryButtonBusy]}
            onPress={handleSubmit}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color={COLORS.textInverse} />
            ) : (
              <Text style={styles.primaryButtonText}>
                {mode === 'sign-in' ? 'SIGN IN' : 'CREATE ACCOUNT'}
              </Text>
            )}
          </Pressable>

          {mode === 'sign-in' ? (
            <Pressable
              testID="auth-forgot-password-button"
              onPress={() => router.push('/auth/reset')}
              disabled={busy}
              style={styles.forgotPasswordButton}
            >
              <Text style={[styles.secondaryLinkAction, busy && styles.disabled]}>
                Forgot password?
              </Text>
            </Pressable>
          ) : null}
        </View>

        <Pressable
          onPress={() => switchMode(mode === 'sign-in' ? 'create-account' : 'sign-in')}
          disabled={busy}
          style={styles.secondaryLinkRow}
        >
          <Text style={styles.secondaryLink}>
            {mode === 'sign-in' ? 'Need an account? ' : 'Already have an account? '}
            <Text style={styles.secondaryLinkAction}>
              {mode === 'sign-in' ? 'Create one' : 'Sign in'}
            </Text>
          </Text>
        </Pressable>

        <Text style={styles.footNote}>
          Your choices are private to your account.
        </Text>
        <View style={styles.legalLinks}>
          <Pressable onPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}>
            <Text style={styles.legalLinkText}>Privacy Policy</Text>
          </Pressable>
          <Text style={styles.legalLinkSep}>·</Text>
          <Pressable onPress={() => void Linking.openURL('https://kscan.app/legal/terms')}>
            <Text style={styles.legalLinkText}>Terms</Text>
          </Pressable>
          <Text style={styles.legalLinkSep}>·</Text>
          <Pressable onPress={() => void Linking.openURL('https://kscan.app/support')}>
            <Text style={styles.legalLinkText}>Support</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
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
    paddingHorizontal: LAYOUT.screenPadding,
    paddingBottom: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    width: 56,
  },
  backText: {
    color: COLORS.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.4,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerRight: {
    width: 56,
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
    padding: LAYOUT.screenPadding,
    gap: SPACING.lg,
    justifyContent: 'center',
  },
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    padding: SPACING.xl,
    gap: SPACING.lg,
  },
  // Mode switcher tabs
  tabRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginBottom: SPACING.xs,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    gap: SPACING.xs,
  },
  tabText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
  },
  tabTextActive: {
    color: COLORS.accent,
  },
  tabIndicator: {
    height: 2,
    width: 28,
    backgroundColor: COLORS.accent,
    borderRadius: 1,
  },
  tabIndicatorInvisible: {
    height: 2,
    width: 28,
  },
  cardTitle: {
    ...TYPOGRAPHY.title,
    fontSize: 20,
  },
  cardBody: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    lineHeight: 20,
  },
  emailHighlight: {
    color: COLORS.textPrimary,
    fontWeight: '600',
  },
  errorBanner: {
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 107, 0.45)',
    borderRadius: RADIUS.sm,
    backgroundColor: 'rgba(255, 107, 107, 0.08)',
    padding: SPACING.md,
  },
  errorText: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    color: COLORS.errorSoft,
  },
  fieldGroup: {
    gap: SPACING.xs,
  },
  fieldLabel: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
  },
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
  inputDisabled: {
    opacity: 0.6,
  },
  primaryButton: {
    height: 52,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.sm,
  },
  primaryButtonBusy: {
    opacity: 0.7,
  },
  primaryButtonText: {
    ...TYPOGRAPHY.cta,
    color: COLORS.textInverse,
    fontSize: 13,
  },
  googleButton: {
    minHeight: 52,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: SPACING.md,
  },
  googleButtonDisabled: {
    opacity: 0.6,
  },
  googleIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.textPrimary,
  },
  googleIconText: {
    color: '#4285F4',
    fontSize: 15,
    fontWeight: '800',
  },
  googleButtonText: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.textPrimary,
    fontSize: 14,
  },
  appleButton: {
    minHeight: 52,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: SPACING.md,
  },
  appleButtonDisabled: {
    opacity: 0.6,
  },
  appleIconText: {
    color: COLORS.black,
    fontSize: 15,
    fontWeight: '800',
  },
  appleButtonText: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.black,
    fontSize: 14,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.border,
  },
  dividerText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
    fontSize: 10,
  },
  secondaryLinkRow: {
    alignItems: 'center',
    paddingVertical: SPACING.xs,
  },
  secondaryLink: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  secondaryLinkAction: {
    color: COLORS.accent,
    fontWeight: '600',
  },
  forgotPasswordButton: {
    alignSelf: 'center',
    paddingVertical: SPACING.xs,
  },
  footNote: {
    ...TYPOGRAPHY.body,
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.textSecondary,
    textAlign: 'center',
    paddingHorizontal: SPACING.lg,
  },
  legalLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    paddingTop: SPACING.sm,
    paddingHorizontal: SPACING.lg,
  },
  legalLinkText: {
    fontSize: 11,
    color: COLORS.textSecondary,
    textDecorationLine: 'underline',
  },
  legalLinkSep: {
    fontSize: 11,
    color: COLORS.textSecondary,
  },
});
