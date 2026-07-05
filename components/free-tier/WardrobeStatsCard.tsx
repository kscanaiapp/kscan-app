/**
 * Free Tier Utility Expansion — wardrobe stats / style summary card.
 * Simple stat chips and bars; all figures based on saved items only.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  FREE_TIER_WARDROBE_STATS_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useWardrobeStats } from '../../hooks/useWardrobeStats';
import type {
  NormalizedItem,
  OutfitFeedbackEntry,
  WearTrackingEntry,
} from '../../services/free-tier/wardrobeUtilityTypes';
import {
  FT_COLORS,
  UtilityBody,
  UtilityCard,
  UtilityChip,
  UtilityRow,
  UtilityStatBar,
  UtilityTitle,
} from './freeTierUi';

export function WardrobeStatsCard(props: {
  items: NormalizedItem[];
  feedback?: Record<string, OutfitFeedbackEntry>;
  wear?: Record<string, WearTrackingEntry>;
}) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_WARDROBE_STATS_ENABLED);
  const stats = useWardrobeStats(props.items, {
    feedback: props.feedback,
    wear: props.wear,
  });
  if (!enabled) return null;
  if (stats.totalItems === 0) {
    return (
      <UtilityCard>
        <UtilityTitle kicker="Based on saved items">Your style at a glance</UtilityTitle>
        <UtilityBody>Save a scan to start building your closet memory.</UtilityBody>
      </UtilityCard>
    );
  }

  const maxCategory = stats.topCategories[0]?.count ?? 1;
  return (
    <UtilityCard>
      <UtilityTitle kicker="Based on saved items">{stats.progressLabel}</UtilityTitle>
      <View style={styles.summaryRow}>
        <Text style={styles.bigNumber}>{stats.totalItems}</Text>
        <Text style={styles.bigNumberLabel}>saved items</Text>
        {typeof stats.averageRating === 'number' ? (
          <Text style={styles.avgRating}>
            {stats.averageRating.toFixed(1)}★ avg ({stats.ratedCount} rated)
          </Text>
        ) : null}
      </View>
      {stats.topCategories.length > 0 ? (
        <View style={styles.block}>
          <Text style={styles.blockLabel}>Most saved categories</Text>
          {stats.topCategories.map((c) => (
            <UtilityStatBar
              key={c.label}
              label={c.label + ' · ' + c.count}
              ratio={c.count / maxCategory}
            />
          ))}
        </View>
      ) : null}
      {stats.topColors.length > 0 ? (
        <View style={styles.block}>
          <Text style={styles.blockLabel}>Top colors</Text>
          <UtilityRow>
            {stats.topColors.map((c) => (
              <UtilityChip key={c.label} label={c.label + ' · ' + c.count} />
            ))}
          </UtilityRow>
        </View>
      ) : null}
      {stats.topBrands.length > 0 ? (
        <View style={styles.block}>
          <Text style={styles.blockLabel}>Favorite brands</Text>
          <UtilityRow>
            {stats.topBrands.map((b) => (
              <UtilityChip key={b.label} label={b.label} />
            ))}
          </UtilityRow>
        </View>
      ) : null}
      {stats.mostWorn ? (
        <UtilityBody>
          Most worn:{' '}
          {stats.mostWorn.item.title ?? stats.mostWorn.item.category ?? 'saved item'} (
          {stats.mostWorn.wearCount}×)
        </UtilityBody>
      ) : null}
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  summaryRow: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 10, flexWrap: 'wrap' },
  bigNumber: { fontSize: 28, fontWeight: '700', color: FT_COLORS.plum, marginRight: 6 },
  bigNumberLabel: { fontSize: 13, color: FT_COLORS.textMuted, marginRight: 12 },
  avgRating: { fontSize: 13, color: FT_COLORS.goldText },
  block: { marginBottom: 10 },
  blockLabel: {
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: FT_COLORS.textMuted,
    marginBottom: 6,
  },
});
