import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SharedScanCard } from '../../components/luxury';
import { RoomMessagesPanel } from '../../components/rooms/RoomMessagesPanel';
import { ItemReactions } from './ItemReactions';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type {
  DressingRoomItem,
  DressingRoomReactionType,
} from '../../types/styleObjects';
import type { ReactionCountsForItem } from './ItemReactions';

type Props = {
  roomId: string;
  items: DressingRoomItem[];
  reactionCounts: Record<string, ReactionCountsForItem>;
  selectedReactions: Record<string, DressingRoomReactionType | null>;
  mutatingReactionItemId: string | null;
  onReact: (itemId: string, reactionType: DressingRoomReactionType) => void;
  isAuthenticated: boolean;
};

export function RoomChatBoard({
  roomId,
  items,
  reactionCounts,
  selectedReactions,
  mutatingReactionItemId,
  onReact,
  isAuthenticated,
}: Props) {
  const heroItem = items[0] ?? null;
  const railItems = items.slice(1, 5);

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {heroItem ? (
          <View style={styles.heroSection}>
            <SharedScanCard
              imageUrl={heroItem.imageUrl}
              title={heroItem.title || 'Untitled item'}
              subtitle={heroItem.brand || heroItem.category || 'Shared item'}
              status="SHARED"
              chips={[
                heroItem.category,
                heroItem.snapshotPayload?.color as string | undefined,
                heroItem.snapshotPayload?.silhouette as string | undefined,
              ].filter((c): c is string => Boolean(c))}
              footer={
                <ItemReactions
                  itemId={heroItem.id}
                  counts={
                    reactionCounts[heroItem.id] ?? {
                      love: 0,
                      like: 0,
                      looking: 0,
                      thumbs_down: 0,
                    }
                  }
                  selectedReaction={selectedReactions[heroItem.id] ?? null}
                  disabled={!isAuthenticated}
                  isMutating={mutatingReactionItemId === heroItem.id}
                  onReact={onReact}
                />
              }
            />
          </View>
        ) : null}

        {railItems.length > 0 ? (
          <View style={styles.railSection}>
            <Text style={styles.railLabel}>Recent items</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.railContent}
            >
              {railItems.map((item) => (
                <View key={item.id} style={styles.railItem}>
                  <SharedScanCard
                    imageUrl={item.imageUrl}
                    title={item.title || ''}
                    subtitle={item.brand || item.category || ''}
                    style={styles.railCard}
                  />
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}

        <RoomMessagesPanel roomId={roomId} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.lg,
  },
  heroSection: {
    marginBottom: SPACING.sm,
  },
  railSection: {
    marginBottom: SPACING.sm,
  },
  railLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    marginBottom: SPACING.sm,
  },
  railContent: {
    gap: SPACING.md,
  },
  railItem: {
    width: 140,
  },
  railCard: {
    width: 140,
    borderRadius: RADIUS.lg,
  },
});
