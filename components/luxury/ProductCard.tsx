import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  ViewStyle,
} from 'react-native';
import { LUXURY, SPACING, RADIUS } from '../../constants/theme';

export interface ProductCardProps {
  /** Product image URI. */
  imageUrl?: string | null;
  /** Product name. */
  title: string;
  /** Brand or retailer name. */
  subtitle?: string;
  /** Formatted price string. */
  price?: string;
  /** Called when the card is pressed. */
  onPress?: () => void;
  /** Called when the user taps the "Add to Dressing Room" action. */
  onAddToRoom?: () => void;
  /** Label for the add-to-room action. Defaults to "Add to Room". */
  addToRoomLabel?: string;
  /** Accessibility label describing the product card. */
  accessibilityLabel?: string;
  /** Override root style. */
  style?: ViewStyle;
}

/**
 * A compact, image-first product card for scan results and style shelves.
 *
 * - Rounded corners, soft shadow, warm border.
 * - Optional add-to-dressing-room action with clear accessibility label.
 * - Image error fallback to a warm placeholder so empty states stay polished.
 */
export function ProductCard({
  imageUrl,
  title,
  subtitle,
  price,
  onPress,
  onAddToRoom,
  addToRoomLabel = 'Add to Room',
  accessibilityLabel,
  style,
}: ProductCardProps) {
  const [imageError, setImageError] = useState(false);

  const hasImage = Boolean(imageUrl) && !imageError;

  const cardContent = (
    <>
      <View style={styles.imageWrap}>
        {hasImage ? (
          <Image
            source={{ uri: imageUrl! }}
            style={styles.image}
            resizeMode="cover"
            onError={() => setImageError(true)}
            accessibilityLabel={`${title} product image`}
          />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>K</Text>
          </View>
        )}
      </View>

      <View style={styles.meta}>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {price ? (
          <Text style={styles.price} numberOfLines={1}>
            {price}
          </Text>
        ) : null}

        {onAddToRoom && (
          <Pressable
            onPress={onAddToRoom}
            style={styles.addButton}
            accessibilityRole="button"
            accessibilityLabel={`${addToRoomLabel}: ${title}`}
          >
            <Text style={styles.addLabel}>{addToRoomLabel}</Text>
          </Pressable>
        )}
      </View>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={[styles.card, style]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? `${title} by ${subtitle ?? 'K Scan'}`}
      >
        {cardContent}
      </Pressable>
    );
  }

  return (
    <View
      style={[styles.card, style]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `${title} by ${subtitle ?? 'K Scan'}`}
    >
      {cardContent}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 152,
    backgroundColor: LUXURY.cards.product.backgroundColor,
    borderRadius: LUXURY.cards.product.borderRadius,
    borderWidth: LUXURY.cards.product.borderWidth,
    borderColor: LUXURY.cards.product.borderColor,
    padding: LUXURY.cards.product.padding,
    ...LUXURY.cards.product.shadow,
  },
  imageWrap: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    backgroundColor: LUXURY.colors.champagne,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.champagne,
  },
  placeholderText: {
    fontFamily: LUXURY.typography.brandMark.fontFamily,
    fontSize: 28,
    color: LUXURY.colors.goldBrushed,
  },
  meta: {
    marginTop: SPACING.sm,
  },
  subtitle: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.2,
    color: LUXURY.colors.stone,
    marginBottom: 2,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    lineHeight: 18,
    color: LUXURY.colors.ink,
  },
  price: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
  },
  addButton: {
    marginTop: SPACING.sm,
    paddingVertical: 4,
    minHeight: 32,
    justifyContent: 'center',
  },
  addLabel: {
    ...LUXURY.typography.ctaSecondary,
    fontSize: 11,
    letterSpacing: 1.4,
    textAlign: 'left',
  },
});
