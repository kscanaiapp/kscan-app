// Closet Ownership V1 — the review prompt on Closet Home (PR A2, sections 50/51).
//
// ONE LINE, NEVER A PILE. Section 50's volume guard is the whole design of this
// component: when the reviewable set is large, Closet Home says a single
// coalesced sentence and the truthful count lives behind the filter. A wardrobe
// that greets its owner with fifteen separate nags is a chore list, and a chore
// list is the thing most likely to make someone stop curating their Closet.
//
// There is no Dismiss (DM-03). Review state is derived, so it cannot remember a
// dismissal without inventing durable per-item state; resolution is editing the
// item, at which point the condition — and the row — goes away on its own.

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LUXURY, SPACING, FONTS } from '../../constants/theme';
import type { ClosetReviewSummary } from '../../services/closet/closetReview';

export interface ClosetReviewRowProps {
  review: ClosetReviewSummary;
  /** True when the Closet is currently filtered to the review set. */
  active: boolean;
  onToggle: (next: boolean) => void;
}

export function ClosetReviewRow({ review, active, onToggle }: ClosetReviewRowProps) {
  if (!review.homeMessage) return null;

  return (
    <View style={styles.root} testID="closet-review-row">
      <Text style={styles.message} testID="closet-review-message">
        {review.homeMessage}
      </Text>
      <TouchableOpacity
        onPress={() => onToggle(!active)}
        testID="closet-review-toggle"
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        // The COUNT is spoken even when the visible message is coalesced: the
        // guard is about not crowding the screen, not about withholding the
        // number from someone using a screen reader.
        accessibilityLabel={
          active
            ? `Showing the ${review.count} items that could use a review. Tap to show all items.`
            : `Review ${review.count} ${review.count === 1 ? 'item' : 'items'}`
        }
        style={[styles.action, active && styles.actionActive]}
      >
        <Text style={[styles.actionText, active && styles.actionTextActive]}>
          {active ? 'Show all' : `Review ${review.count}`}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginHorizontal: SPACING.lg,
    marginBottom: SPACING.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.champagne,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  message: { flex: 1, fontFamily: FONTS.sans, fontSize: 13, color: LUXURY.colors.graphite },
  action: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.plum,
    minHeight: 32,
    justifyContent: 'center',
  },
  actionActive: { backgroundColor: LUXURY.colors.plum },
  actionText: { fontFamily: FONTS.sans, fontSize: 12, color: LUXURY.colors.plum },
  actionTextActive: { color: LUXURY.colors.inverse },
});
