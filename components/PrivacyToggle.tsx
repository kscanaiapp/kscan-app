import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../constants/theme';

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
      disabled={locked}
      onPress={() => onChange(!value)}
      style={[styles.row, value && styles.rowActive, locked && styles.rowDisabled]}
    >
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
      </View>
      {busy ? (
        <View style={styles.busySlot}>
          <ActivityIndicator size="small" color={COLORS.goldPressed} />
        </View>
      ) : (
        <View style={[styles.track, value && styles.trackActive, locked && styles.trackDisabled]}>
          <View style={[styles.thumb, value && styles.thumbActive]} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 96,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    padding: SPACING.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.lg,
  },
  rowActive: {
    borderColor: COLORS.goldMuted,
  },
  rowDisabled: {
    opacity: 0.66,
  },
  copy: {
    flex: 1,
    gap: SPACING.sm,
  },
  title: {
    ...TYPOGRAPHY.title,
    color: COLORS.editorialTextPrimary,
  },
  body: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  track: {
    width: 52,
    height: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.surfaceMuted,
    padding: 3,
    justifyContent: 'center',
  },
  trackActive: {
    borderColor: COLORS.goldMuted,
    backgroundColor: COLORS.goldMuted,
  },
  trackDisabled: {
    backgroundColor: COLORS.surfaceMuted,
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
    backgroundColor: COLORS.editorialTextMuted,
  },
  thumbActive: {
    transform: [{ translateX: 20 }],
    backgroundColor: COLORS.surfaceCard,
  },
});
