import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';

export interface TextScanFeatureRowProps {
  showVoicePlaceholder?: boolean;
  style?: ViewStyle;
}

interface FeatureBlock {
  title: string;
  body: string;
  badge?: string;
}

const FEATURES: FeatureBlock[] = [
  {
    title: 'AI STAR POWERED',
    body: 'Advanced AI understands natural language fashion queries with precision.',
  },
  {
    title: 'SMART COMPARISON',
    body: 'Retail and resale side by side so you can compare options.',
  },
  {
    title: 'PRIVATE BY DESIGN',
    body: 'Your searches and style preferences stay under your control.',
  },
  {
    title: 'STYLE-FIRST SEARCH',
    body: 'Describe silhouette, fabric, color, budget, and mood in your own words.',
  },
];

/**
 * A compact 2×2 feature grid for the TextScan input screen.
 */
export function TextScanFeatureRow({
  showVoicePlaceholder = false,
  style,
}: TextScanFeatureRowProps) {
  const blocks = showVoicePlaceholder
    ? [
        ...FEATURES,
        {
          title: 'VOICE TO SEARCH',
          body: 'Future',
          badge: 'Coming Soon',
        },
      ]
    : FEATURES;

  return (
    <View style={[styles.root, style]}>
      {blocks.map((feature) => (
        <View key={feature.title} style={styles.block}>
          <View style={styles.blockHeader}>
            <Text style={styles.title}>{feature.title}</Text>
            {feature.badge ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{feature.badge}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.body}>{feature.body}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
  block: {
    width: '47%',
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  blockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.xs,
    marginBottom: SPACING.xs,
  },
  title: {
    ...LUXURY.typography.caption,
    flex: 1,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: LUXURY.colors.goldText,
  },
  badge: {
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plumMuted,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  badgeText: {
    ...LUXURY.typography.caption,
    fontSize: 8,
    fontWeight: '700',
    color: LUXURY.colors.plum,
  },
  body: {
    ...LUXURY.typography.body,
    fontSize: 12,
    lineHeight: 18,
    color: LUXURY.colors.graphite,
  },
});
