import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { LuxuryButton } from '../luxury/LuxuryButton';
import { PrivacyFooter } from '../luxury/PrivacyFooter';
import { AIStarBadge } from '../text-scan/AIStarBadge';
import { ScanRoomHeader } from './ScanRoomHeader';

interface ScanLandingProps {
  onOpenCamera: () => void;
  onUploadImage: () => void;
  onTextScan: () => void;
  testID?: string;
}

/**
 * Scan Room landing screen.
 *
 * - Pearl/ivory canvas with editorial serif heading.
 * - Hero card with "Point. Scan. Shop." positioning.
 * - Glossy plum Open Camera CTA.
 * - Gold-outlined Upload Image CTA.
 * - Tertiary TextScan affordance.
 * - Feature row: Retail + Resale, Private by design.
 */
export function ScanLanding({
  onOpenCamera,
  onUploadImage,
  onTextScan,
  testID,
}: ScanLandingProps) {
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      testID={testID}
    >
      <ScanRoomHeader badge={<AIStarBadge />} />

      {/* Hero card */}
      <View style={styles.heroCard}>
        <Text style={styles.heroTitle}>Point. Scan. Shop.</Text>
        <Text style={styles.heroBody}>
          Point the camera at an outfit, clothing item, bag, or shoe.
        </Text>

        {/* Feature row */}
        <View style={styles.featureRow}>
          <View style={styles.featureCell}>
            <Text style={styles.featureIcon}>✦</Text>
            <Text style={styles.featureTitle}>Retail + Resale</Text>
            <Text style={styles.featureSubtitle}>FIND IT EVERYWHERE</Text>
          </View>
          <View style={styles.featureDivider} />
          <View style={styles.featureCell}>
            <Text style={styles.featureIcon}>✦</Text>
            <Text style={styles.featureTitle}>Private by design</Text>
            <Text style={styles.featureSubtitle}>ONLY YOU, ALWAYS</Text>
          </View>
        </View>
      </View>

      {/* CTAs */}
      <View style={styles.ctaStack}>
        <LuxuryButton
          title="Open Camera"
          variant="primary"
          onPress={onOpenCamera}
          accessibilityLabel="Open camera to scan a fashion item"
          accessibilityHint="Starts the camera for a live scan"
          testID="scan-room-open-camera"
        />
        <LuxuryButton
          title="Upload Image"
          variant="secondary"
          onPress={onUploadImage}
          accessibilityLabel="Upload an image from your library"
          accessibilityHint="Opens the image picker for an uploaded scan"
          testID="scan-room-upload-image"
        />
        <TouchableOpacity
          onPress={onTextScan}
          activeOpacity={0.78}
          accessibilityRole="button"
          accessibilityLabel="Describe an item with TextScan"
          style={styles.textScanButton}
          testID="scan-room-textscan"
        >
          <Text style={styles.textScanText}>✧ Describe an item</Text>
        </TouchableOpacity>
      </View>

      <PrivacyFooter
        trustCopy="Private by design. Raw scans and uploaded images are not sold to third-party data buyers."
        style={styles.privacyFooter}
      />
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
    paddingBottom: SPACING.xxxl,
  },
  heroCard: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: 'rgba(198, 161, 91, 0.24)',
    backgroundColor: LUXURY.colors.warmWhite,
    padding: SPACING.xl,
    ...SHADOWS.editorialRaised,
    marginTop: SPACING.md,
  },
  heroTitle: {
    ...LUXURY.typography.displayHero,
    fontSize: 32,
    lineHeight: 40,
    textAlign: 'center',
    color: LUXURY.colors.plumDeep,
  },
  heroBody: {
    ...LUXURY.typography.body,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
    marginTop: SPACING.md,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.xl,
    gap: SPACING.md,
  },
  featureCell: {
    alignItems: 'center',
    flex: 1,
  },
  featureDivider: {
    width: 1,
    height: 40,
    backgroundColor: LUXURY.colors.hairline,
  },
  featureIcon: {
    fontSize: 18,
    color: LUXURY.colors.goldBrushed,
    marginBottom: SPACING.xs,
  },
  featureTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  featureSubtitle: {
    ...LUXURY.typography.caption,
    fontSize: 9,
    letterSpacing: 1.4,
    textAlign: 'center',
    marginTop: 2,
  },
  ctaStack: {
    gap: SPACING.md,
    marginTop: SPACING.xl,
  },
  textScanButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textScanText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  privacyFooter: {
    marginTop: SPACING.xxl,
  },
});
