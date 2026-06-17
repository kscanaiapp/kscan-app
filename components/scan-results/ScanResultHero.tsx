import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Animated,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { StatusPill } from '../luxury/StatusPill';
import { EmptyStateCard } from '../luxury/EmptyStateCard';
import { formatMatchPercent } from './formatMatchPercent';

interface ScanResultHeroProps {
  imageUri?: string | null;
  category?: string;
  confidence?: number;
  onImageError?: () => void;
}

/**
 * Premium hero card for scan results.
 *
 * - Large image with reserved 4:5 aspect ratio to prevent layout jump.
 * - Match badge positioned bottom-left using real confidence only.
 * - Pearl/champagne placeholder if no image is available.
 */
export function ScanResultHero({
  imageUri,
  category,
  confidence,
  onImageError,
}: ScanResultHeroProps) {
  const { width: screenWidth } = useWindowDimensions();
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const imageOpacity = React.useRef(new Animated.Value(0)).current;

  const hasImage = Boolean(imageUri) && !imageError;
  const formattedConfidence = formatMatchPercent(confidence);

  const handleLoad = () => {
    setImageLoaded(true);
    Animated.timing(imageOpacity, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  };

  const handleError = () => {
    setImageError(true);
    onImageError?.();
  };

  const heroWidth = Math.min(screenWidth - SPACING.xl * 2, 420);
  const heroHeight = heroWidth * 1.25; // 4:5 aspect ratio

  if (!hasImage && !category) {
    return (
      <EmptyStateCard
        title="No scan image available"
        subtitle="Your scan analysis is ready."
        testID="scan-result-hero-empty"
      />
    );
  }

  return (
    <View
      style={[styles.container, { width: heroWidth, height: heroHeight }]}
      testID="scan-result-hero"
    >
      <View style={[styles.imageWrap, { width: heroWidth, height: heroHeight }]}>
        {!imageLoaded && hasImage && (
          <View style={[styles.skeleton, { width: heroWidth, height: heroHeight }]} />
        )}

        {hasImage ? (
          <Animated.Image
            source={{ uri: imageUri! }}
            style={[
              styles.image,
              { width: heroWidth, height: heroHeight, opacity: imageOpacity },
            ]}
            resizeMode="cover"
            onLoad={handleLoad}
            onError={handleError}
            accessibilityLabel={
              category ? `Scanned ${category} image` : 'Scanned fashion item image'
            }
          />
        ) : (
          <View style={[styles.placeholder, { width: heroWidth, height: heroHeight }]}>
            <Text style={styles.placeholderText}>
              {category ? category.charAt(0).toUpperCase() : 'K'}
            </Text>
          </View>
        )}

        {/* Match badge — bottom-left, only if real confidence exists */}
        {formattedConfidence !== null && formattedConfidence >= 50 && (
          <View style={styles.badgeWrap}>
            <StatusPill
              label={`${formattedConfidence}% MATCH`}
              variant="gold"
              accessibilityLabel={`Match confidence: ${formattedConfidence} percent`}
              testID="scan-result-match-badge"
            />
          </View>
        )}
        {formattedConfidence !== null && formattedConfidence < 50 && (
          <View style={styles.badgeWrap}>
            <StatusPill
              label="MATCH"
              variant="neutral"
              accessibilityLabel="Match detected"
              testID="scan-result-match-badge"
            />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'center',
    borderRadius: RADIUS.xl,
    overflow: 'hidden',
    ...SHADOWS.editorialRaised,
  },
  imageWrap: {
    borderRadius: RADIUS.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(198, 161, 91, 0.24)',
    backgroundColor: LUXURY.colors.champagne,
  },
  image: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  skeleton: {
    position: 'absolute',
    top: 0,
    left: 0,
    backgroundColor: LUXURY.colors.champagne,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.champagne,
  },
  placeholderText: {
    fontFamily: LUXURY.typography.brandMark.fontFamily,
    fontSize: 48,
    color: LUXURY.colors.goldBrushed,
  },
  badgeWrap: {
    position: 'absolute',
    bottom: SPACING.md,
    left: SPACING.md,
  },
});
