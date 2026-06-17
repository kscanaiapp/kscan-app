import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { ProductCard, StatusPill } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import type { TextScanDemoProduct } from '../../data/textscan-demo';

export interface TextScanProductCardProps {
  product: TextScanDemoProduct;
  onPress?: () => void;
  style?: ViewStyle;
}

/**
 * A product card for TextScan results that composes the existing ProductCard
 * with a Retail / Resale badge.
 */
export function TextScanProductCard({
  product,
  onPress,
  style,
}: TextScanProductCardProps) {
  return (
    <View style={[styles.root, style]}>
      <View style={styles.badge}>
        <StatusPill
          label={product.type === 'retail' ? 'Retail' : 'Resale'}
          variant={product.type === 'retail' ? 'neutral' : 'gold'}
        />
      </View>
      <ProductCard
        title={product.title}
        subtitle={product.source}
        price={product.price}
        onPress={onPress}
        accessibilityLabel={`${product.title}, ${product.source}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: SPACING.sm,
    left: SPACING.sm,
    zIndex: 2,
  },
});
