import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  EmptyStateCard,
  PrimaryButton,
  SecondaryButton,
  TertiaryButton,
} from '../../components/luxury';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { ItemTile } from '../../components/StyleObjectCards';
import type { DressingRoomItem } from '../../types/styleObjects';

type Props = {
  items: DressingRoomItem[];
  selectedIds: string[];
  onToggleItem: (itemId: string) => void;
  onCreateLook: () => void;
  selectedCount: number;
  onRemoveItem: (itemId: string) => void;
};

export function RoomSavedPanel({
  items,
  selectedIds,
  onToggleItem,
  onCreateLook,
  selectedCount,
  onRemoveItem,
}: Props) {
  if (items.length === 0) {
    return (
      <EmptyStateCard
        title="No saved looks yet."
        subtitle="Select items in this room to create a look, or save products for inspiration."
      />
    );
  }

  const selectedSet = new Set(selectedIds);

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.actionCard}>
        <Text style={styles.actionLabel}>Create Look</Text>
        <Text style={styles.actionSubtitle}>
          {selectedCount > 0
            ? `${selectedCount} selected`
            : 'Select items to create a look'}
        </Text>
        <PrimaryButton
          title={
            selectedCount > 0
              ? `Create Look (${selectedCount})`
              : 'Select Items For Look'
          }
          onPress={onCreateLook}
          disabled={selectedCount === 0}
          accessibilityLabel={
            selectedCount > 0
              ? `Create look from ${selectedCount} selected items`
              : 'Select items before creating a look'
          }
        />
      </View>

      <View style={styles.items}>
        {items.map((item) => (
          <ItemTile
            key={item.id}
            item={item}
            selected={selectedSet.has(item.id)}
            onPress={() => onToggleItem(item.id)}
            onRemove={() => onRemoveItem(item.id)}
          />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.md,
  },
  actionCard: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  actionLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  actionSubtitle: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.sm,
  },
  items: {
    marginTop: SPACING.lg,
  },
});
