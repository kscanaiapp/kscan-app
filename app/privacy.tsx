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
import { goBackOrHome } from '../services/navigationExit';

import { PrivacyToggle } from '../components/PrivacyToggle';
import { canToggleSaleSharing } from '../services/privacyPolicy';
import {
  requestCorrection,
  requestDataExport,
} from '../services/supabasePrivacy';
import { usePrivacyPreferences } from '../contexts/PrivacyPreferencesContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../constants/theme';
import { MODAL_MAX_WIDTH } from '../services/responsiveLayout';
import {
  LuxuryScreen,
  KScanHeader,
  PrimaryButton,
  SecondaryButton,
  TertiaryButton,
  SectionHeader,
  StatusPill,
  InlineNotice,
} from '../components/luxury';
import {
  createDeletionGraceMarker,
  persistDeletionGraceMarker,
  submitAccountDeletionRequest,
} from '../services/accountDeletion';
import { supabase } from '../services/supabaseClient';
import { LOCAL_PRIVACY_STORAGE_KEY } from '../services/privacyLocalStore';
import { hasPendingDeletionProfile } from '../services/routingGuard';
import { SignatureStyleSettingsSection } from '../components/style-chat/SignatureStyleSettingsSection';

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
  trust: [
    'Private by design.',
    'Your data stays under your control.',
    'Raw scans and uploaded images are not sold to third-party data buyers.',
    'K Scan is not designed for facial recognition or identifying people.',
  ],
  deletion:
    'You can request account deletion from this screen. Your request will be reviewed and processed through our account lifecycle workflow, generally within 30 days, subject to legal, security, and operational requirements.',
};

const SYNC_STATUS_LABELS: Record<string, string> = {
  synced: 'Saved to Account',
  syncing: 'Syncing',
  'local-only': 'Saved to Device',
  error: 'Could Not Sync',
};

const SYNC_STATUS_VARIANTS: Record<string, StatusPillVariant> = {
  synced: 'success',
  syncing: 'gold',
  'local-only': 'neutral',
  error: 'error',
};

type StatusPillVariant = 'success' | 'warning' | 'error' | 'neutral' | 'gold';

interface TrustCenterCardProps {
  title: string;
  subtitle?: string;
  items: string[];
  details?: string[];
}

