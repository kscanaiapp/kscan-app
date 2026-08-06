import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type {
  CandidateReviewDescriptor,
  ScanItemQueueState,
} from '../../services/multiImageScan';

export type MultiItemResultSummary = {
  id: string;
  label: string;
  sourceImageIndex: number;
  detailStatus: 'complete' | 'partial';
};

export type MultiItemNavigatorMode = 'review' | 'processing' | 'results';

type Props = {
  /**
   * 'review'     — deliberate candidate multi-select; zero commerce work.
   * 'processing' — the sequential queue is running and no result is displayable
   *                yet; selection is frozen and per-item states are shown.
   * 'results'    — at least one analyzed item is displayable; chips navigate
   *                between ready items while later items keep streaming in.
   */
  mode?: MultiItemNavigatorMode;
  imageCount: number;
  items?: ReadonlyArray<MultiItemResultSummary>;
  selectedItemId?: string;
  savedItemIds?: ReadonlySet<string>;
  onSelectItem?: (itemId: string) => void;
  onSaveAll?: () => void;
  saveAllDisabled?: boolean;
  onAddAllToDressingRoom?: () => void;
  // Review/processing surface
  candidates?: ReadonlyArray<CandidateReviewDescriptor>;
  selectedCandidateIds?: ReadonlyArray<string>;
  itemStates?: Readonly<Record<string, ScanItemQueueState>>;
  onToggleCandidate?: (candidateId: string) => void;
  detectionNotice?: string | null;
  queueNotice?: string | null;
};

function stateLabel(state: ScanItemQueueState | undefined): string | null {
  switch (state) {
    case 'queued': return 'QUEUED';
    case 'analyzing': return 'ANALYZING…';
    case 'ready': return 'READY';
    case 'failed': return 'NOT ANALYZED';
    default: return null;
  }
}

/**
 * Category / subtype / colour, skipping absent values AND repeated ones.
 *
 * A plain top classifies as category "top" and subtype "top", which read as
 * "top · top · black" on the card and in its accessibility label. Broadest
 * first, so keeping the first occurrence keeps the more specific label whenever
 * the two genuinely differ.
 */
function describeCandidate(
  candidate: Pick<CandidateReviewDescriptor, 'category' | 'subtype' | 'primaryColor'>,
  separator: string,
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const part of [candidate.category, candidate.subtype, candidate.primaryColor]) {
    if (typeof part !== 'string' || !part.trim()) continue;
    const key = part.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts.join(separator);
}

function candidateAccessibilityLabel(
  candidate: CandidateReviewDescriptor,
  position: number,
  selected: boolean,
  selectionOrder: number,
  imageCount: number,
): string {
  const parts = [`Item ${position}`, candidate.label];
  const detail = describeCandidate(candidate, ', ');
  if (detail) parts.push(detail);
  if (imageCount > 1) parts.push(`from image ${candidate.sourceImageIndex + 1}`);
  parts.push(selected ? `selected, position ${selectionOrder}` : 'not selected');
  return parts.join(', ');
}

