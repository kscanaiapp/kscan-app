/**
 * Free Tier Utility Expansion — one suggested/saved outfit card.
 */

import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type {
  NormalizedItem,
  SuggestedOutfit,
} from '../../services/free-tier/wardrobeUtilityTypes';
import {
  FT_COLORS,
  UtilityButton,
  UtilityCard,
  UtilityChip,
  UtilityRow,
} from './freeTierUi';

function itemLabel(item: NormalizedItem): string {
  return (
    item.title ?? ([item.color, item.category].filter(Boolean).join(' ') || 'Saved item')
  );
}

export function SavedOutfitCard(props: {
  outfit: SuggestedOutfit;
  onSaveLook?: (outfit: SuggestedOutfit) => void;
  onShare?: (outfit: SuggestedOutfit) => void;
}) {
  const { outfit } = props;
  if (!outfit || outfit.items.length === 0) return null;
  return (
    <UtilityCard>
      <Text style={styles.title}>{outfit.title}</Text>
      <View style={styles.itemsRow}>
        {outfit.items.slice(0, 4).map((item) => (
          <View key={item.id} style={styles.itemCell}>
            {item.imageUri ? (
              <Image source={{ uri: item.imageUri }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbFallback]}>
                <Text style={styles.thumbFallbackText} numberOfLines={2}>
                  {item.category ?? 'Item'}
                </Text>
              </View>
            )}
            <Text style={styles.itemLabel} numberOfLines={2}>
              {itemLabel(item)}
            </Text>
          </View>
        ))}
      </View>
      <UtilityRow>
        {outfit.reasonLabels.slice(0, 2).map((reason) => (
          <UtilityChip key={reason} label={reason} />
        ))}
      </UtilityRow>
      <UtilityRow>
        {props.onSaveLook ? (
          <UtilityButton label="Save as look" onPress={() => props.onSaveLook?.(outfit)} />
        ) : null}
        {props.onShare ? (
          <UtilityButton label="Share" subtle onPress={() => props.onShare?.(outfit)} />
        ) : null}
      </UtilityRow>
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 14, fontWeight: '600', color: FT_COLORS.plum, marginBottom: 10 },
  itemsRow: { flexDirection: 'row', marginBottom: 8 },
  itemCell: { width: 72, marginRight: 10 },
  thumb: { width: 64, height: 64, borderRadius: 12, backgroundColor: FT_COLORS.surfaceSoft },
  thumbFallback: { alignItems: 'center', justifyContent: 'center', padding: 4 },
  thumbFallbackText: { fontSize: 10, color: FT_COLORS.textMuted, textAlign: 'center' },
  itemLabel: { fontSize: 10, color: FT_COLORS.textMuted, marginTop: 4 },
});
