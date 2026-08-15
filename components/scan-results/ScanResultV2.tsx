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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useResponsiveLayout } from '../../hooks/useResponsiveLayout';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
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
import type { LegacyAnalysisData, ProductMatch, ScanResultV2 } from './types';
import { SCAN_RESULTS_DEMO_UI_ENABLED } from '../../constants/featureFlags';
import { ScanResultUtilityFooter } from '../free-tier/ScanResultUtilityFooter';
import { getDemoScanResultV2 } from '../../data/scan-results-demo';

// Sheet metrics derive from the live window (see useResponsiveLayout inside
// the component) so rotation and split-view resizes never animate from a
// stale offset.
const SIMILAR_SCROLL_TOP_OFFSET = 20;

function isRenderableSimilarFind(product: ProductMatch | null | undefined): product is ProductMatch {
  if (!product) return false;

  const id = product.id?.trim() ?? '';
  const title = product.title?.trim() ?? '';
  const genericTitle = title.toLowerCase() === 'similar style';
  const hasSpecificTitle = title.length > 0 && !genericTitle;
  const hasStableIdentifier = id.length > 0 && !/^similar-\d+$/.test(id);

  return Boolean(
    hasSpecificTitle ||
      hasStableIdentifier ||
      product.imageUrl?.trim() ||
      product.productUrl?.trim() ||
      product.brand?.trim() ||
      product.retailer?.trim() ||
      product.priceLabel?.trim()
  );
}

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
  /** Optional label for the save/library action. */
  saveActionLabel?: string;
  /** Called to add the scan to a Dressing Room. */
  onAddToDressingRoom?: () => void;
  /** Called to navigate to StyleChat. */
  onAskStyleChat?: () => void;
  /** Called to scroll to / focus Similar Finds. */
  onFindSimilar?: () => void;
  selectedCandidateId?: string | null;
  onSelectCandidate?: (candidateId: string) => void;
  onAnalyzeSelectedCandidate?: (candidateId: string) => void;
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
  saveActionLabel,
  onAddToDressingRoom,
  onAskStyleChat,
  onFindSimilar,
  selectedCandidateId,
  onSelectCandidate,
  onAnalyzeSelectedCandidate,
  testID,
}: ScanResultV2Props) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight, modalMaxWidth } = useResponsiveLayout();
  const fromY = windowHeight * 0.36;
  const router = useRouter();

  // Map legacy data into V2 shape
  let v2Data: ScanResultV2 | null = mapLegacyToV2(analysis, scanImageUri);

  // Demo data override (dev-only, gated)
  if (
    SCAN_RESULTS_DEMO_UI_ENABLED &&
    !analysis?.confirmationCandidates?.length &&
    !v2Data?.similarFinds
  ) {
    const demo = getDemoScanResultV2(v2Data ?? undefined);
    v2Data = {
      ...demo,
      ...v2Data,
      similarFinds: demo.similarFinds,
      purchaseOptions: v2Data?.purchaseOptions ?? demo.purchaseOptions,
    };
  }

  const translateY = React.useRef(new Animated.Value(fromY)).current;
  const opacity = React.useRef(new Animated.Value(0)).current;
  const isExiting = React.useRef(false);
  const scrollViewRef = React.useRef<ScrollView>(null);
  const [actionRowHeight, setActionRowHeight] = React.useState(0);
  // DEF-010: the priceDiscovery freeze is a remote kill switch, and this is the
  // shipping commerce surface. AnalysisCard honoured it while this screen did
  // not, so a freeze removed the shelves on a reopened scan but left them on a
  // fresh one. Same derivation as AnalysisCard: while the config is still
  // loading the feature is treated as OFF, so a freeze is never briefly
  // ignored on first paint.
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const priceDiscoveryEnabled = !featureFreezeLoading && isFeatureEnabled('priceDiscovery');

  const [similarFindsTarget, setSimilarFindsTarget] = React.useState<{
    key: string;
    y: number;
  } | null>(null);
  const confirmationCandidates = Array.isArray(analysis?.confirmationCandidates)
    ? analysis.confirmationCandidates
    : [];
  const activeCandidateId = selectedCandidateId ?? confirmationCandidates[0]?.id ?? null;
  const isConfirmationStep = confirmationCandidates.length > 0;

  const runExit = () => {
    if (isExiting.current) return;
    isExiting.current = true;

    Animated.parallel([
      Animated.timing(translateY, {
        toValue: fromY,
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
    translateY.setValue(fromY);
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
  const title = v2Data?.title || 'Fashion Item';

  const renderableSimilarFinds = Array.isArray(v2Data?.similarFinds)
    ? v2Data.similarFinds.filter(isRenderableSimilarFind)
    : [];
  const similarFindsKey = renderableSimilarFinds.map((product) => product.id).join('|');
  const hasRenderableSimilarFinds = renderableSimilarFinds.length >= 2;
  const similarFindsTargetReady =
    hasRenderableSimilarFinds && similarFindsTarget?.key === similarFindsKey;

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      onDismiss();
    }
  };

  const handleFindSimilar = React.useCallback(() => {
    if (!similarFindsTargetReady || !similarFindsTarget) {
      return;
    }

    scrollViewRef.current?.scrollTo({ y: similarFindsTarget.y, animated: true });

    // Keep any external handler contract intact.
    onFindSimilar?.();
  }, [onFindSimilar, similarFindsTarget, similarFindsTargetReady]);

  const handleViewAllSimilar = handleFindSimilar;
  const handleFindCandidateMatches = React.useCallback(() => {
    if (!activeCandidateId) return;
    onAnalyzeSelectedCandidate?.(activeCandidateId);
  }, [activeCandidateId, onAnalyzeSelectedCandidate]);

  // If no meaningful data at all, show empty state
  if (!v2Data) {
    return (
      <Modal transparent animationType="none" onRequestClose={runExit}>
        <View style={styles.backdrop} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.cardWrap,
              {
                width: '100%',
                maxWidth: modalMaxWidth,
                alignSelf: 'center',
                marginBottom: Math.max(LAYOUT.modalBottomPadding, insets.bottom + SPACING.lg),
                transform: [{ translateY }],
                opacity,
              },
            ]}
          >
            <View style={[styles.card, { maxHeight: windowHeight * 0.92 }]}>
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
              // Inert on phones; caps and centers the sheet on regular-width
              // iPad windows so it never spans the full 1024-1366pt surface.
              width: '100%',
              maxWidth: modalMaxWidth,
              alignSelf: 'center',
              marginBottom: Math.max(LAYOUT.modalBottomPadding, insets.bottom + SPACING.lg),
              transform: [{ translateY }],
              opacity,
            },
          ]}
          {...panResponder.panHandlers}
        >
          <View style={styles.glow} pointerEvents="none" />

          <View style={[styles.card, { maxHeight: windowHeight * 0.92 }]}>
            <ScrollView
              ref={scrollViewRef}
              bounces={false}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[
                styles.cardInner,
                {
                  // Ensure the last scrollable content clears the absolute sticky
                  // action row, including its measured height, safe-area inset,
                  // and a small extra margin.
                  paddingBottom:
                    Math.max(actionRowHeight, 100) +
                    Math.max(insets.bottom, SPACING.md) +
                    SPACING.xl,
                },
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

              {confirmationCandidates.length > 0 ? (
                <View style={styles.section} testID="outfit-confirmation-candidates">
                  <Text style={styles.candidateEyebrow}>Detected Items</Text>
                  <View style={styles.candidateList}>
                    {confirmationCandidates.map((candidate) => {
                      const selected = activeCandidateId === candidate.id;
                      return (
                        <TouchableOpacity
                          key={candidate.id}
                          testID={`outfit-candidate-${candidate.id}`}
                          style={[
                            styles.candidateButton,
                            selected ? styles.candidateButtonSelected : null,
                          ]}
                          onPress={() => onSelectCandidate?.(candidate.id)}
                          activeOpacity={0.84}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`${selected ? 'Deselect' : 'Select'} ${candidate.label}`}
                        >
                          <Text
                            style={[
                              styles.candidateLabel,
                              selected ? styles.candidateLabelSelected : null,
                            ]}
                            numberOfLines={1}
                          >
                            {candidate.label}
                          </Text>
                          <Text
                            style={[
                              styles.candidateMeta,
                              selected ? styles.candidateMetaSelected : null,
                            ]}
                            numberOfLines={1}
                          >
                            {candidate.category} - {candidate.subtype}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ) : null}

              {/* Style Match Summary */}
              <View style={styles.section}>
                <StyleMatchPanel
                  title={title}
                  category={v2Data.category}
                  color={v2Data.color}
                  silhouette={v2Data.silhouette}
                  material={v2Data.material}
                  pattern={v2Data.pattern}
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
                  scanSourceId={scanSourceId ?? null}
                />
              </View>

              {/* Similar Finds: only show when there are at least 2 matches. */}
              {priceDiscoveryEnabled && hasRenderableSimilarFinds ? (
                <View
                  style={styles.section}
                  onLayout={(event) => {
                    setSimilarFindsTarget({
                      key: similarFindsKey,
                      y: Math.max(event.nativeEvent.layout.y - SIMILAR_SCROLL_TOP_OFFSET, 0),
                    });
                  }}
                >
                  <SimilarFindsShelf
                    similarFinds={renderableSimilarFinds}
                    onViewAll={handleViewAllSimilar}
                  />
                </View>
              ) : null}

              {/* Purchase Options */}
              {priceDiscoveryEnabled
                && Array.isArray(v2Data.purchaseOptions)
                && v2Data.purchaseOptions.length > 0 ? (
                <View style={styles.section}>
                  <PurchaseOptionsPanel
                    purchaseOptions={v2Data.purchaseOptions}
                  />
                </View>
              ) : null}

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

              {/* Extra spacer so ScrollView content clears sticky action row */}
              <View style={{ height: SPACING.xl }} />
            </ScrollView>

            {/* Sticky Bottom Action Row */}
            <ScanResultActionRow
              onSave={isConfirmationStep ? undefined : onSaveToLibrary}
              saveLabel={saveActionLabel}
              onFindSimilar={
                confirmationCandidates.length > 0
                  ? onAnalyzeSelectedCandidate
                    ? handleFindCandidateMatches
                    : undefined
                  : similarFindsTargetReady
                  ? handleFindSimilar
                  : undefined
              }
              findSimilarLabel={confirmationCandidates.length > 0 ? 'Find Matches' : 'Find Similar'}
              onAskStyleChat={isConfirmationStep ? undefined : onAskStyleChat}
              onAddToDressingRoom={isConfirmationStep ? undefined : onAddToDressingRoom}
              onLayout={(event) => setActionRowHeight(event.nativeEvent.layout.height)}
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
    // maxHeight set inline (responsive to live window height)
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
  candidateEyebrow: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 10,
    letterSpacing: 2.2,
    color: LUXURY.colors.goldBrushed,
    marginBottom: SPACING.sm,
  },
  candidateList: {
    gap: SPACING.sm,
  },
  candidateButton: {
    minHeight: 54,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.cream,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    justifyContent: 'center',
  },
  candidateButtonSelected: {
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.pearl,
  },
  candidateLabel: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    color: LUXURY.colors.ink,
  },
  candidateLabelSelected: {
    color: LUXURY.colors.plumDeep,
  },
  candidateMeta: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 0.6,
    color: LUXURY.colors.stone,
    marginTop: 2,
    textTransform: 'uppercase',
  },
  candidateMetaSelected: {
    color: LUXURY.colors.plum,
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
