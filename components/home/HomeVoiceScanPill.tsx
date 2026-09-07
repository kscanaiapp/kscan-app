import React from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { KPlusGate } from '../kplus/KPlusGate';
import { VoiceScanIcon } from '../icons/kscan';
import { VOICESCAN_ENABLED } from '../../constants/featureFlags';
import { isVoicePlatformProvisioned } from '../../services/voice/voiceRecognition';
import { getPlatform } from '../../services/voice/voiceNativeModule';
import type { KPlusResolvedState } from '../../types/entitlements';

export interface HomeVoiceScanPillProps {
  style?: ViewStyle;
}

interface HomeVoiceScanPillInnerProps {
  state: KPlusResolvedState;
  isActive: boolean;
  openUpgrade: () => void;
  style?: ViewStyle;
}

/**
 * Presentation-only. Visibility is the VOICESCAN_ENABLED build-capability
 * flag (gated by the caller, see HomeVoiceScanPill below); K+ entitlement
 * only ever decides whether the pill renders ENTITLED or LOCKED. Tapping
 * ENTITLED navigates to the existing TextScan screen, where the existing
 * K+-gated VoiceScanButton/useVoiceScan is the one and only functional Voice
 * Scan entry point -- this pill never starts a session, requests the
 * microphone, or duplicates that eligibility check.
 */
function HomeVoiceScanPillInner({ state, isActive, openUpgrade, style }: HomeVoiceScanPillInnerProps) {
  const resolving = state === 'loading';
  const locked = !resolving && !isActive;

  const handlePress = () => {
    if (resolving) return;
    if (locked) {
      openUpgrade();
      return;
    }
    router.push('/text-scan');
  };

  const accessibilityLabel = resolving
    ? 'Voice Scan, K Plus feature. Checking your access.'
    : isActive
      ? 'Voice Scan, K Plus feature. Starts voice search.'
      : 'Voice Scan, K Plus feature, not currently available on your account. Tap to learn more.';

  const muted = resolving || locked;

  return (
    <Pressable
      testID="home-luxury-voicescan"
      onPress={handlePress}
      disabled={resolving}
      style={[styles.pill, muted && styles.pillMuted, style]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: resolving }}
    >
      <VoiceScanIcon size={20} color={muted ? LUXURY.colors.stone : LUXURY.colors.plum} />
      <Text style={[styles.title, muted && styles.titleMuted]}>VOICESCAN</Text>
      {!resolving && (
        <View style={[styles.badge, isActive ? styles.badgeIncluded : styles.badgeLocked]}>
          <Text style={[styles.badgeText, isActive ? styles.badgeTextIncluded : styles.badgeTextLocked]}>
            {isActive ? 'INCLUDED' : 'K+'}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * Home's Voice Scan pill (full-width, directly above TEXTSCAN).
 *
 * VISIBILITY is the VoiceScan build-capability authority alone --
 * VOICESCAN_ENABLED plus the same native-provisioning check
 * VoiceScanButton already uses -- never K+ entitlement. A build that cannot
 * execute Voice Scan at all must never advertise it, regardless of who is
 * signed in. K+ entitlement only ever decides whether a rendered pill shows
 * ENTITLED or LOCKED (see HomeVoiceScanPillInner).
 */
export function HomeVoiceScanPill({ style }: HomeVoiceScanPillProps) {
  if (!VOICESCAN_ENABLED) return null;
  if (!isVoicePlatformProvisioned(getPlatform())) return null;

  return (
    <KPlusGate source="voice_scan">
      {({ state, isActive, openUpgrade }) => (
        <HomeVoiceScanPillInner state={state} isActive={isActive} openUpgrade={openUpgrade} style={style} />
      )}
    </KPlusGate>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    height: LUXURY.buttons.secondary.height,
    borderRadius: LUXURY.buttons.secondary.borderRadius,
    borderWidth: LUXURY.buttons.secondary.borderWidth,
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.buttons.secondary.backgroundColor,
    paddingHorizontal: LUXURY.buttons.secondary.paddingHorizontal,
    gap: SPACING.sm,
  },
  pillMuted: {
    borderColor: LUXURY.colors.border,
  },
  title: {
    color: LUXURY.colors.plum,
    letterSpacing: LUXURY.buttons.secondary.letterSpacing,
    fontSize: LUXURY.buttons.secondary.fontSize,
    fontWeight: LUXURY.buttons.secondary.fontWeight,
  },
  titleMuted: {
    color: LUXURY.colors.stone,
  },
  badge: {
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  badgeIncluded: {
    backgroundColor: LUXURY.colors.plumMuted,
  },
  badgeLocked: {
    backgroundColor: LUXURY.colors.border,
  },
  badgeText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    fontWeight: '800',
  },
  badgeTextIncluded: {
    color: LUXURY.colors.plum,
  },
  badgeTextLocked: {
    color: LUXURY.colors.graphite,
  },
});
