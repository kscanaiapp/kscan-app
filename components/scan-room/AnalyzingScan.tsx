import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Image,
  ActivityIndicator,
  useWindowDimensions,
  Pressable,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { ScanRoomHeader } from './ScanRoomHeader';
import { EmptyStateCard } from '../luxury/EmptyStateCard';

interface AnalyzingScanProps {
  imageUri?: string | null;
  isComplete?: boolean;
  hasError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  onRetake?: () => void;
  onMinimumDisplayComplete?: () => void;
  onHome?: () => void;
  testID?: string;
}

const MIN_DISPLAY_MS = 1500;

/**
 * Analyzing Scan state for Scan Room V2.
 *
 * - Light luxury pearl canvas.
 * - Image-first layout with compact honest loading copy.
 * - One stable "Analyzing your look…" message (no fake steps or percentages).
 * - Minimum 1.5s display, fast-forwards when `isComplete` becomes true.
 * - Error state with Retry / Retake if analysis fails.
 */
export function AnalyzingScan({
  imageUri,
  isComplete,
  hasError,
  errorMessage,
  onRetry,
  onRetake,
  onMinimumDisplayComplete,
  onHome,
  testID,
}: AnalyzingScanProps) {
  const { width: screenWidth } = useWindowDimensions();
  const startTime = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const imageWidth = Math.min(screenWidth - SPACING.xl * 2, 280);
  const imageHeight = imageWidth * 1.25;

  // Fast-forward when complete
  useEffect(() => {
    if (!isComplete || hasError) return;

    const elapsed = Date.now() - startTime.current;
    if (elapsed < MIN_DISPLAY_MS) {
      timerRef.current = setTimeout(() => {
        onMinimumDisplayComplete?.();
      }, MIN_DISPLAY_MS - elapsed);
    } else {
      onMinimumDisplayComplete?.();
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isComplete, hasError, onMinimumDisplayComplete]);

  const homeButton = onHome ? (
    <Pressable
      onPress={onHome}
      style={styles.homeButton}
      accessibilityRole="button"
      accessibilityLabel="Go Home"
      accessibilityHint="Returns to the K Scan AI home screen"
    >
      <Text style={styles.homeButtonText}>Home</Text>
    </Pressable>
  ) : undefined;

  if (hasError) {
    return (
      <View style={styles.root} testID={testID}>
        <ScanRoomHeader rightAction={homeButton} />
        <View style={styles.errorContainer}>
          <EmptyStateCard
            title={errorMessage || 'Analysis failed'}
            subtitle="We couldn't complete the scan. Please try again."
            icon={<Text style={styles.errorIcon}>✦</Text>}
            action={
              onRetry
                ? {
                    label: 'Retry',
                    onPress: onRetry,
                    accessibilityLabel: 'Retry analysis',
                  }
                : undefined
            }
          />
          {onRetake && (
            <Text
              style={styles.retakeLink}
              onPress={onRetake}
              accessibilityRole="button"
              accessibilityLabel="Retake photo"
            >
              Retake Photo
            </Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root} testID={testID}>
      <ScanRoomHeader rightAction={homeButton} />

      {/* Thumbnail */}
      {imageUri && (
        <View style={[styles.thumbnailCard, { width: imageWidth, height: imageHeight }]}>
          <Image
            source={{ uri: imageUri }}
            style={styles.thumbnailImage}
            resizeMode="cover"
          />
        </View>
      )}

      {/* Compact processing card */}
      <View style={styles.processingCard}>
        <ActivityIndicator size="small" color={LUXURY.colors.plum} />
        <Text style={styles.processingTitle}>Analyzing your look…</Text>
        <View style={styles.analyzingButton}>
          <Text style={styles.analyzingButtonText}>ANALYZING…</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: LUXURY.colors.ivory,
    alignItems: 'center',
  },
  thumbnailCard: {
    alignSelf: 'center',
    borderRadius: RADIUS.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    ...SHADOWS.editorialSmall,
    marginTop: SPACING.lg,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  processingCard: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    marginTop: SPACING.lg,
    marginHorizontal: SPACING.xl,
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  processingTitle: {
    ...LUXURY.typography.displayTitle,
    fontSize: 20,
    textAlign: 'center',
  },
  analyzingButton: {
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    backgroundColor: 'transparent',
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.sm,
    minHeight: 40,
    minWidth: 160,
    justifyContent: 'center',
    alignItems: 'center',
  },
  analyzingButtonText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 1.2,
    color: LUXURY.colors.stone,
    textTransform: 'uppercase',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    gap: SPACING.lg,
  },
  errorIcon: {
    fontSize: 32,
    color: LUXURY.colors.goldBrushed,
  },
  retakeLink: {
    ...LUXURY.typography.ctaSecondary,
    textAlign: 'center',
    marginTop: SPACING.md,
  },
  homeButton: {
    borderRadius: RADIUS.pill,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.goldBrushed,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    minHeight: 36,
    justifyContent: 'center',
    alignItems: 'center',
    ...SHADOWS.editorialSmall,
  },
  homeButtonText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 1.2,
    color: LUXURY.colors.plumDeep,
    textTransform: 'uppercase',
  },
});
