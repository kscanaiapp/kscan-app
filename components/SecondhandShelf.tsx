import React, { useRef, useState } from 'react';
import {
  Animated,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ImageStyle,
} from 'react-native';
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../constants/theme';
import { selectionTick } from '../services/haptics';
import type { SecondhandItem } from '../types/scan';

interface SecondhandShelfProps {
  items?: SecondhandItem[];
}

const CARD_WIDTH = 148;
const IMAGE_SIZE = CARD_WIDTH;

function formatPrice(item: SecondhandItem) {
  const price = item.price?.trim();
  const currency = item.currency?.trim();
  if (!price && !currency) return 'Price unavailable';
  if (!price) return currency;
  if (!currency || price.includes(currency)) return price;
  return `${price} ${currency}`;
}

function ListingImage({
  uri,
  onError,
}: {
  uri: string;
  onError: () => void;
}) {
  const opacity = useRef(new Animated.Value(0)).current;

  return (
    <View style={styles.image}>
      <View style={[styles.image, styles.imageSkeleton]} />
      <Animated.Image
        source={{ uri }}
        style={[styles.listingImage as ImageStyle, { opacity }]}
        resizeMode="cover"
        onLoad={() => {
          Animated.timing(opacity, {
            toValue: 1,
            duration: 180,
            useNativeDriver: true,
          }).start();
        }}
        onError={onError}
      />
    </View>
  );
}

export function SecondhandShelf({ items = [] }: SecondhandShelfProps) {
  const [linkErrorVisible, setLinkErrorVisible] = useState(false);
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  if (!items.length) return null;

  const handleLinkPress = (url: string) => {
    selectionTick();
    Linking.openURL(url).catch(() => {
      setLinkErrorVisible(true);
      setTimeout(() => setLinkErrorVisible(false), 2000);
    });
  };

  return (
    <View testID="secondhand-shelf" style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>SECONDHAND FIRST</Text>
        <View style={styles.labelLine} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {items.map((item, index) => {
          const itemKey = item.id || `${item.source}-${index}`;
          const showImage = !!item.imageUrl && !failedImages[itemKey];
          return (
            <TouchableOpacity
              key={itemKey}
              style={styles.card}
              onPress={() => handleLinkPress(item.listingUrl)}
              activeOpacity={0.78}
            >
              {showImage ? (
                <ListingImage
                  uri={item.imageUrl as string}
                  onError={() => setFailedImages((current) => ({ ...current, [itemKey]: true }))}
                />
              ) : (
                <View style={[styles.image, styles.imagePlaceholder]}>
                  <Text style={styles.placeholderText}>VINTED</Text>
                </View>
              )}

              <View style={styles.cardBody}>
                <Text style={styles.source}>VINTED</Text>
                <Text style={styles.title} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.price}>{formatPrice(item)}</Text>
                <View style={styles.metaRow}>
                  {item.brand ? <Text style={styles.meta} numberOfLines={1}>{item.brand}</Text> : null}
                  {item.size ? <Text style={styles.meta} numberOfLines={1}>{item.size}</Text> : null}
                </View>
                <Text style={styles.linkText}>View on Vinted</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {linkErrorVisible && <Text style={styles.linkError}>LINK UNAVAILABLE</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: SPACING.xl,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  label: {
    ...TYPOGRAPHY.sectionLabel,
    color: COLORS.goldPressed,
  },
  labelLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.borderHairline,
    opacity: 0.55,
  },
  scrollContent: {
    gap: SPACING.md,
    paddingBottom: SPACING.xs,
  },
  card: {
    width: CARD_WIDTH,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  image: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
  },
  imageSkeleton: {
    backgroundColor: COLORS.surfaceMuted,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderHairline,
  },
  listingImage: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
    position: 'absolute',
    top: 0,
    left: 0,
  },
  imagePlaceholder: {
    backgroundColor: COLORS.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderHairline,
  },
  placeholderText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
  },
  cardBody: {
    padding: SPACING.sm,
    gap: SPACING.xxs,
  },
  source: {
    fontSize: 9,
    fontWeight: '600' as const,
    letterSpacing: 1.8,
    color: COLORS.editorialTextMuted,
  },
  title: {
    fontSize: 12,
    fontWeight: '500' as const,
    color: COLORS.editorialTextPrimary,
    lineHeight: 17,
  },
  price: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: COLORS.goldPressed,
    marginTop: SPACING.xxs,
  },
  metaRow: {
    minHeight: 16,
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  meta: {
    maxWidth: 62,
    fontSize: 10,
    fontWeight: '500' as const,
    color: COLORS.editorialTextSecondary,
  },
  linkText: {
    marginTop: SPACING.xs,
    fontSize: 10,
    fontWeight: '700' as const,
    letterSpacing: 1.2,
    color: COLORS.arBlue,
    textTransform: 'uppercase' as const,
  },
  linkError: {
    ...TYPOGRAPHY.caption,
    color: COLORS.errorSoft,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
});
