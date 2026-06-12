import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
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
import { COLORS, LAYOUT, RADIUS, SPACING, TYPOGRAPHY } from '../constants/theme';
import { submitAccountDeletionRequest } from '../services/accountDeletion';
import { supabase } from '../services/supabaseClient';
import { LOCAL_PRIVACY_STORAGE_KEY } from '../services/privacyLocalStore';

const PRIVACY_COPY = {
  saleRemote:
    'When enabled, K Scan will treat your account as opted out of applicable data sale or sharing preferences, subject to our Privacy Policy and legal obligations.',
  saleLocal:
    'This preference is saved on this device only. Sign in to save it to your account across devices.',
  sensitiveRemote:
    'Limit sensitive processing where applicable. Operational diagnostics and security events may still be processed where permitted.',
  sensitiveLocal:
    'Saved on this device until your account is connected. Operational diagnostics may still run where permitted.',
  aggregate:
    'Aggregated or deidentified trend reports are managed separately from transfers of user-linked personal information.',
  scans:
    'Raw scan storage must follow the production storage map. Derived fashion metadata may be reviewed for export when linked to your account.',
  minor:
    'Sale or sharing of personal information is disabled for users under 16 unless legally valid authorization is obtained.',
};

const SYNC_STATUS_LABELS: Record<string, string> = {
  synced: 'Saved to Account',
  syncing: 'Syncing',
  'local-only': 'Saved to Device',
  error: 'Could Not Sync',
};

