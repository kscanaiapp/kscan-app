/**
 * Commerce V2 — single shared retailer presentation component (Build 35 §21).
 *
 * The only place that renders a retailer name/logo/monogram. Commerce cards,
 * purchase-option rows, and Watchlist must all render through this component
 * rather than hand-rolling their own retailer label -- see
 * `resolveRetailerIdentity` (services/commerce/retailerIdentity.ts) for the
 * data-side half of this contract.
 *
 * Renders nothing when the retailer is unknown (`retailerKey` and
 * `displayName` both null) -- consistent with the rest of this app's
 * commerce UI, which omits an unknown field rather than showing a
 * placeholder (Build 35 §70).
 */

import React from 'react';
import { Image, StyleSheet, Text, View, type ImageSourcePropType } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';
import type { RetailerIdentity as RetailerIdentityValue } from '../../services/commerce/retailerIdentity';

/**
 * Static asset map for retailer logos, keyed by `retailerKey`. Empty today --
 * no retailer logo ships with a documented rights basis yet (Build 35 §19,
 * `assets/commerce/retailers/README.md`). React Native's bundler requires
 * static `require()` calls, so a future logo is wired in here by hand, one
 * line per retailer, exactly as the README describes.
 */
const RETAILER_LOGO_ASSETS: Readonly<Record<string, ImageSourcePropType>> = {};

export type RetailerIdentityMode = 'card' | 'row' | 'compact' | 'watchlist' | 'text-only';

export interface RetailerIdentityProps {
  identity: RetailerIdentityValue;
  mode?: RetailerIdentityMode;
  testID?: string;
}

const MONOGRAM_SIZE: Record<RetailerIdentityMode, number> = {
  card: 16,
  row: 18,
  compact: 14,
  watchlist: 18,
  'text-only': 0,
};

export function retailerAccessibilityLabel(identity: RetailerIdentityValue): string | null {
  if (!identity.displayName) return null;
  return identity.commerceType ? `${identity.displayName}, ${identity.commerceType}` : identity.displayName;
}

export function RetailerIdentity({ identity, mode = 'card', testID }: RetailerIdentityProps) {
  if (!identity || !identity.displayName) return null;

  const label = mode === 'watchlist' ? identity.displayName.toUpperCase() : identity.displayName;
  const logoSource = identity.retailerKey ? RETAILER_LOGO_ASSETS[identity.retailerKey] : undefined;
  const monogramSize = MONOGRAM_SIZE[mode];
  const accessibilityLabel = retailerAccessibilityLabel(identity) ?? undefined;

  if (mode === 'text-only') {
    return (
      <Text
        testID={testID}
        style={[styles.text, styles.textOnly]}
        numberOfLines={1}
        accessibilityLabel={accessibilityLabel}
      >
        {label}
      </Text>
    );
  }

  return (
    <View testID={testID} style={styles.row} accessible accessibilityLabel={accessibilityLabel}>
      {logoSource ? (
        <Image
          source={logoSource}
          style={{ width: monogramSize, height: monogramSize }}
          resizeMode="contain"
          // Decorative alongside the text label below -- avoids a duplicate
          // announcement of the same retailer name (Build 35 §69).
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ) : identity.fallbackMonogram ? (
        <View style={[styles.monogram, { width: monogramSize, height: monogramSize, borderRadius: monogramSize / 2 }]}>
          <Text style={[styles.monogramText, { fontSize: monogramSize * 0.6 }]}>{identity.fallbackMonogram}</Text>
        </View>
      ) : null}
      <Text style={[styles.text, mode === 'watchlist' && styles.watchlistText]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xxs,
  },
  monogram: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.champagne,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  monogramText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontWeight: '700' as const,
    textTransform: 'uppercase' as const,
  },
  text: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.4,
    color: LUXURY.colors.stone,
    textTransform: 'uppercase' as const,
  },
  textOnly: {
    letterSpacing: 1.2,
  },
  watchlistText: {
    fontSize: 11,
    letterSpacing: 1.6,
  },
});
