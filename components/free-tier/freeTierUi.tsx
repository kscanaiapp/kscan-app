/**
 * Free Tier Utility Expansion — shared UI primitives.
 * Calm editorial styling on the K Scan brand palette: pearl/ivory surfaces,
 * deep plum text/actions, champagne-gold accents. No gaudy gamification.
 */

import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { COLORS, RADIUS, SPACING } from '../../constants/theme';

export const FT_COLORS = {
  surface: '#FCFAF6',
  surfaceSoft: '#F5F0E8',
  border: '#E7D4A8',
  plum: '#3F0B2F',
  plumSoft: '#6E1F55',
  gold: '#C6A15B',
  goldText: '#7A5624',
  textPrimary: COLORS.textPrimary ?? '#2A1420',
  textMuted: '#6F5A66',
};

export function UtilityCard(props: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, props.style]}>{props.children}</View>;
}

export function UtilityTitle(props: { children: React.ReactNode; kicker?: string }) {
  return (
    <View style={styles.titleBlock}>
      {props.kicker ? <Text style={styles.kicker}>{props.kicker}</Text> : null}
      <Text style={styles.title}>{props.children}</Text>
    </View>
  );
}

export function UtilityBody(props: { children: React.ReactNode }) {
  return <Text style={styles.body}>{props.children}</Text>;
}

export function UtilityChip(props: {
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={!props.onPress}
      accessibilityRole={props.onPress ? 'button' : undefined}
      style={[styles.chip, props.active && styles.chipActive]}
    >
      <Text style={[styles.chipText, props.active && styles.chipTextActive]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function UtilityButton(props: {
  label: string;
  onPress?: () => void;
  subtle?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        props.subtle && styles.buttonSubtle,
        (pressed || props.disabled) && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonText, props.subtle && styles.buttonTextSubtle]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function UtilityStatBar(props: { label: string; ratio: number }) {
  const ratio = Math.max(0, Math.min(1, props.ratio));
  return (
    <View style={styles.statBarRow}>
      <Text style={styles.statBarLabel} numberOfLines={1}>
        {props.label}
      </Text>
      <View style={styles.statBarTrack}>
        <View style={[styles.statBarFill, { width: `${(ratio * 100).toFixed(0)}%` } as ViewStyle]} />
      </View>
    </View>
  );
}

export function UtilityRow(props: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, props.style]}>{props.children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: FT_COLORS.surface,
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: FT_COLORS.border,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
  },
  titleBlock: { marginBottom: SPACING.sm },
  kicker: {
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: FT_COLORS.goldText,
    marginBottom: 2,
  },
  title: { fontSize: 16, fontWeight: '600', color: FT_COLORS.plum },
  body: { fontSize: 13, lineHeight: 19, color: FT_COLORS.textMuted },
  chip: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: FT_COLORS.border,
    backgroundColor: FT_COLORS.surfaceSoft,
    marginRight: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  chipActive: { backgroundColor: FT_COLORS.plum, borderColor: FT_COLORS.plum },
  chipText: { fontSize: 12, color: FT_COLORS.plum },
  chipTextActive: { color: '#FFFDF9' },
  button: {
    backgroundColor: FT_COLORS.plum,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    alignSelf: 'flex-start',
    marginRight: SPACING.sm,
    marginTop: SPACING.sm,
  },
  buttonSubtle: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: FT_COLORS.border,
  },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: '#FFFDF9', fontSize: 13, fontWeight: '600' },
  buttonTextSubtle: { color: FT_COLORS.plum },
  statBarRow: { marginBottom: SPACING.sm },
  statBarLabel: { fontSize: 12, color: FT_COLORS.textMuted, marginBottom: 3 },
  statBarTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: FT_COLORS.surfaceSoft,
    overflow: 'hidden',
  },
  statBarFill: { height: 6, borderRadius: 3, backgroundColor: FT_COLORS.gold },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
});
