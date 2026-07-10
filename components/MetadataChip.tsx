import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS, LUXURY, SPACING, TYPOGRAPHY, chip } from '../constants/theme';

const EMPTY_VALUE = '—';

interface MetadataChipProps {
  label: string;
  value: string;
}

function formatLabel(label: string) {
  return (label || '').trim().toUpperCase();
}

export function MetadataChip({ label, value }: MetadataChipProps) {
  const displayLabel = formatLabel(label);
  const displayValue = value?.trim() || EMPTY_VALUE;

  return (
    <View
      style={styles.chip}
      accessible
      accessibilityLabel={`${displayLabel}: ${displayValue}`}
    >
      <Text style={styles.label}>{displayLabel}</Text>
      <Text style={styles.value} numberOfLines={2}>
        {displayValue}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight:         chip.minHeight,
    minWidth:          chip.minWidth,
    paddingHorizontal: chip.paddingHorizontal,
    paddingVertical:   chip.paddingVertical,
    borderRadius:      chip.borderRadius,
    borderWidth:       1,
    borderColor:       LUXURY.colors.border,
    borderLeftWidth:   3,
    borderLeftColor:   LUXURY.colors.gold,
    backgroundColor:   LUXURY.colors.cream,
    justifyContent:    'center',
  },
  label: {
    ...LUXURY.typography.caption,
    marginBottom: chip.labelMarginBottom,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
  },
  value: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    paddingRight: SPACING.xs,
  },
});
