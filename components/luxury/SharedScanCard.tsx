import React, { useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';

export interface SharedScanCardProps {
  /** Image URI for the scan/product. */
  imageUrl?: string | null;
  /** Primary label (title or category fallback). */
  title: string;
  /** Secondary label such as source or room context. */
  subtitle?: string;
  /** Small attribute chips (category, color, silhouette, etc.). */
  chips?: string[];
  /** Optional status pill label, e.g. "Shared". */
  status?: string;
  /** Optional footer slot for read-only reactions or actions. */
  footer?: React.ReactNode;
  /** Called when the card is pressed. */
  onPress?: () => void;
  /** Accessibility label describing the card. */
  accessibilityLabel?: string;
  /** Override root style. */
  style?: ViewStyle;
}

/**
 * A premium card for an existing scan or product referenced in a shared context.
 *
 * - Image-first layout with warm pearl surface and champagne border.
 * - Optional status pill and attribute chips.
 * - Optional footer for read-only reactions or context actions.
 * - Does not invent scan/product data.
 */
export function SharedScanCard({
  imageUrl,
  title,
  subtitle,
  chips,
  status,
  footer,
  onPress,
  accessibilityLabel,
  style,
}: SharedScanCardProps) {
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
            accessibilityLabel={`${title} image`}
          />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>K</Text>
          </View>
        )}
        {status ? (
          <View style={styles.statusPill}>
            <Text style={styles.statusText}>{status}</Text>
          </View>
        ) : null}
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
        {chips && chips.length > 0 ? (
          <View style={styles.chipRow}>
            {chips.map((chip) => (
              <View key={chip} style={styles.chip}>
                <Text style={styles.chipText}>{chip}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </View>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={[styles.card, style]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? `${title} shared scan`}
      >
        {cardContent}
      </Pressable>
    );
  }

  return (
    <View
      style={[styles.card, style]}
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? `${title} shared scan`}
    >
      {cardContent}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  imageWrap: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: LUXURY.colors.champagne,
    position: 'relative',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    fontFamily: LUXURY.typography.brandMark.fontFamily,
    fontSize: 28,
    color: LUXURY.colors.goldBrushed,
  },
  statusPill: {
    position: 'absolute',
    top: SPACING.sm,
    left: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: `${LUXURY.colors.goldBrushed}55`,
    backgroundColor: `${LUXURY.colors.pearl}F2`,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  statusText: {
    ...LUXURY.typography.caption,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.2,
    color: LUXURY.colors.goldBrushed,
  },
  meta: {
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  subtitle: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.2,
    color: LUXURY.colors.stone,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    lineHeight: 20,
    color: LUXURY.colors.ink,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.xs,
  },
  chip: {
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
  },
  chipText: {
    ...LUXURY.typography.caption,
    fontSize: 9,
    letterSpacing: 0.8,
    color: LUXURY.colors.graphite,
  },
  footer: {
    marginTop: SPACING.sm,
  },
});
