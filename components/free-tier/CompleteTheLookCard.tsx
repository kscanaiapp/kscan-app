/**
 * Free Tier Utility Expansion — "Complete the look" pairing suggestions.
 * Rules-based; copy avoids AI claims and overstatement.
 */

import React, { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import {
  FREE_TIER_OUTFIT_GENERATOR_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { suggestPairings } from '../../services/free-tier/pairingSuggestions';
import type {
  NormalizedItem,
  OutfitFeedbackEntry,
} from '../../services/free-tier/wardrobeUtilityTypes';
import { FT_COLORS, UtilityCard, UtilityTitle } from './freeTierUi';

export function CompleteTheLookCard(props: {
  anchor?: NormalizedItem | null;
  savedItems: NormalizedItem[];
  feedback?: Record<string, OutfitFeedbackEntry>;
}) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_OUTFIT_GENERATOR_ENABLED);
  const pairings = useMemo(
    () => suggestPairings(props.anchor, props.savedItems, { feedback: props.feedback }),
    [props.anchor, props.savedItems, props.feedback]
  );
  if (!enabled || pairings.length === 0) return null;

  return (
    <UtilityCard>
      <UtilityTitle kicker="Complete the look">
        These saved items may work together
      </UtilityTitle>
      {pairings.map(({ item, reason }) => (
        <View key={item.id} style={styles.row}>
          {item.imageUri ? (
            <Image source={{ uri: item.imageUri }} style={styles.thumb} />
          ) : (
            <View style={[styles.thumb, styles.thumbFallback]} />
          )}
          <View style={styles.text}>
            <Text style={styles.itemTitle} numberOfLines={1}>
              {item.title ?? ([item.color, item.category].filter(Boolean).join(' ') || 'Saved item')}
            </Text>
            <Text style={styles.reason} numberOfLines={1}>
              {reason}
            </Text>
          </View>
        </View>
      ))}
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  thumb: { width: 40, height: 40, borderRadius: 10, marginRight: 10, backgroundColor: FT_COLORS.surfaceSoft },
  thumbFallback: { borderWidth: 1, borderColor: FT_COLORS.border },
  text: { flex: 1 },
  itemTitle: { fontSize: 13, fontWeight: '600', color: FT_COLORS.plum },
  reason: { fontSize: 11, color: FT_COLORS.textMuted },
});
