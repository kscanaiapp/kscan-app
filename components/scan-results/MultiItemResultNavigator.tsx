import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export type MultiItemResultSummary = {
  id: string;
  label: string;
  sourceImageIndex: number;
  detailStatus: 'complete' | 'partial';
};

type Props = {
  imageCount: number;
  items: ReadonlyArray<MultiItemResultSummary>;
  selectedItemId: string;
  savedItemIds?: ReadonlySet<string>;
  onSelectItem: (itemId: string) => void;
  onSaveAll?: () => void;
  onAddAllToDressingRoom?: () => void;
};

export function MultiItemResultNavigator({
  imageCount,
  items,
  selectedItemId,
  savedItemIds = new Set<string>(),
  onSelectItem,
  onSaveAll,
  onAddAllToDressingRoom,
}: Props) {
  if (items.length <= 1 && imageCount <= 1) return null;

  return (
    <View style={styles.container} testID="multi-item-result-navigator">
      <Text style={styles.eyebrow}>MULTI-ITEM SCAN</Text>
      <Text style={styles.summary}>
        {imageCount} {imageCount === 1 ? 'image' : 'images'} · {items.length}{' '}
        {items.length === 1 ? 'garment' : 'garments'}
      </Text>
      <Text style={styles.hint}>Choose an item to review its matches and actions.</Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.itemRow}
      >
        {items.map((item, index) => {
          const selected = item.id === selectedItemId;
          const saved = savedItemIds.has(item.id);
          return (
            <TouchableOpacity
              key={item.id}
              onPress={() => onSelectItem(item.id)}
              activeOpacity={0.82}
              style={[styles.itemChip, selected && styles.itemChipSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Item ${index + 1}, ${item.label}, from image ${item.sourceImageIndex + 1}${saved ? ', saved' : ''}`}
              testID={`multi-item-result-${index}`}
            >
              <Text style={[styles.itemIndex, selected && styles.itemTextSelected]}>
                {index + 1}
              </Text>
              <Text
                numberOfLines={2}
                style={[styles.itemLabel, selected && styles.itemTextSelected]}
              >
                {item.label}
              </Text>
              <Text style={[styles.itemMeta, selected && styles.itemTextSelected]}>
                IMAGE {item.sourceImageIndex + 1}
                {saved ? ' · SAVED' : item.detailStatus === 'partial' ? ' · PARTIAL' : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {items.length > 1 && (onSaveAll || onAddAllToDressingRoom) ? (
        <View style={styles.bulkRow}>
          {onSaveAll ? (
            <TouchableOpacity
              onPress={onSaveAll}
              style={styles.bulkPrimary}
              accessibilityRole="button"
              accessibilityLabel={`Save all ${items.length} detected items`}
              testID="multi-item-save-all"
            >
              <Text style={styles.bulkPrimaryText}>SAVE ALL ITEMS</Text>
            </TouchableOpacity>
          ) : null}
          {onAddAllToDressingRoom ? (
            <TouchableOpacity
              onPress={onAddAllToDressingRoom}
              style={styles.bulkSecondary}
              accessibilityRole="button"
              accessibilityLabel={`Add all ${items.length} detected items to a Dressing Room`}
              testID="multi-item-add-all-room"
            >
              <Text style={styles.bulkSecondaryText}>ADD ALL TO ROOM</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    padding: SPACING.md,
    marginBottom: SPACING.lg,
  },
  eyebrow: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 1.8,
  },
  summary: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    marginTop: SPACING.xs,
  },
  hint: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
  },
  itemRow: {
    gap: SPACING.sm,
    paddingVertical: SPACING.md,
  },
  itemChip: {
    width: 142,
    minHeight: 100,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.sm,
  },
  itemChipSelected: {
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.plum,
  },
  itemIndex: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
  },
  itemLabel: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    marginTop: SPACING.xs,
  },
  itemMeta: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    marginTop: 'auto',
  },
  itemTextSelected: {
    color: LUXURY.colors.inverse,
  },
  bulkRow: {
    gap: SPACING.sm,
  },
  bulkPrimary: {
    minHeight: 46,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulkPrimaryText: {
    ...LUXURY.typography.cta,
    color: LUXURY.colors.inverse,
  },
  bulkSecondary: {
    minHeight: 46,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulkSecondaryText: {
    ...LUXURY.typography.ctaSecondary,
    color: LUXURY.colors.plum,
  },
});
