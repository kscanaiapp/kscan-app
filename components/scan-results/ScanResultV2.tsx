import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  Animated,
  PanResponder,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  COLORS,
  LUXURY,
  LAYOUT,
  MOTION,
  RADIUS,
  SHADOWS,
  SPACING,
  TYPOGRAPHY,
  card,
} from '../../constants/theme';
import { ScanResultHero } from './ScanResultHero';
import { StyleMatchPanel } from './StyleMatchPanel';
import { StyleAnalysisSection } from './StyleAnalysisSection';
import { SimilarFindsShelf } from './SimilarFindsShelf';
import { PurchaseOptionsPanel } from './PurchaseOptionsPanel';
import { ScanResultActionRow } from './ScanResultActionRow';
import { EmptyStateCard } from '../luxury/EmptyStateCard';
import { mapLegacyToV2 } from './types';
import type { LegacyAnalysisData, ScanResultV2 } from './types';
import { SCAN_RESULTS_DEMO_UI_ENABLED } from '../../constants/featureFlags';
import { ScanResultUtilityFooter } from '../free-tier/ScanResultUtilityFooter';
import { getDemoScanResultV2 } from '../../data/scan-results-demo';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const FROM_Y = SCREEN_HEIGHT * 0.36;

interface ScanResultV2Props {
  /** Legacy analysis data from the current scan pipeline. */
  analysis?: LegacyAnalysisData | null;
  /** URI of the captured scan image. */
  scanImageUri?: string | null;
  /** Source identifier for QA fixtures. */
  scanSourceId?: string | null;
  /** Called when the user dismisses the result (e.g., "Scan Again"). */
  onDismiss: () => void;
  /** Called to save the scan to the Style Library. */
  onSaveToLibrary?: () => void;
  /** Called to add the scan to a Dressing Room. */
  onAddToDressingRoom?: () => void;
  /** Called to navigate to StyleChat. */
  onAskStyleChat?: () => void;
  /** Called to scroll to / focus Similar Finds. */
  onFindSimilar?: () => void;
  testID?: string;
}

/**
 * Scan Results V2 — premium scan-to-commerce result page.
 *
 * - Wraps legacy analysis data into the V2 shape for forward-compat rendering.
 * - Supports future backend fields (similarFinds, purchaseOptions, confidence, etc.).
 * - Falls back to prepared empty states when product data is missing.
 * - Preserves all existing app behaviors (save, dressing room, StyleChat).
 */
