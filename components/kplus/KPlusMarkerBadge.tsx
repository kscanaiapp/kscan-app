// Small shared K+ marker badge, extracted from the shipped Voice Scan pill
// treatment (components/home/HomeVoiceScanPill.tsx) so Home entries can mark
// K+ features without inventing a new badge family.
//
// Presentation-only. It owns no entitlement state: callers render
//   state="locked"   -> "K+"        (free / eligible, feature available via K+)
//   state="included" -> "INCLUDED"  (active K+ entitlement)
// and MUST render nothing at all while the entitlement is still resolving
// (RESOLVING != FREE -- see KPlusGateRenderArgs.resolving). Never show
// "INCLUDED" unless the entitlement is actually active.
import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export interface KPlusMarkerBadgeProps {
  state: 'locked' | 'included';
  testID?: string;
  style?: ViewStyle;
}

export function KPlusMarkerBadge({ state, testID, style }: KPlusMarkerBadgeProps) {
  const included = state === 'included';
  return (
    <View
      testID={testID}
      style={[styles.badge, included ? styles.badgeIncluded : styles.badgeLocked, style]}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no"
      accessibilityElementsHidden
    >
      <Text style={[styles.badgeText, included ? styles.badgeTextIncluded : styles.badgeTextLocked]}>
        {included ? 'INCLUDED' : 'K+'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
