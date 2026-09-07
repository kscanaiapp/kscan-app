// Closet Experience V1 — the wardrobe control bar (PR A1).
//
// Summary line + search + category chips + origin chips + sort. One component,
// because these four controls describe ONE query and splitting them into four
// files would make it easy to render three of them and forget the fourth.
//
// READ-ONLY. Nothing here can create, edit or delete an owned item.
//
// Built on the existing LUXURY tokens and existing primitives. No new design
// system, no charts, no animation library (section 26).

import React from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { LUXURY, SPACING, FONTS } from '../../constants/theme';
import {
  CLOSET_ORIGIN_LABELS,
  CLOSET_SORT_IDS,
  CLOSET_SORT_LABELS,
  type ClosetInventorySummary,
  type ClosetOriginFilterId,
  type ClosetSortId,
} from '../../services/closet/closetInventory';

export interface ClosetInventoryBarProps {
  summary: ClosetInventorySummary;
  search: string;
  onSearchChange: (value: string) => void;
  category: string | null;
  onCategoryChange: (value: string | null) => void;
  origin: ClosetOriginFilterId;
  onOriginChange: (value: ClosetOriginFilterId) => void;
  sort: ClosetSortId;
  onSortChange: (value: ClosetSortId) => void;
  /** How many items the current query leaves visible. */
  visibleItems: number;
  isNarrowed: boolean;
  onClear: () => void;
}

function Chip({
  label,
  selected,
  onPress,
  testID,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      // `selected` rather than `checked`: these chips are a single-choice
      // filter, and screen readers announce selection state for a chip group
      // more usefully than a checkbox state.
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * The one line that says what the user owns.
 *
 * CLAIM BOUNDARY (sections 58, 87): "in K Scan" is not decoration. The Closet
 * knows what the user recorded, never what hangs in their actual wardrobe, and
 * every count rendered here has to say so.
 */
function summaryLine(summary: ClosetInventorySummary): string {
  if (summary.totalItems === 0) return 'No items in K Scan yet';
  const items = summary.totalItems === 1 ? '1 item' : `${summary.totalItems} items`;
  if (summary.distinctCategoryCount === 0) return `${items} in K Scan`;
  const cats =
    summary.distinctCategoryCount === 1 ? '1 category' : `${summary.distinctCategoryCount} categories`;
  return `${items} in K Scan · ${cats}`;
}

export function ClosetInventoryBar({
  summary,
  search,
  onSearchChange,
  category,
  onCategoryChange,
  origin,
  onOriginChange,
  sort,
  onSortChange,
  visibleItems,
  isNarrowed,
  onClear,
}: ClosetInventoryBarProps) {
  // Sort cycles rather than opening a picker: four options, one tap each, no
  // modal to dismiss. A picker would be more chrome than the choice deserves.
  const nextSort = (): ClosetSortId => {
    const i = CLOSET_SORT_IDS.indexOf(sort);
    return CLOSET_SORT_IDS[(i + 1) % CLOSET_SORT_IDS.length];
  };

  return (
    <View style={styles.root} testID="closet-inventory-bar">
      <View style={styles.summaryRow}>
        <Text style={styles.summaryText} testID="closet-inventory-summary" accessibilityRole="text">
          {summaryLine(summary)}
        </Text>
        <TouchableOpacity
          onPress={() => onSortChange(nextSort())}
          testID="closet-sort-button"
          accessibilityRole="button"
          accessibilityLabel={`Sort: ${CLOSET_SORT_LABELS[sort]}. Tap to change.`}
          style={styles.sortButton}
        >
          <Text style={styles.sortText} numberOfLines={1}>
            {CLOSET_SORT_LABELS[sort]}
          </Text>
        </TouchableOpacity>
      </View>

      <TextInput
        value={search}
        onChangeText={onSearchChange}
        placeholder="Search your Closet"
        placeholderTextColor={LUXURY.colors.stone}
        style={styles.search}
        testID="closet-search-input"
        accessibilityLabel="Search your Closet"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />

      {summary.categories.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
          testID="closet-category-filters"
        >
          <Chip
            label="All"
            selected={category === null}
            onPress={() => onCategoryChange(null)}
            testID="closet-category-chip-all"
            accessibilityLabel={`All categories, ${summary.totalItems} items`}
          />
          {summary.categories.map((entry) => (
            <Chip
              key={entry.value}
              label={`${entry.label} ${entry.count}`}
              selected={category === entry.value}
              onPress={() => onCategoryChange(category === entry.value ? null : entry.value)}
              testID={`closet-category-chip-${entry.value}`}
              accessibilityLabel={`${entry.label}, ${entry.count} ${entry.count === 1 ? 'item' : 'items'}`}
            />
          ))}
        </ScrollView>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        testID="closet-origin-filters"
      >
        {(Object.keys(CLOSET_ORIGIN_LABELS) as ClosetOriginFilterId[]).map((id) => (
          <Chip
            key={id}
            label={CLOSET_ORIGIN_LABELS[id]}
            selected={origin === id}
            onPress={() => onOriginChange(id)}
            testID={`closet-origin-chip-${id}`}
          />
        ))}
      </ScrollView>

      {isNarrowed ? (
        <View style={styles.narrowRow}>
          <Text style={styles.narrowText} testID="closet-filter-result-count">
            {visibleItems === 0
              ? 'No items match'
              : `Showing ${visibleItems} of ${summary.totalItems}`}
          </Text>
          <TouchableOpacity
            onPress={onClear}
            testID="closet-clear-filters-button"
            accessibilityRole="button"
            accessibilityLabel="Clear search and filters"
          >
            <Text style={styles.clearText}>Clear</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: SPACING.lg, paddingBottom: SPACING.sm },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
  },
  summaryText: {
    flex: 1,
    fontFamily: FONTS.sans,
    fontSize: 13,
    color: LUXURY.colors.graphite,
  },
  sortButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.border,
    marginLeft: SPACING.sm,
  },
  sortText: { fontFamily: FONTS.sans, fontSize: 12, color: LUXURY.colors.graphite },
  search: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.border,
    borderRadius: 10,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontFamily: FONTS.sans,
    fontSize: 15,
    color: LUXURY.colors.ink,
    backgroundColor: LUXURY.colors.warmWhite,
    marginBottom: SPACING.sm,
    // A search field below ~44pt is hard to hit reliably.
    minHeight: 44,
  },
  chipRow: { gap: SPACING.sm, paddingVertical: SPACING.xs, paddingRight: SPACING.lg },
  chip: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.warmWhite,
    minHeight: 32,
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: LUXURY.colors.plum, borderColor: LUXURY.colors.plum },
  chipText: { fontFamily: FONTS.sans, fontSize: 12, color: LUXURY.colors.graphite },
  chipTextSelected: { color: LUXURY.colors.inverse },
  narrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACING.xs,
  },
  narrowText: { fontFamily: FONTS.sans, fontSize: 12, color: LUXURY.colors.stone },
  clearText: { fontFamily: FONTS.sans, fontSize: 12, color: LUXURY.colors.plum },
});
