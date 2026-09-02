import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { SectionHeader } from '../luxury/SectionHeader';
import { EmptyStateCard } from '../luxury/EmptyStateCard';
import { InlineNotice } from '../luxury/InlineNotice';
import { canWatchPurchaseOption } from './types';
import type { PurchaseOption, WatchCandidate } from './types';
import { selectCommerceDestination } from '../../services/commerceDestination';
// DEF-WL-07: the EXISTING Watch creation flow, reused rather than reimplemented.
// ProductShelf keeps owning the modal and the createWatch call; this surface
// only decides which rows may open it.
import { WatchThisModal } from '../ProductShelf';
import { KPlusGate } from '../kplus/KPlusGate';
// VTO-REACH-001: the EXISTING try-on entry point, reused rather than
// reimplemented. TryItOnEntry keeps owning eligibility, the K+ conversation and
// the sheet; this surface only decides which rows may offer it.
import { VTO_UI_ENABLED } from '../../constants/featureFlags';
import { TryItOnEntry } from '../vto/TryItOnEntry';

interface PurchaseOptionsPanelProps {
  purchaseOptions?: PurchaseOption[];
  /** Section heading. Defaults to the single-item shelf's existing title. */
  title?: string;
  testID?: string;
  /**
   * v127 (P1-B): deferred commerce lifecycle. 'idle' (the default) leaves
   * this panel exactly as it behaves without this prop — data or the
   * existing empty state. 'pending'/'error' apply only while there is no
   * data yet; once options arrive they always render regardless of status.
   */
  commerceStatus?: 'idle' | 'pending' | 'success' | 'empty' | 'error';
  /** Present only when a failed deferred fetch is retryable. */
  onRetry?: () => void;
}

/**
 * Which treatment this panel shows. Pulled out of the JSX branch so this
 * exact precedence is independently testable — a pure decision, not a
 * parallel copy of it. Options in hand always win, regardless of status: a
 * stale 'error' from before a successful retry must never hide options that
 * already arrived.
 */
export function resolvePurchaseOptionsPanelMode(
  hasData: boolean,
  commerceStatus: string,
): 'data' | 'pending' | 'error' | 'empty' {
  if (hasData) return 'data';
  if (commerceStatus === 'pending') return 'pending';
  if (commerceStatus === 'error') return 'error';
  return 'empty';
}

/**
 * Purchase options panel.
 *
 * - Renders real purchase options only if backend supplies them.
 * - No hardcoded retailer rows, no fake prices, no fake inventory.
 * - "View Options" opens productUrl if available; otherwise hidden.
 */
