import React from 'react';
import { View, Text, Pressable, Switch, StyleSheet } from 'react-native';
import { PrimaryButton, TertiaryButton } from '../../components/luxury';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';

import type { PermissionKey, PermissionPreferences } from '../../hooks/usePermissionPreferences';

interface PermissionsStepV1Props {
  preferences: PermissionPreferences;
  togglePreference: (key: PermissionKey) => void;
  setPreference: (key: PermissionKey, value: boolean) => void;
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
 * - Camera and Photos only; unimplemented permissions are not advertised
 * - Continue to Home CTA and Not now link
 *
 * Build 33: the Microphone and Notifications "Coming Soon" cards were removed.
 * Neither capability is implemented, and advertising them on a reviewer-visible
 * onboarding screen reads as an incomplete app. K Scan requests no microphone
 * permission on any platform; camera and photos remain point-of-use grants.
 */
export function PermissionsStepV1({
  preferences,
  togglePreference,
  setPreference,
  isSaving,
  onContinueToHome,
  onNotNow,
}: PermissionsStepV1Props) {
  const { camera, photos } = preferences;

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
  actionType: 'allow' | 'toggle';
  actionValue: boolean;
  onActionChange: (value: boolean) => void;
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
  actionValue,
  onActionChange,
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
          {actionType === 'allow' ? (
            <Pressable
              onPress={() => !disabled && onActionChange(!actionValue)}
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
