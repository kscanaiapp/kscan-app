import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';

import { PrivacyToggle } from '../components/PrivacyToggle';
import { canToggleSaleSharing } from '../services/privacyPolicy';
import {
  requestCorrection,
  requestDataExport,
} from '../services/supabasePrivacy';
import { usePrivacyPreferences } from '../contexts/PrivacyPreferencesContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../constants/theme';
import { LuxuryScreen, KScanHeader, PrimaryButton, SecondaryButton, TertiaryButton } from '../components/luxury';
import { submitAccountDeletionRequest } from '../services/accountDeletion';
import { supabase } from '../services/supabaseClient';
import { LOCAL_PRIVACY_STORAGE_KEY } from '../services/privacyLocalStore';
import { hasPendingDeletionProfile } from '../services/routingGuard';

const PRIVACY_COPY = {
  saleRemote:
    'When enabled, K Scan treats your account as opted out of data sale or sharing under applicable privacy laws.',
  saleLocal:
    'This preference is saved on this device only. Sign in to save it to your account across devices.',
  sensitiveRemote:
    'Limit sensitive processing where applicable. Security and reliability events may still be processed where permitted.',
  sensitiveLocal:
    'Saved on this device until your account is connected. Security and reliability checks may still run where permitted.',
  aggregate:
    'Aggregated or deidentified trend reports are managed separately from transfers of user-linked personal information.',
  scans:
    'Your saved scan information follows K Scan privacy settings. Account-linked scan details may be included when you request an export.',
  minor:
    'Sale or sharing of personal information is disabled for users under 16 unless legally valid authorization is obtained.',
  trust:
    'Private by design. Your data stays under your control. Raw scans and uploaded images are not sold to third-party data buyers.',
  noFaces:
    'K Scan is not designed for facial recognition or identifying people.',
};

const SYNC_STATUS_LABELS: Record<string, string> = {
  synced: 'Saved to Account',
  syncing: 'Syncing',
  'local-only': 'Saved to Device',
  error: 'Could Not Sync',
};

const SYNC_STATUS_COLORS: Record<string, string> = {
  synced: LUXURY.colors.success,
  syncing: LUXURY.colors.goldBrushed,
  'local-only': LUXURY.colors.stone,
  error: LUXURY.colors.error,
};

