/**
 * Shelf refinement chips (Build 35 Commerce UX §14-20).
 *
 * Two visibly different things, never conflated:
 *  - `ActiveConstraints`: what the shopping intent already holds ("black",
 *    "Under 150 USD", "No leather", "4 hidden"). Read-only labels. Changing a
 *    constraint is conversational, and a chip that looked tappable but did
 *    nothing would be a lie.
 *  - `RefinementChips`: commands ("Different", "Another", "Not these",
 *    "Cheaper"). A tap sends the SAME sentence the customer could type,
 *    through the chat's own send path, so Commerce V2's deterministic parser
 *    decides what it means. No chip-only semantics exist anywhere.
 *
 * Neither is a Save, Watch or Shop control; those stay in ProductShelf.
 */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { selectionTick } from '../../services/haptics';
import {
  activeConstraintChips,
  type RefinementAction,
  type ShelfIntentSummary,
} from '../../services/commerce/shelfRefinements';

export function ActiveConstraints({
  intentSummary,
  hiddenCount,
  testID,
}: {
  intentSummary: ShelfIntentSummary | null | undefined;
  hiddenCount: number;
  testID?: string;
}) {
  const chips = activeConstraintChips(intentSummary ?? null, hiddenCount);
  if (!chips.length) return null;
  return (
    <View
      style={styles.chipRow}
      testID={testID}
      accessible
      accessibilityLabel={`Shopping for: ${chips.map((chip) => chip.label).join(', ')}`}
    >
      {chips.map((chip) => (
        <View key={chip.key} style={styles.constraintChip}>
          <Text style={styles.constraintChipText}>{chip.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function RefinementChips({
  actions,
  onRefine,
  refining,
  testID,
}: {
  actions: RefinementAction[];
  onRefine?: (message: string) => void;
  refining: boolean;
  testID?: string;
}) {
  if (!onRefine || actions.length === 0) return null;
  return (
    <View style={styles.refineWrap} testID={testID}>
      <Text style={styles.refineLabel}>REFINE</Text>
      <View style={styles.chipRow}>
        {actions.map((action) => (
          <TouchableOpacity
            key={action.key}
            style={[styles.actionChip, refining && styles.actionChipDisabled]}
            disabled={refining}
            onPress={() => {
              selectionTick();
              onRefine(action.message);
            }}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityHint={`Sends "${action.message}" to your stylist`}
            accessibilityState={{ disabled: refining }}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            testID={testID ? `${testID}-${action.key}` : undefined}
          >
            <Text style={styles.actionChipText}>{action.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    paddingTop: SPACING.sm,
  },
  // Constraint: hairline outline, no fill, not pressable -- reads as a label.
  constraintChip: {
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xxs,
  },
  constraintChipText: {
    color: LUXURY.colors.graphite,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.3,
  },
  refineWrap: {
    marginTop: SPACING.md,
  },
  refineLabel: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 10,
  },
  // Action: filled plum tint and a 36pt target plus hit slop -- reads as a control.
  actionChip: {
    minHeight: 36,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plumMuted,
    paddingHorizontal: SPACING.md,
    justifyContent: 'center',
  },
  actionChipDisabled: {
    opacity: 0.45,
  },
  actionChipText: {
    color: LUXURY.colors.plum,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
});
