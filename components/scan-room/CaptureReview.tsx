import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  useWindowDimensions,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { LuxuryButton } from '../luxury/LuxuryButton';
import { StatusPill } from '../luxury/StatusPill';
import { ScanRoomHeader } from './ScanRoomHeader';
import { AIStarBadge } from '../text-scan/AIStarBadge';

interface CaptureReviewProps {
  imageUri: string;
  source?: 'camera' | 'upload' | 'fixture';
  onRetake: () => void;
  onAnalyze: () => void;
  onHome?: () => void;
  testID?: string;
}

/**
 * Capture Review screen for Scan Room V2.
 *
 * - Large rounded image card with champagne border.
 * - Clear guidance text.
 * - Analyze Scan = primary glossy plum button.
 * - Retake/Replace = secondary gold-outlined button.
 * - No "Add to Dressing Room" here (belongs after analysis in Results).
 * - Adapts labels for camera vs upload sources.
 */
export function CaptureReview({
  imageUri,
  source = 'camera',
  onRetake,
  onAnalyze,
  onHome,
  testID,
}: CaptureReviewProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const imageWidth = Math.min(screenWidth - SPACING.xl * 2, 420);
  const imageHeight = imageWidth * 1.25; // 4:5

  const isUpload = source === 'upload';
  const title = isUpload ? 'Upload Review' : 'Capture Review';
  const subtitle = isUpload
    ? 'Confirm the uploaded image is clear before we analyze it.'
    : 'Confirm the item below is clear and well-framed before we analyze it.';
  const secondaryLabel = isUpload ? 'Replace Image' : 'Retake';
  const secondaryHint = isUpload
    ? 'Choose a different image from your library'
    : 'Discard this photo and return to camera';
  const imageAccessibilityLabel = isUpload
    ? 'Uploaded inspiration image'
    : 'Captured scan image';

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
      <ScanRoomHeader
        badge={<AIStarBadge />}
        rightAction={
          onHome ? (
            <Pressable
              onPress={onHome}
              style={styles.homeButton}
              accessibilityRole="button"
              accessibilityLabel="Go Home"
              accessibilityHint="Returns to the K Scan home screen"
            >
              <Text style={styles.homeButtonText}>Home</Text>
            </Pressable>
          ) : undefined
        }
      />

      <Text style={styles.screenTitle}>{title}</Text>
      <Text style={styles.screenSubtitle}>{subtitle}</Text>

      {/* Image card */}
      <View style={[styles.imageCard, { width: imageWidth, height: imageHeight }]}>
        <Image
          source={{ uri: imageUri }}
          style={styles.image}
          resizeMode="cover"
          accessibilityLabel={imageAccessibilityLabel}
        />
        {isUpload && (
          <View style={styles.badgeWrap}>
            <StatusPill
              label="Upload"
              variant="neutral"
              accessibilityLabel="Upload source"
            />
          </View>
        )}
      </View>

      {/* Metadata placeholder card */}
      <View style={styles.metaCard}>
        <Text style={styles.metaLabel}>Category —</Text>
        <Text style={styles.metaLabel}>Color —</Text>
        <Text style={styles.metaLabel}>Silhouette —</Text>
        <Text style={styles.metaMicro}>
          AI analysis will complete this after scanning.
        </Text>
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
          title={secondaryLabel}
          variant="secondary"
          onPress={onRetake}
          accessibilityLabel={secondaryLabel}
          accessibilityHint={secondaryHint}
          testID={isUpload ? 'scan-room-replace-image' : 'scan-room-retake'}
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

      {/* Privacy microcopy */}
      <Text style={styles.privacyText}>
        Private by design. Your uploaded images are not sold to third-party data buyers.
      </Text>
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
  badgeWrap: {
    position: 'absolute',
    bottom: SPACING.md,
    left: SPACING.md,
  },
  metaCard: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    marginTop: SPACING.lg,
    alignSelf: 'stretch',
    ...SHADOWS.editorialSmall,
  },
  metaLabel: {
    ...LUXURY.typography.body,
    fontSize: 13,
    color: LUXURY.colors.stone,
    lineHeight: 20,
  },
  metaMicro: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 0.8,
    color: LUXURY.colors.stone,
    marginTop: SPACING.xs,
    fontStyle: 'italic',
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
  privacyText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 0.8,
    color: LUXURY.colors.stone,
    textAlign: 'center',
    marginTop: SPACING.lg,
    maxWidth: 320,
  },
  homeButton: {
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.goldChampagne,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    minHeight: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  homeButtonText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 1.2,
    color: LUXURY.colors.plum,
    textTransform: 'uppercase',
  },
});
