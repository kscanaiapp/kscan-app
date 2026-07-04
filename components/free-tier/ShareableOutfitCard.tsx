/**
 * Free Tier Utility Expansion — shareable outfit card UI.
 * Displays what will be shared (title, item list, watermark) with a share CTA.
 */

import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import {
  FREE_TIER_SHARE_CARD_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { SHARE_WATERMARK } from '../../services/free-tier/shareTextBuilder';
import type {
  NormalizedItem,
  SuggestedOutfit,
} from '../../services/free-tier/wardrobeUtilityTypes';
import { ShareOutfitButton } from './ShareOutfitButton';
import { FT_COLORS, UtilityCard } from './freeTierUi';

export function ShareableOutfitCard(props: {
  outfit?: SuggestedOutfit | null;
  item?: NormalizedItem | null;
}) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_SHARE_CARD_ENABLED);
  if (!enabled || (!props.outfit && !props.item)) return null;
  const items: NormalizedItem[] = props.outfit?.items ?? (props.item ? [props.item] : []);
  const title = props.outfit?.title ?? props.item?.title ?? 'A look from my saved items';
  const image = items.find((i) => i.imageUri)?.imageUri;

  return (
    <UtilityCard>
      <Text style={styles.title}>{title}</Text>
      {image ? <Image source={{ uri: image }} style={styles.image} /> : null}
      {items.map((item) => (
        <Text key={item.id} style={styles.itemLine} numberOfLines={1}>
          • {item.title ?? ([item.color, item.category].filter(Boolean).join(' ') || 'Saved item')}
        </Text>
      ))}
      <Text style={styles.watermark}>{SHARE_WATERMARK}</Text>
      <View style={styles.actions}>
        <ShareOutfitButton item={props.item} outfit={props.outfit} />
      </View>
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 15, fontWeight: '600', color: FT_COLORS.plum, marginBottom: 8 },
  image: {
    width: '100%',
    height: 160,
    borderRadius: 14,
    marginBottom: 8,
    backgroundColor: FT_COLORS.surfaceSoft,
  },
  itemLine: { fontSize: 13, color: FT_COLORS.textMuted, marginBottom: 2 },
  watermark: {
    fontSize: 11,
    color: FT_COLORS.goldText,
    letterSpacing: 0.5,
    marginTop: 6,
  },
  actions: { flexDirection: 'row' },
});
