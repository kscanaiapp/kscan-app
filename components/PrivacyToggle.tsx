import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../constants/theme';

interface PrivacyToggleProps {
  title: string;
  body: string;
  value: boolean;
  disabled?: boolean;
  /** Saving to backend or local store — shows inline busy state */
  busy?: boolean;
  onChange: (value: boolean) => void;
}

export function PrivacyToggle({ title, body, value, disabled, busy, onChange }: PrivacyToggleProps) {
  const locked = Boolean(disabled) || Boolean(busy);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: locked }}
      accessibilityLabel={title}
      accessibilityHint={value ? 'Toggle off' : 'Toggle on'}
      disabled={locked}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [
        styles.row,
        value && styles.rowActive,
        locked && styles.rowDisabled,
        pressed && !locked && styles.rowPressed,
      ]}
    >
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
      </View>
      {busy ? (
        <View style={styles.busySlot}>
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
        </View>
      ) : (
        <View
          style={[
            styles.track,
            value && styles.trackActive,
            locked && styles.trackDisabled,
          ]}
          accessibilityElementsHidden
        >
          <View style={[styles.thumb, value && styles.thumbActive]} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 96,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    padding: SPACING.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.lg,
  },
  rowActive: {
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.plumMuted,
  },
  rowPressed: {
    backgroundColor: LUXURY.colors.pearl,
  },
  rowDisabled: {
    opacity: 0.62,
  },
  copy: {
    flex: 1,
    gap: SPACING.sm,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  body: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    fontSize: 13,
    lineHeight: 20,
  },
  track: {
    width: 52,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: 3,
    justifyContent: 'center',
  },
  trackActive: {
    borderColor: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.plum,
  },
  trackDisabled: {
    backgroundColor: LUXURY.colors.cream,
  },
  busySlot: {
    width: 52,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: LUXURY.colors.stone,
  },
  thumbActive: {
    transform: [{ translateX: 20 }],
    backgroundColor: LUXURY.colors.inverse,
  },
});
