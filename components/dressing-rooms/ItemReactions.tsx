import React, { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import {
  ACTIVE_DRESSING_ROOM_REACTION_TYPES,
  type ActiveDressingRoomReactionType,
  type DressingRoomReactionType,
} from '../../types/styleObjects';

export type ReactionCountsForItem = Record<ActiveDressingRoomReactionType, number>;

const REACTION_META: Record<
  ActiveDressingRoomReactionType,
  { emoji: string; label: string }
> = {
  love: { emoji: '❤️', label: 'love' },
  like: { emoji: '👍', label: 'like' },
  looking: { emoji: '👀', label: 'looking' },
  thumbs_down: { emoji: '👎', label: 'Not it' },
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
      ACTIVE_DRESSING_ROOM_REACTION_TYPES.map((reactionType) => ({
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
            accessibilityLabel={`${label} reaction, count ${count}${selected ? ', selected' : ''}`}
            accessibilityHint={buttonDisabled ? undefined : `Toggle ${label} reaction`}
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
    minHeight: 36,
    minWidth: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    paddingHorizontal: SPACING.sm,
  },
  reactionButtonSelected: {
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.plumMuted,
  },
  reactionButtonDisabled: {
    opacity: 0.6,
  },
  reactionButtonPressed: {
    backgroundColor: LUXURY.colors.pearl,
  },
  emoji: {
    fontSize: 14,
  },
  count: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  countSelected: {
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
});
