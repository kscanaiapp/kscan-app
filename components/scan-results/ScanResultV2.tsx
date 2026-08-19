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
import type { LegacyAnalysisData, ProductMatch, ScanResultV2 } from './types';
import { SCAN_RESULTS_DEMO_UI_ENABLED } from '../../constants/featureFlags';
import { ScanResultUtilityFooter } from '../free-tier/ScanResultUtilityFooter';
import { getDemoScanResultV2 } from '../../data/scan-results-demo';
import {
  MultiItemResultNavigator,
  type MultiItemNavigatorMode,
  type MultiItemResultSummary,
} from './MultiItemResultNavigator';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { recordScanLatencyMarker } from '../../services/scanLatencyMarkers';
import { resolvePurchaseShelfMode } from '../AnalysisCard';
import type {
  CandidateReviewDescriptor,
  ScanItemQueueState,
} from '../../services/multiImageScan';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const FROM_Y = SCREEN_HEIGHT * 0.36;
const SIMILAR_SCROLL_TOP_OFFSET = 20;

/**
 * Height to reserve for the sticky action row BEFORE it has been measured.
 *
 * Two wrapped lines of 48pt buttons + the 8pt gap between them + the row's own
 * 12pt top padding. Four actions wrap to two lines on a narrow screen, and this
 * is the only frame where a too-small estimate is visible as the last item
 * sitting behind the bar. Excludes the safe-area inset, which the caller adds.
 */
