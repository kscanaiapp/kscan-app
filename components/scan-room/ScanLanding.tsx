import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  TouchableOpacity,
  Pressable,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { KScanIcon } from '../icons/kscan';
import { LuxuryButton } from '../luxury/LuxuryButton';
import { PrivacyFooter } from '../luxury/PrivacyFooter';
import { ScanRoomHeader } from './ScanRoomHeader';

interface ScanLandingProps {
  onOpenCamera: () => void;
  onUploadImage: () => void;
  onTextScan: () => void;
  onHome?: () => void;
  disabled?: boolean;
  textScanEnabled?: boolean;
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
  onHome,
  disabled = false,
  textScanEnabled = false,
  testID,
}: ScanLandingProps) {
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      testID={testID}
    >
      <ScanRoomHeader
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
          disabled={disabled}
          accessibilityLabel="Open camera to scan a fashion item"
          accessibilityHint="Starts the camera for a live scan"
          testID="scan-room-open-camera"
        />
        <LuxuryButton
          title="Upload Image"
          variant="secondary"
          onPress={onUploadImage}
          disabled={disabled}
          accessibilityLabel="Upload an image from your library"
          accessibilityHint="Opens the image picker for an uploaded scan"
          testID="scan-room-upload-image"
        />
        {textScanEnabled && (
          <TouchableOpacity
            onPress={onTextScan}
            disabled={disabled}
            activeOpacity={disabled ? 1 : 0.78}
            accessibilityRole="button"
            accessibilityLabel="Describe an item with TextScan"
            accessibilityState={{ disabled }}
            style={[styles.textScanButton, disabled && styles.textScanButtonDisabled]}
            testID="scan-room-textscan"
          >
            <KScanIcon name="textscan" size={16} variant="compact" />
            <Text style={styles.textScanText}>Describe an item</Text>
          </TouchableOpacity>
        )}
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  textScanText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  textScanButtonDisabled: {
    opacity: 0.5,
  },
  privacyFooter: {
    marginTop: SPACING.xxl,
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
