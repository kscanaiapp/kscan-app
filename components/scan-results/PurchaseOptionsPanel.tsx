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
import { openPersistedCommerceUrl } from '../../services/dressingRoomCommerce';
import { isSafeCommerceUrl } from '../../services/commerceDestination';

interface PurchaseOptionsPanelProps {
  purchaseOptions?: PurchaseOption[];
  testID?: string;
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
}: PurchaseOptionsPanelProps) {
  const hasData = Array.isArray(purchaseOptions) && purchaseOptions.length > 0;

  return (
    <View style={styles.container} testID={testID ?? 'purchase-options-panel'}>
      <SectionHeader title="MATCHING PRODUCTS" />

      {hasData ? (
        <View style={styles.list}>
          {purchaseOptions!.map((option, index) => {
            // KSB29-025 / DEF-020 / DEF-032: product metadata is untrusted
            // provider input, so the destination is validated BEFORE the row
            // offers to open it. `isSafeCommerceUrl` is the authoritative
            // check — HTTPS only, no embedded credentials, no loopback or
            // private-network target, no javascript:/file:/data:. A URL that
            // fails it renders as "Unavailable" rather than as a live control.
            const safeProductUrl = isSafeCommerceUrl(option.productUrl);
            const hasProductUrl = Boolean(safeProductUrl);
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
                  {hasProductUrl ? (
                    <TouchableOpacity
                      onPress={() => {
                        // Routed through the centralized opener rather than
                        // calling Linking.openURL directly, so this row cannot
                        // drift away from the shared destination policy the
                        // way it had.
                        void openPersistedCommerceUrl(safeProductUrl, (url) =>
                          Linking.openURL(url),
                        );
                      }}
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
    minHeight: 48,
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
