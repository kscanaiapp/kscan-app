import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  Switch,
  BackHandler,
  ActivityIndicator,
  Linking,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams, useNavigationContainerRef, useRouter } from 'expo-router';

import { useAuthSession } from '../../contexts/AuthSessionContext';
import {
  markOnboardingComplete,
  isOnboardingComplete,
} from '../../services/onboardingCompletion';
import {
  LuxuryScreen,
  KScanHeader,
  PrimaryButton,
  SecondaryButton,
  TertiaryButton,
} from '../../components/luxury';
import { OnboardingShell } from '../../components/onboarding';
import {
  WelcomeStepV1,
  AccountSetupStepV1,
  PermissionsStepV1,
} from '../../components/account-home';
import { LUXURY, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { ACCOUNT_HOME_UX_V1_ENABLED, VOICESCAN_ENABLED } from '../../constants/featureFlags';
import { TERMS_VERSION, PRIVACY_VERSION, AGE_VERSION } from '../../constants/legal';
import { validateAuthInput, mapAuthError } from '../../services/authValidation';
import { recordLegalAcceptances } from '../../services/legalAcceptance';
import { usePermissionPreferences } from '../../hooks/usePermissionPreferences';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '../../services/supabaseClient';
import { AUTH_CALLBACK_URL } from '../../services/authConfig';
import { parseAuthCallbackUrl } from '../../services/authDeepLink';

// ── Types ───────────────────────────────────────────────────────────────────

type OnboardingStep =
  | 1  // Welcome
  | 2  // Auth Choice
  | 3  // Create Account / Email Auth
  | 4  // Terms + Privacy
  | 5  // Permissions Preferences
  | 6; // Home Handoff

// ── Main Route ───────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router = useRouter();
  const routeParams = useLocalSearchParams<{ resume?: string | string[] }>();
  const { loading: authLoading, isAuthenticated, user, signUp, signIn } = useAuthSession();
  const resumeParam = Array.isArray(routeParams.resume) ? routeParams.resume[0] : routeParams.resume;
  const shouldResumeTerms = resumeParam === 'terms';

  const [step, setStep] = useState<OnboardingStep>(1);

  // Step 3: Create Account form
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [styleNickname, setStyleNickname] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmPasswordVisible, setConfirmPasswordVisible] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [appleBusy, setAppleBusy] = useState(false);
  const [appleAuthAvailable, setAppleAuthAvailable] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);
  const resumeHandledRef = useRef(false);
  const authResumeKeyRef = useRef<string | null>(null);
  const routedHomeRef = useRef(false);

  // Step 4: Terms
  const [termsChecked, setTermsChecked] = useState(false);
  const [privacyChecked, setPrivacyChecked] = useState(false);
  const [ageChecked, setAgeChecked] = useState(false);
  const [legalBusy, setLegalBusy] = useState(false);
  const [legalError, setLegalError] = useState<string | null>(null);

  // Step 5: Permissions (visual toggles only)
  const {
    preferences: permissionPrefs,
    togglePreference: togglePermission,
    setPreference: setPermissionPreference,
    isSaving: permissionSaving,
    savePreferences,
  } = usePermissionPreferences();
  const microphoneDisabled = !VOICESCAN_ENABLED;

  const navigationRef = useNavigationContainerRef();
  const replaceHomeOnce = useCallback(() => {
    if (routedHomeRef.current) return;
    routedHomeRef.current = true;
    const performReplace = () => {
      if (navigationRef.isReady?.()) {
        router.replace('/');
        return;
      }
      setTimeout(performReplace, 50);
    };
    performReplace();
  }, [router, navigationRef]);

  const moveToTermsOnce = useCallback(() => {
    setStep((current) => (current === 4 ? current : 4));
  }, []);

  useEffect(() => {
    if (resumeHandledRef.current || resumeParam !== 'terms') return;
    resumeHandledRef.current = true;
    moveToTermsOnce();
  }, [moveToTermsOnce, resumeParam]);

  // Auth state: if onboarding is already complete for this user, redirect to Home.
  // Otherwise, stay on onboarding so the user can finish Terms + Permissions.
  // If user is authenticated but on Welcome/Auth-Choice (steps 1-2), skip to Terms (step 4)
  // so they don't get reset after OAuth or returning with an existing session.
  useEffect(() => {
    if (authLoading || !isAuthenticated || !user?.id) return;
    const resumeKey = `${user.id}:${resumeParam === 'terms' ? 'terms' : 'session'}`;
    if (authResumeKeyRef.current === resumeKey) return;
    authResumeKeyRef.current = resumeKey;

    let active = true;
    isOnboardingComplete(user.id)
      .then((complete) => {
        if (!active) return;
        if (complete) {
          replaceHomeOnce();
        } else {
          setStep((current) => {
            if (current === 4) return current;
            return shouldResumeTerms || current <= 2 ? 4 : current;
          });
        }
      })
      .catch((error) => {
        if (__DEV__) {
          console.warn('[onboarding] Unable to read onboarding completion flag', error);
        }
        if (active) moveToTermsOnce();
      });

    return () => {
      active = false;
    };
  }, [authLoading, isAuthenticated, user?.id, moveToTermsOnce, replaceHomeOnce, resumeParam, shouldResumeTerms]);

  // Apple Sign-In availability check (iOS only)
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
  useEffect(() => {
    const backAction = () => {
      if (step > 1) {
        setStep((prev) => Math.max(1, prev - 1) as OnboardingStep);
        return true;
      }
      return false;
    };

    const subscription = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => subscription.remove();
  }, [step]);

  // ── Navigation helpers ───────────────────────────────────────────────────

  const goToNext = useCallback(() => {
    setCreateError(null);
    setConfirmationEmail(null);
    setStep((prev) => Math.min(6, prev + 1) as OnboardingStep);
  }, []);

  const goToPrev = useCallback(() => {
    setCreateError(null);
    setConfirmationEmail(null);
    setStep((prev) => Math.max(1, prev - 1) as OnboardingStep);
  }, []);

  const continueAuthenticatedFlow = useCallback(
    async (sessionUserId?: string | null) => {
      const resolvedUserId =
        sessionUserId ??
        user?.id ??
        (await supabase.auth.getSession()).data.session?.user?.id ??
        null;

      if (!resolvedUserId) {
        moveToTermsOnce();
        return;
      }

      const complete = await isOnboardingComplete(resolvedUserId);
      if (complete) {
        replaceHomeOnce();
        return;
      }

      moveToTermsOnce();
    },
    [moveToTermsOnce, replaceHomeOnce, user?.id],
  );

  const goToAuth = useCallback(() => {
    router.push('/auth');
  }, [router]);

  const goToHome = useCallback(async () => {
    // Advancing without recording completion sent the user to "/", where the
    // routing guard read onboardingComplete === false and bounced them straight
    // back here — an unbreakable onboarding loop. Only advance once completion
    // is actually persisted for a known user.
    if (!user?.id) {
      setCreateError('Your session ended before we could finish setup. Please sign in again.');
      goToAuth();
      return;
    }
    await markOnboardingComplete(user.id);
    setStep(6);
    replaceHomeOnce();
  }, [replaceHomeOnce, user?.id, goToAuth]);

  // ── Step 3: Create Account handler ───────────────────────────────────────

  const handleCreateAccount = useCallback(async () => {
    const validation = validateAuthInput('create-account', email, password, confirmPassword);
    if (!validation.valid) {
      setCreateError(validation.error);
      return;
    }
    const trimmedEmail = email.trim();
    setConfirmationEmail(null);
    setCreateError(null);
    setCreateBusy(true);
    try {
      const result = await signUp(trimmedEmail, password);
      if (result.confirmationRequired) {
        setConfirmationEmail(trimmedEmail);
        return;
      }
      await continueAuthenticatedFlow(result.session?.user?.id ?? null);
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Something went wrong. Try again.';
      setCreateError(mapAuthError(raw, 'create-account'));
    } finally {
      setCreateBusy(false);
    }
  }, [email, password, confirmPassword, signUp, continueAuthenticatedFlow]);

  // ── Apple OAuth handler (used from onboarding auth-choice step) ─────────────

  function createRawNonce(length = 32) {
    const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._';
    const randomBytes = Crypto.getRandomBytes(length);
    return Array.from(randomBytes, (byte) => charset[byte % charset.length]).join('');
  }

  const handleAppleSignIn = useCallback(async () => {
    if (Platform.OS !== 'ios') {
      setCreateError('Apple sign-in is available on iOS devices.');
      return;
    }

    setCreateError(null);
    setConfirmationEmail(null);
    setAppleBusy(true);

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
        setCreateError('We could not complete Apple sign-in. Please try again.');
        setAppleBusy(false);
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
        nonce: rawNonce,
      });

      if (signInError) {
        setCreateError('We could not complete Apple sign-in. Please try again.');
        setAppleBusy(false);
        return;
      }

      await continueAuthenticatedFlow();
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
      const message = err instanceof Error ? err.message : '';
      const lowerMessage = message.toLowerCase();

      if (code === 'ERR_REQUEST_CANCELED') {
        setCreateError('Sign-in cancelled.');
      } else if (lowerMessage.includes('network')) {
        setCreateError('Network error. Please try again.');
      } else {
        setCreateError('We could not complete Apple sign-in. Please try again.');
      }
      setAppleBusy(false);
    }
  }, [continueAuthenticatedFlow]);

  // ── Google OAuth handler (used from onboarding auth-choice step) ─────────────

  const handleGoogleSignIn = useCallback(async () => {
    setCreateError(null);
    setConfirmationEmail(null);
    setGoogleBusy(true);

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
        setCreateError('Sign-in cancelled.');
        setGoogleBusy(false);
        return;
      }

      if (result.type !== 'success' || !result.url) {
        setCreateError('We could not complete Google sign-in. Please try again.');
        setGoogleBusy(false);
        return;
      }

      const parsed = parseAuthCallbackUrl(result.url);

      if (parsed.error) {
        const lowerError = String(parsed.error).toLowerCase();
        setCreateError(
          lowerError.includes('access_denied')
            ? 'Google sign-in was denied.'
            : 'We could not complete Google sign-in. Please try again.',
        );
        setGoogleBusy(false);
        return;
      }

      if (parsed.code) {
        const { data: sessionData, error } = await supabase.auth.exchangeCodeForSession(parsed.code);
        if (error) {
          setCreateError('We could not complete Google sign-in. Please try again.');
          setGoogleBusy(false);
          return;
        }
        await continueAuthenticatedFlow(sessionData.session?.user?.id ?? null);
        setGoogleBusy(false);
        return;
      }

      if (parsed.hasSessionTokens) {
        const { data: sessionData, error } = await supabase.auth.setSession({
          access_token: parsed.accessToken,
          refresh_token: parsed.refreshToken,
        });
        if (error) {
          setCreateError('We could not complete Google sign-in. Please try again.');
          setGoogleBusy(false);
          return;
        }
        await continueAuthenticatedFlow(sessionData.session?.user?.id ?? null);
        setGoogleBusy(false);
        return;
      }

      setCreateError('We could not complete Google sign-in. Please try again.');
      setGoogleBusy(false);
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setCreateError(
        raw.toLowerCase().includes('network')
          ? 'Network error. Please try again.'
          : 'We could not launch Google sign-in. Please try again.',
      );
      setGoogleBusy(false);
    }
  }, [continueAuthenticatedFlow]);

  // ── Step 4: Accept & Continue handler ───────────────────────────────────

  const handleAcceptAndContinue = useCallback(async () => {
    setLegalError(null);
    setLegalBusy(true);

    // Capture timestamps at the exact moment the user taps Accept & Continue.
    // These are kept local; recordLegalAcceptances does not currently accept timestamps.
    const acceptedAt = new Date().toISOString();
    const acceptedTermsAt = acceptedAt;
    const acceptedPrivacyAt = acceptedAt;
    const acceptedAgeAt = acceptedAt;

    try {
      const result = await recordLegalAcceptances({
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        minimumAgeVersion: AGE_VERSION,
        appVersion: null, // app_version not wired — deferred until app metadata helper exists
      });
      if (result.ok) {
        goToNext();
      } else {
        setLegalError(result.error ?? 'Unable to save your preferences. Please try again.');
      }
    } catch {
      setLegalError('Unable to save your preferences. Please try again.');
    } finally {
      setLegalBusy(false);
    }
  }, [goToNext]);

  // ── Render helpers ───────────────────────────────────────────────────────

  const renderWelcome = () => {
    if (ACCOUNT_HOME_UX_V1_ENABLED) {
      return (
        <WelcomeStepV1
          onGetStarted={goToNext}
          onAlreadyHaveAccount={goToAuth}
        />
      );
    }
    return (
    <View style={styles.stepContent} testID="onboarding-welcome-screen">
      <View style={styles.heroArea}>
        <Text style={styles.brandMark}>K Scan</Text>
        <Text style={styles.sparkAccent}>✦</Text>
        <Text style={styles.heroHeadline}>Welcome to your AI style world</Text>
        <Text style={styles.heroBody}>
          Scan outfits, get AI styling inspiration, discover similar looks, and shop smarter.
        </Text>
      </View>

      <PrimaryButton
        testID="onboarding-get-started-button"
        title="Get Started"
        onPress={goToNext}
        style={styles.wideButton}
      />

      <Pressable
        testID="onboarding-login-link"
        onPress={goToAuth}
        accessibilityRole="button"
        accessibilityLabel="Already a member? Log in"
      >
        <Text style={styles.footerLink}>
          Already a member? <Text style={styles.footerLinkAction}>Log in</Text>
        </Text>
      </Pressable>
    </View>
  );
  };

  const renderAuthChoice = () => {
    if (ACCOUNT_HOME_UX_V1_ENABLED) {
      return (
        <AccountSetupStepV1
          onContinueEmail={goToNext}
          onContinueGoogle={handleGoogleSignIn}
          onContinueApple={handleAppleSignIn}
          onGoToLogin={goToAuth}
          appleAvailable={appleAuthAvailable}
          error={createError}
          googleBusy={googleBusy}
        />
      );
    }
    return (
    <View style={styles.stepContent} testID="onboarding-auth-choice-screen">
      <Text style={styles.stepTitle}>Account Access</Text>
      <Text style={styles.stepBody}>Choose how you want to continue.</Text>

      {createError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{createError}</Text>
        </View>
      ) : null}

      <PrimaryButton
        testID="onboarding-continue-email-button"
        title="Continue with Email"
        onPress={goToNext}
        style={styles.wideButton}
      />

      <SecondaryButton
        testID="onboarding-continue-google-button"
        title="Continue with Google"
        onPress={handleGoogleSignIn}
        loading={googleBusy}
        disabled={googleBusy}
        style={styles.wideButton}
      />

      {appleAuthAvailable && Platform.OS === 'ios' && (
        <SecondaryButton
          testID="onboarding-continue-apple-button"
          title="Continue with Apple"
          onPress={handleAppleSignIn}
          loading={appleBusy}
          disabled={appleBusy}
          style={styles.wideButton}
        />
      )}

      <Pressable
        testID="onboarding-auth-login-link"
        onPress={goToAuth}
        accessibilityRole="button"
        accessibilityLabel="Already a member? Log in"
      >
        <Text style={styles.footerLink}>
          Already a member? <Text style={styles.footerLinkAction}>Log in</Text>
        </Text>
      </Pressable>
    </View>
  );
  };

  const renderCreateAccount = () => {
    if (confirmationEmail) {
      return (
        <View style={styles.stepContent} testID="onboarding-confirm-email-screen">
          <Text style={styles.stepTitle}>Check Your Email</Text>
          <Text style={styles.stepBody}>
            We sent a confirmation link to{' '}
            <Text style={styles.emailHighlight}>{confirmationEmail}</Text>. Open it to verify
            your account, then return to sign in.
          </Text>

          <View style={styles.infoBanner}>
            <Text style={styles.infoText}>
              Once you verify your email and sign in, you'll continue right where you left
              off with Terms and Permissions.
            </Text>
          </View>

          <PrimaryButton
            testID="onboarding-confirm-email-login-button"
            title="Sign In"
            onPress={goToAuth}
            style={styles.wideButton}
          />

          <TertiaryButton
            testID="onboarding-confirm-email-edit-button"
            title="Use Another Email"
            onPress={() => {
              setConfirmationEmail(null);
              setCreateError(null);
            }}
            style={styles.wideButton}
          />
        </View>
      );
    }

    return (
    <View style={styles.stepContent} testID="onboarding-create-account-screen">
      <Text style={styles.stepTitle}>Create Account</Text>
      <Text style={styles.stepBody}>Join K Scan to save your style journey.</Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>FULL NAME</Text>
        <TextInput
          testID="onboarding-full-name-input"
          value={fullName}
          onChangeText={setFullName}
          placeholder="Your full name"
          placeholderTextColor={LUXURY.colors.stone}
          textContentType="name"
          autoCapitalize="words"
          autoCorrect={false}
          editable={!createBusy}
          style={styles.input}
        />
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>EMAIL</Text>
        <TextInput
          testID="onboarding-create-email-input"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={LUXURY.colors.stone}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="emailAddress"
          editable={!createBusy}
          style={styles.input}
        />
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>PASSWORD</Text>
        <TextInput
          testID="onboarding-create-password-input"
          value={password}
          onChangeText={setPassword}
          placeholder="Minimum 8 characters"
          placeholderTextColor={LUXURY.colors.stone}
          secureTextEntry={!passwordVisible}
          textContentType="newPassword"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!createBusy}
          style={styles.input}
        />
        <Pressable
          onPress={() => setPasswordVisible((v) => !v)}
          style={styles.eyeToggle}
        >
          <Text style={styles.eyeToggleText}>{passwordVisible ? 'Hide' : 'Show'}</Text>
        </Pressable>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>CONFIRM PASSWORD</Text>
        <TextInput
          testID="onboarding-create-confirm-password-input"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="Re-enter your password"
          placeholderTextColor={LUXURY.colors.stone}
          secureTextEntry={!confirmPasswordVisible}
          textContentType="newPassword"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!createBusy}
          style={styles.input}
        />
        <Pressable
          onPress={() => setConfirmPasswordVisible((v) => !v)}
          style={styles.eyeToggle}
        >
          <Text style={styles.eyeToggleText}>{confirmPasswordVisible ? 'Hide' : 'Show'}</Text>
        </Pressable>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>STYLE NICKNAME (OPTIONAL)</Text>
        <TextInput
          testID="onboarding-style-nickname-input"
          value={styleNickname}
          onChangeText={setStyleNickname}
          placeholder="e.g., VintageVibes"
          placeholderTextColor={LUXURY.colors.stone}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!createBusy}
          style={styles.input}
        />
      </View>

      <Pressable
        testID="onboarding-marketing-optin-checkbox"
        onPress={() => setMarketingOptIn((v) => !v)}
        style={styles.checkboxRow}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: marketingOptIn }}
      >
        <View style={[styles.checkbox, marketingOptIn && styles.checkboxChecked]}>
          {marketingOptIn && <Text style={styles.checkmark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>Send me occasional style updates and tips.</Text>
      </Pressable>

      {createError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{createError}</Text>
        </View>
      ) : null}

      <PrimaryButton
        testID="onboarding-create-account-submit-button"
        title="Create Account"
        onPress={handleCreateAccount}
        loading={createBusy}
        disabled={createBusy}
        style={styles.wideButton}
      />

      <Pressable
        testID="onboarding-create-login-link"
        onPress={goToAuth}
        accessibilityRole="button"
      >
        <Text style={styles.footerLink}>
          Already have an account? <Text style={styles.footerLinkAction}>Log in</Text>
        </Text>
      </Pressable>
    </View>
  );
  };

  const renderTerms = () => (
    <View style={styles.stepContent} testID="onboarding-terms-screen">
      <Text style={styles.stepTitle}>Before we begin</Text>
      <Text style={styles.stepBody}>A quick note on privacy and permissions.</Text>

      <View style={styles.trustCard}>
        {[
          'Privacy-first AI styling',
          'Secure account management',
          'Delete your account anytime',
          'Transparent permissions',
        ].map((item, i) => (
          <View key={i} style={styles.trustRow}>
            <Text style={styles.trustBullet}>✦</Text>
            <Text style={styles.trustItem}>{item}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.privacyNote}>
        K Scan is not designed for facial recognition or identifying people. Raw scans and
        uploaded images are not sold to third-party data buyers. Camera access is used when you
        choose to scan. You can manage permissions in device settings.
      </Text>

      <View style={styles.legalLinks}>
        <Pressable
          onPress={() => void Linking.openURL('https://kscan.app/legal/terms')}
          accessibilityRole="link"
          accessibilityLabel="Open Terms of Service"
        >
          <Text style={styles.legalLinkText}>Terms of Service</Text>
        </Pressable>
        <Text style={styles.legalLinkSep}>·</Text>
        <Pressable
          onPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
          accessibilityRole="link"
          accessibilityLabel="Open Privacy Policy"
        >
          <Text style={styles.legalLinkText}>Privacy Policy</Text>
        </Pressable>
      </View>

      <Pressable
        testID="onboarding-terms-checkbox"
        onPress={() => setTermsChecked((v) => !v)}
        style={styles.checkboxRow}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: termsChecked }}
      >
        <View style={[styles.checkbox, termsChecked && styles.checkboxChecked]}>
          {termsChecked && <Text style={styles.checkmark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>I agree to the Terms of Service</Text>
      </Pressable>

      <Pressable
        testID="onboarding-privacy-checkbox"
        onPress={() => setPrivacyChecked((v) => !v)}
        style={styles.checkboxRow}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: privacyChecked }}
      >
        <View style={[styles.checkbox, privacyChecked && styles.checkboxChecked]}>
          {privacyChecked && <Text style={styles.checkmark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>I acknowledge the Privacy Policy</Text>
      </Pressable>

      <Pressable
        testID="onboarding-age-checkbox"
        onPress={() => setAgeChecked((v) => !v)}
        style={styles.checkboxRow}
        accessibilityRole="checkbox"
        accessibilityLabel="Age confirmation checkbox"
        accessibilityState={{ checked: ageChecked }}
      >
        <View style={[styles.checkbox, ageChecked && styles.checkboxChecked]}>
          {ageChecked && <Text style={styles.checkmark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>I confirm that I am 18 years of age or older.</Text>
      </Pressable>

      <Text style={styles.ageFooter}>
        By continuing, you acknowledge that K Scan AI is intended for users 18 years of age or older.
      </Text>

      {legalError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{legalError}</Text>
        </View>
      ) : null}

      <PrimaryButton
        testID="onboarding-accept-continue-button"
        title="Accept & Continue"
        onPress={handleAcceptAndContinue}
        loading={legalBusy}
        disabled={!termsChecked || !privacyChecked || !ageChecked || legalBusy}
        style={styles.wideButton}
      />
    </View>
  );

  const renderPermissions = () => {
    if (ACCOUNT_HOME_UX_V1_ENABLED) {
      const handlePermissionsContinue = async () => {
        await savePreferences();
        await goToHome();
      };
      return (
        <PermissionsStepV1
          preferences={permissionPrefs}
          togglePreference={togglePermission}
          setPreference={setPermissionPreference}
          isSaving={permissionSaving}
          onContinueToHome={handlePermissionsContinue}
          onNotNow={goToHome}
        />
      );
    }
    return (
    <View style={styles.stepContent} testID="onboarding-permissions-screen">
      <Text style={styles.stepTitle}>Permissions</Text>
      <Text style={styles.stepBody}>
        You can change these anytime in device settings. VoiceScan is coming soon and is not active in this release.
      </Text>

      {/* Camera */}
      <View style={styles.permissionRow}>
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionLabel}>Camera</Text>
          <Text style={styles.permissionStatus}>Requested when you enter Scan.</Text>
        </View>
        <Switch
          testID="onboarding-camera-toggle"
          value={permissionPrefs.camera}
          onValueChange={() => togglePermission('camera')}
          trackColor={{ false: LUXURY.colors.border, true: LUXURY.colors.plumMuted }}
          thumbColor={permissionPrefs.camera ? LUXURY.colors.plum : '#f4f3f4'}
        />
      </View>

      {/* Photos */}
      <View style={styles.permissionRow}>
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionLabel}>Photos</Text>
          <Text style={styles.permissionStatus}>Requested when you choose Upload Image.</Text>
        </View>
        <Switch
          testID="onboarding-photos-toggle"
          value={permissionPrefs.photos}
          onValueChange={() => togglePermission('photos')}
          trackColor={{ false: LUXURY.colors.border, true: LUXURY.colors.plumMuted }}
          thumbColor={permissionPrefs.photos ? LUXURY.colors.plum : '#f4f3f4'}
        />
      </View>

      {/* Microphone — VoiceScan is planned but inactive for this launch. */}
      <View
        style={[styles.permissionRow, microphoneDisabled && styles.permissionRowDisabled]}
        accessibilityLabel="Microphone permission, coming soon, disabled"
        accessibilityState={{ disabled: microphoneDisabled }}
      >
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionLabel}>Microphone</Text>
          <Text style={styles.permissionStatus}>Coming Soon</Text>
          <Text style={styles.permissionSubtext}>VoiceScan is coming soon and is not active in this build.</Text>
        </View>
        <Switch
          testID="onboarding-microphone-toggle"
          value={false}
          onValueChange={() => {}}
          disabled={microphoneDisabled}
          trackColor={{ false: LUXURY.colors.border, true: LUXURY.colors.plumMuted }}
          thumbColor="#f4f3f4"
          accessibilityLabel="Toggle Microphone"
          accessibilityState={{ disabled: microphoneDisabled, checked: false }}
        />
      </View>

      {/* Notifications */}
      <View
        style={[styles.permissionRow, styles.permissionRowDisabled]}
        accessibilityLabel="Notifications permission, coming soon, disabled"
        accessibilityState={{ disabled: true }}
      >
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionLabel}>Notifications</Text>
          <Text style={styles.permissionStatus}>Coming Soon</Text>
          <Text style={styles.permissionSubtext}>Notifications are coming soon and are not active in this build.</Text>
        </View>
        <Switch
          testID="onboarding-notifications-toggle"
          value={false}
          onValueChange={() => {}}
          disabled={true}
          trackColor={{ false: LUXURY.colors.border, true: LUXURY.colors.plumMuted }}
          thumbColor="#f4f3f4"
          accessibilityLabel="Toggle Notifications"
          accessibilityState={{ disabled: true, checked: false }}
        />
      </View>

      <PrimaryButton
        testID="onboarding-permissions-continue-button"
        title="Continue to Home"
        onPress={goToHome}
        style={styles.wideButton}
      />

      <TertiaryButton
        testID="onboarding-permissions-not-now-button"
        title="Not Now"
        onPress={goToHome}
        style={styles.wideButton}
      />
    </View>
  );
  };

  const renderHomeHandoff = () => (
    <View style={styles.stepContent} testID="onboarding-home-handoff">
      <ActivityIndicator size="large" color={LUXURY.colors.plum} />
      <Text style={styles.stepTitle}>Entering K Scan...</Text>
    </View>
  );

  // ── Main render ───────────────────────────────────────────────────────────

  const renderStep = () => {
    switch (step) {
      case 1:
        return renderWelcome();
      case 2:
        return renderAuthChoice();
      case 3:
        return renderCreateAccount();
      case 4:
        return renderTerms();
      case 5:
        return renderPermissions();
      case 6:
        return renderHomeHandoff();
      default:
        return renderWelcome();
    }
  };

  return (
    <OnboardingShell step={step} testID="onboarding-shell">
      <StatusBar style="dark" />
      {renderStep()}
    </OnboardingShell>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  stepContent: {
    flex: 1,
    gap: SPACING.lg,
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.xl,
  },
  heroArea: {
    alignItems: 'center',
    gap: SPACING.md,
    marginBottom: SPACING.xl,
  },
  brandMark: {
    ...LUXURY.typography.brandMark,
    fontSize: 28,
    color: LUXURY.colors.ink,
  },
  sparkAccent: {
    fontSize: 32,
    color: LUXURY.colors.gold,
    marginTop: SPACING.xs,
  },
  heroHeadline: {
    ...LUXURY.typography.displayHeadline,
    textAlign: 'center',
    color: LUXURY.colors.ink,
    marginTop: SPACING.sm,
  },
  heroBody: {
    ...LUXURY.typography.body,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
    paddingHorizontal: SPACING.lg,
  },
  stepTitle: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
    textAlign: 'center',
    marginBottom: SPACING.xs,
  },
  stepBody: {
    ...LUXURY.typography.body,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.md,
  },
  wideButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
  },
  footerLink: {
    ...LUXURY.typography.body,
    fontSize: 14,
    textAlign: 'center',
  },
  footerLinkAction: {
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  // Form fields
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
    backgroundColor: LUXURY.inputs.field.backgroundColor,
    fontSize: LUXURY.inputs.field.fontSize,
    fontWeight: LUXURY.inputs.field.fontWeight,
  },
  eyeToggle: {
    alignSelf: 'flex-end',
    paddingVertical: SPACING.xs,
  },
  eyeToggleText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    textDecorationLine: 'underline',
  },
  // Checkbox
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.pearl,
  },
  checkboxChecked: {
    backgroundColor: LUXURY.colors.plum,
    borderColor: LUXURY.colors.plum,
  },
  checkmark: {
    color: LUXURY.colors.inverse,
    fontSize: 14,
    fontWeight: '700',
  },
  checkboxLabel: {
    ...LUXURY.typography.body,
    fontSize: 14,
    flex: 1,
  },
  // Error
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
  infoBanner: {
    borderWidth: 1,
    borderColor: 'rgba(46, 109, 130, 0.24)',
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(46, 109, 130, 0.08)',
    padding: SPACING.md,
  },
  infoText: {
    ...LUXURY.typography.body,
    fontSize: 14,
    color: LUXURY.colors.graphite,
  },
  emailHighlight: {
    color: LUXURY.colors.ink,
    fontWeight: '700',
  },
  // Terms
  trustCard: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  trustBullet: {
    fontSize: 14,
    color: LUXURY.colors.gold,
  },
  trustItem: {
    ...LUXURY.typography.body,
    fontSize: 14,
    color: LUXURY.colors.ink,
  },
  privacyNote: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    lineHeight: 18,
    color: LUXURY.colors.graphite,
    paddingHorizontal: SPACING.sm,
  },
  ageFooter: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    lineHeight: 18,
    color: LUXURY.colors.stone,
    paddingHorizontal: SPACING.sm,
    marginTop: -SPACING.sm,
  },
  legalLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  legalLinkText: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    textDecorationLine: 'underline',
    color: LUXURY.colors.plum,
    minHeight: 44,
    textAlignVertical: 'center',
  },
  legalLinkSep: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  // Permissions
  permissionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.border,
  },
  permissionInfo: {
    flex: 1,
    marginRight: SPACING.md,
  },
  permissionLabel: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 16,
    color: LUXURY.colors.ink,
  },
  permissionStatus: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    marginTop: SPACING.xs,
    color: LUXURY.colors.graphite,
  },
  permissionRowDisabled: {
    opacity: 0.5,
  },
  permissionSubtext: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    lineHeight: 18,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
  },
});
