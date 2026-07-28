// Ordered batch review (Closet Upgrade Build 2, Phase 2).
//
// SCOPE: the review mode of the existing Library candidate surface. It is mounted
// by ClosetCandidateStatusPanel — not by a new top-level route — because reviewing
// staged photos is a mode of the Closet section, not a destination, and nothing in
// the navigation evidence asks for a route.
//
// THIS COMPONENT DECIDES NOTHING. Grouping, ordering, status vocabulary, which
// actions a row may offer and whether an item may be selected are all read off the
// projection in services/closetBatchReview.ts, which asks the one authoritative
// predicate in services/closetCandidateReviewEligibility.ts. A second opinion
// formed here is exactly how a duplicate becomes selectable on one surface and not
// another.
//
// NO PROMOTION, AND NO PLACEHOLDER FOR ONE. There is no "Add selected to Closet",
// disabled or otherwise. Selecting items is a complete, honest step; a control the
// build cannot complete is not.
//
// NO WRITES TO CANDIDATE STORAGE FROM HERE. Every mutation goes through the one
// hook instance the screen owns, which goes through the service funnel.

import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { SecondaryButton } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import { useClosetCandidates } from '../../hooks/useClosetCandidates';
import { useClosetBatchSelection } from '../../hooks/useClosetBatchSelection';
import {
  describeClosetBatchReviewItem,
  getClosetBatchReviewProjection,
  type ClosetBatchReviewGroup,
  type ClosetBatchReviewItem,
} from '../../services/closetBatchReview';
import {
  ClosetCandidateManualClassifyModal,
  type ManualClassifyTarget,
} from './ClosetCandidateManualClassifyModal';

/**
 * The header summary.
 *
 * Zero-count states are OMITTED. "0 duplicates" is not reassurance, it is noise,
 * and a summary that lists every status the system knows about reads as a debug
 * panel rather than as a count of the user's photos.
 */
function summaryParts(group: ClosetBatchReviewGroup): string[] {
  const parts: string[] = [];
  if (group.readyCount) parts.push(`${group.readyCount} ready`);
  if (group.processingCount) parts.push(`${group.processingCount} processing`);
  if (group.waitingCount) parts.push(`${group.waitingCount} waiting for connection`);
  if (group.needsDetailsCount) parts.push(`${group.needsDetailsCount} need details`);
  if (group.duplicateCount) parts.push(`${group.duplicateCount} already in your Closet`);
  const failures = group.retryableFailureCount + group.unresolvableFailureCount;
  if (failures) parts.push(`${failures} couldn't be identified`);
  if (group.expiredCount) parts.push(`${group.expiredCount} expired`);
  return parts;
}

function itemCountLabel(group: ClosetBatchReviewGroup): string {
  return group.totalCount === 1 ? '1 item' : `${group.totalCount} items`;
}