export function ScanResultV2({
  analysis,
  scanImageUri,
  scanSourceId,
  onDismiss,
  onSaveToLibrary,
  onAddToDressingRoom,
  onAskStyleChat,
  onFindSimilar,
  testID,
}: ScanResultV2Props) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // Map legacy data into V2 shape
  let v2Data: ScanResultV2 | null = mapLegacyToV2(analysis, scanImageUri);

  // Demo data override (dev-only, gated)
  if (SCAN_RESULTS_DEMO_UI_ENABLED && !v2Data?.similarFinds) {
    const demo = getDemoScanResultV2(v2Data ?? undefined);
    v2Data = { ...demo, ...v2Data, similarFinds: demo.similarFinds, purchaseOptions: demo.purchaseOptions };
  }

  const translateY = React.useRef(new Animated.Value(FROM_Y)).current;
  const opacity = React.useRef(new Animated.Value(0)).current;
  const isExiting = React.useRef(false);

  const runExit = () => {
    if (isExiting.current) return;
    isExiting.current = true;

    Animated.parallel([
      Animated.timing(translateY, {
        toValue: FROM_Y,
        duration: MOTION.exitDuration,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: MOTION.exitDuration,
        useNativeDriver: true,
      }),
    ]).start(onDismiss);
  };

  const panResponder = React.useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > SPACING.md,
      onPanResponderRelease: (_, gesture) => {
        if (gesture.vy > 0.3 || gesture.dy > 80) runExit();
      },
    })
  ).current;

  React.useEffect(() => {
    translateY.setValue(FROM_Y);
    opacity.setValue(0);
    isExiting.current = false;

    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: MOTION.enterDuration,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: MOTION.enterDuration,
        useNativeDriver: true,
      }),
    ]).start();
  }, [translateY, opacity]);

  // Build title from available metadata
  const title = v2Data?.title || 'Style Match';

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      onDismiss();
    }
  };

  const handleViewAllSimilar = () => {
    if (onFindSimilar) {
      onFindSimilar();
    }
  };

  // If no meaningful data at all, show empty state
  if (!v2Data) {
    return (
      <Modal transparent animationType="none" onRequestClose={runExit}>
        <View style={styles.backdrop} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.cardWrap,
              {
                marginBottom: Math.max(LAYOUT.modalBottomPadding, insets.bottom + SPACING.lg),
                transform: [{ translateY }],
                opacity,
              },
            ]}
          >
            <View style={styles.card}>
              <ScrollView
                bounces={false}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.cardInner}
              >
                <EmptyStateCard
                  title="Scan result unavailable"
                  subtitle="Your scan data could not be loaded."
                  action={{
                    label: 'Scan Again',
                    onPress: runExit,
                    accessibilityLabel: 'Scan again',
                  }}
                />
              </ScrollView>
            </View>
          </Animated.View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal transparent animationType="none" onRequestClose={runExit}>
      <View style={styles.backdrop} pointerEvents="box-none">
        <Animated.View
          testID={testID ?? 'scan-result-v2'}
          style={[
            styles.cardWrap,
            {
              marginBottom: Math.max(LAYOUT.modalBottomPadding, insets.bottom + SPACING.lg),
              transform: [{ translateY }],
              opacity,
            },
          ]}
          {...panResponder.panHandlers}
        >
          <View style={styles.glow} pointerEvents="none" />

          <View style={styles.card}>
            <ScrollView
              bounces={false}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[
                styles.cardInner,
                { paddingBottom: SPACING.xxxl + 80 }, // extra padding for sticky action row
              ]}
            >
              {/* Header */}
              <View style={styles.header}>
                <Text style={styles.brandTitle}>K SCAN</Text>
                <Text style={styles.statusLabel}>SCAN ANALYSIS COMPLETE</Text>
                <TouchableOpacity
                  onPress={handleBack}
                  activeOpacity={0.78}
                  accessibilityRole="button"
                  accessibilityLabel="Go back"
                  style={styles.backButton}
                >
                  <Text style={styles.backButtonText}>←</Text>
                </TouchableOpacity>
              </View>

              {/* Gold sparkle divider */}
              <View style={styles.divider}>
                <Text style={styles.dividerText}>✧</Text>
              </View>

              {/* Hero */}
              <ScanResultHero
                imageUri={scanImageUri}
                category={v2Data.category}
                confidence={v2Data.confidence}
              />

              {/* Style Match Summary */}
              <View style={styles.section}>
                <StyleMatchPanel
                  title={v2Data.title}
                  category={v2Data.category}
                  color={v2Data.color}
                  silhouette={v2Data.silhouette}
                  material={v2Data.material}
                  confidence={v2Data.confidence}
                  styleTags={v2Data.styleTags}
                />
              </View>

              {/* Add to Dressing Room — secondary action */}
              {onAddToDressingRoom ? (
                <TouchableOpacity
                  style={styles.secondaryCta}
                  onPress={onAddToDressingRoom}
                  activeOpacity={0.86}
                  accessibilityRole="button"
                  accessibilityLabel="Add this scan to a Dressing Room"
                >
                  <Text style={styles.secondaryCtaText}>Add Scan to Dressing Room</Text>
                </TouchableOpacity>
              ) : null}

              {/* Style Analysis */}
              <View style={styles.section}>
                <StyleAnalysisSection
                  analysisText={v2Data.styleAnalysis || v2Data.analysisText}
                />
              </View>

              {/* Similar Finds */}
              <View style={styles.section}>
                <SimilarFindsShelf
                  similarFinds={v2Data.similarFinds}
                  onViewAll={handleViewAllSimilar}
                />
              </View>

              {/* Purchase Options */}
              <View style={styles.section}>
                <PurchaseOptionsPanel
                  purchaseOptions={v2Data.purchaseOptions}
                />
              </View>

              {/* Next-step framing above sticky actions */}
              <Text style={styles.nextStepPrompt}>
                What would you like to do with this look?
              </Text>

              {/* Closet tools footer (flag-guarded; renders null by default) */}
              <ScanResultUtilityFooter result={v2Data} />

              {/* Privacy footer */}
              <View style={styles.privacyFooter}>
                <Text style={styles.privacyText}>Private by design.</Text>
                <Text style={styles.privacySubtext}>
                  Your scan data stays under your control. Raw scans and uploaded images are not sold to third-party data buyers.
                </Text>
              </View>

              {/* Bottom spacing so ScrollView content clears sticky action row */}
              <View style={{ height: 100 }} />
            </ScrollView>

            {/* Sticky Bottom Action Row */}
            <ScanResultActionRow
              onSave={onSaveToLibrary}
              onFindSimilar={onFindSimilar}
              onAskStyleChat={onAskStyleChat}
              onAddToDressingRoom={onAddToDressingRoom}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: COLORS.backdrop,
    justifyContent: 'flex-end',
    paddingHorizontal: SPACING.xl,
  },
  cardWrap: {
    borderRadius: card.borderRadius,
    overflow: 'visible',
    ...SHADOWS.editorialRaised,
  },
  glow: {
    ...StyleSheet.absoluteFillObject,
    top: SPACING.lg,
    bottom: SPACING.lg,
    left: SPACING.xl,
    right: SPACING.xl,
    borderRadius: card.borderRadius,
    backgroundColor: COLORS.goldMuted,
    opacity: 0.16,
  },
  card: {
    borderRadius: card.borderRadius,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    overflow: 'hidden',
    backgroundColor: LUXURY.colors.pearl,
    maxHeight: SCREEN_HEIGHT * 0.92,
  },
  cardInner: {
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: card.paddingHorizontal,
    paddingVertical: card.paddingVertical,
  },
  header: {
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  brandTitle: {
    ...LUXURY.typography.brandMark,
    fontSize: 18,
    letterSpacing: 3.5,
    color: LUXURY.colors.plumDeep,
  },
  statusLabel: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 10,
    letterSpacing: 2.8,
    color: LUXURY.colors.goldBrushed,
    marginTop: SPACING.xs,
  },
  backButton: {
    position: 'absolute',
    left: 0,
    top: 0,
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButtonText: {
    fontSize: 22,
    color: LUXURY.colors.plum,
  },
  divider: {
    alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  dividerText: {
    fontSize: 14,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 4,
  },
  section: {
    marginTop: SPACING.lg,
  },
  secondaryCta: {
    width: '100%',
    minHeight: 52,
    borderRadius: RADIUS.pill,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.gold,
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: SPACING.lg,
  },
  secondaryCtaText: {
    ...LUXURY.typography.ctaSecondary,
    textAlign: 'center',
  },
  nextStepPrompt: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    letterSpacing: 0.6,
    color: LUXURY.colors.plum,
    textAlign: 'center',
    marginTop: SPACING.xl,
  },
  privacyFooter: {
    marginTop: SPACING.xl,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  privacyText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 1.2,
    color: LUXURY.colors.stone,
  },
  privacySubtext: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 0.8,
    color: LUXURY.colors.stone,
    textAlign: 'center',
    marginTop: SPACING.xs,
    opacity: 0.8,
  },
});