export function PurchaseOptionsPanel({
  purchaseOptions,
  title = 'MATCHING PRODUCTS',
  testID,
  commerceStatus = 'idle',
  onRetry,
}: PurchaseOptionsPanelProps) {
  const hasData = Array.isArray(purchaseOptions) && purchaseOptions.length > 0;
  const mode = resolvePurchaseOptionsPanelMode(hasData, commerceStatus);
  // DEF-WL-07: the row whose Watch action is open, or null. Ephemeral view
  // state -- nothing here is written back into the scan.
  const [watchCandidate, setWatchCandidate] = useState<WatchCandidate | null>(null);

  return (
    <View style={styles.container} testID={testID ?? 'purchase-options-panel'}>
      <SectionHeader title={title} />

      {mode === 'data' ? (
        <View style={styles.list}>
          {purchaseOptions!.map((option, index) => {
            // Validated rather than merely present: an unsafe or malformed URL
            // must not surface an action that cannot lead anywhere.
            const destination = selectCommerceDestination([option.productUrl]);
            const hasPrice = Boolean(option.priceLabel);
            const hasAvailability = Boolean(option.availabilityLabel);
            // DEF-WL-07: server-authored eligibility, read not re-derived.
            const canWatch = canWatchPurchaseOption(option);

            return (
              <View
                key={option.id}
                style={[
                  styles.row,
                  index > 0 && styles.rowBorder,
                ]}
              >
                <View style={styles.rowLeft}>
                  <Text style={styles.retailer}>{option.retailer}</Text>
                  {option.title ? (
                    <Text style={styles.productTitle} numberOfLines={1}>
                      {option.title}
                    </Text>
                  ) : null}
                </View>

                <View style={styles.rowRight}>
                  {hasPrice ? (
                    <Text style={styles.price}>{option.priceLabel}</Text>
                  ) : null}
                  {hasAvailability ? (
                    <Text
                      style={[
                        styles.availability,
                        option.availabilityLabel === 'In Stock'
                          ? styles.inStock
                          : styles.outOfStock,
                      ]}
                    >
                      {option.availabilityLabel}
                    </Text>
                  ) : null}
                  {destination ? (
                    <TouchableOpacity
                      onPress={() => Linking.openURL(destination)}
                      activeOpacity={0.78}
                      accessibilityRole="link"
                      accessibilityLabel={`View options for ${option.title ?? option.retailer}`}
                      // SCAN-009. The visible CTA is deliberately hedged
                      // ("View Options") because the destination is not
                      // guaranteed to be the retailer's own site: the backend
                      // prefers a direct retailer URL and falls back to the
                      // aggregator the provider returned when there is none
                      // (see selectRetailerDestination / isAggregatorDestination).
                      // Measured live, 28 of 33 destinations were Google
                      // Shopping listings. The hint must not promise what the
                      // button does not, so it states what is always true.
                      accessibilityHint="Opens this listing in your browser"
                      style={styles.viewOptionsButton}
                    >
                      <Text style={styles.viewOptionsText}>View Options</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.unavailableLabel}>Unavailable</Text>
                  )}
                  {/* DEF-WL-07 (P1). The Watch affordance on the SHIPPED
                      commerce surface. ScanResultV2 renders this panel
                      directly for a single item and, via
                      MultiItemCommerceSection, for every per-item card -- so
                      placing it here reaches both without a second commerce
                      architecture and without resurrecting AnalysisCard.
                      Eligibility is server-authored and only read here. */}
                  {canWatch ? (
                    <KPlusGate source="watchlist">
                      {({ isActive, openUpgrade }) => (
                        <TouchableOpacity
                          testID={`purchase-option-watch-${option.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`Watch ${option.title ?? option.retailer}`}
                          accessibilityHint="Get notified about price changes on this listing"
                          style={styles.watchButton}
                          activeOpacity={0.78}
                          onPress={() => {
                            if (isActive) setWatchCandidate(option.watchCandidate ?? null);
                            else openUpgrade();
                          }}
                        >
                          <Text style={styles.watchButtonText}>Watch</Text>
                        </TouchableOpacity>
                      )}
                    </KPlusGate>
                  ) : null}
                  {/* VTO-REACH-001 (P2). The Try It On affordance on the
                      SHIPPED commerce surface. eas.json sets
                      EXPO_PUBLIC_SCAN_RESULTS_V2_UI=true in every governed
                      profile, so ScanResultV2 renders this panel directly for
                      a single item and, via MultiItemCommerceSection, for
                      every per-item card -- while nothing in scan-results/
                      renders ProductShelf. Placing it here reaches both
                      without a second commerce architecture and without
                      resurrecting AnalysisCard, exactly as DEF-WL-07 did for
                      Watch.

                      `vtoGarment` is the canonical identity for THIS row,
                      derived by the same shared builder ProductShelf uses, so
                      a try-on started here can only ever be anchored to the
                      product the row is showing. TryItOnEntry itself renders
                      nothing unless the item is genuinely eligible (or the
                      only gap is K+), so an ineligible row looks exactly as it
                      does today. */}
                  {VTO_UI_ENABLED && option.vtoGarment ? (
                    <TryItOnEntry
                      garment={option.vtoGarment}
                      garmentTitle={option.title ?? option.retailer}
                      origin="commerce_product"
                      onShop={destination ? () => Linking.openURL(destination) : undefined}
                      testID={`purchase-option-try-it-on-${option.id}`}
                    />
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : mode === 'pending' ? (
        <InlineNotice
          variant="info"
          body="Finding where to buy this…"
          testID="purchase-options-pending"
          accessibilityRole="text"
        />
      ) : mode === 'error' ? (
        <InlineNotice
          variant="error"
          body="Couldn't load purchase options."
          action={onRetry ? { label: 'Retry', onPress: onRetry, testID: 'purchase-options-retry' } : undefined}
          testID="purchase-options-error"
          accessibilityRole="alert"
        />
      ) : (
        <EmptyStateCard
          title="Matching products will appear here for shoppable looks."
          subtitle="Based on your scan — save this look to your Closet to keep it."
          testID="purchase-options-empty"
        />
      )}

      {/* DEF-WL-07: the existing Watchlist creation flow. `WatchCandidate` is a
          structural subset of ProductShelf's `Product`, so the modal receives
          the same canonical retailer/product-URL identity it does on the legacy
          shelf and creates an identical watch. No second creation path. */}
      <WatchThisModal
        product={watchCandidate}
        visible={!!watchCandidate}
        onClose={() => setWatchCandidate(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: SPACING.lg,
  },
  list: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.md,
    gap: SPACING.md,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: LUXURY.colors.hairline,
  },
  rowLeft: {
    flex: 1,
    gap: SPACING.xs,
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: SPACING.xs,
  },
  retailer: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.4,
    color: LUXURY.colors.stone,
    textTransform: 'uppercase',
  },
  productTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    lineHeight: 18,
  },
  price: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
  },
  availability: {
    ...LUXURY.typography.caption,
    fontSize: 11,
  },
  inStock: {
    color: LUXURY.colors.success,
  },
  outOfStock: {
    color: LUXURY.colors.stone,
  },
  // DEF-WL-07: a secondary action beside "View Options" -- deliberately the
  // same geometry so the row keeps its existing rhythm.
  watchButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.plumMuted,
    marginTop: SPACING.xs,
  },
  watchButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    textTransform: 'none',
    letterSpacing: 0.5,
  },
  viewOptionsButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.plumMuted,
    backgroundColor: LUXURY.colors.plumMuted,
    marginTop: SPACING.xs,
  },
  viewOptionsText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    textTransform: 'none',
    letterSpacing: 0.5,
  },
  unavailableLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    textTransform: 'none',
    letterSpacing: 0.4,
    marginTop: SPACING.xs,
  },
});
