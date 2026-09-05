import React, { useState } from 'react';
import { View, Text, Pressable, Switch, StyleSheet } from 'react-native';
import { PrimaryButton, TertiaryButton } from '../../components/luxury';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { openNotificationSettings } from '../../services/watchlist/pushRegistration';

import type { PermissionKey, PermissionPreferences } from '../../hooks/usePermissionPreferences';
import type { EnableDeviceNotificationsResult } from '../../services/watchlist/pushRegistration';

interface PermissionsStepV1Props {
  preferences: PermissionPreferences;
  togglePreference: (key: PermissionKey) => void;
  setPreference: (key: PermissionKey, value: boolean) => void;
  requestNotificationPermission: () => Promise<EnableDeviceNotificationsResult>;
  isSaving: boolean;
  onContinueToHome: () => void;
  onNotNow: () => void;
}

/**
 * Bright luxury Permissions education step (Step 5).
 *
 * Matches the permissions-v1 mockup visually:
 * - Card-based permission rows with icons
 * - Essential vs Optional labels
 * - Visual-only Allow buttons for Camera/Photos
 * - Continue to Home CTA and Not now link
 *
 * Build 33 removed the Microphone and Notifications "Coming Soon" cards
 * rather than activating them. Notifications is now a real, actionable
 * toggle (Build 34). Microphone is restored as a live but PASSIVE status
 * card: Voice Scan (components/text-scan/VoiceScanButton.tsx) is the sole
 * governed microphone-permission authority, and its OS prompt must stay
 * strictly just-in-time -- fired only by an explicit tap on the Voice Scan
 * mic button mid-search, never from onboarding. This card only describes
 * that behavior; its action area is informational and calls no permission
 * API of any kind (see __tests__/androidGooglePlayComplianceV1.test.js and
 * __tests__/iosAppReviewSurface.test.js, which assert this file never
 * imports or invokes a microphone/recording permission function).
 */
