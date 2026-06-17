import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { LuxuryButton } from '../luxury/LuxuryButton';
import { ScanRoomHeader } from './ScanRoomHeader';
import { AIStarBadge } from '../text-scan/AIStarBadge';

interface CaptureReviewProps {
  imageUri: string;
  onRetake: () => void;
  onAnalyze: () => void;
  testID?: string;
}

/**
 * Capture Review screen for Scan Room V2.
 *
 * - Large rounded image card with champagne border.
 * - Clear guidance text.
 * - Analyze Scan = primary glossy plum button.
 * - Retake = secondary gold-outlined button.
 * - No "Add to Dressing Room" here (belongs after analysis in Results).
 */
export function CaptureReview({
  imageUri,
  onRetake,
  onAnalyze,
  testID,
}: CaptureReviewProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const imageWidth = Math.min(screenWidth - SPACING.xl * 2, 420);
  const imageHeight = imageWidth * 1.25; // 4:5

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top, paddingBottom: insets.bottom + SPACING.xxxl },
      ]}
      showsVerticalScrollIndicator={false}
      testID={testID}
    >
      <ScanRoomHeader badge={<AIStarBadge />} />

      <Text style={styles.screenTitle}>Capture Review</Text>
      <Text style={styles.screenSubtitle}>
        Confirm the item below is clear and well-framed before we analyze it.
      </Text>

      {/* Image card */}
      <View style={[styles.imageCard, { width: imageWidth, height: imageHeight }]}>
        <Image
          source={{ uri: imageUri }}
          style={styles.image}
          resizeMode="cover"
          accessibilityLabel="Captured scan image"
        />
      </View>

      {/* Guidance card */}
      <View style={styles.guidanceCard}>
        <Text style={styles.guidanceTitle}>Ready to analyze</Text>
        <Text style={styles.guidanceBody}>
          We'll analyze fabric, color, silhouette, and details.
        </Text>
      </View>

      {/* Buttons */}
      <View style={styles.buttonRow}>
        <LuxuryButton
          title="Retake"
          variant="secondary"
          onPress={onRetake}
          accessibilityLabel="Retake photo"
          accessibilityHint="Discard this photo and return to camera"
          testID="scan-room-retake"
        />
        <LuxuryButton
          title="Analyze Scan"
          variant="primary"
          onPress={onAnalyze}
          accessibilityLabel="Analyze scan style"
          accessibilityHint="Start AI style analysis on this photo"
          testID="scan-room-analyze"
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: LUXURY.colors.ivory,
  },
  content: {
    paddingHorizontal: SPACING.xl,
    alignItems: 'center',
  },
  screenTitle: {
    ...LUXURY.typography.displayTitle,
    fontSize: 24,
    marginTop: SPACING.lg,
    textAlign: 'center',
  },
  screenSubtitle: {
    ...LUXURY.typography.body,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
    marginBottom: SPACING.lg,
  },
  imageCard: {
    alignSelf: 'center',
    borderRadius: RADIUS.xl,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(198, 161, 91, 0.36)',
    ...SHADOWS.editorialRaised,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  guidanceCard: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    marginTop: SPACING.lg,
    alignSelf: 'stretch',
    ...SHADOWS.editorialSmall,
  },
  guidanceTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    textAlign: 'center',
  },
  guidanceBody: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
    marginTop: SPACING.xl,
    flexWrap: 'wrap',
  },
});