export default function PrivacyScreen() {
  const router = useRouter();
  const { isAuthenticated, session, user, signOut, isRefreshing } = useAuthSession();
  const {
    mode,
    syncStatus,
    bootStatus,
    supabaseProjectPresent,
    remoteFetchFailed,
    remoteFetchError,
    preferenceSource,
    normalized,
    profile,
    saving,
    persistPreference,
  } = usePrivacyPreferences();

  const [message, setMessage] = useState<string | null>(null);
  const [correctionText, setCorrectionText] = useState('');
  const [deletionSubmitting, setDeletionSubmitting] = useState(false);
  const [deletionPending, setDeletionPending] = useState(false);
  const [deletionConfirmVisible, setDeletionConfirmVisible] = useState(false);

  const saleSharingLocked = !canToggleSaleSharing(normalized.age_group);
  const accountDeletionPending = hasPendingDeletionProfile(profile);

  const remoteActionsEnabled =
    isAuthenticated && preferenceSource === 'remote' && !remoteFetchFailed;

  const showSignInCta = supabaseProjectPresent && !isAuthenticated && mode !== 'booting';

  const saleBody = preferenceSource === 'remote' ? PRIVACY_COPY.saleRemote : PRIVACY_COPY.saleLocal;
  const sensitiveBody =
    preferenceSource === 'remote' ? PRIVACY_COPY.sensitiveRemote : PRIVACY_COPY.sensitiveLocal;

  // Block writes while session is booting, mid-refresh, or a write is in flight
  const writesBlocked = mode === 'booting' || saving || isRefreshing;

  const loadFailureBanner = useMemo(() => {
    if (!remoteFetchFailed) return null;
    return (
      <View style={styles.errorBanner} accessibilityRole="alert">
        <Text style={styles.errorBannerTitle}>Unable to load your privacy preference right now.</Text>
        <Text style={styles.errorBannerBody}>
          {remoteFetchError || 'Check your connection and try again.'} Showing the last-known preference saved on this device until account sync succeeds.
        </Text>
      </View>
    );
  }, [remoteFetchFailed, remoteFetchError]);

  const syncChip = useMemo(() => {
    if (mode === 'booting') return null;
    const label = SYNC_STATUS_LABELS[syncStatus] ?? syncStatus;
    const color = SYNC_STATUS_COLORS[syncStatus] ?? LUXURY.colors.stone;
    return (
      <View style={[styles.syncChip, { borderColor: `${color}55` }]}>
        {syncStatus === 'syncing' ? (
          <ActivityIndicator size="small" color={color} style={styles.syncSpinner} />
        ) : null}
        <Text style={[styles.syncChipText, { color }]}>{label}</Text>
      </View>
    );
  }, [mode, syncStatus]);

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Your privacy preferences will continue to be stored on this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          try {
            await signOut();
            setMessage('Signed out. Preferences are now saved on this device only.');
          } catch {
            setMessage('Sign-out failed. Try again.');
          }
        },
      },
    ]);
  };

  const handleDeletion = () => {
    if (deletionPending || accountDeletionPending) {
      setMessage('Deletion request already pending. You have been signed out.');
      return;
    }
    setDeletionConfirmVisible(true);
  };

  const confirmDeletion = async () => {
    setDeletionConfirmVisible(false);
    setDeletionSubmitting(true);
    try {
      const result = await submitAccountDeletionRequest(supabase, session);
      setDeletionPending(true);
      const confirmationMessage =
        result.status === 'already_requested'
          ? 'Request already pending. You have been signed out.'
          : 'Deletion request submitted. You have been signed out.';
      setMessage(confirmationMessage);

      Alert.alert(
        'Account deletion request',
        confirmationMessage,
        [
          {
            text: 'OK',
            onPress: async () => {
              try {
                await AsyncStorage.removeItem(LOCAL_PRIVACY_STORAGE_KEY);
                await signOut();
              } catch {
                await AsyncStorage.removeItem(LOCAL_PRIVACY_STORAGE_KEY).catch(() => undefined);
              } finally {
                setDeletionSubmitting(false);
                router.replace('/auth');
              }
            },
          },
        ],
        { cancelable: false },
      );
    } catch (error) {
      console.error('Account deletion request failed', error);
      setMessage("We couldn't submit your request right now. Please try again later.");
      setDeletionSubmitting(false);
    }
  };

  const handleExport = async () => {
    try {
      await requestDataExport();
      setMessage('This request has been submitted to K Scan for review.');
    } catch (error) {
      console.error('Data export request failed', error);
      setMessage("We couldn't submit your request right now. Please try again later.");
    }
  };

  const handleCorrection = async () => {
    if (!correctionText.trim()) {
      setMessage('Describe the account information you want corrected.');
      return;
    }
    try {
      await requestCorrection({ user_description: correctionText.trim() });
      setCorrectionText('');
      setMessage('This request has been submitted to K Scan for review.');
    } catch (error) {
      console.error('Correction request failed', error);
      setMessage("We couldn't submit your request right now. Please try again later.");
    }
  };

  const loading = bootStatus === 'loading';

  return (
    <LuxuryScreen
      scrollable
      safeArea
      backgroundColor={LUXURY.colors.ivory}
      accessibilityLabel="Privacy and data controls"
    >
      <StatusBar style="dark" />
      <KScanHeader
        title="Privacy"
        subtitle="YOUR DATA CONTROLS"
        onBack={() => router.back()}
        backLabel="Back"
      />

      <Modal
        transparent
        visible={deletionConfirmVisible}
        animationType="fade"
        onRequestClose={() => setDeletionConfirmVisible(false)}
      >
        <View style={styles.modalScrim}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Request account deletion?</Text>
            <Text style={styles.modalBody}>
              Your deletion request will be reviewed and processed through our account lifecycle workflow, generally within 30 days, subject to legal, security, and operational requirements.
            </Text>
            <View style={styles.modalActions}>
              <SecondaryButton
                title="Cancel"
                onPress={() => setDeletionConfirmVisible(false)}
                disabled={deletionSubmitting}
                style={styles.modalButton}
                accessibilityLabel="Cancel account deletion"
              />
              <TertiaryButton
                title="Delete"
                onPress={confirmDeletion}
                disabled={deletionSubmitting}
                style={styles.modalButton}
                textStyle={{ color: LUXURY.colors.error }}
                accessibilityLabel="Confirm account deletion"
                accessibilityHint="Permanently request account deletion"
              />
            </View>
          </View>
        </View>
      </Modal>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>TRUST CENTER</Text>
          <View style={styles.heroRow}>
            <Text style={styles.title}>Your Privacy Choices</Text>
            {syncChip}
          </View>
          <Text style={styles.body}>
            Review sale and sharing opt-outs, sensitive processing limits, and account requests.
          </Text>
        </View>

        {loading ? (
          <View style={styles.loadingPanel}>
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
            <Text style={styles.loadingCaption}>Loading your preferences…</Text>
          </View>
        ) : (
          <>
            {message ? (
              <View style={styles.messageCard} accessibilityRole="alert">
                <Text style={styles.messageText}>{message}</Text>
              </View>
            ) : null}
            {loadFailureBanner}

            {accountDeletionPending ? (
              <View testID="privacy-pending-deletion-banner" style={styles.pendingDeletionBanner} accessibilityRole="alert">
                <Text style={styles.pendingDeletionTitle}>Account Deletion Pending</Text>
                <Text style={styles.pendingDeletionBody}>
                  Your account deletion request is pending processing. For privacy and safety, app access is limited while the request is processed. You can sign out at any time.
                </Text>
              </View>
            ) : null}

            {showSignInCta ? (
              <Pressable
                testID="privacy-auth-cta"
                style={({ pressed }) => [styles.signInNotice, pressed && styles.signInNoticePressed]}
                onPress={() => router.push('/auth')}
                accessibilityRole="button"
                accessibilityLabel="Sign in or create account"
                accessibilityHint="Save privacy preferences across devices"
              >
                <View style={styles.signInNoticeText}>
                  <Text style={styles.noticeTitle}>Sign In or Create Account</Text>
                  <Text style={styles.noticeBody}>
                    Sign in or create an account to save privacy preferences across devices. Until then, this setting is preserved only on this device.
                  </Text>
                </View>
                <Text style={styles.signInArrow}>›</Text>
              </Pressable>
            ) : null}

            {isAuthenticated && user ? (
              <View style={styles.accountRow}>
                <Text style={styles.accountEmail} numberOfLines={1}>{user.email}</Text>
                <SecondaryButton
                  title="Sign Out"
                  onPress={handleSignOut}
                  style={styles.signOutButton}
                  accessibilityLabel="Sign out"
                  accessibilityHint="Keep preferences on this device only"
                />
              </View>
            ) : null}

            {saleSharingLocked ? (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>Under-16 Protection Active</Text>
                <Text style={styles.noticeBody}>{PRIVACY_COPY.minor}</Text>
              </View>
            ) : null}

            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Privacy & Data Choices</Text>
              <Text style={styles.sectionSubtitle}>
                {preferenceSource === 'remote'
                  ? 'These choices are linked to your K Scan account.'
                  : 'On-device preferences — sign in to sync to your account.'}
              </Text>

              <PrivacyToggle
                title="Do Not Sell or Share My Personal Information"
                body={saleBody}
                value={normalized.opt_out_of_sale}
                busy={saving}
                disabled={writesBlocked || saleSharingLocked}
                onChange={(value) => {
                  setMessage(null);
                  void persistPreference({ opt_out_of_sale: value }).catch((error) => {
                    console.error('Privacy preference update failed', error);
                    setMessage("We couldn't save that preference. Please try again.");
                  });
                }}
              />

              <PrivacyToggle
                title="Limit Sensitive Processing"
                body={sensitiveBody}
                value={normalized.limit_sensitive_processing}
                busy={saving}
                disabled={writesBlocked}
                onChange={(value) => {
                  setMessage(null);
                  void persistPreference({ limit_sensitive_processing: value }).catch((error) => {
                    console.error('Privacy preference update failed', error);
                    setMessage("We couldn't save that preference. Please try again.");
                  });
                }}
              />
            </View>

            <View style={styles.infoPanel}>
              <Text style={styles.panelTitle}>How K Scan Handles Your Data</Text>
              <Text style={styles.panelBody}>{PRIVACY_COPY.trust}</Text>
              <Text style={styles.panelBody}>{PRIVACY_COPY.scans}</Text>
              <Text style={styles.panelBody}>{PRIVACY_COPY.noFaces}</Text>
              <Text style={styles.panelBody}>{PRIVACY_COPY.aggregate}</Text>
            </View>

            <View style={styles.actions}>
              {!remoteActionsEnabled ? (
                <Text style={styles.edgeHint}>
                  Data export, correction, and deletion requests require a connected account. Sign in to enable these actions.
                </Text>
              ) : null}

              <SecondaryButton
                title="Request Data Export"
                onPress={handleExport}
                disabled={!remoteActionsEnabled || saving}
                accessibilityLabel="Request data export"
                accessibilityHint="Submit a request to export your account data"
              />

              <View style={styles.correctionBox}>
                <TextInput
                  value={correctionText}
                  onChangeText={setCorrectionText}
                  placeholder="Describe a correction request"
                  placeholderTextColor={LUXURY.colors.stone}
                  multiline
                  style={styles.input}
                  accessibilityLabel="Correction request description"
                  accessibilityHint="Describe the account information you want corrected"
                />
                <SecondaryButton
                  title="Submit Correction Request"
                  onPress={handleCorrection}
                  disabled={!remoteActionsEnabled || saving}
                  accessibilityLabel="Submit correction request"
                  accessibilityHint="Send your data correction request"
                />
              </View>

              <TertiaryButton
                title={deletionPending || accountDeletionPending ? 'Deletion Request Pending' : 'Delete Account'}
                onPress={handleDeletion}
                disabled={!isAuthenticated || saving || deletionSubmitting || deletionPending || accountDeletionPending}
                textStyle={{ color: LUXURY.colors.error }}
                accessibilityLabel="Request account deletion"
                accessibilityHint="Start the account deletion request flow"
              />

              <View style={styles.legalFooter}>
                <Pressable
                  onPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
                  accessibilityRole="link"
                  accessibilityLabel="Open Privacy Policy"
                >
                  <Text style={styles.legalFooterLink}>Privacy Policy</Text>
                </Pressable>
                <Text style={styles.legalFooterSep}>·</Text>
                <Pressable
                  onPress={() => void Linking.openURL('https://kscan.app/legal/terms')}
                  accessibilityRole="link"
                  accessibilityLabel="Open Terms of Service"
                >
                  <Text style={styles.legalFooterLink}>Terms</Text>
                </Pressable>
                <Text style={styles.legalFooterSep}>·</Text>
                <Pressable
                  onPress={() => void Linking.openURL('https://kscan.app/support')}
                  accessibilityRole="link"
                  accessibilityLabel="Open Support"
                >
                  <Text style={styles.legalFooterLink}>Support</Text>
                </Pressable>
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACING.xl,
    gap: SPACING.lg,
    paddingBottom: 56,
  },
  hero: {
    gap: SPACING.sm,
    paddingBottom: SPACING.sm,
  },
  eyebrow: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.goldBrushed,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    flexWrap: 'wrap',
  },
  title: {
    ...LUXURY.typography.displayHeadline,
    flex: 1,
    color: LUXURY.colors.ink,
  },
  syncChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    backgroundColor: LUXURY.colors.pearl,
  },
  syncSpinner: {
    width: 12,
    height: 12,
  },
  syncChipText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  body: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
  },
  loadingPanel: {
    minHeight: 240,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
  },
  loadingCaption: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  messageCard: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.lg,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  messageText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  errorBanner: {
    borderWidth: 1,
    borderColor: 'rgba(130, 48, 56, 0.28)',
    borderRadius: RADIUS.lg,
    backgroundColor: 'rgba(130, 48, 56, 0.07)',
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  errorBannerTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
  },
  errorBannerBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    fontSize: 13,
    lineHeight: 20,
  },
  pendingDeletionBanner: {
    borderWidth: 1,
    borderColor: 'rgba(130, 48, 56, 0.28)',
    borderRadius: RADIUS.lg,
    backgroundColor: 'rgba(130, 48, 56, 0.07)',
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  pendingDeletionTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
  },
  pendingDeletionBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    fontSize: 13,
    lineHeight: 20,
  },
  signInNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.lg,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  signInNoticePressed: {
    backgroundColor: LUXURY.colors.cream,
    borderColor: LUXURY.colors.goldLight,
  },
  signInNoticeText: {
    flex: 1,
    gap: SPACING.sm,
  },
  signInArrow: {
    color: LUXURY.colors.goldBrushed,
    fontSize: 22,
    fontWeight: '300',
  },
  notice: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.lg,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  noticeTitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
  },
  noticeBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.ink,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
  },
  accountEmail: {
    ...LUXURY.typography.body,
    fontSize: 13,
    color: LUXURY.colors.graphite,
    flex: 1,
    marginRight: SPACING.md,
  },
  signOutButton: {
    alignSelf: 'flex-start',
    minWidth: 120,
  },
  sectionCard: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.xl,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.md,
    ...SHADOWS.editorialRaised,
  },
  sectionTitle: {
    ...LUXURY.typography.displayTitle,
    fontSize: 20,
    color: LUXURY.colors.ink,
  },
  sectionSubtitle: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.xs,
  },
  infoPanel: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.xl,
    padding: SPACING.xl,
    backgroundColor: LUXURY.colors.cream,
    gap: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  panelTitle: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.goldBrushed,
  },
  panelBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    fontSize: 14,
    lineHeight: 22,
  },
  actions: {
    gap: SPACING.md,
  },
  edgeHint: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.stone,
    marginBottom: SPACING.sm,
  },
  correctionBox: {
    gap: SPACING.sm,
  },
  input: {
    minHeight: 96,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    color: LUXURY.colors.ink,
    backgroundColor: LUXURY.colors.pearl,
    textAlignVertical: 'top',
    fontSize: 15,
    lineHeight: 22,
  },
  legalFooter: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  legalFooterLink: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.plum,
    textDecorationLine: 'underline',
  },
  legalFooterSep: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
  },
  modalScrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
    backgroundColor: LUXURY.colors.plumDeep + 'C2',
  },
  modalCard: {
    width: '100%',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.xl,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.lg,
    ...SHADOWS.editorialRaised,
  },
  modalTitle: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
  },
  modalBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    fontSize: 14,
    lineHeight: 22,
  },
  modalActions: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  modalButton: {
    flex: 1,
  },
});
