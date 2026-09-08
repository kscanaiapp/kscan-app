import React, { useState } from 'react';
import { View, Text, Pressable, Switch, StyleSheet } from 'react-native';
import { PrimaryButton, TertiaryButton } from '../../components/luxury';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { openNotificationSettings } from '../../services/watchlist/pushRegistration';
import { resolveRemotePushActivationAllowed } from '../../services/notifications/remotePushCapability';
import { KPlusGate } from '../kplus/KPlusGate';
import { VOICESCAN_ENABLED } from '../../constants/featureFlags';

import type { PermissionKey, PermissionPreferences } from '../../hooks/usePermissionPreferences';
import type {
  DisableDeviceNotificationsResult,
  EnableDeviceNotificationsResult,
} from '../../services/watchlist/pushRegistration';

interface PermissionsStepV1Props {
  preferences: PermissionPreferences;
  setPreference: (key: PermissionKey, value: boolean) => void;
  requestNotificationPermission: () => Promise<EnableDeviceNotificationsResult>;
  /**
   * RP-104. Revokes THIS device's backend push-delivery route. The switch may
   * only settle to OFF once this succeeds.
   */
  disableNotificationDelivery: () => Promise<DisableDeviceNotificationsResult>;
  onContinueToHome: () => void;
  onNotNow: () => void;
}