export function PermissionsStepV1({
  preferences,
  togglePreference,
  setPreference,
  requestNotificationPermission,
  isSaving,
  onContinueToHome,
  onNotNow,
}: PermissionsStepV1Props) {
  const { camera, photos, notifications } = preferences;
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const [notificationsStatus, setNotificationsStatus] = useState<
    'idle' | 'denied_can_retry' | 'denied_needs_settings' | 'unavailable'
  >('idle');

  const handleNotificationsToggle = async (nextValue: boolean) => {
    if (!nextValue) {
      // Turning the device switch off only clears the locally reflected
      // state. Registration is what arms delivery; there is no "disable all"
      // call from onboarding, and per-Watch alerts are a separate concept.
      setPreference('notifications', false);
      setNotificationsStatus('idle');
      return;
    }

    setNotificationsBusy(true);
    setNotificationsStatus('idle');
    try {
      const result = await requestNotificationPermission();
      if (result.ok) {
        setNotificationsStatus('idle');
      } else if (result.reason === 'permission_denied') {
        setNotificationsStatus(result.canAskAgain ? 'denied_can_retry' : 'denied_needs_settings');
      } else {
        setNotificationsStatus('unavailable');
      }
    } finally {
      setNotificationsBusy(false);
    }
  };

  const notificationsDescription =
    notificationsStatus === 'denied_needs_settings'
      ? 'Notifications are turned off in device Settings.'
      : notificationsStatus === 'denied_can_retry'
        ? 'Permission was not granted. You can try again.'
        : notificationsStatus === 'unavailable'
          ? 'Unavailable right now — tap to retry.'
          : 'Get notified when a watched item hits your target price.';

  return (
    <View style={styles.stepContent} testID="onboarding-permissions-screen-v1">
      <View style={styles.textBlock}>
        <Text style={styles.headline} accessibilityRole="header">
          Enable your{' '}
          <Text style={styles.headlineGold}>style tools</Text>
        </Text>
        <Text style={styles.body}>
          Allow a few permissions to unlock the full K Scan AI experience.
        </Text>
      </View>

      <View style={styles.cards}>
        {/* Camera */}
        <PermissionCard
          icon="◉"
          title="Camera"
          badge="ESSENTIAL"
          description="Scan outfits in the real world. Snap or scan to discover style and similar looks instantly."
          actionType="allow"
          actionValue={camera}
          onActionChange={() => togglePreference('camera')}
        />

        {/* Photos */}
        <PermissionCard
          icon="◈"
          title="Photos"
          badge="ESSENTIAL"
          description="Import looks and inspiration. Upload photos to find similar pieces and build your style effortlessly."
          actionType="allow"
          actionValue={photos}
          onActionChange={() => togglePreference('photos')}
        />

        {/* Microphone — live capability surface, PASSIVE by design. This
            card never calls a permission API and registers no press
            handler on its action area (see actionType="status" below).
            Voice Scan (components/text-scan/VoiceScanButton.tsx) remains
            the ONLY place that requests the real OS microphone/speech
            permission, just-in-time, after an explicit tap. */}
        <PermissionCard
          icon="◎"
          title="Microphone"
          badge="OPTIONAL"
          description="Use Voice Scan to speak a fashion search instead of typing. Microphone access is requested only when you tap Voice Scan."
          actionType="status"
          statusLabel="ON USE"
          accessibilityLabel="Microphone is used by Voice Scan, requested only when you tap Voice Scan"
        />

        {/* Notifications — permanent core permission surface. Visibility is
            unconditional: no environment, K+, RevenueCat, PostHog,
            FeatureFreeze, or remote-config gate may hide it. Off by default;
            the user must affirmatively enable it. */}
        <PermissionCard
          icon="◉"
          title="Notifications"
          badge="OPTIONAL"
          description={notificationsDescription}
          actionType="toggle"
          actionValue={notifications}
          onActionChange={(value) => void handleNotificationsToggle(value)}
          disabled={notificationsBusy}
          accessibilityLabel="Notifications permission toggle"
        />
        {notificationsStatus === 'denied_needs_settings' ? (
          <Pressable
            testID="onboarding-notifications-open-settings-v1"
            onPress={() => void openNotificationSettings()}
            accessibilityRole="button"
          >
            <Text style={styles.settingsLink}>Open Settings to enable notifications</Text>
          </Pressable>
        ) : null}

      </View>

      <View style={styles.actions}>
        <PrimaryButton
          testID="onboarding-permissions-continue-button-v1"
          title={isSaving ? '✧ SAVING...' : '✧ CONTINUE TO HOME'}
          onPress={onContinueToHome}
          style={styles.wideButton}
          loading={isSaving}
        />

        <TertiaryButton
          testID="onboarding-permissions-not-now-button-v1"
          title="Not now"
          onPress={onNotNow}
          style={styles.wideButton}
          disabled={isSaving}
        />
      </View>
    </View>
  );
}

// ── Permission Card ──────────────────────────────────────────────────────────

interface PermissionCardProps {
  icon: string;
  title: string;
  badge: string;
  description: string;
  // 'status' is a passive, non-interactive action area: no Pressable, no
  // Switch, no onPress/onValueChange of any kind. It exists for a card that
  // must describe a real capability without itself being able to trigger
  // any permission request -- see the Microphone card above.
  actionType: 'allow' | 'toggle' | 'status';
  actionValue?: boolean;
  onActionChange?: (value: boolean) => void;
  /** Label shown in the passive status pill. Only used when actionType === 'status'. */
  statusLabel?: string;
  recommendation?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
}

