/**
 * Commerce V2 "Where to Buy" summary (Build 35 §54-56).
 *
 * A neutral retailer-count summary for one item's offers. Renders nothing
 * for zero or one offer -- with a single offer, the purchase-option row
 * above already says where to buy it; this is only useful once there is
 * more than one place to compare.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';
import { RetailerIdentity } from './RetailerIdentity';
import { getRetailerByKey } from '../../services/commerce/retailerRegistry';
import { whereToBuyRowLabel, type WhereToBuyRow } from '../../services/commerce/whereToBuy';

export interface WhereToBuySummaryProps {
  rows: WhereToBuyRow[];
  testID?: string;
}

export function WhereToBuySummary({ rows, testID }: WhereToBuySummaryProps) {
  if (!rows || rows.length < 2) return null;

  return (
    <View testID={testID ?? 'where-to-buy-summary'} style={styles.container}>
      <Text style={styles.heading}>WHERE TO BUY</Text>
      {rows.map((row, index) => {
        const registryEntry = getRetailerByKey(row.retailerKey);
        return (
          <View
            key={`${row.retailerKey ?? row.displayName}-${index}`}
            style={styles.row}
            accessible
            accessibilityLabel={`${row.displayName}, ${whereToBuyRowLabel(row)}`}
          >
            <RetailerIdentity
              identity={{
                retailerKey: row.retailerKey,
                displayName: row.displayName,
                logoAsset: registryEntry?.logoAsset ?? null,
                fallbackMonogram: registryEntry?.fallbackMonogram ?? null,
                commerceType: row.allResale ? 'resale' : null,
                sourceAuthority: row.retailerKey ? 'declared' : 'unknown',
              }}
              mode="row"
            />
            <Text style={styles.count}>{whereToBuyRowLabel(row)}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: SPACING.md,
    gap: SPACING.xs,
  },
  heading: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 11,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.xxs,
  },
  count: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
});
