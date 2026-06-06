import React, { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import {
  DRESSING_ROOM_REACTION_TYPES,
  type DressingRoomReactionType,
} from '../../types/styleObjects';

export type ReactionCountsForItem = Record<DressingRoomReactionType, number>;

const REACTION_META: Record<
  DressingRoomReactionType,
  { emoji: string; label: string }
> = {
  love: { emoji: '❤️', label: 'love' },
  like: { emoji: '👍', label: 'like' },
  looking: { emoji: '👀', label: 'looking' },
  favorite: { emoji: '🔥', label: 'favorite' },
};

type ItemReactionsProps = {
  itemId: string;
  counts: ReactionCountsForItem;
  selectedReaction: DressingRoomReactionType | null;
  disabled?: boolean;
  isMutating?: boolean;
  onReact?: (itemId: string, reactionType: DressingRoomReactionType) => void;
};

function ItemReactionsComponent({
  itemId,
  counts,
  selectedReaction,
  disabled = false,
  isMutating = false,
  onReact,
}: ItemReactionsProps) {
  const reactions = useMemo(
    () =>
      DRESSING_ROOM_REACTION_TYPES.map((reactionType) => ({
        reactionType,
        count: counts[reactionType] ?? 0,
        ...REACTION_META[reactionType],
      })),
    [counts],
  );

  return (
    <View style={styles.row}>
      {reactions.map(({ reactionType, emoji, label, count }) => {
        const selected = selectedReaction === reactionType;
        const buttonDisabled = disabled || isMutating || !onReact;
        return (
          <Pressable
            key={reactionType}
            accessibilityRole="button"
            accessibilityLabel={`${label} reaction, count ${count}`}
            accessibilityState={{ disabled: buttonDisabled, selected }}
            disabled={buttonDisabled}
            onPress={() => onReact?.(itemId, reactionType)}
            style={({ pressed }) => [
              styles.reactionButton,
              selected ? styles.reactionButtonSelected : null,
              buttonDisabled ? styles.reactionButtonDisabled : null,
              pressed && !buttonDisabled ? styles.reactionButtonPressed : null,
            ]}
          >
            <Text style={styles.emoji}>{emoji}</Text>
            <Text style={[styles.count, selected ? styles.countSelected : null]}>{count}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export const ItemReactions = memo(ItemReactionsComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
    paddingTop: SPACING.xs,
  },
  reactionButton: {
    minHeight: 32,
    minWidth: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    paddingHorizontal: SPACING.sm,
  },
  reactionButtonSelected: {
    borderColor: COLORS.goldPressed,
    backgroundColor: COLORS.accentSoft,
  },
  reactionButtonDisabled: {
    opacity: 0.72,
  },
  reactionButtonPressed: {
    backgroundColor: COLORS.surfaceCard,
  },
  emoji: {
    fontSize: 14,
  },
  count: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextSecondary,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  countSelected: {
    color: COLORS.goldPressed,
  },
});
