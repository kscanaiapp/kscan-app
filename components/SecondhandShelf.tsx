import React, { useRef, useState } from 'react';
import {
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ImageStyle,
} from 'react-native';
import { COLORS, LUXURY, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../constants/theme';
import { selectionTick } from '../services/haptics';
import { openExternalUrl } from '../services/openExternalUrl';
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

  // listingUrl comes from the search-vinted-secondhand response, so its scheme
  // is upstream-controlled. A URL the shared guard rejects shows the same
  // LINK UNAVAILABLE notice an unreachable one already did.
  const handleLinkPress = (url: string) => {
    selectionTick();
    void openExternalUrl(url).then((opened) => {
      if (opened) return;
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
              accessibilityRole="link"
              accessibilityLabel={`${item.title || 'Secondhand item'} on Vinted, ${formatPrice(item)}`}
              accessibilityHint="Opens the Vinted listing"
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
                <View style={styles.linkPill}>
                  <Text style={styles.linkText}>View on Vinted</Text>
                </View>
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
    ...LUXURY.typography.sectionLabel,
  },
  labelLine: {
    flex: 1,
    height: 1,
    backgroundColor: LUXURY.colors.border,
  },
  scrollContent: {
    gap: SPACING.md,
    paddingBottom: SPACING.xs,
  },
  card: {
    width: CARD_WIDTH,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  image: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
  },
  imageSkeleton: {
    backgroundColor: LUXURY.colors.champagne,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.border,
  },
  listingImage: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
    position: 'absolute',
    top: 0,
    left: 0,
  },
  imagePlaceholder: {
    backgroundColor: LUXURY.colors.champagne,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.border,
  },
  placeholderText: {
    ...LUXURY.typography.caption,
  },
  cardBody: {
    padding: SPACING.sm,
    gap: SPACING.xxs,
  },
  source: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase' as const,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    lineHeight: 18,
  },
  price: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
    marginTop: SPACING.xxs,
  },
  metaRow: {
    minHeight: 16,
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  meta: {
    maxWidth: 62,
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.4,
  },
  linkPill: {
    alignSelf: 'flex-start',
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.plumMuted,
    backgroundColor: LUXURY.colors.plumMuted,
    minHeight: 30,
    justifyContent: 'center',
  },
  linkText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    textTransform: 'none',
    letterSpacing: 0.5,
  },
  linkError: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.error,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
});
