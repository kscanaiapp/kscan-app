/**
 * N-6 — the post-onboarding control for K Scan AI notifications on this device.
 *
 * THE GAP THIS CLOSES
 *
 * Notifications could be enabled during onboarding and, after that, nowhere
 * else. The onboarding Permissions step is unreachable once onboarding
 * completes, so a user who said yes had no way inside K Scan AI to say no
 * again — while the backend push route their yes created stayed live.
 *
 * WHAT IT CLAIMS, AND WHAT IT REFUSES TO CLAIM
 *
 * It controls exactly one thing: whether K Scan AI has a push-delivery route on
 * THIS device. It says so in the label. It does not, and cannot, revoke the
 * operating system's notification authorization — only the user can do that,
 * in system Settings — so no copy here implies otherwise. When the OS is the
 * thing blocking delivery, that is presented as a separate fact with its own
 * separate remedy, never as the app toggle having failed or succeeded.
 *
 * The device scope is stated rather than assumed: turning this off leaves the
 * same account's other handsets, the Watchlist, and K+ exactly as they were.
 */
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { InlineNotice, SectionHeader } from '../luxury';
import { PrivacyToggle } from '../PrivacyToggle';
import { useDeviceNotificationSetting } from '../../hooks/useDeviceNotificationSetting';

interface DeviceNotificationSettingsSectionProps {
  /** Stable actor identity, or null when signed out. */
  actorKey: string | null;
}

const TOGGLE_TITLE = 'Notifications on this device';

export function DeviceNotificationSettingsSection({
  actorKey,
}: DeviceNotificationSettingsSectionProps) {
  const { status, osPermission, pending, failure, enable, disable, refresh, openSystemSettings } =
    useDeviceNotificationSetting({ actorKey });

  // N-6 §6. The build ships nothing that can send a push, so there is no
  // delivery to control and no honest state to render. Hidden entirely rather
  // than shown inert: an inert row still teaches the user that a control exists
  // here, and the feature it would control does not.
  if (status === 'unavailable') return null;

  const busy = pending !== null;
  const isOn = status === 'on';
  const osBlocked = osPermission === 'blocked';

  const body = busy
    ? pending === 'enabling'
      ? 'Turning on K Scan AI alerts for this device…'
      : 'Turning off K Scan AI alerts for this device…'
    : isOn
      ? osBlocked
        ? 'K Scan AI alerts are on for this device, but this device is not currently allowing them.'
        : 'Get K Scan AI alerts on this device. Your other devices keep their own setting.'
      : 'K Scan AI will not send alerts to this device. Your Watchlist and K+ are unchanged.';

  return (
    <View style={styles.card} testID="settings-device-notifications-section">
      <SectionHeader
        title="Notifications"
        subtitle="K Scan AI alerts on this device"
      />

      {status === 'loading' ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
          <Text style={styles.loadingText}>Checking this device…</Text>
        </View>
      ) : status === 'unreadable' ? (
        // Neither ON nor OFF is a fact we hold, so neither is presented. A
        // toggle rendered here would assert a position it cannot support.
        <InlineNotice
          testID="settings-device-notifications-unreadable"
          variant="warning"
          title="We couldn't check this device"
          body="K Scan AI could not read whether alerts are on for this device. Try again."
          accessibilityRole="alert"
          action={{
            label: 'Try again',
            onPress: () => void refresh(),
            accessibilityLabel: 'Check this device’s notification setting again',
            testID: 'settings-device-notifications-retry',
          }}
        />
      ) : (
        <PrivacyToggle
          title={TOGGLE_TITLE}
          body={body}
          value={isOn}
          busy={busy}
          onChange={(next) => {
            // Both directions are real, bounded network work through the
            // canonical authority. Neither is reachable while one is pending:
            // `busy` locks the row, so a double tap cannot start a second
            // mutation, and the hook's monotonic intent sequence discards any
            // completion that a newer intent has already superseded.
            if (next) {
              void enable();
              return;
            }
            void disable();
          }}
        />
      )}

      {/* The operating system, as its own fact with its own remedy. Shown
          whichever way the app-level control is set, because a blocked OS
          permission stops delivery either way — and K Scan AI cannot change it.

          The wording deliberately says "this device is not allowing" rather
          than "you turned this off in Settings". Both are real states and they
          are indistinguishable from here: on iOS and Android this is usually
          the user's own choice, but on Android 13+ this build also declares
          POST_NOTIFICATIONS as a BLOCKED permission (app.json), which produces
          the same not-granted, cannot-ask answer for a reason the user never
          chose. Naming a cause we cannot verify would be the same kind of false
          claim this lane exists to remove. */}
      {osBlocked && status !== 'loading' ? (
        <InlineNotice
          testID="settings-device-notifications-os-blocked"
          variant="info"
          title="This device isn't allowing notifications"
          body="K Scan AI alerts can't arrive on this device while notifications are not allowed for the app. You can check this in your device settings."
          action={{
            label: 'Open Settings',
            onPress: openSystemSettings,
            accessibilityLabel: 'Open device settings to allow K Scan AI notifications',
            testID: 'settings-device-notifications-open-settings',
          }}
          style={styles.noticeSpacer}
        />
      ) : null}

      {failure === 'disable_failed' ? (
        <InlineNotice
          testID="settings-device-notifications-error"
          variant="error"
          title="Couldn't turn notifications off"
          body="K Scan AI alerts are still on for this device. Try again."
          accessibilityRole="alert"
          style={styles.noticeSpacer}
        />
      ) : null}

      {failure === 'enable_failed' ? (
        <InlineNotice
          testID="settings-device-notifications-error"
          variant="error"
          title="Couldn't turn notifications on"
          body="K Scan AI alerts are still off for this device. Try again."
          accessibilityRole="alert"
          style={styles.noticeSpacer}
        />
      ) : null}

      {failure === 'permission_denied' && !osBlocked ? (
        <InlineNotice
          testID="settings-device-notifications-error"
          variant="error"
          title="Notifications weren't allowed"
          body="K Scan AI alerts are off for this device because notification permission was not granted. You can try again."
          accessibilityRole="alert"
          style={styles.noticeSpacer}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    gap: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    minHeight: 48,
  },
  loadingText: {
    ...LUXURY.typography.body,
    fontSize: 13,
    color: LUXURY.colors.graphite,
  },
  noticeSpacer: {
    marginTop: SPACING.sm,
  },
});
