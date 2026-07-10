import React from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  Linking,
} from 'react-native';
import type { SneakerReference } from '../services/sneakers/types';
import { COLORS, LUXURY, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../constants/theme';

interface Props {
  matches: SneakerReference[];
}

function fmt(price: number | null): string | null {
  if (price == null) return null;
  return `$${price.toLocaleString()}`;
}

function openUrl(url: string | null | undefined): void {
  if (!url) return;
  Linking.openURL(url).catch(() => {});
}

export function SneakerMatchCard({ matches }: Props) {
  if (!matches || matches.length === 0) return null;

  const primary   = matches[0];
  const marketVal = primary.lowestAsk ?? primary.estimatedMarketValue ?? null;

  return (
    <View style={styles.container}>
      <Text style={styles.sectionLabel}>SNEAKER MATCH</Text>

      <View style={styles.card} accessible accessibilityLabel={`Sneaker match: ${primary.name}`}>
        {/* Image */}
        {primary.imageUrl ? (
          <Image
            source={{ uri: primary.imageUrl }}
            style={styles.image}
            resizeMode="contain"
            accessibilityLabel={primary.name}
          />
        ) : null}

        {/* Info */}
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={2}>
            {primary.name}
          </Text>

          {primary.brand ? (
            <Text style={styles.brand}>{primary.brand}</Text>
          ) : null}

          {primary.sku ? (
            <Text style={styles.sku}>{primary.sku}</Text>
          ) : null}

          {primary.colorway ? (
            <Text style={styles.detail}>{primary.colorway}</Text>
          ) : null}

          {/* Prices */}
          {(primary.retailPrice != null || marketVal != null || primary.lastSale != null) ? (
            <View style={styles.prices}>
              {primary.retailPrice != null ? (
                <View style={styles.priceBlock}>
                  <Text style={styles.priceLabel}>Retail</Text>
                  <Text style={styles.priceValue}>{fmt(primary.retailPrice)}</Text>
                </View>
              ) : null}

              {marketVal != null ? (
                <View style={styles.priceBlock}>
                  <Text style={styles.priceLabel}>
                    {primary.lowestAsk != null ? 'Lowest Ask' : 'Market'}
                  </Text>
                  <Text style={[styles.priceValue, styles.marketPrice]}>
                    {fmt(marketVal)}
                  </Text>
                </View>
              ) : null}

              {primary.lastSale != null ? (
                <View style={styles.priceBlock}>
                  <Text style={styles.priceLabel}>Last Sale</Text>
                  <Text style={styles.priceValue}>{fmt(primary.lastSale)}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Marketplace links */}
          {primary.marketplaceLinks ? (
            <View style={styles.linkRow}>
              {primary.marketplaceLinks.stockx ? (
                <TouchableOpacity
                  onPress={() => openUrl(primary.marketplaceLinks?.stockx)}
                  style={styles.linkChip}
                  activeOpacity={0.7}
                  accessibilityRole="link"
                  accessibilityLabel="Open StockX listing"
                >
                  <Text style={styles.linkText}>StockX</Text>
                </TouchableOpacity>
              ) : null}
              {primary.marketplaceLinks.goat ? (
                <TouchableOpacity
                  onPress={() => openUrl(primary.marketplaceLinks?.goat)}
                  style={styles.linkChip}
                  activeOpacity={0.7}
                  accessibilityRole="link"
                  accessibilityLabel="Open GOAT listing"
                >
                  <Text style={styles.linkText}>GOAT</Text>
                </TouchableOpacity>
              ) : null}
              {primary.marketplaceLinks.flightClub ? (
                <TouchableOpacity
                  onPress={() => openUrl(primary.marketplaceLinks?.flightClub)}
                  style={styles.linkChip}
                  activeOpacity={0.7}
                  accessibilityRole="link"
                  accessibilityLabel="Open Flight Club listing"
                >
                  <Text style={styles.linkText}>Flight Club</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.source}>via {primary.source}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: SPACING.xl,
  },
  sectionLabel: {
    ...LUXURY.typography.sectionLabel,
    marginBottom:  SPACING.sm,
  },
  card: {
    flexDirection:   'row',
    borderRadius:    RADIUS.lg,
    borderWidth:     1,
    borderColor:     LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow:        'hidden',
    padding:         SPACING.md,
    gap:             SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  image: {
    width:        88,
    height:       88,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.champagne,
    flexShrink:   0,
  },
  info: {
    flex:    1,
    gap:     SPACING.xs,
  },
  name: {
    ...LUXURY.typography.bodyStrong,
    fontSize:    15,
    lineHeight:  21,
  },
  brand: {
    ...LUXURY.typography.body,
    fontSize:    13,
    letterSpacing: 0.4,
  },
  sku: {
    ...LUXURY.typography.caption,
    fontFamily:  'monospace' as const,
    textTransform: 'none',
    letterSpacing: 0.6,
  },
  detail: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.4,
  },
  prices: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           SPACING.md,
    marginTop:     SPACING.xs,
  },
  priceBlock: {
    gap: 1,
  },
  priceLabel: {
    ...LUXURY.typography.caption,
    fontSize:      11,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.8,
  },
  priceValue: {
    ...LUXURY.typography.bodyStrong,
    fontSize:   14,
  },
  marketPrice: {
    color: LUXURY.colors.plum,
  },
  linkRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           SPACING.xs,
    marginTop:     SPACING.xs,
  },
  linkChip: {
    paddingHorizontal: SPACING.md,
    paddingVertical:   SPACING.xs,
    borderRadius:      RADIUS.pill,
    borderWidth:       1,
    borderColor:       LUXURY.colors.border,
    backgroundColor:   LUXURY.colors.cream,
    minHeight:         32,
    justifyContent:    'center',
  },
  linkText: {
    ...LUXURY.typography.caption,
    color:      LUXURY.colors.plum,
    textTransform: 'none',
    letterSpacing: 0.5,
  },
  source: {
    ...LUXURY.typography.caption,
    marginTop:   SPACING.xs,
    fontStyle:   'italic' as const,
    textTransform: 'none',
  },
});