/**
 * Bright luxury Permissions education step (Step 5).
 *
 * Matches the permissions-v1 mockup visually:
 * - Card-based permission rows with icons
 * - Essential vs Optional labels
 * - Truthful point-of-use status for Camera/Photos
 * - Continue to Home CTA and Not now link
 *
 * Build 33 removed the Microphone and Notifications "Coming Soon" cards
 * rather than activating them. Notifications became a real, actionable toggle
 * in Build 34, and Android Repair 05 made that toggle conditional on the build
 * actually shipping something that sends push (see the card's own comment
 * below). Microphone is restored as a live but PASSIVE status
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
  setPreference,
  requestNotificationPermission,
  disableNotificationDelivery,
  onContinueToHome,
  onNotNow,
}: PermissionsStepV1Props) {
  const { notifications } = preferences;
  // Android Repair 05. THE canonical decision, read once per render from the
  // one authority (services/notifications/remotePushCapability.ts) rather than
  // recomposed here from a flag and a platform test. When it is false this
  // build ships nothing that can send the user a push, so the row below must
  // not offer -- or silently perform -- a permission request.
  const remotePushAllowed = resolveRemotePushActivationAllowed();
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const [notificationsStatus, setNotificationsStatus] = useState<
    'idle' | 'denied_can_retry' | 'denied_needs_settings' | 'unavailable' | 'disable_failed'
  >('idle');

  const handleNotificationsToggle = async (nextValue: boolean) => {
    // Both directions are real, bounded network work, so both enter the busy
    // state and the switch stays uninteractive until the outcome is known.
    setNotificationsBusy(true);
    setNotificationsStatus('idle');
    try {
      if (!nextValue) {
        // RP-104. Turning the switch off must actually stop delivery. It used
        // to clear local state only, leaving this device's backend push route
        // live -- the UI said OFF while K Scan AI could still push to the
        // handset. The switch now settles to OFF only after the route is
        // revoked; `disableNotificationDelivery` is what writes that state.
        //
        // Scoped to the application delivery route: this revokes nothing at
        // the OS level and no copy below claims that it does.
        const result = await disableNotificationDelivery();
        if (!result.ok) {
          // Never present a durable OFF that was not achieved. The switch is
          // left where it was -- ON, still a live push destination -- with a
          // retryable failure state.
          setNotificationsStatus('disable_failed');
        }
        return;
      }

      const result = await requestNotificationPermission();
      if (result.ok) {
        setNotificationsStatus('idle');
      } else if (result.reason === 'permission_denied') {
        setNotificationsStatus(result.canAskAgain ? 'denied_can_retry' : 'denied_needs_settings');
      } else if (result.reason === 'superseded') {
        // A newer explicit OFF won. Nothing to report: the switch already
        // reflects the decision the user actually ended on.
        setNotificationsStatus('idle');
      } else {
        setNotificationsStatus('unavailable');
      }
    } finally {
      setNotificationsBusy(false);
    }
  };

  const notificationsDescription = notificationsBusy
    ? 'Updating your notification settings…'
    : notificationsStatus === 'denied_needs_settings'
      ? 'Notifications are turned off in device Settings.'
      : notificationsStatus === 'denied_can_retry'
        ? 'Permission was not granted. You can try again.'
        : notificationsStatus === 'unavailable'
          ? 'Unavailable right now — tap to retry.'
          : notificationsStatus === 'disable_failed'
            ? 'Could not turn K Scan AI notifications off just now — tap to try again.'
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
          description="Use the Scanner to capture a look when you are ready. Camera access is requested only when you start that flow."
          actionType="status"
          statusLabel="ON USE"
          accessibilityLabel="Camera is requested only when you use the Scanner"
        />

        {/* Photos */}
        <PermissionCard
          icon="◈"
          title="Photos"
          badge="ESSENTIAL"
          description="Choose a look from the system picker when you are ready to search with a photo."
          actionType="status"
          statusLabel="ON USE"
          accessibilityLabel="Photos are selected only when you use the system picker"
        />

        {/* This gate only controls the K+ acquisition action. The Microphone
            card itself is rendered for every state, including unavailable
            builds and unresolved/error entitlement states. Voice Scan remains
            the sole just-in-time microphone permission authority. */}
        <KPlusGate source="onboarding">
          {({ state, isActive, openUpgrade }) => {
            const voiceScanAvailable = VOICESCAN_ENABLED;
            const isResolving = state === 'loading';
            const needsKPlusCheck = state === 'error' || state === 'unavailable';
            const microphoneActionDisabled = !voiceScanAvailable || isResolving;
            const canUseVoiceScan = voiceScanAvailable && isActive;

            return (
              <PermissionCard
                icon="◎"
                title="Microphone"
                badge="OPTIONAL"
                description={
                  !voiceScanAvailable
                    ? 'Voice Scan is not available in this build.'
                    : isActive
                      ? 'Use Voice Scan to speak a fashion search instead of typing. Microphone access is requested only when you tap Voice Scan.'
                      : 'Voice Scan is available with K+. Microphone access is requested only when you tap Voice Scan.'
                }
                actionType={canUseVoiceScan ? 'status' : 'button'}
                statusLabel={canUseVoiceScan ? 'ON USE' : undefined}
                actionLabel={
                  !voiceScanAvailable
                    ? 'NOT AVAILABLE'
                    : isResolving
                      ? 'CHECKING K+'
                      : needsKPlusCheck
                        ? 'CHECK K+'
                        : 'UNLOCK WITH K+'
                }
                recommendation={isActive ? 'K+ ACTIVE' : undefined}
                onActionPress={microphoneActionDisabled ? undefined : openUpgrade}
                disabled={microphoneActionDisabled}
                accessibilityLabel={
                  !voiceScanAvailable
                    ? 'Voice Scan is not available in this build'
                    : isActive
                    ? 'Microphone is used by Voice Scan, included with active K+, and requested only when you tap Voice Scan'
                    : microphoneActionDisabled
                      ? 'Microphone Voice Scan availability is currently unavailable'
                      : 'Unlock K+ to use Voice Scan. Microphone permission is requested only when you tap Voice Scan.'
                }
              />
            );
          }}
        </KPlusGate>

        {/* Notifications — permanent core permission surface. VISIBILITY stays
            unconditional: no environment, K+, RevenueCat, PostHog,
            FeatureFreeze, or remote-config gate may hide this card. Off by
            default; the user must affirmatively enable it.

            Android Repair 05 separates VISIBILITY from ACTIONABILITY. The card
            is still always rendered — it is education, and the education is
            true either way — but the live toggle is offered only when this
            build actually ships a feature that sends push. With no such
            feature, the row becomes a passive status card that requests no
            permission and mints no push token, exactly like the Microphone row
            above when Voice Scan is absent from the build. The alternative —
            leaving a toggle that asks the OS for POST_NOTIFICATIONS and
            registers a device for alerts nothing can ever send — is the defect
            this repair closes, not a state worth preserving. */}
        <PermissionCard
          icon="◉"
          title="Notifications"
          badge="OPTIONAL"
          description={
            remotePushAllowed
              ? notificationsDescription
              : 'Price alerts are not available in this build.'
          }
          actionType={remotePushAllowed ? 'toggle' : 'status'}
          statusLabel={remotePushAllowed ? undefined : 'NOT AVAILABLE'}
          actionValue={notifications}
          onActionChange={
            remotePushAllowed ? (value) => void handleNotificationsToggle(value) : undefined
          }
          disabled={notificationsBusy}
          accessibilityLabel={
            remotePushAllowed
              ? 'Notifications permission toggle'
              : 'Price alerts are not available in this build, so no notification permission is requested'
          }
        />
        {remotePushAllowed && notificationsStatus === 'denied_needs_settings' ? (
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
          title="✧ CONTINUE TO HOME"
          onPress={onContinueToHome}
          style={styles.wideButton}
        />

        <TertiaryButton
          testID="onboarding-permissions-not-now-button-v1"
          title="Not now"
          onPress={onNotNow}
          style={styles.wideButton}
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
  // 'status' is a passive, non-interactive action area. It is used for
  // point-of-use permissions and an active K+ Voice Scan state.
  actionType: 'button' | 'toggle' | 'status';
  actionValue?: boolean;
  onActionChange?: (value: boolean) => void;
  onActionPress?: () => void;
  /** Label shown in the passive status pill. Only used when actionType === 'status'. */
  statusLabel?: string;
  actionLabel?: string;
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
  onActionPress,
  statusLabel,
  actionLabel,
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
            <View style={styles.statusPill} accessibilityRole="text">
              <Text style={styles.statusPillText}>{statusLabel ?? 'ON USE'}</Text>
            </View>
          ) : actionType === 'button' ? (
            <Pressable
              testID={`onboarding-${title.toLowerCase()}-action-v1`}
              onPress={onActionPress}
              disabled={disabled}
              style={({ pressed }) => [
                styles.actionButton,
                disabled && styles.actionButtonDisabled,
                pressed && !disabled && styles.actionButtonPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel ?? actionLabel ?? title}
              accessibilityState={{ disabled }}
            >
              <Text style={[styles.actionButtonText, disabled && styles.actionButtonTextDisabled]}>
                {actionLabel ?? 'CONTINUE'}
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
  actionButton: {
    borderWidth: 1.5,
    borderColor: LUXURY.colors.plum,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonPressed: {
    backgroundColor: LUXURY.colors.plumMuted,
  },
  actionButtonText: {
    ...LUXURY.typography.cta,
    fontSize: 11,
    color: LUXURY.colors.plum,
  },
  actionButtonDisabled: {
    borderColor: LUXURY.colors.border,
  },
  actionButtonTextDisabled: {
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
