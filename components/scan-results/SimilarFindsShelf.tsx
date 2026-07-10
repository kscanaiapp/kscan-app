import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { ProductCard } from '../luxury/ProductCard';
import { SectionHeader } from '../luxury/SectionHeader';
import { EmptyStateCard } from '../luxury/EmptyStateCard';
import { InlineNotice } from '../luxury/InlineNotice';
import { formatMatchPercent } from './formatMatchPercent';
import type { ProductMatch } from './types';

interface SimilarFindsShelfProps {
  similarFinds?: ProductMatch[];
  onViewAll?: () => void;
  testID?: string;
}

/**
 * Horizontal product shelf for similar finds.
 *
 * - Renders real similarFinds only if provided.
 * - Shows match percentage only if real.
 * - Shows price only if real.
 * - Uses ProductCard from the luxury design system.
 * - Empty state when no backend data is available.
 */
export function SimilarFindsShelf({
  similarFinds,
  onViewAll,
  testID,
}: SimilarFindsShelfProps) {
  const hasData = Array.isArray(similarFinds) && similarFinds.length > 0;

  return (
    <View style={styles.container} testID={testID ?? 'similar-finds-shelf'}>
      <SectionHeader
        title="SIMILAR STYLES YOU CAN SHOP"
        actionLabel="View all"
        onAction={onViewAll}
        actionAccessibilityLabel="View all similar styles"
      />

      {hasData ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {similarFinds!.map((product) => {
            const matchPct = formatMatchPercent(product.matchPercent);
            const price = product.priceLabel || undefined;
            const subtitle = product.brand || product.retailer || undefined;

            return (
              <ProductCard
                key={product.id}
                imageUrl={product.imageUrl}
                title={product.title}
                subtitle={subtitle}
                price={price}
                onPress={
                  product.productUrl
                    ? () => Linking.openURL(product.productUrl!)
                    : undefined
                }
                accessibilityLabel={
                  matchPct !== null
                    ? `${product.title}. ${matchPct} percent match.`
                    : `${product.title}. Similar find.`
                }
                style={styles.card}
              />
            );
          })}
        </ScrollView>
      ) : (
        <EmptyStateCard
          title="Similar styles from this look will appear here."
          subtitle="Based on your scan — your style analysis above is ready to use."
          testID="similar-finds-empty"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: SPACING.lg,
  },
  scrollContent: {
    gap: SPACING.md,
    paddingBottom: SPACING.xs,
  },
  card: {
    width: 168,
  },
});
