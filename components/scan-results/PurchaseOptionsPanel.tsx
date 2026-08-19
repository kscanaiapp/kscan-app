import React from 'react';
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
import type { PurchaseOption } from './types';
import { selectCommerceDestination } from '../../services/commerceDestination';

interface PurchaseOptionsPanelProps {
  purchaseOptions?: PurchaseOption[];
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
  testID,
  commerceStatus = 'idle',
  onRetry,
}: PurchaseOptionsPanelProps) {
  const hasData = Array.isArray(purchaseOptions) && purchaseOptions.length > 0;
  const mode = resolvePurchaseOptionsPanelMode(hasData, commerceStatus);

  return (
    <View style={styles.container} testID={testID ?? 'purchase-options-panel'}>
      <SectionHeader title="MATCHING PRODUCTS" />

      {mode === 'data' ? (
        <View style={styles.list}>
          {purchaseOptions!.map((option, index) => {
            // Validated rather than merely present: an unsafe or malformed URL
            // must not surface an action that cannot lead anywhere.
            const destination = selectCommerceDestination([option.productUrl]);
            const hasPrice = Boolean(option.priceLabel);
            const hasAvailability = Boolean(option.availabilityLabel);

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
                      accessibilityHint="Opens the retailer product page"
                      style={styles.viewOptionsButton}
                    >
                      <Text style={styles.viewOptionsText}>View Options</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.unavailableLabel}>Unavailable</Text>
                  )}
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
