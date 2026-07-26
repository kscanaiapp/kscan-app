import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { goBackOrOnboarding } from '../../services/navigationExit';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// @ts-ignore — expo-apple-authentication is not installed for Android builds; iOS-only feature
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';

import { useAuthSession } from '../../contexts/AuthSessionContext';
import { COLORS, LUXURY, LAYOUT, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { FORM_MAX_WIDTH } from '../../services/responsiveLayout';
import { validateAuthInput, mapAuthError } from '../../services/authValidation';
import { AUTH_CALLBACK_URL } from '../../services/authConfig';
import { supabase } from '../../services/supabaseClient';
import { parseAuthCallbackUrl } from '../../services/authDeepLink';
import { completeOAuthCallbackSession } from '../../services/oauthCallbackSession';
import { traceAuthLifecycle } from '../../services/authLifecycleTrace';

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
  const { signIn, signUp } = useAuthSession();

  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [step, setStep] = useState<AuthStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [appleAuthAvailable, setAppleAuthAvailable] = useState(false);

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
      traceAuthLifecycle('oauth-browser-result', { outcome: result.type });

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
      traceAuthLifecycle('oauth-callback-parsed', {
        callbackKind: parsed.code ? 'code' : parsed.hasSessionTokens ? 'tokens' : 'missing',
      });

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

      const callbackResult = await completeOAuthCallbackSession(parsed);
      traceAuthLifecycle('oauth-session-establishment', {
        callbackKind: callbackResult.source,
        outcome: callbackResult.error || !callbackResult.session ? 'failed' : 'accepted',
        sessionPresent: Boolean(callbackResult.session),
      });
      if (callbackResult.error || !callbackResult.session) {
        setError('We could not complete Google sign-in. Please try again.');
        setStep('idle');
      }
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

      traceAuthLifecycle('apple-session-establishment', {
        outcome: 'accepted',
        sessionPresent: true,
      });
      return;
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
        <StatusBar style="dark" />
        <View style={[styles.header, { paddingTop: Math.max(insets.top, LAYOUT.safeTop) }]}>
          <Pressable
            style={styles.backButton}
            onPress={() => goBackOrOnboarding(router)}
            accessibilityRole="button"
            accessibilityLabel="Cancel and go back"
          >
            <Text style={styles.backText}>Cancel</Text>
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={styles.brand}>K Scan AI</Text>
            <Text style={styles.screenTitle}>ACCOUNT ACCESS</Text>
          </View>
          <View style={styles.headerRight} />
        </View>

        <KeyboardAvoidingView
          style={styles.body}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 40 : 0}
        >
          <ScrollView
            contentContainerStyle={[
              styles.scrollContent,
              { paddingBottom: Math.max(insets.bottom, 24) + 120 },
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.scrollInner}>
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
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ── Main auth card ────────────────────────────────────────────────────────────

  const screenTitle = mode === 'sign-in' ? 'SIGN IN' : 'CREATE ACCOUNT';

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={[styles.header, { paddingTop: Math.max(insets.top, LAYOUT.safeTop) }]}>
        <Pressable
          style={styles.backButton}
          onPress={() => goBackOrOnboarding(router)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Cancel and go back"
          accessibilityState={{ disabled: busy }}
        >
          <Text style={[styles.backText, busy && styles.disabled]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.brand}>K Scan AI</Text>
          <Text style={styles.screenTitle}>{screenTitle}</Text>
        </View>
        <View style={styles.headerRight} />
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 40 : 0}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: Math.max(insets.bottom, 24) + 120 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.scrollInner}>
            <View style={styles.card}>
              {/* Mode switcher tabs */}
          <View style={styles.tabRow}>
            <Pressable
              testID="auth-mode-signin"
              style={styles.tab}
              onPress={() => switchMode('sign-in')}
              disabled={busy}
              accessibilityRole="tab"
              accessibilityLabel="Sign in"
              accessibilityState={{ selected: mode === 'sign-in', disabled: busy }}
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
              accessibilityRole="tab"
              accessibilityLabel="Create account"
              accessibilityState={{ selected: mode === 'create-account', disabled: busy }}
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
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
            accessibilityState={{ disabled: busy, busy: googleBusy }}
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
              accessibilityRole="button"
              accessibilityLabel="Continue with Apple"
              accessibilityState={{ disabled: busy, busy: appleBusy }}
            >
              {appleBusy ? (
                <ActivityIndicator size="small" color={COLORS.black} />
              ) : (
                <>
                  <Text style={styles.appleIconText}>{''}</Text>
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
              placeholderTextColor={LUXURY.colors.stone}
              accessibilityLabel="Email address"
              accessibilityHint="Enter your email address"
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
              placeholderTextColor={LUXURY.colors.stone}
              accessibilityLabel="Password"
              accessibilityHint={mode === 'sign-in' ? 'Enter your password' : 'Create a password'}
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
                placeholderTextColor={LUXURY.colors.stone}
                accessibilityLabel="Confirm password"
                accessibilityHint="Re-enter your password"
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
            accessibilityRole="button"
            accessibilityLabel={mode === 'sign-in' ? 'Sign in' : 'Create account'}
            accessibilityState={{ disabled: busy, busy }}
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
              accessibilityRole="link"
              accessibilityLabel="Forgot password"
              accessibilityState={{ disabled: busy }}
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
          accessibilityRole="button"
          accessibilityLabel={mode === 'sign-in' ? 'Create an account' : 'Sign in to existing account'}
          accessibilityState={{ disabled: busy }}
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
          <Pressable
            onPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
            accessibilityRole="link"
            accessibilityLabel="Open Privacy Policy"
          >
            <Text style={styles.legalLinkText}>Privacy Policy</Text>
          </Pressable>
          <Text style={styles.legalLinkSep}>·</Text>
          <Pressable
            onPress={() => void Linking.openURL('https://kscan.app/legal/terms')}
            accessibilityRole="link"
            accessibilityLabel="Open Terms of Service"
          >
            <Text style={styles.legalLinkText}>Terms</Text>
          </Pressable>
          <Text style={styles.legalLinkSep}>·</Text>
          <Pressable
            onPress={() => void Linking.openURL('https://kscan.app/support')}
            accessibilityRole="link"
            accessibilityLabel="Open Support"
          >
            <Text style={styles.legalLinkText}>Support</Text>
          </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: LUXURY.colors.ivory,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: LAYOUT.screenPadding,
    paddingBottom: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.border,
  },
  backButton: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
  },
  backText: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    color: LUXURY.colors.plum,
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
    ...LUXURY.typography.brandMark,
    fontSize: 18,
    color: LUXURY.colors.plum,
  },
  screenTitle: {
    ...LUXURY.typography.sectionLabel,
    marginTop: SPACING.xs,
    color: LUXURY.colors.plum,
  },
  body: {
    flex: 1,
    padding: LAYOUT.screenPadding,
    paddingBottom: LAYOUT.modalBottomPadding,
  },
  scrollContent: {
    flexGrow: 1,
  },
  scrollInner: {
    gap: SPACING.lg,
    // Readable form column: inert on phones, caps and centers the sign-in
    // form on regular-width iPad windows.
    width: '100%',
    maxWidth: FORM_MAX_WIDTH,
    alignSelf: 'center',
  },
  card: {
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    borderRadius: RADIUS.xl,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.xl,
    paddingVertical: 20,
    gap: SPACING.lg,
    ...SHADOWS.editorialSmall,
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
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.stone,
    fontSize: 12,
  },
  tabTextActive: {
    color: LUXURY.colors.plum,
  },
  tabIndicator: {
    height: 2,
    width: 28,
    backgroundColor: LUXURY.colors.gold,
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
    ...LUXURY.typography.body,
    fontSize: 14,
    lineHeight: 22,
  },
  emailHighlight: {
    color: LUXURY.colors.ink,
    fontWeight: '600',
  },
  errorBanner: {
    borderWidth: 1,
    borderColor: 'rgba(130, 48, 56, 0.25)',
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(130, 48, 56, 0.08)',
    padding: SPACING.md,
  },
  errorText: {
    ...LUXURY.typography.body,
    fontSize: 14,
    color: LUXURY.colors.error,
  },
  fieldGroup: {
    gap: SPACING.xs,
  },
  fieldLabel: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.stone,
    fontSize: 11,
  },
  input: {
    height: LUXURY.inputs.field.height,
    borderRadius: LUXURY.inputs.field.borderRadius,
    borderWidth: LUXURY.inputs.field.borderWidth,
    borderColor: LUXURY.inputs.field.borderColor,
    paddingHorizontal: LUXURY.inputs.field.paddingHorizontal,
    color: LUXURY.inputs.field.color,
    backgroundColor: LUXURY.colors.cream,
    fontSize: LUXURY.inputs.field.fontSize,
    fontWeight: LUXURY.inputs.field.fontWeight,
  },
  inputDisabled: {
    opacity: 0.6,
  },
  primaryButton: {
    minHeight: LUXURY.buttons.primary.height,
    borderRadius: LUXURY.buttons.primary.borderRadius,
    backgroundColor: LUXURY.buttons.primary.backgroundColor,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  primaryButtonBusy: {
    opacity: 0.7,
  },
  primaryButtonText: {
    ...LUXURY.typography.cta,
    color: LUXURY.buttons.primary.color,
    fontSize: LUXURY.buttons.primary.fontSize,
    letterSpacing: LUXURY.buttons.primary.letterSpacing,
    fontWeight: LUXURY.buttons.primary.fontWeight,
  },
  googleButton: {
    minHeight: 52,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.borderStrong,
    backgroundColor: LUXURY.colors.pearl,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: SPACING.md,
    marginBottom: -SPACING.sm,
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
    backgroundColor: LUXURY.colors.ink,
  },
  googleIconText: {
    color: LUXURY.colors.pearl,
    fontSize: 15,
    fontWeight: '800',
  },
  googleButtonText: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
  },
  appleButton: {
    minHeight: 52,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: SPACING.md,
  },
  appleButtonDisabled: {
    opacity: 0.6,
  },
  appleIconText: {
    color: LUXURY.colors.pearl,
    fontSize: 15,
    fontWeight: '800',
  },
  appleButtonText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.pearl,
    fontSize: 14,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    marginVertical: -SPACING.xs,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: LUXURY.colors.border,
  },
  dividerText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    fontSize: 12,
  },
  secondaryLinkRow: {
    alignItems: 'center',
    paddingVertical: SPACING.xs,
  },
  secondaryLink: {
    ...LUXURY.typography.body,
    fontSize: 14,
    textAlign: 'center',
  },
  secondaryLinkAction: {
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  forgotPasswordButton: {
    alignSelf: 'center',
    paddingVertical: SPACING.xs,
  },
  footNote: {
    ...LUXURY.typography.caption,
    fontSize: 13,
    lineHeight: 20,
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
    ...LUXURY.typography.caption,
    fontSize: 12,
    textDecorationLine: 'underline',
    textTransform: 'none',
    letterSpacing: 0.5,
    minHeight: 44,
    textAlignVertical: 'center',
  },
  legalLinkSep: {
    ...LUXURY.typography.caption,
    fontSize: 12,
  },
});
