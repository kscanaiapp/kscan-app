import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Image,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { ScanRoomHeader } from './ScanRoomHeader';
import { AIStarBadge } from '../text-scan/AIStarBadge';
import { EmptyStateCard } from '../luxury/EmptyStateCard';

interface AnalyzingScanProps {
  imageUri?: string | null;
  isComplete?: boolean;
  hasError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  onRetake?: () => void;
  onMinimumDisplayComplete?: () => void;
  testID?: string;
}

const STEPS = [
  { label: 'Detecting item', sub: 'Identifying key features' },
  { label: 'Extracting details', sub: 'Reading color, silhouette, material' },
  { label: 'Preparing results', sub: 'Building your scan analysis' },
];

const STEP_DURATION_MS = 1800;
const MIN_DISPLAY_MS = 1500;

/**
 * Analyzing Scan state for Scan Room V2.
 *
 * - Light luxury pearl canvas.
 * - Deterministic 3-step visual progression.
 * - Minimum 1.5s display, fast-forwards when `isComplete` becomes true.
 * - Shows captured image thumbnail.
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
  testID,
}: AnalyzingScanProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const [activeStep, setActiveStep] = useState(0);
  const startTime = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const imageWidth = Math.min(screenWidth - SPACING.xl * 2, 280);
  const imageHeight = imageWidth * 1.25;

  // Step progression
  useEffect(() => {
    if (hasError) return;
    if (activeStep >= STEPS.length) return;

    timerRef.current = setTimeout(() => {
      if (!isComplete) {
        setActiveStep((prev) => Math.min(prev + 1, STEPS.length));
      }
    }, STEP_DURATION_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [activeStep, isComplete, hasError]);

  // Fast-forward when complete
  useEffect(() => {
    if (!isComplete || hasError) return;

    const elapsed = Date.now() - startTime.current;
    if (elapsed < MIN_DISPLAY_MS) {
      timerRef.current = setTimeout(() => {
        setActiveStep(STEPS.length);
      }, MIN_DISPLAY_MS - elapsed);
    } else {
      setActiveStep(STEPS.length);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isComplete, hasError]);

  // Notify parent when minimum display time has elapsed.
  useEffect(() => {
    if (hasError) return;

    const elapsed = Date.now() - startTime.current;
    const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);
    timerRef.current = setTimeout(() => {
      onMinimumDisplayComplete?.();
    }, remaining);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [hasError, onMinimumDisplayComplete]);

  if (hasError) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]} testID={testID}>
        <ScanRoomHeader badge={<AIStarBadge />} />
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
    <View style={[styles.root, { paddingTop: insets.top }]} testID={testID}>
      <ScanRoomHeader badge={<AIStarBadge />} />

      <Text style={styles.title}>Analyzing your scan</Text>

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

      {/* Progress steps */}
      <View style={styles.stepsCard}>
        {STEPS.map((step, index) => {
          const isActive = index === activeStep;
          const isDone = index < activeStep;
          return (
            <View
              key={step.label}
              style={[
                styles.stepRow,
                index > 0 && styles.stepBorder,
              ]}
            >
              <View style={[styles.stepDot, isDone && styles.stepDotDone, isActive && styles.stepDotActive]} />
              <View style={styles.stepText}>
                <Text style={[styles.stepLabel, isActive && styles.stepLabelActive]}>
                  {step.label}
                </Text>
                <Text style={styles.stepSub}>{step.sub}</Text>
              </View>
              {isDone && <Text style={styles.stepCheck}>✓</Text>}
              {isActive && (
                <Animated.View style={styles.stepSpinner}>
                  <Text style={styles.stepSpinnerText}>◌</Text>
                </Animated.View>
              )}
            </View>
          );
        })}
      </View>

      {activeStep >= STEPS.length && !isComplete && (
        <Text style={styles.stillAnalyzing}>Still analyzing your scan...</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: LUXURY.colors.ivory,
    alignItems: 'center',
  },
  title: {
    ...LUXURY.typography.displayTitle,
    fontSize: 24,
    marginTop: SPACING.lg,
    textAlign: 'center',
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
  stepsCard: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    marginTop: SPACING.lg,
    marginHorizontal: SPACING.xl,
    alignSelf: 'stretch',
    ...SHADOWS.editorialSmall,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.md,
    gap: SPACING.md,
  },
  stepBorder: {
    borderTopWidth: 1,
    borderTopColor: LUXURY.colors.hairline,
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: LUXURY.colors.border,
    flexShrink: 0,
  },
  stepDotDone: {
    backgroundColor: LUXURY.colors.success,
  },
  stepDotActive: {
    backgroundColor: LUXURY.colors.plum,
  },
  stepText: {
    flex: 1,
  },
  stepLabel: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    color: LUXURY.colors.stone,
  },
  stepLabelActive: {
    color: LUXURY.colors.plum,
  },
  stepSub: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'none',
    marginTop: 2,
  },
  stepCheck: {
    fontSize: 14,
    color: LUXURY.colors.success,
    fontWeight: '700',
  },
  stepSpinner: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepSpinnerText: {
    fontSize: 14,
    color: LUXURY.colors.plum,
  },
  stillAnalyzing: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.lg,
    textAlign: 'center',
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
});
