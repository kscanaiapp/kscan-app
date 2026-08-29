import React from 'react';
import { Pressable, View, Text, StyleSheet, ViewStyle } from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { KPLUS_EARLY_ACCESS_ENABLED } from '../../constants/featureFlags';
import { KPlusGate } from '../kplus/KPlusGate';

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
    title: '',
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

function FeatureBlockContent({ feature }: { feature: FeatureBlock }) {
  return (
    <>
      <View style={styles.blockHeader}>
        <Text style={styles.title}>{feature.title || ' '}</Text>
        {feature.badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{feature.badge}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.body}>{feature.body}</Text>
    </>
  );
}

function FeatureBlockView({ feature }: { feature: FeatureBlock }) {
  return (
    <View style={styles.block}>
      <FeatureBlockContent feature={feature} />
    </View>
  );
}

/**
 * The Voice Scan acquisition block. Legacy "Coming Soon" placeholder when
 * the K+ boundary isn't rolled out (KPLUS_EARLY_ACCESS_ENABLED off);
 * otherwise a live K+ upgrade surface -- "Upgrade to K+" opens the shared
 * K+ Early Access sheet, "Included with K+" for an active member while
 * Voice Scan itself remains unimplemented. Never opens a nonexistent
 * feature.
 */
function VoiceScanBlock() {
  if (!KPLUS_EARLY_ACCESS_ENABLED) {
    return (
      <FeatureBlockView
        feature={{ title: 'VOICE TO SEARCH', body: 'Future', badge: 'Coming Soon' }}
      />
    );
  }

  return (
    <KPlusGate source="voice_scan_pill">
      {({ isActive, openUpgrade }) => (
        <Pressable
          style={styles.block}
          onPress={isActive ? undefined : openUpgrade}
          disabled={isActive}
          accessibilityRole="button"
          accessibilityLabel={isActive ? 'Voice Scan, included with K+' : 'Voice Scan, upgrade to K+'}
          testID="text-scan-voice-kplus-block"
        >
          <FeatureBlockContent
            feature={{
              title: 'VOICE TO SEARCH',
              body: isActive ? 'Included with your K+ Early Access.' : 'Unlock with K+ Early Access.',
              badge: isActive ? 'Included with K+' : 'Upgrade to K+',
            }}
          />
        </Pressable>
      )}
    </KPlusGate>
  );
}

/**
 * A compact 2×2 feature grid for the TextScan input screen.
 */
export function TextScanFeatureRow({
  showVoicePlaceholder = false,
  style,
}: TextScanFeatureRowProps) {
  return (
    <View style={[styles.root, style]}>
      {FEATURES.map((feature) => (
        <FeatureBlockView key={feature.title || feature.body} feature={feature} />
      ))}
      {showVoicePlaceholder ? <VoiceScanBlock /> : null}
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