export function MultiItemResultNavigator({
  mode = 'results',
  imageCount,
  items = [],
  selectedItemId = '',
  savedItemIds = new Set<string>(),
  onSelectItem,
  onSaveAll,
  saveAllDisabled = false,
  onAddAllToDressingRoom,
  candidates = [],
  selectedCandidateIds = [],
  itemStates = {},
  onToggleCandidate,
  detectionNotice,
  queueNotice,
}: Props) {
  if (mode === 'review' || mode === 'processing') {
    const reviewLocked = mode === 'processing';
    return (
      <View style={styles.container} testID="multi-item-candidate-review">
        <Text style={styles.eyebrow}>MULTI-ITEM SCAN</Text>
        <Text style={styles.summary}>
          {candidates.length} {candidates.length === 1 ? 'item' : 'items'} found
        </Text>
        <Text style={styles.hint}>
          {reviewLocked
            ? 'Analyzing your selection, one item at a time.'
            : 'Choose what you want to explore'}
        </Text>
        {detectionNotice ? (
          <Text style={styles.notice} accessibilityLiveRegion="polite">
            {detectionNotice}
          </Text>
        ) : null}
        {queueNotice ? (
          <Text style={styles.notice} accessibilityLiveRegion="polite">
            {queueNotice}
          </Text>
        ) : null}

        <View style={styles.candidateColumn}>
          {candidates.map((candidate, index) => {
            const selectionOrder = selectedCandidateIds.indexOf(candidate.id);
            const selected = selectionOrder >= 0;
            const state = itemStates[candidate.id];
            const stateText = reviewLocked ? stateLabel(state) : null;
            const detail = describeCandidate(candidate, ' · ');
            return (
              <TouchableOpacity
                key={candidate.id}
                onPress={reviewLocked ? undefined : () => onToggleCandidate?.(candidate.id)}
                disabled={reviewLocked}
                activeOpacity={0.82}
                style={[styles.candidateCard, selected && styles.candidateCardSelected]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected, disabled: reviewLocked }}
                accessibilityLabel={candidateAccessibilityLabel(
                  candidate,
                  index + 1,
                  selected,
                  selectionOrder + 1,
                  imageCount,
                )}
                testID={`multi-item-candidate-${index}`}
              >
                <View
                  style={[styles.selectBadge, selected && styles.selectBadgeSelected]}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                >
                  {selected ? (
                    <Text style={styles.selectBadgeText}>{selectionOrder + 1}</Text>
                  ) : (
                    <Text style={styles.selectBadgeEmpty}>+</Text>
                  )}
                </View>
                <View style={styles.candidateBody}>
                  <Text
                    numberOfLines={2}
                    style={[styles.itemLabel, selected && styles.candidateLabelSelected]}
                  >
                    {candidate.label}
                  </Text>
                  {detail ? (
                    <Text
                      numberOfLines={1}
                      style={[styles.itemMeta, selected && styles.candidateMetaSelected]}
                    >
                      {detail}
                    </Text>
                  ) : null}
                  <Text style={[styles.itemMeta, selected && styles.candidateMetaSelected]}>
                    {imageCount > 1 ? `IMAGE ${candidate.sourceImageIndex + 1}` : ''}
                    {imageCount > 1 && stateText ? ' · ' : ''}
                    {stateText ?? ''}
                    {/* Selection is announced via accessibilityState and shown by
                        the numbered badge + border, never by color alone. */}
                    {!reviewLocked && selected ? (imageCount > 1 ? ' · ' : '') + 'SELECTED' : ''}
                  </Text>
                </View>
                {reviewLocked && state === 'analyzing' ? (
                  <ActivityIndicator size="small" color={LUXURY.colors.plum} />
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  }

  if (items.length <= 1 && imageCount <= 1 && !queueNotice) return null;

  return (
    <View style={styles.container} testID="multi-item-result-navigator">
      <Text style={styles.eyebrow}>MULTI-ITEM SCAN</Text>
      <Text style={styles.summary}>
        {imageCount} {imageCount === 1 ? 'image' : 'images'} · {items.length}{' '}
        {items.length === 1 ? 'garment' : 'garments'}
      </Text>
      <Text style={styles.hint}>Choose an item to review its matches and actions.</Text>
      {queueNotice ? (
        <Text style={styles.notice} accessibilityLiveRegion="polite">
          {queueNotice}
        </Text>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.itemRow}
      >
        {items.map((item, index) => {
          const selected = item.id === selectedItemId;
          const saved = savedItemIds.has(item.id);
          const state = itemStates[item.id];
          const pending = state === 'queued' || state === 'analyzing';
          const pendingLabel = stateLabel(pending || state === 'failed' ? state : undefined);
          return (
            <TouchableOpacity
              key={item.id}
              onPress={() => onSelectItem?.(item.id)}
              disabled={pending || state === 'failed'}
              activeOpacity={0.82}
              style={[
                styles.itemChip,
                selected && styles.itemChipSelected,
                (pending || state === 'failed') && styles.itemChipPending,
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: pending || state === 'failed' }}
              accessibilityLabel={`Item ${index + 1}, ${item.label}, from image ${item.sourceImageIndex + 1}${saved ? ', saved' : ''}${pendingLabel ? `, ${pendingLabel.toLowerCase()}` : ''}`}
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
                {saved
                  ? ' · SAVED'
                  : pendingLabel
                  ? ` · ${pendingLabel}`
                  : item.detailStatus === 'partial'
                  ? ' · PARTIAL'
                  : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {items.length >= 1 && (onSaveAll || onAddAllToDressingRoom) ? (
        <View style={styles.bulkRow}>
          {onSaveAll ? (
            <TouchableOpacity
              onPress={saveAllDisabled ? undefined : onSaveAll}
              disabled={saveAllDisabled}
              style={[styles.bulkPrimary, saveAllDisabled && styles.bulkDisabled]}
              accessibilityRole="button"
              accessibilityState={{ disabled: saveAllDisabled }}
              accessibilityLabel={saveAllDisabled
                ? 'No items ready to save yet'
                : `Save all ${items.length} analyzed items`}
              testID="multi-item-save-all"
            >
              <Text style={styles.bulkPrimaryText}>
                {saveAllDisabled ? 'NO ITEMS READY TO SAVE YET' : 'SAVE ALL ITEMS'}
              </Text>
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
  notice: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    marginTop: SPACING.sm,
  },
  candidateColumn: {
    gap: SPACING.sm,
    paddingVertical: SPACING.md,
  },
  candidateCard: {
    minHeight: 64,
    borderRadius: RADIUS.lg,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  candidateCardSelected: {
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.plum,
  },
  candidateBody: {
    flex: 1,
  },
  candidateLabelSelected: {
    color: LUXURY.colors.inverse,
  },
  candidateMetaSelected: {
    color: LUXURY.colors.inverse,
  },
  selectBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  selectBadgeSelected: {
    backgroundColor: LUXURY.colors.gold,
  },
  selectBadgeText: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    color: LUXURY.colors.ink,
  },
  selectBadgeEmpty: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 15,
    color: LUXURY.colors.goldBrushed,
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
  itemChipPending: {
    opacity: 0.55,
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
  bulkDisabled: {
    opacity: 0.5,
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
