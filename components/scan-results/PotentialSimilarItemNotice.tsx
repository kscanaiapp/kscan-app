import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { PotentialSimilarItemView, SimilarItemAction } from '../../services/scanJourney';
import {
  SIMILARITY_REASON_LABELS,
  SIMILAR_ITEM_ACTION_LABELS,
  SIMILAR_ITEM_NOTICE_TITLE,
  SIMILAR_ITEM_SOURCE_LABELS,
  eligibleSimilarItemActions,
  type SimilarItemRecordState,
} from '../../services/similarItemActions';

/**
 * Side-by-side potential-similar-item notice.
 *
 * THE LANGUAGE IS PART OF THE CONTRACT
 *
 * A correct advisory payload rendered as "Duplicate found" is still a duplicate
 * claim. This component never says duplicate, already own, or same item. It
 * shows the two pictures next to each other, states where the existing one
 * lives, lists why they looked alike, and lets the user decide. The headline is
 * "This looks similar to something you have" — an observation, not a verdict.
 *
 * IT RENDERS. IT DOES NOT DECIDE.
 *
 * No merge, no suppression, no deletion, no pre-selected action, and no
 * dismissal that silently resolves anything. Every action is an explicit press,
 * handed straight back to the caller. `onAction` is the only way anything
 * happens, and the component has no state of its own to lose.
 *
 * Actions are filtered by CURRENT RECORD STATE, not by the contract: the
 * backend sends the whole vocabulary because it cannot know whether the new
 * scan is already saved or the existing item still exists. The client knows, so
 * the client filters — see `services/similarItemActions.ts`.
 */

export interface PotentialSimilarItemNoticeProps {
  item: PotentialSimilarItemView;
  /** Current state of both records. Drives which actions are offered. */
  recordState: SimilarItemRecordState;
  onAction: (action: SimilarItemAction, item: PotentialSimilarItemView) => void;
  testID?: string;
}

export function PotentialSimilarItemNotice({
  item,
  recordState,
  onAction,
  testID = 'potential-similar-item-notice',
}: PotentialSimilarItemNoticeProps) {
  // Intersect what the contract permitted with what the current state allows.
  // A contract action the client does not recognise is dropped rather than
  // rendered as an unlabelled button.
  const permitted = new Set(item.contractActions);
  const actions = eligibleSimilarItemActions(recordState).filter(
    (action) => permitted.size === 0 || permitted.has(action),
  );

  const reasons = item.reasons
    .map((reason) => SIMILARITY_REASON_LABELS[reason])
    .filter((label): label is string => Boolean(label));

  return (
    <View style={styles.container} testID={testID} accessibilityRole="summary">
      <Text style={styles.title} testID={`${testID}-title`}>
        {SIMILAR_ITEM_NOTICE_TITLE}
      </Text>

      <View style={styles.comparisonRow}>
        <ComparisonPane
          testID={`${testID}-new-scan`}
          heading="Just scanned"
          imageUri={item.comparison.newScanImageUri}
          label={item.comparison.newScanLabel}
        />
        <ComparisonPane
          testID={`${testID}-existing-item`}
          heading={SIMILAR_ITEM_SOURCE_LABELS[item.existingItemSource]}
          imageUri={item.comparison.existingItemImageUri}
          label={item.comparison.existingItemLabel}
        />
      </View>

      {reasons.length > 0 && (
        <View style={styles.reasonRow} testID={`${testID}-reasons`}>
          {reasons.map((reason) => (
            <View key={reason} style={styles.reasonChip}>
              <Text style={styles.reasonText}>{reason}</Text>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.helper} testID={`${testID}-helper`}>
        Both are kept unless you choose otherwise.
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.actionRow}
        testID={`${testID}-actions`}
      >
        {actions.map((action) => (
          <TouchableOpacity
            key={action}
            style={styles.actionButton}
            onPress={() => onAction(action, item)}
            accessibilityRole="button"
            accessibilityLabel={SIMILAR_ITEM_ACTION_LABELS[action]}
            testID={`${testID}-action-${action}`}
          >
            <Text style={styles.actionText}>{SIMILAR_ITEM_ACTION_LABELS[action]}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

function ComparisonPane({
  heading,
  imageUri,
  label,
  testID,
}: {
  heading: string;
  imageUri: string | null;
  label: string | null;
  testID: string;
}) {
  return (
    <View style={styles.pane} testID={testID}>
      <Text style={styles.paneHeading}>{heading}</Text>
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={styles.paneImage} resizeMode="cover" />
      ) : (
        // A missing image is stated rather than hidden. Silently collapsing one
        // side would leave a "side-by-side" comparison with one side, which
        // reads as a system error rather than a missing thumbnail.
        <View style={[styles.paneImage, styles.paneImageMissing]} testID={`${testID}-no-image`}>
          <Text style={styles.paneImageMissingText}>No image</Text>
        </View>
      )}
      {label ? (
        <Text style={styles.paneLabel} numberOfLines={2}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  title: {
    color: LUXURY.colors.ink,
    fontSize: 16,
    fontWeight: '600',
  },
  comparisonRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  pane: {
    flex: 1,
    gap: SPACING.xs,
  },
  paneHeading: {
    color: LUXURY.colors.graphite,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  paneImage: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.champagne,
  },
  paneImageMissing: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  paneImageMissingText: {
    color: LUXURY.colors.graphite,
    fontSize: 12,
  },
  paneLabel: {
    color: LUXURY.colors.ink,
    fontSize: 13,
  },
  reasonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
  },
  reasonChip: {
    backgroundColor: LUXURY.colors.champagne,
    borderRadius: RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 4,
  },
  reasonText: {
    color: LUXURY.colors.graphite,
    fontSize: 12,
  },
  helper: {
    color: LUXURY.colors.graphite,
    fontSize: 12,
  },
  actionRow: {
    gap: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  actionButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
  },
  actionText: {
    color: LUXURY.colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
});

export default PotentialSimilarItemNotice;