function PermissionCard({
  icon,
  title,
  badge,
  description,
  actionType,
  actionValue = false,
  onActionChange,
  statusLabel,
  recommendation,
  disabled = false,
  accessibilityLabel,
}: PermissionCardProps) {
  return (
    <View
      style={[styles.card, disabled && styles.cardDisabled]}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
    >
      <View style={styles.cardRow}>
        <View style={styles.cardIconWrap}>
          <Text style={styles.cardIcon}>{icon}</Text>
        </View>

        <View style={styles.cardBody}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>{title}</Text>
            <Text
              style={[
                styles.cardBadge,
                badge === 'ESSENTIAL' ? styles.badgeEssential : styles.badgeOptional,
              ]}
            >
              {badge}
            </Text>
          </View>
          <Text style={styles.cardDescription}>{description}</Text>
          {recommendation ? (
            <Text style={styles.recommendation}>{recommendation}</Text>
          ) : null}
        </View>

        <View style={styles.cardAction}>
          {actionType === 'status' ? (
            // Deliberately a bare View + Text: no Pressable, no onPress, no
            // touchable ancestor of any kind. There is nothing here for a
            // future edit to silently wire a permission call onto.
            <View style={styles.statusPill} accessibilityRole="text">
              <Text style={styles.statusPillText}>{statusLabel ?? 'ON USE'}</Text>
            </View>
          ) : actionType === 'allow' ? (
            <Pressable
              onPress={() => !disabled && onActionChange?.(!actionValue)}
              disabled={disabled}
              style={({ pressed }) => [
                styles.allowButton,
                disabled && styles.allowButtonDisabled,
                pressed && !disabled && styles.allowButtonPressed,
                actionValue && styles.allowButtonActive,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Allow ${title}`}
              accessibilityState={{ selected: actionValue, disabled }}
            >
              <Text style={[styles.allowButtonText, disabled && styles.allowButtonTextDisabled]}>
                ALLOW
              </Text>
            </Pressable>
          ) : (
            <Switch
              value={actionValue}
              onValueChange={disabled ? undefined : onActionChange}
              disabled={disabled}
              trackColor={{ false: LUXURY.colors.border, true: LUXURY.colors.plumMuted }}
              thumbColor={actionValue ? LUXURY.colors.plum : '#f4f3f4'}
              accessibilityLabel={`Toggle ${title}`}
              accessibilityState={{ disabled, checked: actionValue }}
            />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stepContent: {
    flex: 1,
    gap: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.xl,
  },
  textBlock: {
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  headline: {
    ...LUXURY.typography.displayHeadline,
    textAlign: 'center',
    color: LUXURY.colors.ink,
  },
  headlineGold: {
    color: LUXURY.colors.goldBrushed,
  },
  body: {
    ...LUXURY.typography.body,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
    paddingHorizontal: SPACING.lg,
  },
  cards: {
    gap: SPACING.md,
  },
  card: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.md,
  },
  cardIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: LUXURY.colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  cardIcon: {
    fontSize: 20,
    color: LUXURY.colors.goldBrushed,
  },
  cardBody: {
    flex: 1,
    gap: SPACING.xs,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flexWrap: 'wrap',
  },
  cardTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 16,
    color: LUXURY.colors.ink,
  },
  cardBadge: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.2,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: RADIUS.pill,
    overflow: 'hidden',
  },
  badgeEssential: {
    color: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.plumMuted,
  },
  badgeOptional: {
    color: LUXURY.colors.goldText,
    backgroundColor: LUXURY.colors.goldLight,
  },
  cardDescription: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    lineHeight: 18,
    color: LUXURY.colors.graphite,
  },
  recommendation: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.plumSoft,
    textTransform: 'none',
    letterSpacing: 0.2,
  },
  cardAction: {
    justifyContent: 'center',
    minHeight: 44,
  },
  allowButton: {
    borderWidth: 1.5,
    borderColor: LUXURY.colors.plum,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  allowButtonPressed: {
    backgroundColor: LUXURY.colors.plumMuted,
  },
  allowButtonActive: {
    backgroundColor: LUXURY.colors.plum,
  },
  allowButtonText: {
    ...LUXURY.typography.cta,
    fontSize: 11,
    color: LUXURY.colors.plum,
  },
  allowButtonDisabled: {
    borderColor: LUXURY.colors.border,
  },
  allowButtonTextDisabled: {
    color: LUXURY.colors.stone,
  },
  statusPill: {
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    backgroundColor: LUXURY.colors.goldLight,
  },
  statusPillText: {
    ...LUXURY.typography.cta,
    fontSize: 10,
    letterSpacing: 0.6,
    color: LUXURY.colors.goldText,
  },
  settingsLink: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    textDecorationLine: 'underline',
    color: LUXURY.colors.plum,
    textAlign: 'center',
    marginTop: -SPACING.sm,
  },
  cardDisabled: {
    opacity: 0.5,
  },

  actions: {
    gap: SPACING.md,
    marginTop: SPACING.lg,
  },
  wideButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
  },
});
