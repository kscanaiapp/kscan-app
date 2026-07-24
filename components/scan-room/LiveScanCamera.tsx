import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  useWindowDimensions,
  Pressable,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { ScanButton } from '../ScanButton';
import { ScanRoomHeader } from './ScanRoomHeader';
import { EmptyStateCard } from '../luxury/EmptyStateCard';
import { LuxuryButton } from '../luxury/LuxuryButton';
import { KScanIcon } from '../icons/kscan';
import {
  isPrivateImageUploadAvailable,
  PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE,
} from '../../services/privacyImageUpload';

interface LiveScanCameraProps {
  cameraRef: React.RefObject<any>;
  isCameraReady: boolean;
  onCapture: () => void;
  onUpload: () => void;
  onTextScan: () => void;
  onBack: () => void;
  onHome?: () => void;
  onCameraReady?: () => void;
  isCapturing?: boolean;
  isAnalyzing?: boolean;
  textScanEnabled?: boolean;
  testID?: string;
}

/**
 * Light luxury live camera surface for Scan Room V2.
 *
 * - Camera preview in a large rounded rectangle with champagne border.
 * - Cyan scan brackets overlay (crosshair).
 * - Instruction card below the viewfinder.
 * - Capture button, Upload Image, TextScan pill.
 * - Graceful permission denial handling.
 * - Camera unmounts when not in use (managed by parent status change).
 */