export function ClosetBatchReviewPanel({
  api,
}: {
  /**
   * The screen's ONE `useClosetCandidates()` instance. REQUIRED rather than
   * defaulted for the same reason Build 1's panel requires it: a second instance
   * would run its own hydrate and classification pass, and a photo staged through
   * the screen's instance would not appear here until the next focus.
   */
  api: ReturnType<typeof useClosetCandidates>;
}) {
  const {
    candidates,
    loading,
    actorId,
    actorEpoch,
    activeBatchId,
    setActiveBatchId,
    retry,
    remove,
    classifyManually,
  } = api;
  const [manualTarget, setManualTarget] = useState<ManualClassifyTarget | null>(null);

  const projection = useMemo(
    () =>
      getClosetBatchReviewProjection({
        actorId: actorId ?? null,
        actorEpoch: actorEpoch ?? null,
        candidates,
        activeBatchId: activeBatchId ?? null,
      }),
    [actorId, actorEpoch, candidates, activeBatchId],
  );

  const selection = useClosetBatchSelection(projection);

  if (loading) {
    return (
      <View style={styles.loadingWrap} accessibilityLabel="Loading photos waiting for review">
        <ActivityIndicator size="small" color={LUXURY.colors.plum} />
      </View>
    );
  }

  const group = projection.activeGroup;
  // Nothing staged renders nothing at all: the committed Closet below already owns
  // this screen's empty state, and a second one implies two empty things to fill.
  if (!group) return null;

  const summary = summaryParts(group);

  return (
    <View style={styles.wrap} testID="closet-batch-review">
      <Text style={styles.heading}>REVIEW ITEMS</Text>

      {/* Group switcher, only when there is somewhere else to switch to. */}
      {projection.groups.length > 1 ? (
        <View style={styles.groupTabs}>
          {projection.groups.map((entry, index) => {
            const active = entry.groupId === group.groupId;
            const label = entry.groupLabel ?? `Batch ${projection.groups.length - index}`;
            return (
              <TouchableOpacity
                key={entry.groupId}
                onPress={() => setActiveBatchId(entry.groupId)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${label}, ${itemCountLabel(entry)}`}
                testID={`closet-batch-tab-${entry.groupId}`}
                style={[styles.groupTab, active && styles.groupTabActive]}
              >
                <Text style={[styles.groupTabText, active && styles.groupTabTextActive]}>
                  {label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      <View style={styles.header}>
        <Text style={styles.headerCount} testID="closet-batch-review-count">
          {group.groupLabel ?? itemCountLabel(group)}
        </Text>
        {summary.length ? (
          <Text style={styles.headerSummary} testID="closet-batch-review-summary">
            {summary.join(' · ')}
          </Text>
        ) : null}
        {selection.selectedCount ? (
          <Text style={styles.headerSelected} testID="closet-batch-review-selected">
            {`${selection.selectedCount} selected`}
          </Text>
        ) : null}
        <View style={styles.headerActions}>
          {selection.canSelectAllReady ? (
            <SecondaryButton
              title="Select all ready"
              onPress={selection.selectAllReady}
              accessibilityLabel="Select every item that is ready for review"
              testID="closet-batch-select-all"
            />
          ) : null}
          {selection.canClearSelection ? (
            <SecondaryButton
              title="Clear selection"
              onPress={selection.clear}
              accessibilityLabel="Clear the current selection"
              testID="closet-batch-clear-selection"
            />
          ) : null}
        </View>
      </View>

      {group.items.map((item: ClosetBatchReviewItem) => {
        const selected = selection.isSelected(item.candidateId);
        const label = describeClosetBatchReviewItem(item, { selected });
        return (
          <View key={item.candidateId} style={styles.row} accessibilityLabel={label}>
            {item.thumbnailUri ? (
              <Image
                source={{ uri: item.thumbnailUri }}
                style={styles.thumb}
                accessibilityIgnoresInvertColors
              />
            ) : (
              <View style={[styles.thumb, styles.thumbPlaceholder]} />
            )}

            <View style={styles.body}>
              {/* Status is carried by words, never by colour alone. */}
              <Text style={styles.status}>{item.statusLabel}</Text>
              {item.displaySummary ? (
                <Text style={styles.detail}>{item.displaySummary}</Text>
              ) : null}
              {item.displayBrand ? <Text style={styles.detail}>{item.displayBrand}</Text> : null}
              {item.statusMessage ? (
                <Text style={styles.message} testID={`closet-batch-message-${item.candidateId}`}>
                  {item.statusMessage}
                </Text>
              ) : null}
            </View>

            <View style={styles.actions}>
              {/* A selection control exists only where selection is permitted. */}
              {item.selectionEligible ? (
                <TouchableOpacity
                  onPress={() => selection.toggle(item.candidateId)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={`${item.displaySummary ?? 'Unidentified item'}, ${
                    selected ? 'selected' : 'not selected'
                  }`}
                  testID={`closet-batch-select-${item.candidateId}`}
                  style={[styles.checkbox, selected && styles.checkboxChecked]}
                >
                  <Text style={styles.checkboxMark}>{selected ? 'Selected' : 'Select'}</Text>
                </TouchableOpacity>
              ) : null}

              {item.availableActions.includes('add_details') ? (
                <SecondaryButton
                  title="Add details"
                  onPress={() => {
                    setManualTarget({
                      candidateId: item.candidateId,
                      category: item.displayCategory,
                      clothingType: item.displayType,
                      subtype: item.displaySubtype,
                      primaryColor: item.displayColor,
                    });
                  }}
                  accessibilityLabel="Add a category for this photo yourself"
                  testID={`closet-batch-manual-${item.candidateId}`}
                />
              ) : null}
              {item.availableActions.includes('retry') ? (
                <SecondaryButton
                  title="Try again"
                  onPress={() => {
                    void retry(item.candidateId);
                  }}
                  accessibilityLabel="Try identifying this photo again"
                  testID={`closet-batch-retry-${item.candidateId}`}
                />
              ) : null}
              {item.availableActions.includes('remove') ? (
                <SecondaryButton
                  title="Remove"
                  onPress={() => {
                    void remove(item.candidateId);
                  }}
                  accessibilityLabel="Remove this photo from review"
                  testID={`closet-batch-remove-${item.candidateId}`}
                />
              ) : null}
            </View>
          </View>
        );
      })}

      {/* Build 1's editor and its mutation funnel, reused unchanged. */}
      <ClosetCandidateManualClassifyModal
        target={manualTarget}
        onClose={() => setManualTarget(null)}
        onSubmit={classifyManually}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  loadingWrap: {
    paddingVertical: SPACING.lg,
    alignItems: 'center',
  },
  heading: {
    fontSize: 11,
    letterSpacing: 1.5,
    color: LUXURY.colors.plum,
    marginBottom: SPACING.sm,
  },
  groupTabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  groupTab: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.plum,
  },
  groupTabActive: {
    backgroundColor: LUXURY.colors.pearl,
  },
  groupTabText: {
    fontSize: 12,
    color: LUXURY.colors.plum,
  },
  groupTabTextActive: {
    color: LUXURY.colors.ink,
  },
  header: {
    gap: 2,
    marginBottom: SPACING.sm,
  },
  headerCount: {
    fontSize: 15,
    color: LUXURY.colors.ink,
  },
  headerSummary: {
    fontSize: 12,
    color: LUXURY.colors.plum,
    opacity: 0.8,
  },
  headerSelected: {
    fontSize: 12,
    color: LUXURY.colors.ink,
  },
  headerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: LUXURY.colors.ivory,
  },
  thumbPlaceholder: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.plum,
    opacity: 0.3,
  },
  body: {
    flex: 1,
  },
  status: {
    fontSize: 14,
    color: LUXURY.colors.ink,
  },
  detail: {
    fontSize: 12,
    opacity: 0.7,
    color: LUXURY.colors.plum,
  },
  message: {
    fontSize: 12,
    marginTop: 2,
    color: LUXURY.colors.plum,
  },
  actions: {
    gap: SPACING.xs,
  },
  checkbox: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.plum,
  },
  checkboxChecked: {
    backgroundColor: LUXURY.colors.pearl,
  },
  checkboxMark: {
    fontSize: 12,
    color: LUXURY.colors.ink,
  },
});
