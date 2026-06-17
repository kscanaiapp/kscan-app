import React from 'react';
import {
  Dimensions,
  StyleSheet,
  View,
} from 'react-native';
import { EmptyStateCard } from '../../components/luxury';
import { SPACING } from '../../constants/theme';
import { RoomScanCard } from './RoomScanCard';
import type {
  DressingRoomItem,
  DressingRoomReactionType,
} from '../../types/styleObjects';
import type { ReactionCountsForItem } from './ItemReactions';

const SCREEN_W = Dimensions.get('window').width;
const CARD_W = Math.floor((SCREEN_W - SPACING.xl * 2 - SPACING.md) / 2);

type Props = {
  items: DressingRoomItem[];
  reactionCounts: Record<string, ReactionCountsForItem>;
  selectedReactions: Record<string, DressingRoomReactionType | null>;
  mutatingReactionItemId: string | null;
  onReact: (itemId: string, reactionType: DressingRoomReactionType) => void;
  isAuthenticated: boolean;
  onRemoveItem: (itemId: string) => void;
};

export function RoomScansGrid({
  items,
  reactionCounts,
  selectedReactions,
  mutatingReactionItemId,
  onReact,
  isAuthenticated,
  onRemoveItem,
}: Props) {
  if (items.length === 0) {
    return (
      <EmptyStateCard
        title="No scans shared to this room yet."
        subtitle="Add catalog matches from scan results when they include remote product images."
      />
    );
  }

  const pairs = items.reduce<
    [DressingRoomItem, DressingRoomItem | null][]
  >((acc, item, i) => {
    if (i % 2 === 0) acc.push([item, items[i + 1] ?? null]);
    return acc;
  }, []);

  return (
    <View style={styles.container}>
      {pairs.map(([a, b]) => (
        <View key={a.id} style={styles.row}>
          <View style={{ width: CARD_W }}>
            <RoomScanCard
              item={a}
              counts={reactionCounts[a.id] ?? { love: 0, like: 0, looking: 0, thumbs_down: 0 }}
              selectedReaction={selectedReactions[a.id] ?? null}
              isMutating={mutatingReactionItemId === a.id}
              onReact={onReact}
              disabled={!isAuthenticated}
              onRemove={() => onRemoveItem(a.id)}
            />
          </View>
          {b ? (
            <View style={{ width: CARD_W }}>
              <RoomScanCard
                item={b}
                counts={reactionCounts[b.id] ?? { love: 0, like: 0, looking: 0, thumbs_down: 0 }}
                selectedReaction={selectedReactions[b.id] ?? null}
                isMutating={mutatingReactionItemId === b.id}
                onReact={onReact}
                disabled={!isAuthenticated}
                onRemove={() => onRemoveItem(b.id)}
              />
            </View>
          ) : (
            <View style={{ width: CARD_W }} />
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.md,
  },
  row: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginBottom: SPACING.md,
  },
});