export function LiveScanCamera({
  cameraRef,
  isCameraReady,
  onCapture,
  onUpload,
  onTextScan,
  onBack,
  onHome,
  onCameraReady,
  isCapturing = false,
  isAnalyzing = false,
  textScanEnabled = false,
  testID,
}: LiveScanCameraProps) {
  const { width: screenWidth } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();
  const uploadAvailable = isPrivateImageUploadAvailable();

  const viewfinderWidth = Math.min(screenWidth - SPACING.xl * 2, 420);
  const viewfinderHeight = viewfinderWidth * 1.25; // 4:5

  const homeButton = onHome ? (
    <Pressable
      onPress={onHome}
      style={styles.homeButton}
      accessibilityRole="button"
      accessibilityLabel="Go Home"
      accessibilityHint="Returns to the K Scan home screen"
    >
      <Text style={styles.homeButtonText}>Home</Text>
    </Pressable>
  ) : undefined;

  // Permission denied state
  if (!permission?.granted) {
    return (
      <View style={styles.root} testID={testID}>
        <StatusBar style="dark" />
        <ScanRoomHeader rightAction={homeButton} />
        <View style={styles.permissionContainer}>
          <EmptyStateCard
            title="Camera access is needed to scan items."
            subtitle="Enable camera permission to capture your look."
            icon={<Text style={styles.permissionIcon}>✦</Text>}
            action={{
              label: permission?.canAskAgain ? 'Allow Camera' : 'Open Settings',
              onPress: permission?.canAskAgain ? requestPermission : () => { void Linking.openSettings(); },
              accessibilityLabel: 'Allow camera access',
            }}
          />
          <View style={styles.permissionAltActions}>
            <LuxuryButton
              title={uploadAvailable ? 'Upload Image' : 'Upload Unavailable'}
              variant="secondary"
              onPress={onUpload}
              disabled={isAnalyzing || !uploadAvailable}
              accessibilityLabel={uploadAvailable ? 'Upload an image instead' : 'Upload unavailable'}
              accessibilityHint={uploadAvailable ? undefined : PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE}
            />
            <LuxuryButton
              title="Back"
              variant="tertiary"
              onPress={onBack}
              accessibilityLabel="Go back to scan landing"
            />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root} testID={testID}>
      <StatusBar style="dark" />
      <ScanRoomHeader rightAction={homeButton} />

      {/* Viewfinder */}
      <View style={[styles.viewfinderWrap, { width: viewfinderWidth, height: viewfinderHeight }]}>
        <View style={[styles.cameraContainer, { width: viewfinderWidth, height: viewfinderHeight }]}>
          <CameraView
            style={styles.camera}
            ref={cameraRef}
            facing="back"
            onCameraReady={onCameraReady}
          />
        </View>

        {/* Cyan scan brackets overlay */}
        <View style={styles.bracketOverlay} pointerEvents="none">
          <View style={[styles.bracket, styles.topLeft]} />
          <View style={[styles.bracket, styles.topRight]} />
          <View style={[styles.bracket, styles.bottomLeft]} />
          <View style={[styles.bracket, styles.bottomRight]} />
        </View>
      </View>

      {/* Instruction card */}
      <View style={styles.instructionCard}>
        <Text style={styles.instructionTitle}>Frame the item</Text>
        <Text style={styles.instructionBody}>
          Center the full piece for best results. Avoid faces and keep the item well-lit.
        </Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <ScanButton
          onPress={onCapture}
          disabled={!isCameraReady || isCapturing || isAnalyzing}
          testID="scan-room-capture-button"
        />

        <View style={styles.secondaryControls}>
          <TouchableOpacity
            onPress={onUpload}
            disabled={isAnalyzing || !uploadAvailable}
            activeOpacity={isAnalyzing || !uploadAvailable ? 1 : 0.78}
            accessibilityRole="button"
            accessibilityLabel={uploadAvailable ? 'Upload image from library' : 'Upload unavailable'}
            accessibilityHint={uploadAvailable ? undefined : PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE}
            accessibilityState={{ disabled: isAnalyzing || !uploadAvailable }}
            style={[
              styles.controlPill,
              (isAnalyzing || !uploadAvailable) && styles.controlPillDisabled,
            ]}
          >
            <Text
              style={[
                styles.controlPillText,
                (isAnalyzing || !uploadAvailable) && styles.controlPillTextDisabled,
              ]}
            >
              {uploadAvailable ? 'Upload Image' : 'Upload Unavailable'}
            </Text>
          </TouchableOpacity>

          {textScanEnabled && (
            <TouchableOpacity
              onPress={onTextScan}
              activeOpacity={0.78}
              accessibilityRole="button"
              accessibilityLabel="Open TextScan"
              style={[styles.controlPill, styles.controlPillWithIcon]}
            >
              <KScanIcon name="textscan" size={14} variant="compact" />
              <Text style={styles.controlPillText}>TextScan</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={onBack}
            activeOpacity={0.78}
            accessibilityRole="button"
            accessibilityLabel="Back to scan landing"
            style={styles.controlPill}
          >
            <Text style={styles.controlPillText}>Back</Text>
          </TouchableOpacity>
        </View>
      </View>

      {(isCapturing || isAnalyzing) && (
        <View style={styles.capturingOverlay}>
          <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          <Text style={styles.capturingText}>{isAnalyzing ? 'Analyzing your look…' : 'Capturing…'}</Text>
        </View>
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
  viewfinderWrap: {
    alignSelf: 'center',
    borderRadius: RADIUS.xl,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(198, 161, 91, 0.36)',
    ...SHADOWS.editorialRaised,
    marginTop: SPACING.lg,
  },
  cameraContainer: {
    borderRadius: RADIUS.xl,
    overflow: 'hidden',
    backgroundColor: LUXURY.colors.champagne,
  },
  camera: {
    ...StyleSheet.absoluteFillObject,
  },
  bracketOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    elevation: 10,
  },
  bracket: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: '#0D9FB3', // scanCyan
  },
  topLeft: {
    top: 12,
    left: 12,
    borderTopWidth: 2,
    borderLeftWidth: 2,
  },
  topRight: {
    top: 12,
    right: 12,
    borderTopWidth: 2,
    borderRightWidth: 2,
  },
  bottomLeft: {
    bottom: 12,
    left: 12,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
  },
  bottomRight: {
    bottom: 12,
    right: 12,
    borderBottomWidth: 2,
    borderRightWidth: 2,
  },
  instructionCard: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    marginTop: SPACING.lg,
    marginHorizontal: SPACING.xl,
    alignSelf: 'stretch',
    ...SHADOWS.editorialSmall,
  },
  instructionTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    textAlign: 'center',
  },
  instructionBody: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
  },
  controls: {
    marginTop: SPACING.lg,
    alignItems: 'center',
    gap: SPACING.md,
    paddingBottom: SPACING.xl,
  },
  secondaryControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
    flexWrap: 'wrap',
  },
  controlPill: {
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    backgroundColor: 'transparent',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    minHeight: 36,
    justifyContent: 'center',
  },
  controlPillWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  controlPillText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 1.2,
    color: LUXURY.colors.plum,
    textTransform: 'uppercase',
  },
  controlPillDisabled: {
    borderColor: LUXURY.colors.border,
  },
  controlPillTextDisabled: {
    color: LUXURY.colors.stone,
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    gap: SPACING.lg,
  },
  permissionIcon: {
    fontSize: 32,
    color: LUXURY.colors.goldBrushed,
  },
  permissionAltActions: {
    gap: SPACING.md,
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
  capturingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
    zIndex: 100,
  },
  capturingText: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.plum,
  },
});
