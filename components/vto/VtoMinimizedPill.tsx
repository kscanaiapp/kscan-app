/**
 * The persistent affordance for a MINIMIZED try-on.
 *
 * WHY IT EXISTS. Generation takes 15-30s. Holding the user on a modal for
 * that long stalls the commerce flow they were in the middle of -- they can
 * neither read the product details nor look at anything else. Minimizing
 * returns them to the product; this pill is the promise that the work is
 * still running and the way back to it.
 *
 * It reports state, it does not own it. Tapping only reopens the sheet; the
 * generation continues regardless of whether this component is mounted,
 * because the request lives in the module-scoped store, not here.
 */

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import {
  VTO_PILL_READY_LABEL,
  VTO_PILL_RENDERING_LABEL,
} from '../../services/vto/vtoProgressStages';

export interface VtoMinimizedPillProps {
  /** True only once the store reports a validated result. */
  ready: boolean;
  onPress: () => void;
  testID?: string;
}

export function VtoMinimizedPill({ ready, onPress, testID }: VtoMinimizedPillProps) {
  const label = ready ? VTO_PILL_READY_LABEL : VTO_PILL_RENDERING_LABEL;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={
        ready ? 'Opens your finished try-on' : 'Reopens the try-on while it finishes'
      }
      // A still-running try-on is a status message, not an alert.
      accessibilityLiveRegion="polite"
      style={({ pressed }) => [
        styles.pill,
        ready ? styles.pillReady : styles.pillBusy,
        pressed ? styles.pressed : null,
      ]}
      testID={testID ?? 'vto-minimized-pill'}
    >
      <View style={styles.row}>
        {ready ? (
          <View style={styles.readyDot} />
        ) : (
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
        )}
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    marginTop: SPACING.sm,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
  pillBusy: {
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.champagne,
  },
  pillReady: {
    borderColor: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.warmWhite,
  },
  pressed: {
    opacity: 0.7,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  readyDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: LUXURY.colors.plum,
  },
  label: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plumDeep,
    flexShrink: 1,
  },
});
