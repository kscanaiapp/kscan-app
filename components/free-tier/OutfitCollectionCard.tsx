/**
 * Free Tier Utility Expansion — one collection / lookbook card.
 */

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import type { OutfitCollection } from '../../services/free-tier/wardrobeUtilityTypes';
import { FT_COLORS, UtilityButton, UtilityCard, UtilityRow } from './freeTierUi';

export function OutfitCollectionCard(props: {
  collection: OutfitCollection;
  onRename?: (collection: OutfitCollection) => void;
  onDelete?: (collection: OutfitCollection) => void;
  onOpen?: (collection: OutfitCollection) => void;
}) {
  const { collection } = props;
  return (
    <UtilityCard>
      <Text style={styles.name}>{collection.name}</Text>
      <Text style={styles.meta}>
        {collection.itemIds.length}
        {collection.itemIds.length === 1 ? ' item' : ' items'}
      </Text>
      <UtilityRow>
        {props.onOpen ? (
          <UtilityButton label="Open" onPress={() => props.onOpen?.(collection)} />
        ) : null}
        {props.onRename ? (
          <UtilityButton label="Rename" subtle onPress={() => props.onRename?.(collection)} />
        ) : null}
        {props.onDelete ? (
          <UtilityButton label="Delete" subtle onPress={() => props.onDelete?.(collection)} />
        ) : null}
      </UtilityRow>
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 15, fontWeight: '600', color: FT_COLORS.plum },
  meta: { fontSize: 12, color: FT_COLORS.textMuted, marginTop: 2 },
});
