/**
 * Free Tier Utility Expansion — wear-again suggestion card (P2 shell).
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  FREE_TIER_WEAR_AGAIN_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useWearAgainSuggestions } from '../../hooks/useWearAgainSuggestions';
import type {
  NormalizedItem,
  OutfitFeedbackEntry,
  WearTrackingEntry,
} from '../../services/free-tier/wardrobeUtilityTypes';
import { FT_COLORS, UtilityCard, UtilityTitle } from './freeTierUi';

export function WearAgainSuggestionCard(props: {
  items: NormalizedItem[];
  feedback?: Record<string, OutfitFeedbackEntry>;
  wear?: Record<string, WearTrackingEntry>;
}) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_WEAR_AGAIN_ENABLED);
  const suggestions = useWearAgainSuggestions(props.items, {
    feedback: props.feedback,
    wear: props.wear,
    limit: 3,
  });
  if (!enabled || suggestions.length === 0) return null;

  return (
    <UtilityCard>
      <UtilityTitle kicker="Wear again">You liked these before</UtilityTitle>
      {suggestions.map(({ item, reason }) => (
        <View key={item.id} style={styles.row}>
          <Text style={styles.itemTitle} numberOfLines={1}>
            {item.title ?? ([item.color, item.category].filter(Boolean).join(' ') || 'Saved item')}
          </Text>
          <Text style={styles.reason} numberOfLines={1}>
            {reason}
          </Text>
        </View>
      ))}
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: 8 },
  itemTitle: { fontSize: 13, fontWeight: '600', color: FT_COLORS.plum },
  reason: { fontSize: 11, color: FT_COLORS.textMuted },
});
