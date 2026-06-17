import React, { useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { ItemReactions } from './ItemReactions';
import type {
  DressingRoomItem,
  DressingRoomReactionType,
} from '../../types/styleObjects';
import type { ReactionCountsForItem } from './ItemReactions';

type Props = {
  item: DressingRoomItem;
  counts: ReactionCountsForItem;
  selectedReaction: DressingRoomReactionType | null;
  isMutating: boolean;
  onReact: (itemId: string, reactionType: DressingRoomReactionType) => void;
  disabled: boolean;
  onRemove?: () => void;
};

export function RoomScanCard({
  item,
  counts,
  selectedReaction,
  isMutating,
  onReact,
  disabled,
  onRemove,
}: Props) {
  const [imageError, setImageError] = useState(false);
  const hasImage = Boolean(item.imageUrl) && !imageError;

  const statusLabel = item.sourceType
    ? item.sourceType.replace('_', ' ').toUpperCase()
    : null;

  return (
    <View style={styles.card}>
      <View style={styles.imageWrap}>
        {hasImage ? (
          <Image
            source={{ uri: item.imageUrl! }}
            style={styles.image}
            resizeMode="cover"
            onError={() => setImageError(true)}
            accessibilityLabel={`${item.title || 'Item'} image`}
          />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>K</Text>
          </View>
        )}
        {statusLabel ? (
          <View style={styles.statusPill}>
            <Text style={styles.statusText}>{statusLabel}</Text>
          </View>
        ) : null}
        {onRemove ? (
          <Pressable
            style={styles.removeBtn}
            onPress={onRemove}
            accessibilityRole="button"
            accessibilityLabel="Remove item from room"
            hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
          >
            <Text style={styles.removeText}>×</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title || 'Untitled item'}
        </Text>
        {item.brand ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {item.brand}
          </Text>
        ) : null}
        <ItemReactions
          itemId={item.id}
          counts={counts}
          selectedReaction={selectedReaction}
          disabled={disabled}
          isMutating={isMutating}
          onReact={onReact}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  imageWrap: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: LUXURY.colors.champagne,
    position: 'relative',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    fontFamily: LUXURY.typography.brandMark.fontFamily,
    fontSize: 24,
    color: LUXURY.colors.goldBrushed,
  },
  statusPill: {
    position: 'absolute',
    top: SPACING.sm,
    left: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: `${LUXURY.colors.goldBrushed}55`,
    backgroundColor: `${LUXURY.colors.pearl}F2`,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  statusText: {
    ...LUXURY.typography.caption,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.2,
    color: LUXURY.colors.goldBrushed,
  },
  removeBtn: {
    position: 'absolute',
    top: SPACING.sm,
    right: SPACING.sm,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: {
    color: LUXURY.colors.graphite,
    fontSize: 14,
    lineHeight: 18,
  },
  meta: {
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    lineHeight: 20,
    color: LUXURY.colors.ink,
  },
  subtitle: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.2,
    color: LUXURY.colors.stone,
  },
});