const ESTIMATED_ACTION_ROW_HEIGHT = 48 * 2 + SPACING.sm + SPACING.md;

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
  /**
   * v127 (P1-B): deferred commerce lifecycle for the CURRENTLY DISPLAYED
   * item. Undefined/'idle' leaves the Purchase Options panel exactly as it
   * behaves without this prop — hidden when there is no data. 'pending'/
   * 'error' additionally show the panel (with its own governed treatment)
   * only while still empty; once options arrive they always win.
   */
  commerceStatus?: 'idle' | 'pending' | 'success' | 'empty' | 'error';
  /** Present only when a failed deferred fetch is retryable. */
  onRetryCommerce?: () => void;
  multiItem?: {
    imageCount: number;
    items: ReadonlyArray<MultiItemResultSummary>;
    selectedItemId: string;
    savedItemIds?: ReadonlySet<string>;
    onSelectItem: (itemId: string) => void;
    onSaveAll?: () => void;
    saveAllDisabled?: boolean;
    onAddAllToDressingRoom?: () => void;
    itemStates?: Readonly<Record<string, ScanItemQueueState>>;
    queueNotice?: string | null;
    /** Present after a quota halt: explicit resume for the remaining items. */
    onResumeQueue?: () => void;
    resumeCount?: number;
  };
  /**
   * Deliberate multi-item candidate review. When present, the modal renders
   * the review (or queue-processing) surface instead of an analyzed result.
   * Review requires zero commerce work and exposes no Dressing Room actions.
   */
  candidateReview?: {
    stage: 'review' | 'processing';
    imageCount: number;
    candidates: ReadonlyArray<CandidateReviewDescriptor>;
    selectedCandidateIds: ReadonlyArray<string>;
    itemStates?: Readonly<Record<string, ScanItemQueueState>>;
    onToggleCandidate: (candidateId: string) => void;
    onConfirmSelection: () => void;
    detectionNotice?: string | null;
    queueNotice?: string | null;
    /** Latency generation for sanitized first-paint instrumentation. */
    latencyGeneration?: number;
  };
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
  commerceStatus = 'idle',
  onRetryCommerce,
  multiItem,
  candidateReview,
  testID,
}: ScanResultV2Props) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const reducedMotion = useReducedMotion();

  // Map legacy data into V2 shape
  let v2Data: ScanResultV2 | null = mapLegacyToV2(analysis, scanImageUri);

  // Demo data override (dev-only, gated)
  if (SCAN_RESULTS_DEMO_UI_ENABLED && !v2Data?.similarFinds) {
    const demo = getDemoScanResultV2(v2Data ?? undefined);
    v2Data = {
      ...demo,
      ...v2Data,
      similarFinds: demo.similarFinds,
      purchaseOptions: v2Data?.purchaseOptions ?? demo.purchaseOptions,
    };
  }

  const translateY = React.useRef(new Animated.Value(FROM_Y)).current;
  const opacity = React.useRef(new Animated.Value(0)).current;
  const isExiting = React.useRef(false);
  const scrollViewRef = React.useRef<ScrollView>(null);
  const [actionRowHeight, setActionRowHeight] = React.useState(0);
  const [similarFindsTarget, setSimilarFindsTarget] = React.useState<{
    key: string;
    y: number;
  } | null>(null);

  const runExit = () => {
    if (isExiting.current) return;
    isExiting.current = true;

    if (reducedMotion) {
      onDismiss();
      return;
    }

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
    isExiting.current = false;

    if (reducedMotion) {
      // Reduced motion: no entrance animation; content appears immediately.
      translateY.setValue(0);
      opacity.setValue(1);
      return;
    }

    translateY.setValue(FROM_Y);
    opacity.setValue(0);

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
  }, [translateY, opacity, reducedMotion]);

  // Sanitized latency marker: candidate review first paint.
  const reviewPaintMarked = React.useRef(false);
  React.useEffect(() => {
    if (candidateReview?.stage === 'review' && !reviewPaintMarked.current) {
      reviewPaintMarked.current = true;
      recordScanLatencyMarker(
        'candidate_review_first_paint',
        candidateReview.latencyGeneration ?? 0,
        candidateReview.candidates.length,
      );
    }
  }, [candidateReview]);

  const selectedCount = candidateReview?.selectedCandidateIds.length ?? 0;
  const ctaLabel = selectedCount === 0
    ? 'Select items to match'
    : selectedCount === 1
    ? 'Find Matches for 1 Item'
    : `Find Matches for ${selectedCount} Items`;
  const ctaDisabled = selectedCount === 0 || candidateReview?.stage === 'processing';


  // Build title from available metadata
  const title = v2Data?.title || 'Fashion Item';

  // v127 (P1-B): the live commerce status/retry contract must be evaluated
  // on THIS surface — it previously existed only on the AnalysisCard
  // fallback, which SCAN_RESULTS_V2_UI_ENABLED makes unreachable in every
  // governed profile. Same precedence as AnalysisCard, including the
  // remote priceDiscovery kill-switch.
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const priceDiscoveryEnabled = !featureFreezeLoading && isFeatureEnabled('priceDiscovery');
  const commerceOptionsCount = Array.isArray(v2Data?.purchaseOptions)
    ? v2Data.purchaseOptions.length
    : 0;
  const purchaseShelfMode = resolvePurchaseShelfMode(
    commerceOptionsCount,
    priceDiscoveryEnabled,
    commerceStatus,
  );

  const renderableSimilarFinds = Array.isArray(v2Data?.similarFinds)
    ? v2Data.similarFinds.filter(isRenderableSimilarFind)
    : [];
  const similarFindsKey = renderableSimilarFinds.map((product) => product.id).join('|');
  const hasRenderableSimilarFinds = renderableSimilarFinds.length >= 2;
  const similarFindsTargetReady =
    hasRenderableSimilarFinds && similarFindsTarget?.key === similarFindsKey;

  /**
   * Will the sticky action row render anything?
   *
   * Mirrors ScanResultActionRow's own filter, and must keep mirroring it: the
   * next-step prompt is framing FOR these actions, so a prompt shown without
   * them asks a question the screen cannot answer.
   */
  const hasStickyActions =
    typeof onSaveToLibrary === 'function' ||
    similarFindsTargetReady ||
    typeof onAskStyleChat === 'function' ||
    typeof onAddToDressingRoom === 'function';

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

  // ── Deliberate candidate review / queue processing surface ──
  if (candidateReview) {
    const navigatorMode: MultiItemNavigatorMode =
      candidateReview.stage === 'processing' ? 'processing' : 'review';
    return (
      <Modal transparent animationType="none" onRequestClose={runExit}>
        <View style={styles.backdrop} pointerEvents="box-none">
          <Animated.View
            testID={testID ?? 'scan-result-v2-review'}
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
                contentContainerStyle={[
                  styles.cardInner,
                  { paddingBottom: 120 + Math.max(insets.bottom, SPACING.md) },
                ]}
              >
                <View style={styles.header}>
                  <Text style={styles.brandTitle}>K SCAN</Text>
                  <Text style={styles.statusLabel}>
                    {candidateReview.stage === 'processing'
                      ? 'FINDING YOUR MATCHES'
                      : 'CHOOSE YOUR ITEMS'}
                  </Text>
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

                <View style={styles.divider}>
                  <Text style={styles.dividerText}>✧</Text>
                </View>

                <MultiItemResultNavigator
                  mode={navigatorMode}
                  imageCount={candidateReview.imageCount}
                  candidates={candidateReview.candidates}
                  selectedCandidateIds={candidateReview.selectedCandidateIds}
                  itemStates={candidateReview.itemStates}
                  onToggleCandidate={candidateReview.onToggleCandidate}
                  detectionNotice={candidateReview.detectionNotice}
                  queueNotice={candidateReview.queueNotice}
                />
              </ScrollView>

              {/* Count-aware CTA — pinned above the safe area, never covering
                  candidate controls (content reserves its height). */}
              <View
                style={[
                  styles.reviewCtaWrap,
                  { paddingBottom: Math.max(SPACING.md, insets.bottom) },
                ]}
              >
                <TouchableOpacity
                  onPress={ctaDisabled ? undefined : candidateReview.onConfirmSelection}
                  disabled={ctaDisabled}
                  activeOpacity={0.86}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: ctaDisabled }}
                  accessibilityLabel={ctaLabel}
                  style={[styles.reviewCta, ctaDisabled && styles.reviewCtaDisabled]}
                  testID="candidate-review-cta"
                >
                  <Text style={styles.reviewCtaText}>{ctaLabel.toUpperCase()}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Animated.View>
        </View>
      </Modal>
    );
  }


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
                  // The body says what to expect next, not the title again.
                  // "Your scan data could not be loaded" restated the heading
                  // and left the user with nothing they did not already know.
                  subtitle="Nothing was saved, so you can scan this item again."
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
              ref={scrollViewRef}
              bounces={false}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[
                styles.cardInner,
                {
                  // Clear the absolutely-positioned action row.
                  //
                  // The measured height ALREADY contains the row's own bottom
                  // inset padding, so the inset is only added while no
                  // measurement exists yet — adding it to a measured height
                  // double-counts it and leaves a dead gap under the content.
                  //
                  // The pre-measurement estimate has to cover the row WRAPPED to
                  // two lines, which is what four actions do on a narrow screen.
                  // The old floor of 100 was under a single line plus its inset,
                  // so the last item sat behind the bar until onLayout landed.
                  paddingBottom:
                    (actionRowHeight > 0
                      ? actionRowHeight
                      : ESTIMATED_ACTION_ROW_HEIGHT + Math.max(insets.bottom, SPACING.md)) +
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

              {multiItem ? (
                <>
                  <MultiItemResultNavigator mode="results" {...multiItem} />
                  {multiItem.onResumeQueue && (multiItem.resumeCount ?? 0) > 0 ? (
                    <TouchableOpacity
                      onPress={multiItem.onResumeQueue}
                      activeOpacity={0.86}
                      accessibilityRole="button"
                      accessibilityLabel={`Resume matches for ${multiItem.resumeCount} remaining ${multiItem.resumeCount === 1 ? 'item' : 'items'}`}
                      style={styles.resumeCta}
                      testID="candidate-review-resume"
                    >
                      <Text style={styles.resumeCtaText}>
                        {`RESUME MATCHES FOR ${multiItem.resumeCount} ${multiItem.resumeCount === 1 ? 'ITEM' : 'ITEMS'}`}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </>
              ) : null}

              {/* Hero */}
              <ScanResultHero
                imageUri={scanImageUri}
                category={v2Data.category}
                confidence={v2Data.confidence}
              />

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
                />
              </View>

              {/* Similar Finds: only show when there are at least 2 matches. */}
              {hasRenderableSimilarFinds ? (
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

              {/* Purchase Options — v127 (P1-B): pending/empty/error/retry
                  must be visible on the LIVE result surface, not only on the
                  unreachable AnalysisCard fallback. Options in hand always win. */}
              {purchaseShelfMode === 'options' ? (
                <View style={styles.section}>
                  <PurchaseOptionsPanel
                    purchaseOptions={v2Data.purchaseOptions}
                  />
                </View>
              ) : purchaseShelfMode === 'pending' || purchaseShelfMode === 'error' ? (
                <View style={styles.section}>
                  <PurchaseOptionsPanel
                    purchaseOptions={[]}
                    commerceStatus={purchaseShelfMode}
                    onRetry={onRetryCommerce}
                  />
                </View>
              ) : null}

              {/* Next-step framing above sticky actions.
                  Gated on there BEING sticky actions: every handler below is
                  conditional (a feature freeze, no active scan item, too few
                  similar finds), and when they all resolve to undefined the row
                  renders null — leaving this question with nothing to answer
                  it. */}
              {hasStickyActions ? (
                <Text style={styles.nextStepPrompt}>
                  What would you like to do with this look?
                </Text>
              ) : null}

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
              onSave={onSaveToLibrary}
              saveLabel={saveActionLabel}
              onFindSimilar={similarFindsTargetReady ? handleFindSimilar : undefined}
              onAskStyleChat={onAskStyleChat}
              onAddToDressingRoom={onAddToDressingRoom}
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
  reviewCtaWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    // Opaque for the same reason as ScanResultActionRow: this bar sits over the
    // scrolling candidate list, and 4% bleed-through is enough to make the CTA
    // label compete with whatever is moving behind it.
    backgroundColor: LUXURY.colors.cream,
    borderTopWidth: 1,
    borderTopColor: LUXURY.colors.border,
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.md,
    zIndex: 50,
    elevation: 50,
  },
  reviewCta: {
    minHeight: 52,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  reviewCtaDisabled: {
    opacity: 0.5,
  },
  reviewCtaText: {
    ...LUXURY.typography.cta,
    color: LUXURY.colors.inverse,
    textAlign: 'center',
  },
  resumeCta: {
    minHeight: 48,
    borderRadius: RADIUS.pill,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.lg,
  },
  resumeCtaText: {
    ...LUXURY.typography.ctaSecondary,
    color: LUXURY.colors.plum,
    textAlign: 'center',
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
