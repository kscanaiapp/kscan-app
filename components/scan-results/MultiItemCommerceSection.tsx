import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';
import { PurchaseOptionsPanel } from './PurchaseOptionsPanel';
import { InlineNotice } from '../luxury/InlineNotice';
import { mapRawProductToPurchaseOption } from './types';
import type { PurchaseOption } from './types';
import type { OutfitConfirmationCandidate } from '../../services/outfitConfirmation/outfitDetectionBridge';
import type { ItemCommerceCard } from '../../services/multiItemCommerce';
import {
  commerceShelfNoticeCopy,
  isCandidateCommerceEligible,
  resolveItemCommerceState,
} from '../../services/commerceShelfState';

interface MultiItemCommerceSectionProps {
  /** Every detected item, eligible or not — order is the garment order. */
  candidates: OutfitConfirmationCandidate[];
  /** Populated cards, keyed by candidateId, for candidates that were eligible. */
  cardsByCandidateId: Map<string, ItemCommerceCard>;
  /** Whole-shelf lifecycle: 'idle' before dispatch, 'pending' while in flight. */
  status: 'idle' | 'pending' | 'ready';
  /**
   * The backend announced `commerce.deferred` for this scan (analysis.commerceDeferred).
   * With the shelf still idle that means dispatch is imminent (DEFERRED), not that
   * commerce will never run. Absent means the backend did not defer, so nothing
   * will be dispatched (NOT_STARTED).
   */
  deferred?: boolean;
  /**
   * Whether this surface offers the Find Matches action. It is the real next step
   * from NOT_STARTED, so the copy only points at it when it exists.
   */
  findMatchesAvailable?: boolean;
  onRetry?: () => void;
  testID?: string;
}

function toPurchaseOptions(products: unknown[]): PurchaseOption[] {
  return products
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
    .map((p, index) => mapRawProductToPurchaseOption(p, index));
}

/**
 * One canonical commerce card per detected fashion item — garment-organized,
 * never retailer-organized. Best Match + Alternatives only (no three-tier
 * classification, no match percentages). It never blocks or hides its siblings.
 *
 * Each item is in exactly one of six states (services/commerceShelfState.ts) and
 * says only what is true of that state. A statement that no match was found is
 * COMPLETED_EMPTY's alone: an item nothing has searched for (NOT_STARTED), one
 * whose request is on its way or in flight, and one whose request failed each get
 * their own message. Copy comes from the shared copy table, so this component
 * cannot reach the no-match sentence except through the COMPLETED_EMPTY state.
 */
export function MultiItemCommerceSection({
  candidates,
  cardsByCandidateId,
  status,
  deferred = false,
  findMatchesAvailable = false,
  onRetry,
  testID,
}: MultiItemCommerceSectionProps) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  return (
    <View style={styles.container} testID={testID ?? 'multi-item-commerce-section'}>
      {candidates.map((candidate) => {
        const card = cardsByCandidateId.get(candidate.id);
        const state = resolveItemCommerceState({
          deferred,
          shelfStatus: status,
          eligible: isCandidateCommerceEligible(candidate),
          card,
        });
        const notice = commerceShelfNoticeCopy(state, candidate.label, findMatchesAvailable);

        return (
          <View
            key={candidate.id}
            style={styles.item}
            testID={`multi-item-commerce-card-${candidate.id}`}
          >
            {/* A heading, not a caption. Every product link below belongs to
                THIS garment, and a screen reader otherwise reads one flat run
                of "View options for ..." across all detected items with no
                announced boundary between them. The per-item notices carry
                the garment name for the same reason: several stacked notices
                of the same kind are indistinguishable by voice. */}
            <Text
              style={styles.itemLabel}
              numberOfLines={1}
              accessibilityRole="header"
              accessibilityLabel={`${candidate.label}, purchase options`}
            >
              {candidate.label}
            </Text>

            {state === 'DEFERRED' || state === 'IN_PROGRESS' ? (
              <InlineNotice
                variant="info"
                body={notice.body}
                accessibilityLabel={notice.accessibilityLabel}
                testID={`multi-item-commerce-pending-${candidate.id}`}
              />
            ) : state === 'ERROR' ? (
              <InlineNotice
                variant="error"
                body={notice.body}
                accessibilityLabel={notice.accessibilityLabel}
                action={onRetry ? { label: 'Retry', onPress: onRetry, accessibilityLabel: `Retry purchase options for ${candidate.label}`, testID: `multi-item-commerce-retry-${candidate.id}` } : undefined}
                testID={`multi-item-commerce-error-${candidate.id}`}
              />
            ) : state === 'COMPLETED_EMPTY' ? (
              <InlineNotice
                variant="info"
                body={notice.body}
                accessibilityLabel={notice.accessibilityLabel}
                testID={`multi-item-commerce-no-match-${candidate.id}`}
              />
            ) : state === 'NOT_STARTED' ? (
              <InlineNotice
                variant="info"
                body={notice.body}
                accessibilityLabel={notice.accessibilityLabel}
                testID={`multi-item-commerce-not-started-${candidate.id}`}
              />
            ) : (
              <>
                <PurchaseOptionsPanel
                  title="BEST MATCH"
                  purchaseOptions={card?.bestMatch ? toPurchaseOptions([card.bestMatch]) : []}
                  testID={`multi-item-commerce-best-match-${candidate.id}`}
                />
                {card && card.alternatives.length > 0 ? (
                  <PurchaseOptionsPanel
                    title="ALTERNATIVES"
                    purchaseOptions={toPurchaseOptions(card.alternatives)}
                    testID={`multi-item-commerce-alternatives-${candidate.id}`}
                  />
                ) : null}
              </>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: SPACING.lg,
    gap: SPACING.xl,
  },
  item: {
    gap: SPACING.sm,
  },
  itemLabel: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 15,
  },
});
