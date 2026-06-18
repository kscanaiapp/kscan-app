import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  Switch,
  BackHandler,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';

import { useAuthSession } from '../../contexts/AuthSessionContext';
import {
  LuxuryScreen,
  KScanHeader,
  PrimaryButton,
  SecondaryButton,
  TertiaryButton,
} from '../../components/luxury';
import { OnboardingShell } from '../../components/onboarding';
import { LUXURY, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { validateAuthInput, mapAuthError } from '../../services/authValidation';
import { recordLegalAcceptances } from '../../services/legalAcceptance';

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
  const { loading: authLoading, isAuthenticated, signUp, signIn } = useAuthSession();

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

  // Step 4: Terms
  const [termsChecked, setTermsChecked] = useState(false);
  const [privacyChecked, setPrivacyChecked] = useState(false);
  const [ageChecked, setAgeChecked] = useState(false);
  const [legalBusy, setLegalBusy] = useState(false);
  const [legalError, setLegalError] = useState<string | null>(null);
  // Local placeholders for future backend fields (do not persist)
  const [acceptedTermsAt] = useState<string | null>(null);
  const [acceptedPrivacyAt] = useState<string | null>(null);
  const [acceptedAgeAt] = useState<string | null>(null);
  const [termsVersion] = useState<string | null>(null);
  const [privacyVersion] = useState<string | null>(null);
  const [ageVersion] = useState<string | null>(null);

  // Step 5: Permissions (visual toggles only)
  const [cameraPref, setCameraPref] = useState(false);
  const [photosPref, setPhotosPref] = useState(false);
  const [notificationsPref, setNotificationsPref] = useState(false);

  // Auth state: if user becomes authenticated externally, skip to Home
  useEffect(() => {
    if (isAuthenticated && step < 6) {
      router.replace('/');
    }
  }, [isAuthenticated, step, router]);

  // Android hardware back handler
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
    setStep((prev) => Math.min(6, prev + 1) as OnboardingStep);
  }, []);

  const goToPrev = useCallback(() => {
    setStep((prev) => Math.max(1, prev - 1) as OnboardingStep);
  }, []);

  const goToHome = useCallback(() => {
    router.replace('/');
  }, [router]);

  const goToAuth = useCallback(() => {
    router.push('/auth');
  }, [router]);

  // ── Step 3: Create Account handler ───────────────────────────────────────

  const handleCreateAccount = useCallback(async () => {
    const validation = validateAuthInput('create-account', email, password, undefined);
    if (!validation.valid) {
      setCreateError(validation.error);
      return;
    }
    setCreateError(null);
    setCreateBusy(true);
    try {
      const result = await signUp(email.trim(), password);
      if (result.confirmationRequired) {
        // Email confirmation required — treat as account created enough to proceed
        // In a real app, the user would need to confirm email before full use.
        // For this framework, proceed to Terms.
        goToNext(); // to step 4
      } else {
        // Session created immediately — proceed to Terms
        goToNext();
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Something went wrong. Try again.';
      setCreateError(mapAuthError(raw, 'create-account'));
    } finally {
      setCreateBusy(false);
    }
  }, [email, password, signUp, goToNext]);

  // ── Step 4: Accept & Continue handler ───────────────────────────────────

  const handleAcceptAndContinue = useCallback(async () => {
    setLegalError(null);
    setLegalBusy(true);
    try {
      const result = await recordLegalAcceptances({
        termsVersion: termsVersion ?? '1.0',
        privacyVersion: privacyVersion ?? '1.0',
        minimumAgeVersion: ageVersion ?? '1.0',
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
  }, [goToNext, termsVersion, privacyVersion, ageVersion]);

  // ── Render helpers ───────────────────────────────────────────────────────

  const renderWelcome = () => (
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

  const renderAuthChoice = () => (
    <View style={styles.stepContent} testID="onboarding-auth-choice-screen">
      <Text style={styles.stepTitle}>Account Access</Text>
      <Text style={styles.stepBody}>Choose how you want to continue.</Text>

      <PrimaryButton
        testID="onboarding-continue-email-button"
        title="Continue with Email"
        onPress={goToNext}
        style={styles.wideButton}
      />

      <SecondaryButton
        testID="onboarding-continue-google-button"
        title="Continue with Google"
        onPress={() => {
          // Redirect to existing auth screen for Google OAuth
          goToAuth();
        }}
        style={styles.wideButton}
      />

      {Platform.OS === 'ios' && (
        <SecondaryButton
          testID="onboarding-continue-apple-button"
          title="Continue with Apple"
          onPress={() => {
            // Redirect to existing auth screen for Apple OAuth
            goToAuth();
          }}
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

  const renderCreateAccount = () => (
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

  const renderPermissions = () => (
    <View style={styles.stepContent} testID="onboarding-permissions-screen">
      <Text style={styles.stepTitle}>Permissions</Text>
      <Text style={styles.stepBody}>
        You can change these anytime in device settings. No permissions are requested now.
      </Text>

      {/* Camera */}
      <View style={styles.permissionRow}>
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionLabel}>Camera</Text>
          <Text style={styles.permissionStatus}>Requested when you enter Scan.</Text>
        </View>
        <Switch
          testID="onboarding-camera-toggle"
          value={cameraPref}
          onValueChange={setCameraPref}
          trackColor={{ false: LUXURY.colors.border, true: LUXURY.colors.plumMuted }}
          thumbColor={cameraPref ? LUXURY.colors.plum : '#f4f3f4'}
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
          value={photosPref}
          onValueChange={setPhotosPref}
          trackColor={{ false: LUXURY.colors.border, true: LUXURY.colors.plumMuted }}
          thumbColor={photosPref ? LUXURY.colors.plum : '#f4f3f4'}
        />
      </View>

      {/* Notifications */}
      <View style={styles.permissionRow}>
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionLabel}>Notifications</Text>
          <Text style={styles.permissionStatus}>Optional alerts can be enabled later.</Text>
        </View>
        <Switch
          testID="onboarding-notifications-toggle"
          value={notificationsPref}
          onValueChange={setNotificationsPref}
          trackColor={{ false: LUXURY.colors.border, true: LUXURY.colors.plumMuted }}
          thumbColor={notificationsPref ? LUXURY.colors.plum : '#f4f3f4'}
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
});
