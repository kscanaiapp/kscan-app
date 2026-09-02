import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';
import { PurchaseOptionsPanel } from './PurchaseOptionsPanel';
import { InlineNotice } from '../luxury/InlineNotice';
import { mapRawProductToPurchaseOption } from './types';
import type { PurchaseOption } from './types';
import type { OutfitConfirmationCandidate } from '../../services/outfitConfirmation/outfitDetectionBridge';
import type { ItemCommerceCard, ItemCommerceStatus } from '../../services/multiItemCommerce';

interface MultiItemCommerceSectionProps {
  /** Every detected item, eligible or not — order is the garment order. */
  candidates: OutfitConfirmationCandidate[];
  /** Populated cards, keyed by candidateId, for candidates that were eligible. */
  cardsByCandidateId: Map<string, ItemCommerceCard>;
  /** Whole-shelf lifecycle: 'idle' before dispatch, 'pending' while in flight. */
  status: 'idle' | 'pending' | 'ready';
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
 * classification, no match percentages). An item without a strong result
 * shows a restrained no-match state; it never blocks or hides its siblings.
 */
export function MultiItemCommerceSection({
  candidates,
  cardsByCandidateId,
  status,
  onRetry,
  testID,
}: MultiItemCommerceSectionProps) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  return (
    <View style={styles.container} testID={testID ?? 'multi-item-commerce-section'}>
      {candidates.map((candidate) => {
        const card = cardsByCandidateId.get(candidate.id);
        const itemStatus: ItemCommerceStatus | 'pending' | 'not_eligible' =
          card?.status ?? (status === 'pending' ? 'pending' : 'not_eligible');

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
                the garment name for the same reason: three stacked
                "No strong shopping match found." notices are indistinguishable
                by voice. */}
            <Text
              style={styles.itemLabel}
              numberOfLines={1}
              accessibilityRole="header"
              accessibilityLabel={`${candidate.label}, purchase options`}
            >
              {candidate.label}
            </Text>

            {itemStatus === 'pending' ? (
              <InlineNotice
                variant="info"
                body="Finding where to buy this…"
                accessibilityLabel={`Finding where to buy ${candidate.label}`}
                testID={`multi-item-commerce-pending-${candidate.id}`}
              />
            ) : itemStatus === 'error' ? (
              <InlineNotice
                variant="error"
                body="Couldn't load purchase options for this item."
                accessibilityLabel={`Couldn't load purchase options for ${candidate.label}`}
                action={onRetry ? { label: 'Retry', onPress: onRetry, accessibilityLabel: `Retry purchase options for ${candidate.label}`, testID: `multi-item-commerce-retry-${candidate.id}` } : undefined}
                testID={`multi-item-commerce-error-${candidate.id}`}
              />
            ) : itemStatus === 'no_match' || itemStatus === 'not_eligible' ? (
              <InlineNotice
                variant="info"
                body="No strong shopping match found."
                accessibilityLabel={`No strong shopping match found for ${candidate.label}`}
                testID={`multi-item-commerce-no-match-${candidate.id}`}
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
