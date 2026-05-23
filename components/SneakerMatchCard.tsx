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
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../constants/theme';

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

      <View style={styles.card}>
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
                >
                  <Text style={styles.linkText}>StockX</Text>
                </TouchableOpacity>
              ) : null}
              {primary.marketplaceLinks.goat ? (
                <TouchableOpacity
                  onPress={() => openUrl(primary.marketplaceLinks?.goat)}
                  style={styles.linkChip}
                  activeOpacity={0.7}
                >
                  <Text style={styles.linkText}>GOAT</Text>
                </TouchableOpacity>
              ) : null}
              {primary.marketplaceLinks.flightClub ? (
                <TouchableOpacity
                  onPress={() => openUrl(primary.marketplaceLinks?.flightClub)}
                  style={styles.linkChip}
                  activeOpacity={0.7}
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
    ...(TYPOGRAPHY.categoryLabel as object),
    color:         COLORS.goldPressed,
    textTransform: 'uppercase',
    marginBottom:  SPACING.sm,
  },
  card: {
    flexDirection:   'row',
    borderRadius:    RADIUS.md,
    borderWidth:     StyleSheet.hairlineWidth,
    borderColor:     COLORS.borderSubtle,
    backgroundColor: COLORS.surfaceRaised,
    overflow:        'hidden',
    padding:         SPACING.md,
    gap:             SPACING.md,
  },
  image: {
    width:        80,
    height:       80,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.surfaceMuted,
    flexShrink:   0,
  },
  info: {
    flex:    1,
    gap:     SPACING.xs,
  },
  name: {
    fontSize:    14,
    fontWeight:  '600' as const,
    color:       COLORS.editorialTextPrimary,
    lineHeight:  19,
  },
  brand: {
    fontSize:    12,
    fontWeight:  '500' as const,
    color:       COLORS.editorialTextSecondary,
    letterSpacing: 0.4,
  },
  sku: {
    fontSize:    11,
    fontWeight:  '400' as const,
    color:       COLORS.editorialTextMuted,
    letterSpacing: 0.6,
    fontFamily:  'monospace' as const,
  },
  detail: {
    fontSize:  11,
    color:     COLORS.editorialTextMuted,
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
    fontSize:      10,
    fontWeight:    '500' as const,
    color:         COLORS.editorialTextMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.8,
  },
  priceValue: {
    fontSize:   13,
    fontWeight: '600' as const,
    color:      COLORS.editorialTextPrimary,
  },
  marketPrice: {
    color: COLORS.goldPressed,
  },
  linkRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           SPACING.xs,
    marginTop:     SPACING.xs,
  },
  linkChip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical:   3,
    borderRadius:      RADIUS.pill,
    borderWidth:       StyleSheet.hairlineWidth,
    borderColor:       COLORS.borderSubtle,
    backgroundColor:   COLORS.surfaceMuted,
  },
  linkText: {
    fontSize:   10,
    fontWeight: '500' as const,
    color:      COLORS.editorialTextSecondary,
  },
  source: {
    fontSize:    10,
    color:       COLORS.editorialTextMuted,
    marginTop:   SPACING.xs,
    fontStyle:   'italic' as const,
  },
});