function TrustCenterCard({ title, subtitle, items, details }: TrustCenterCardProps) {
  return (
    <View style={styles.trustCard}>
      <Text style={styles.eyebrow}>TRUST CENTER</Text>
      <Text style={styles.trustTitle}>{title}</Text>
      {subtitle ? <Text style={styles.trustSubtitle}>{subtitle}</Text> : null}
      <View style={styles.trustList}>
        {items.map((item, index) => (
          <View key={index} style={styles.trustRow}>
            <Text style={styles.trustBullet}>✦</Text>
            <Text style={styles.trustItem}>{item}</Text>
          </View>
        ))}
      </View>
      {details ? (
        <View style={styles.trustDetails}>
          {details.map((detail, index) => (
            <Text key={index} style={styles.trustDetailItem}>
              {detail}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

interface DataRequestCardProps {
  disabled: boolean;
  correctionText: string;
  onCorrectionTextChange: (text: string) => void;
  onExport: () => void;
  onCorrection: () => void;
}

function DataRequestCard({
  disabled,
  correctionText,
  onCorrectionTextChange,
  onExport,
  onCorrection,
}: DataRequestCardProps) {
  return (
    <View style={styles.dataCard}>
      <SectionHeader
        title="Data Requests"
        subtitle="Export or correct your account information"
      />
      <SecondaryButton
        title="Request Data Export"
        onPress={onExport}
        disabled={disabled}
        accessibilityLabel="Request data export"
        accessibilityHint="Submit a request to export your account data"
      />

      <View style={styles.correctionBox}>
        <TextInput
          value={correctionText}
          onChangeText={onCorrectionTextChange}
          placeholder="Describe a correction request"
          placeholderTextColor={LUXURY.colors.stone}
          multiline
          style={styles.input}
          accessibilityLabel="Correction request description"
          accessibilityHint="Describe the account information you want corrected"
        />
        <SecondaryButton
          title="Submit Correction Request"
          onPress={onCorrection}
          disabled={disabled}
          numberOfLines={2}
          style={styles.correctionButton}
          accessibilityLabel="Submit correction request"
          accessibilityHint="Send your data correction request"
        />
      </View>
    </View>
  );
}

interface AccountDeletionCardProps {
  pending: boolean;
  disabled: boolean;
  onRequest: () => void;
}

function AccountDeletionCard({ pending, disabled, onRequest }: AccountDeletionCardProps) {
  return (
    <View style={[styles.dataCard, styles.deletionCard]}>
      <SectionHeader
        title="Account Deletion"
        subtitle="Request permanent account closure"
      />
      <Text style={styles.deletionBody}>{PRIVACY_COPY.deletion}</Text>
      <PrimaryButton
        title={pending ? 'Deletion Request Pending' : 'Delete Account'}
        onPress={onRequest}
        disabled={disabled}
        style={styles.deletionButton}
        textStyle={{ color: LUXURY.colors.inverse }}
        accessibilityLabel="Request account deletion"
        accessibilityHint="Start the account deletion request flow"
      />
    </View>
  );
}

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

  const writesBlocked = mode === 'booting' || saving || isRefreshing;

  const syncChipLabel = SYNC_STATUS_LABELS[syncStatus] ?? syncStatus;
  const syncChipVariant = SYNC_STATUS_VARIANTS[syncStatus] ?? 'neutral';

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
      const ownerId = user?.id;
      if (!ownerId) throw new Error('Authenticated account identity unavailable.');
      // The service normalizer owns the backend field names. `accepted` means an
      // active deletion lifecycle exists — NOT that the account was purged. No
      // local Recent Scan or media cleanup happens here; permanent purge is a
      // later, restorable-window-gated step.
      const result = await submitAccountDeletionRequest(supabase, session);
      const marker = createDeletionGraceMarker(ownerId, result);
      await persistDeletionGraceMarker(AsyncStorage, marker).catch((error) => {
        console.error('Unable to persist deletion grace marker', error);
      });
      await AsyncStorage.removeItem(LOCAL_PRIVACY_STORAGE_KEY).catch(() => undefined);

      // The backend has authoritatively accepted the request. Clear the visible
      // actor immediately; never wait for an acknowledgement dialog to sign out.
      await signOut().catch((error) => {
        console.error('Remote sign-out failed after accepted deletion request', error);
      });
      setDeletionPending(true);
      const confirmationMessage = result.alreadyRequested
        ? 'Your account deletion request is already active. You have been signed out.'
        : 'Your account deletion request was submitted. You have been signed out.';
      setMessage(confirmationMessage);

      // Grace-window copy is appended only when the backend supplied a valid
      // timestamp. Deletion is restorable until then, so this must never read
      // as permanent removal.
      const graceCopy = result.gracePeriodEndsAt
        ? ` Your account can be restored using the email we sent, until ${new Date(
            result.gracePeriodEndsAt,
          ).toLocaleDateString()}.`
        : ' Your account can be restored using the email we sent, during the grace period.';
      setDeletionSubmitting(false);
      router.replace('/auth');

      Alert.alert(
        'Account deletion request',
        `${confirmationMessage}${graceCopy}`,
        [{ text: 'OK' }],
        { cancelable: false }
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
      scrollable={false}
      safeArea
      backgroundColor={LUXURY.colors.ivory}
      accessibilityLabel="Privacy and data controls"
    >
      <StatusBar style="dark" />
      <KScanHeader
        title="Privacy"
        subtitle="YOUR DATA CONTROLS"
        onBack={() => goBackOrHome(router)}
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
            <Text style={styles.modalBody}>{PRIVACY_COPY.deletion}</Text>
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

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.heroRow}>
          <Text style={styles.heroTitle}>Your Privacy Choices</Text>
          {mode !== 'booting' ? (
            <StatusPill
              label={syncChipLabel}
              variant={syncChipVariant}
              loading={syncStatus === 'syncing'}
              accessibilityLabel={`Privacy sync status: ${syncChipLabel}`}
            />
          ) : null}
        </View>

        {loading ? (
          <View style={styles.loadingPanel}>
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
            <Text style={styles.loadingCaption}>Loading your preferences…</Text>
          </View>
        ) : (
          <>
            {message ? (
              <InlineNotice
                variant="info"
                body={message}
                style={styles.noticeSpacer}
                action={{
                  label: 'Dismiss',
                  onPress: () => setMessage(null),
                  accessibilityLabel: 'Dismiss message',
                }}
              />
            ) : null}

            {remoteFetchFailed ? (
              <InlineNotice
                variant="error"
                title="Unable to load your privacy preference right now."
                body={
                  remoteFetchError ||
                  'Check your connection and try again. Showing the last-known preference saved on this device until account sync succeeds.'
                }
                accessibilityRole="alert"
                style={styles.noticeSpacer}
              />
            ) : null}

            {accountDeletionPending ? (
              <InlineNotice
                testID="privacy-pending-deletion-banner"
                variant="error"
                title="Account Deletion Pending"
                body="Your account deletion request is pending processing. For privacy and safety, app access is limited while the request is processed. You can sign out at any time."
                accessibilityRole="alert"
                style={styles.noticeSpacer}
              />
            ) : null}

            {showSignInCta ? (
              <InlineNotice
                testID="privacy-auth-cta"
                variant="info"
                title="Sign In or Create Account"
                body="Sign in or create an account to save privacy preferences across devices. Until then, this setting is preserved only on this device."
                action={{
                  label: 'Sign In',
                  onPress: () => router.push('/auth'),
                  accessibilityLabel: 'Sign in or create account',
                  testID: 'privacy-auth-cta',
                }}
                style={styles.noticeSpacer}
              />
            ) : null}

            {isAuthenticated && user ? (
              <View style={styles.accountRow}>
                <Text style={styles.accountEmail} numberOfLines={1}>
                  {user.email}
                </Text>
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
              <InlineNotice
                variant="warning"
                title="Under-16 Protection Active"
                body={PRIVACY_COPY.minor}
                style={styles.noticeSpacer}
              />
            ) : null}

            <View style={styles.sectionCard}>
              <SectionHeader
                title="Privacy & Data Choices"
                subtitle={
                  preferenceSource === 'remote'
                    ? 'These choices are linked to your K Scan account.'
                    : 'On-device preferences — sign in to sync to your account.'
                }
              />

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

            <SignatureStyleSettingsSection userKey={user ? `user:${user.id}` : null} />

            <TrustCenterCard
              title="How K Scan Handles Your Data"
              subtitle="Private by design"
              items={PRIVACY_COPY.trust}
              details={[PRIVACY_COPY.scans, PRIVACY_COPY.aggregate]}
            />

            {!remoteActionsEnabled ? (
              <InlineNotice
                variant="info"
                body="Data export, correction, and deletion requests require a connected account. Sign in to enable these actions."
                style={styles.noticeSpacer}
              />
            ) : null}

            <DataRequestCard
              disabled={!remoteActionsEnabled || saving}
              correctionText={correctionText}
              onCorrectionTextChange={setCorrectionText}
              onExport={handleExport}
              onCorrection={handleCorrection}
            />

            <AccountDeletionCard
              pending={deletionPending || accountDeletionPending}
              disabled={!isAuthenticated || saving || deletionSubmitting || deletionPending || accountDeletionPending}
              onRequest={handleDeletion}
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
          </>
        )}
      </ScrollView>
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    padding: SPACING.xl,
    gap: SPACING.lg,
    paddingBottom: 56,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    flexWrap: 'wrap',
    paddingBottom: SPACING.sm,
  },
  heroTitle: {
    ...LUXURY.typography.displayHeadline,
    flex: 1,
    color: LUXURY.colors.ink,
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
  noticeSpacer: {
    marginBottom: 0,
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
  trustCard: {
    ...LUXURY.cards.hero,
    gap: SPACING.md,
  },
  eyebrow: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.goldBrushed,
  },
  trustTitle: {
    ...LUXURY.typography.displayTitle,
    fontSize: 20,
    color: LUXURY.colors.ink,
  },
  trustSubtitle: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
  },
  trustList: {
    gap: SPACING.sm,
    paddingTop: SPACING.xs,
  },
  trustDetails: {
    gap: SPACING.sm,
    paddingTop: SPACING.xs,
  },
  trustDetailItem: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    fontSize: 13,
    lineHeight: 20,
  },
  trustRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  trustBullet: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.goldBrushed,
    fontSize: 13,
    lineHeight: 22,
  },
  trustItem: {
    ...LUXURY.typography.body,
    flex: 1,
    color: LUXURY.colors.graphite,
    fontSize: 14,
    lineHeight: 22,
  },
  dataCard: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.xl,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  deletionCard: {
    borderColor: `${LUXURY.colors.error}20`,
    backgroundColor: LUXURY.colors.warmWhite,
  },
  deletionBody: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
  },
  deletionButton: {
    backgroundColor: LUXURY.colors.error,
    marginTop: SPACING.md,
  },
  correctionButton: {
    width: '100%',
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
    backgroundColor: LUXURY.colors.warmWhite,
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
    // Inert on phones; caps the sheet on regular-width iPad windows.
    width: '100%',
    maxWidth: MODAL_MAX_WIDTH,
    alignSelf: 'center',
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