const SYNC_STATUS_COLORS: Record<string, string> = {
  synced: COLORS.success,
  syncing: '#00FFFF',
  'local-only': COLORS.textTertiary,
  error: COLORS.errorSoft,
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
    saving,
    persistPreference,
  } = usePrivacyPreferences();

  const [message, setMessage] = useState<string | null>(null);
  const [correctionText, setCorrectionText] = useState('');
  const [deletionSubmitting, setDeletionSubmitting] = useState(false);
  const [deletionPending, setDeletionPending] = useState(false);
  const [deletionConfirmVisible, setDeletionConfirmVisible] = useState(false);

  const saleSharingLocked = !canToggleSaleSharing(normalized.age_group);

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
      <View style={styles.errorBanner}>
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
    const color = SYNC_STATUS_COLORS[syncStatus] ?? COLORS.textTertiary;
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
    if (deletionPending) {
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

      Alert.alert('Account deletion request', confirmationMessage, [
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
      ], { cancelable: false });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to request deletion.');
      setDeletionSubmitting(false);
      return;
    }
  };

  const handleExport = async () => {
    try {
      await requestDataExport();
      setMessage(
        'Data export request submitted (if your Edge Function is deployed and reachable).',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to request export.');
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
      setMessage(
        'Correction request submitted (if your Edge Function is deployed and reachable).',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to request correction.');
    }
  };

  const loading = bootStatus === 'loading';

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
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
              Your account will be marked pending deletion while K Scan AI processes required retention, security, and legal checks.
            </Text>
            <View style={styles.modalActions}>
              <Pressable
                testID="deletion-cancel-button"
                style={styles.modalSecondaryButton}
                onPress={() => setDeletionConfirmVisible(false)}
                disabled={deletionSubmitting}
              >
                <Text style={styles.modalSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="deletion-confirm-button"
                style={styles.modalDangerButton}
                onPress={confirmDeletion}
                disabled={deletionSubmitting}
              >
                <Text style={styles.modalDangerText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <SafeAreaView style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.brand}>K-SCAN</Text>
          <Text style={styles.screenTitle}>PRIVACY CONTROL</Text>
        </View>
        <View style={styles.headerRight} />
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>DATA MANAGEMENT</Text>
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
            <ActivityIndicator size="large" color="#00FFFF" />
            <Text style={styles.loadingCaption}>Loading your preferences…</Text>
          </View>
        ) : (
          <>
            {message ? <Text style={styles.message}>{message}</Text> : null}
            {loadFailureBanner}

            {showSignInCta ? (
              <Pressable testID="privacy-auth-cta" style={styles.signInNotice} onPress={() => router.push('/auth')}>
                <View style={styles.signInNoticeText}>
                  <Text style={styles.noticeTitle}>SIGN IN OR CREATE ACCOUNT</Text>
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
                <Pressable style={styles.signOutButton} onPress={handleSignOut}>
                  <Text style={styles.signOutText}>Sign Out</Text>
                </Pressable>
              </View>
            ) : null}

            {saleSharingLocked ? (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>UNDER-16 PROTECTION ACTIVE</Text>
                <Text style={styles.noticeBody}>{PRIVACY_COPY.minor}</Text>
              </View>
            ) : null}

            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Privacy & Data Choices</Text>
              <Text style={styles.sectionSubtitle}>
                {preferenceSource === 'remote'
                  ? 'These choices are linked to your K Scan account and saved securely.'
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
                    setMessage(
                      error instanceof Error ? error.message : 'Unable to update preference.',
                    );
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
                    setMessage(
                      error instanceof Error ? error.message : 'Unable to update preference.',
                    );
                  });
                }}
              />
            </View>

            <View style={styles.infoPanel}>
              <Text style={styles.panelTitle}>DATA CATEGORY BOUNDARIES</Text>
              <Text style={styles.panelBody}>{PRIVACY_COPY.aggregate}</Text>
              <Text style={styles.panelBody}>{PRIVACY_COPY.scans}</Text>
              <Text style={styles.panelBody}>
                Global Privacy Control from web is synchronized through the gpc_web source when your account is connected.
              </Text>
              <Text style={styles.panelBody}>
                GDPR consent requires separate EU/UK logic and is not inferred from California opt-out state.
              </Text>
            </View>

            <View style={styles.actions}>
              {!remoteActionsEnabled ? (
                <Text style={styles.edgeHint}>
                  Data export, correction, and deletion requests require an authenticated session and deployed Edge Functions. Sign in and connect your account to enable these actions.
                </Text>
              ) : null}

              <Pressable
                disabled={!remoteActionsEnabled || saving}
                style={styles.secondaryButton}
                onPress={handleExport}
              >
                <Text style={styles.secondaryButtonText}>Request Data Export</Text>
              </Pressable>

              <View style={styles.correctionBox}>
                <TextInput
                  value={correctionText}
                  onChangeText={setCorrectionText}
                  placeholder="Describe a correction request"
                  placeholderTextColor={COLORS.textTertiary}
                  multiline
                  style={styles.input}
                />
                <Pressable
                  disabled={!remoteActionsEnabled || saving}
                  style={styles.secondaryButton}
                  onPress={handleCorrection}
                >
                  <Text style={styles.secondaryButtonText}>Submit Correction Request</Text>
                </Pressable>
              </View>

              <Pressable
                testID="privacy-delete-account-button"
                disabled={!isAuthenticated || saving || deletionSubmitting || deletionPending}
                style={styles.dangerButton}
                onPress={handleDeletion}
              >
                {deletionSubmitting ? (
                  <ActivityIndicator size="small" color={COLORS.errorSoft} />
                ) : (
                  <Text style={styles.dangerButtonText}>
                    {deletionPending ? 'Deletion Request Pending' : 'Delete Account'}
                  </Text>
                )}
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
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
    paddingTop: LAYOUT.safeTop,
    paddingHorizontal: LAYOUT.screenPadding,
    paddingBottom: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    width: 56,
  },
  backText: {
    color: '#00FFFF',
    fontSize: 13,
    fontWeight: '700',
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
    color: '#00FFFF',
  },
  content: {
    padding: LAYOUT.screenPadding,
    gap: SPACING.lg,
    paddingBottom: 56,
  },
  hero: {
    gap: SPACING.sm,
    paddingBottom: SPACING.sm,
  },
  eyebrow: {
    ...TYPOGRAPHY.caption,
    color: '#00FFFF',
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    flexWrap: 'wrap',
  },
  title: {
    ...TYPOGRAPHY.headline,
    fontSize: 28,
    flex: 1,
  },
  syncChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    backgroundColor: COLORS.surfaceSoft,
  },
  syncSpinner: {
    width: 12,
    height: 12,
  },
  syncChipText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  body: {
    ...TYPOGRAPHY.body,
  },
  loadingPanel: {
    minHeight: 240,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
  },
  loadingCaption: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
  },
  message: {
    ...TYPOGRAPHY.bodyStrong,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    padding: SPACING.lg,
    color: COLORS.textPrimary,
  },
  errorBanner: {
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 107, 0.45)',
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(255, 107, 107, 0.08)',
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  errorBannerTitle: {
    ...TYPOGRAPHY.caption,
    color: COLORS.errorSoft,
  },
  errorBannerBody: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    lineHeight: 20,
  },
  signInNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#00FFFF',
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(0, 255, 255, 0.08)',
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  signInNoticeText: {
    flex: 1,
    gap: SPACING.sm,
  },
  signInArrow: {
    color: '#00FFFF',
    fontSize: 22,
    fontWeight: '300',
  },
  notice: {
    borderWidth: 1,
    borderColor: '#00FFFF',
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(0, 255, 255, 0.08)',
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  noticeTitle: {
    ...TYPOGRAPHY.caption,
    color: '#00FFFF',
  },
  noticeBody: {
    ...TYPOGRAPHY.bodyStrong,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
  },
  accountEmail: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    color: COLORS.textSecondary,
    flex: 1,
    marginRight: SPACING.md,
  },
  signOutButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  signOutText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.4,
    color: COLORS.textTertiary,
    textTransform: 'uppercase',
  },
  sectionCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  sectionTitle: {
    ...TYPOGRAPHY.title,
    fontSize: 18,
    color: COLORS.textPrimary,
  },
  sectionSubtitle: {
    ...TYPOGRAPHY.body,
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
  },
  infoPanel: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    backgroundColor: COLORS.surface,
    gap: SPACING.md,
  },
  panelTitle: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textPrimary,
  },
  panelBody: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    lineHeight: 20,
  },
  actions: {
    gap: SPACING.md,
  },
  edgeHint: {
    ...TYPOGRAPHY.body,
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.textTertiary,
    marginBottom: SPACING.sm,
  },
  secondaryButton: {
    minHeight: 50,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    backgroundColor: COLORS.surfaceSoft,
  },
  secondaryButtonText: {
    ...TYPOGRAPHY.cta,
    color: COLORS.textSecondary,
    fontSize: 12,
  },
  correctionBox: {
    gap: SPACING.sm,
  },
  input: {
    minHeight: 96,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.lg,
    color: COLORS.textPrimary,
    backgroundColor: COLORS.surface,
    textAlignVertical: 'top',
  },
  dangerButton: {
    minHeight: 50,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 107, 0.48)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    backgroundColor: 'rgba(255, 107, 107, 0.08)',
  },
  dangerButtonText: {
    ...TYPOGRAPHY.cta,
    color: COLORS.errorSoft,
    fontSize: 12,
  },
  modalScrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: LAYOUT.screenPadding,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
  },
  modalCard: {
    width: '100%',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
    padding: SPACING.xl,
    gap: SPACING.lg,
  },
  modalTitle: {
    ...TYPOGRAPHY.title,
    fontSize: 20,
  },
  modalBody: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    lineHeight: 20,
  },
  modalActions: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  modalSecondaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalSecondaryText: {
    ...TYPOGRAPHY.cta,
    color: COLORS.textSecondary,
    fontSize: 12,
  },
  modalDangerButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 107, 0.48)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 107, 107, 0.12)',
  },
  modalDangerText: {
    ...TYPOGRAPHY.cta,
    color: COLORS.errorSoft,
    fontSize: 12,
  },
});
