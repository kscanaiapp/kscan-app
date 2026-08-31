import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
  Animated,
  PanResponder,
  Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MetadataChip } from './MetadataChip';
import { ProductShelf, type Product } from './ProductShelf';
import { ScanResultCard } from './scan/ScanResultCard';
import { SecondhandShelf } from './SecondhandShelf';
import { SneakerMatchCard } from './SneakerMatchCard';
import { useFeatureFreeze } from '../hooks/useFeatureFreeze';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { useAiOutputReporting } from '../contexts/AiOutputReportingContext';
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
} from '../constants/theme';
import type { VintedSecondhandSearchResponse } from '../types/scan';
import type { SneakerReference } from '../services/sneakers/types';
import type { ScanResultObject } from '../types/scanResultObject';
import type { OutfitConfirmationCandidate } from '../services/outfitConfirmation/outfitDetectionBridge';
import { SavedItemUtilityPanel } from './free-tier/SavedItemUtilityPanel';
import { normalizeItem, normalizeItems } from '../services/free-tier/itemNormalization';

// Sheet metrics derive from the live window (see useResponsiveLayout inside
// the component) so rotation and split-view resizes never animate from a
// stale offset.
const EMPTY_VALUE = '—';

export interface AnalysisCardProps {
  result:    string;
  metadata:  {
    category: string;
    color: string;
    silhouette: string;
    pattern?: string | null;
    confidenceScore?: number;
    scanQualityNote?: string | null;
    stylingSuggestions?: string[];
  };
  products?: Product[];
  /** Durable live-commerce snapshot. Distinct from `products`, which is the
   *  catalog similarity shelf. Rehydrated from the saved scan when a Recent
   *  Scan is reopened, so the cards survive app relaunch. */
  purchaseOptions?: Product[];
  /**
   * v127 (P1-B): deferred commerce lifecycle. Undefined/'idle' leaves the
   * "WHERE TO BUY" section exactly as it behaves without this prop — hidden
   * when `purchaseOptions` is empty. 'pending'/'error' additionally render
   * inside the section only when `purchaseOptions` is STILL empty; once any
   * options arrive the shelf renders them and this status is moot.
   */
  commerceStatus?: 'idle' | 'pending' | 'success' | 'empty' | 'error';
  /** Present only when a failed deferred fetch is retryable. */
  onRetryCommerce?: () => void;
  confirmationCandidates?: OutfitConfirmationCandidate[];
  selectedCandidateId?: string | null;
  onSelectCandidate?: (candidateId: string) => void;
  onAnalyzeSelectedCandidate?: (candidateId: string) => void;
  /**
   * Build 32: persisted per-item commerce, restored on a reopened Recent
   * Scan. Absent/empty on every pre-Build-32 saved scan and on any scan that
   * was not a multi-item detection — the section simply does not render.
   */
  multiItemCandidates?: Array<{ id: string; label: string; category: string; subtype: string }>;
  multiItemCommerce?: Array<{
    candidateId: string;
    status: string;
    bestMatch: Product | null;
    alternatives: Product[];
  }>;
  /** Optional structured Scan Result Object (Part 2). When present, an additive
   *  ScanResultCard renders above the product shelf. Absent → UI unchanged. */
  scanResultObject?: ScanResultObject | null;
  secondhand?: VintedSecondhandSearchResponse | null;
  sneakerReference?: SneakerReference[] | null;
  scanImageUri?: string | null;
  scanSourceId?: string | null;
  scanSourceType?: 'live_scan' | 'style_library_scan';
  /** Optional raw saved scans so the free-tier utility panel can show pairings. */
  relatedSavedScans?: unknown[];
  onDismiss: () => void;
  onAddToDressingRoom?: () => void;
  /**
   * When Dressing Rooms is available but this specific item has no usable
   * image source yet (canonical contract: no local URI, storage reference,
   * or remote URL), the caller passes an explanation here instead of simply
   * omitting `onAddToDressingRoom`. The CTA still renders — disabled, with
   * the reason — rather than silently disappearing.
   */
  addToDressingRoomUnavailableReason?: string | null;
  // Phase 2 (additive, optional): Ask StyleChat about this saved item.
  // Undefined leaves rendering and behavior unchanged.
  onAskStyleChat?: () => void;
  /**
   * Closet testing bundle (additive, optional): non-destructive promotion of
   * this Recent Scan into the owned-inventory Closet.
   *
   * The scan itself — including its persisted commerce snapshot rendered above
   * — is NOT modified by this action. Undefined leaves rendering unchanged.
   */
  onAddToCloset?: () => void;
  /** 'saved' reflects an existing Closet item for this scan's lineage. */
  closetState?: 'idle' | 'saving' | 'saved';
}

function sanitizeText(value?: string) {
  return value?.trim() || EMPTY_VALUE;
}

/**
 * Which treatment the "WHERE TO BUY" section gets. Pulled out of the JSX
 * branch so this exact precedence is independently testable.
 *
 * Options in hand always win, regardless of status — a stale 'error' from
 * before a successful retry must never hide options that already arrived.
 * Pending/error render while the result is still unsettled; a completed
 * zero-result search renders its own empty treatment rather than nothing.
 */
export function resolvePurchaseShelfMode(
  purchaseOptionsCount: number,
  priceDiscoveryEnabled: boolean,
  commerceStatus: string,
): 'options' | 'pending' | 'error' | 'empty' | 'hidden' {
  if (!priceDiscoveryEnabled) return 'hidden';
  if (purchaseOptionsCount >= 1) return 'options';
  if (commerceStatus === 'pending') return 'pending';
  if (commerceStatus === 'error') return 'error';
  return 'empty';
}

export function AnalysisCard({
  result,
  metadata,
  products = [],
  purchaseOptions = [],
  commerceStatus = 'idle',
  onRetryCommerce,
  confirmationCandidates = [],
  selectedCandidateId,
  onSelectCandidate,
  onAnalyzeSelectedCandidate,
  multiItemCandidates = [],
  multiItemCommerce = [],
  scanResultObject,
  secondhand,
  sneakerReference,
  scanImageUri,
  scanSourceId,
  scanSourceType = 'live_scan',
  relatedSavedScans,
  onDismiss,
  onAddToDressingRoom,
  addToDressingRoomUnavailableReason,
  onAddToCloset,
  closetState = 'idle',
  onAskStyleChat,
}: AnalysisCardProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight, modalMaxWidth } = useResponsiveLayout();
  const fromY = windowHeight * 0.36;
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const { openAiOutputReport } = useAiOutputReporting();
  const priceDiscoveryEnabled = !featureFreezeLoading && isFeatureEnabled('priceDiscovery');
  const purchaseShelfMode = resolvePurchaseShelfMode(
    purchaseOptions.length,
    priceDiscoveryEnabled,
    commerceStatus,
  );
  const resaleValuationEnabled = !featureFreezeLoading && isFeatureEnabled('resaleValuation');
  const translateY    = useRef(new Animated.Value(fromY)).current;
  const opacity       = useRef(new Animated.Value(0)).current;
  const chip1Opacity  = useRef(new Animated.Value(0)).current;
  const chip2Opacity  = useRef(new Animated.Value(0)).current;
  const chip3Opacity  = useRef(new Animated.Value(0)).current;
  const isExiting     = useRef(false);

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

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder:  (_, gesture) => gesture.dy > SPACING.md,
      onPanResponderRelease:        (_, gesture) => {
        if (gesture.vy > 0.3 || gesture.dy > 80) runExit();
      },
    })
  ).current;

  useEffect(() => {
    translateY.setValue(fromY);
    opacity.setValue(0);
    chip1Opacity.setValue(0);
    chip2Opacity.setValue(0);
    chip3Opacity.setValue(0);
    isExiting.current = false;

    const easingFn = Easing.bezier(
      MOTION.easing.x1,
      MOTION.easing.y1,
      MOTION.easing.x2,
      MOTION.easing.y2
    );

    Animated.parallel([
      Animated.timing(translateY, {
        toValue:  0,
        duration: MOTION.enterDuration,
        easing:   easingFn,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue:  1,
        duration: MOTION.enterDuration,
        easing:   easingFn,
        useNativeDriver: true,
      }),
    ]).start(() => {
      Animated.stagger(MOTION.chipStagger, [
        Animated.timing(chip1Opacity, { toValue: 1, duration: MOTION.microDuration, useNativeDriver: true }),
        Animated.timing(chip2Opacity, { toValue: 1, duration: MOTION.microDuration, useNativeDriver: true }),
        Animated.timing(chip3Opacity, { toValue: 1, duration: MOTION.microDuration, useNativeDriver: true }),
      ]).start();
    });
  }, [translateY, opacity, chip1Opacity, chip2Opacity, chip3Opacity]);

  const meta       = metadata ?? { category: '', color: '', silhouette: '' };
  const resultText = sanitizeText(result);
  const category   = sanitizeText(meta.category);
  const color      = sanitizeText(meta.color);
  const silhouette = sanitizeText(meta.silhouette);
  // Not sanitizeText: that substitutes an em dash for an absent value, which
  // would render a "Pattern —" chip asserting the scan looked and found none.
  const pattern    = typeof meta.pattern === 'string' ? meta.pattern.trim() : '';
  const confidenceScore = typeof meta.confidenceScore === 'number' ? meta.confidenceScore : undefined;
  const scanQualityNote = meta.scanQualityNote ?? undefined;
  const showLowConfidence = confidenceScore !== undefined && confidenceScore < 0.70;
  const activeCandidateId = selectedCandidateId ?? confirmationCandidates[0]?.id ?? null;
  const isConfirmationStep = confirmationCandidates.length > 0;
  const isLibraryScan = scanSourceType === 'style_library_scan';

  return (
    <Modal transparent animationType="none" onRequestClose={runExit}>
      <View style={styles.backdrop} pointerEvents="box-none">
        <Animated.View
          testID="analysis-card"
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
          {/* Subtle gold glow behind card */}
          <View style={styles.glow} pointerEvents="none" />

          <View style={[styles.card, { maxHeight: windowHeight * 0.86 }]}>
            <View style={styles.headerBar} pointerEvents="box-none">
              <View style={styles.headerSpacer} />
              <TouchableOpacity
                testID="analysis-card-close"
                onPress={runExit}
                activeOpacity={0.78}
                accessibilityRole="button"
                accessibilityLabel="Close this screen"
                style={styles.closeButton}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.closeButtonText}>Close</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              bounces={false}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.cardInner}
            >
              {/* Drag handle */}
              <View style={styles.grip} />

              {/* Section label */}
              <Text style={styles.categoryLabel}>STYLE ANALYSIS</Text>

              {/* Headline — category or fallback */}
              <Text style={styles.headline}>
                {meta.category && meta.category !== EMPTY_VALUE ? meta.category : 'Style Read'}
              </Text>

              {/* AI result body */}
              <Text style={styles.body}>{resultText}</Text>

              {/* Offensive/unsafe AI-output reporting for the Scan Results
                  surface. This paragraph is model-authored prose, so it needs
                  the same in-app reporting route StyleChat already gives its
                  assistant messages (components/style-chat/StyleChatBubble).
                  Hidden when there is no analysis text to report. */}
              {resultText && resultText !== EMPTY_VALUE ? (
                <TouchableOpacity
                  onPress={() =>
                    openAiOutputReport({ feature: 'Scan Results', itemId: scanSourceId ?? null })
                  }
                  style={styles.reportBtn}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Report this style analysis as offensive or unsafe"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  testID="analysis-card-report-ai"
                >
                  <Text style={styles.reportText}>Report Response</Text>
                </TouchableOpacity>
              ) : null}

              {/* Match summary */}
              <View style={styles.matchSummary}>
                <Text style={styles.matchSummaryLabel}>K Scan AI understood:</Text>
                <Text style={styles.matchSummaryValue} numberOfLines={2}>
                  {category} · {color} · {silhouette}
                </Text>
              </View>

              {isConfirmationStep ? (
                <View style={styles.candidatePanel} testID="outfit-confirmation-candidates">
                  <Text style={styles.candidateEyebrow}>Detected Items</Text>
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
                  {activeCandidateId && onAnalyzeSelectedCandidate ? (
                    <TouchableOpacity
                      testID="outfit-find-matches"
                      style={styles.scanRoomCta}
                      onPress={() => onAnalyzeSelectedCandidate(activeCandidateId)}
                      activeOpacity={0.86}
                      accessibilityRole="button"
                      accessibilityLabel="Find matches for selected garment"
                    >
                      <Text style={styles.scanRoomCtaText}>Find Matches</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}

              {/* Build 32: restored per-item commerce cards on a reopened
                  Recent Scan. Garment-organized, Best Match + Alternatives
                  only. Absent on scans saved before Build 32 or with no
                  attached commerce yet — section simply does not render. */}
              {multiItemCandidates.length > 0 ? (
                <View style={styles.candidatePanel} testID="multi-item-commerce-section">
                  {multiItemCandidates.map((candidate) => {
                    const card = multiItemCommerce.find((entry) => entry.candidateId === candidate.id);
                    return (
                      <View key={candidate.id} testID={`multi-item-commerce-card-${candidate.id}`}>
                        {card?.bestMatch ? (
                          <ProductShelf
                            products={[card.bestMatch]}
                            label={`${candidate.label} · Best Match`}
                            testID={`multi-item-commerce-best-match-${candidate.id}`}
                          />
                        ) : card?.status === 'error' ? (
                          /* Commerce failed for this item rather than
                             returning nothing — the stored card says so, so
                             the reopened scan must not claim we looked and
                             found no match. Matches the live surface's own
                             error treatment (MultiItemCommerceSection). */
                          <ProductShelf
                            products={[]}
                            label={candidate.label}
                            emptyTitle="Purchase options couldn't be loaded."
                            emptyBody="We couldn't reach our retail partners for this item when this scan was saved."
                            testID={`multi-item-commerce-error-${candidate.id}`}
                          />
                        ) : (
                          <ProductShelf
                            products={[]}
                            label={candidate.label}
                            emptyTitle="No strong shopping match found."
                            emptyBody="This item was identified, but no confident retailer match was returned."
                            testID={`multi-item-commerce-no-match-${candidate.id}`}
                          />
                        )}
                        {card && card.alternatives.length > 0 ? (
                          <ProductShelf
                            products={card.alternatives}
                            label={`${candidate.label} · Alternatives`}
                            testID={`multi-item-commerce-alternatives-${candidate.id}`}
                          />
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              ) : null}

              {/* Metadata chips */}
              <View style={styles.chipRow}>
                <Animated.View style={{ opacity: chip1Opacity }}>
                  <MetadataChip label="Category"  value={category}  />
                </Animated.View>
                <Animated.View style={{ opacity: chip2Opacity }}>
                  <MetadataChip label="Color"     value={color}     />
                </Animated.View>
                <Animated.View style={{ opacity: chip3Opacity }}>
                  <MetadataChip label="Silhouette" value={silhouette} />
                </Animated.View>
                {/* Pattern (BUG-11). Rendered only when the scan established
                    one — an absent pattern stays absent rather than becoming
                    "solid", which would be a claim the scan never made. */}
                {pattern ? (
                  <Animated.View style={{ opacity: chip3Opacity }}>
                    <MetadataChip label="Pattern" value={pattern} />
                  </Animated.View>
                ) : null}
              </View>

              {/* Low-confidence / scan quality guidance */}
              {(showLowConfidence || scanQualityNote) && (
                <View style={styles.guidanceBox}>
                  <Text style={styles.guidanceTitle}>Scan tip</Text>
                  {scanQualityNote ? (
                    <Text style={styles.guidanceText}>{scanQualityNote}</Text>
                  ) : (
                    <Text style={styles.guidanceText}>Try a clearer photo with better lighting. Move closer to the garment and try a straight-on front view.</Text>
                  )}
                </View>
              )}

              {!isConfirmationStep && onAddToDressingRoom ? (
                <TouchableOpacity
                  style={styles.scanRoomCta}
                  onPress={onAddToDressingRoom}
                  activeOpacity={0.86}
                  accessibilityRole="button"
                  accessibilityLabel="Add this scan to a Dressing Room"
                >
                  <Text style={styles.scanRoomCtaText}>Add Scan to Dressing Room</Text>
                </TouchableOpacity>
              ) : !isConfirmationStep && addToDressingRoomUnavailableReason ? (
                <View
                  style={[styles.scanRoomCta, styles.scanRoomCtaDisabled]}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: true }}
                  accessibilityLabel={`Add this scan to a Dressing Room. Unavailable: ${addToDressingRoomUnavailableReason}`}
                >
                  <Text style={[styles.scanRoomCtaText, styles.scanRoomCtaTextDisabled]}>
                    Add Scan to Dressing Room
                  </Text>
                  <Text style={styles.scanRoomCtaReasonText}>{addToDressingRoomUnavailableReason}</Text>
                </View>
              ) : null}

              {!isConfirmationStep && onAddToCloset ? (
                closetState === 'saved' ? (
                  <View
                    style={[styles.scanRoomCta, styles.scanRoomCtaDisabled]}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: true }}
                    accessibilityLabel="This scan is already in your Closet"
                    testID="add-to-closet-saved"
                  >
                    <Text style={[styles.scanRoomCtaText, styles.scanRoomCtaTextDisabled]}>
                      In Your Closet
                    </Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.scanRoomCta}
                    onPress={onAddToCloset}
                    disabled={closetState === 'saving'}
                    activeOpacity={0.86}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: closetState === 'saving' }}
                    accessibilityLabel="Add this item to your Closet"
                    testID="add-to-closet"
                  >
                    <Text style={styles.scanRoomCtaText}>
                      {closetState === 'saving' ? 'Adding…' : 'Add to Closet'}
                    </Text>
                  </TouchableOpacity>
                )
              ) : null}

              {!isConfirmationStep && onAskStyleChat ? (
                <TouchableOpacity
                  style={styles.scanRoomCta}
                  onPress={onAskStyleChat}
                  activeOpacity={0.86}
                  accessibilityRole="button"
                  accessibilityLabel="Ask Elise about this item"
                  testID="ask-stylechat-item"
                >
                  <Text style={styles.scanRoomCtaText}>Ask Elise</Text>
                </TouchableOpacity>
              ) : null}

              {/* Sneaker enrichment card — renders only when enrichment resolves */}
              {sneakerReference && sneakerReference.length > 0 ? (
                <SneakerMatchCard matches={sneakerReference} />
              ) : null}

              {/* Scan Result Object summary card (Part 2). Additive — only when
                  the structured object is present; otherwise UI is unchanged. */}
              {scanResultObject ? (
                <ScanResultCard scanResultObject={scanResultObject} />
              ) : null}

              {/* Live commerce purchase options, rendered directly beneath the
                  scan/analysis and ahead of the catalog shelf. Sourced from the
                  durable snapshot on the saved scan, so a reopened Recent Scan
                  shows the same cards as the original result with no Scanner
                  navigation state involved. One option is enough to render;
                  zero hides the section rather than inventing offers. */}
              {purchaseShelfMode === 'options' ? (
                <ProductShelf
                  products={purchaseOptions}
                  label="WHERE TO BUY"
                  testID="purchase-options-shelf"
                />
              ) : purchaseShelfMode === 'pending' || purchaseShelfMode === 'error' || purchaseShelfMode === 'empty' ? (
                // A completed zero-result search is a real answer, not the
                // same as "never checked" — it still mounts the shelf so its
                // own governed empty state renders instead of nothing at all.
                <ProductShelf
                  products={[]}
                  label="WHERE TO BUY"
                  testID="purchase-options-shelf"
                  pending={purchaseShelfMode === 'pending'}
                  hasError={purchaseShelfMode === 'error'}
                  onRetry={onRetryCommerce}
                />
              ) : null}

              {/* Catalog similarity matches: hide the entire section unless there
                  are at least 2 meaningful matches. */}
              {priceDiscoveryEnabled && products.length >= 2 ? (
                <ProductShelf products={products} />
              ) : null}

              {resaleValuationEnabled && secondhand?.enabled && secondhand.items.length > 0 ? (
                <SecondhandShelf items={secondhand.items} />
              ) : null}

              {/* Primary CTA — library reopen dismisses; live scan returns to capture. */}
              <TouchableOpacity
                style={styles.cta}
                onPress={runExit}
                activeOpacity={0.86}
                accessibilityRole="button"
                accessibilityLabel={isLibraryScan ? 'Close this screen' : 'Scan another item'}
                testID={isLibraryScan ? 'analysis-card-done' : 'analysis-card-scan-again'}
              >
                <Text style={styles.ctaText}>{isLibraryScan ? 'Done' : 'Scan Again'}</Text>
              </TouchableOpacity>

              {/* Free-tier per-item utilities for saved library scans */}
              {scanSourceType === 'style_library_scan' ? (
                <SavedItemUtilityPanel
                  item={normalizeItem({
                    id: scanSourceId,
                    title: result,
                    attributes: {
                      category: metadata.category,
                      color_palette: metadata.color,
                      silhouette: metadata.silhouette,
                    },
                    imageUri: scanImageUri,
                    createdAt: new Date().toISOString(),
                    source: 'library',
                  })}
                  relatedItems={normalizeItems(relatedSavedScans ?? [], 'library')}
                  // This surface is the scan result — live, or the same result
                  // reopened from Recent Scans. It was previously declared
                  // "library", which conflated it with the Closet owned-item
                  // lifecycle and pulled wardrobe-maintenance surfaces into the
                  // scan-to-commerce funnel. A reopened Recent Scan is still
                  // discovery, so it declares its real journey here.
                  context="scan_result"
                />
              ) : null}
            </ScrollView>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex:               1,
    backgroundColor:    COLORS.backdrop,
    justifyContent:     'flex-end',
    paddingHorizontal:  SPACING.xl,
  },
  cardWrap: {
    borderRadius:  card.borderRadius,
    overflow:      'visible',
    ...SHADOWS.editorialRaised,
  },
  glow: {
    ...StyleSheet.absoluteFillObject,
    top:    SPACING.lg,
    bottom: SPACING.lg,
    left:   SPACING.xl,
    right:  SPACING.xl,
    borderRadius:    card.borderRadius,
    backgroundColor: COLORS.goldMuted,
    opacity:         0.16,
  },
  card: {
    borderRadius:     card.borderRadius,
    borderWidth:      1,
    borderColor:      LUXURY.colors.border,
    overflow:         'hidden',
    backgroundColor:  LUXURY.colors.pearl,
    // maxHeight set inline (responsive to live window height)
  },
  headerBar: {
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: card.paddingHorizontal,
    paddingTop: SPACING.md,
    backgroundColor: LUXURY.colors.pearl,
  },
  headerSpacer: {
    flex: 1,
  },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  closeButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    textTransform: 'none',
  },
  cardInner: {
    backgroundColor:   LUXURY.colors.pearl,
    paddingHorizontal: card.paddingHorizontal,
    paddingTop:        SPACING.sm,
    paddingBottom:     card.paddingVertical,
  },
  grip: {
    alignSelf:       'center',
    width:           card.gripWidth,
    height:          card.gripHeight,
    borderRadius:    RADIUS.pill,
    backgroundColor: LUXURY.colors.border,
    marginBottom:    SPACING.lg,
  },
  categoryLabel: {
    ...LUXURY.typography.sectionLabel,
    marginBottom:  SPACING.xs,
  },
  headline: {
    ...LUXURY.typography.displayTitle,
    marginTop: SPACING.xs,
  },
  body: {
    ...LUXURY.typography.body,
    marginTop: SPACING.lg,
  },
  // Mirrors the StyleChat bubble's report affordance so the two AI surfaces
  // present the same control rather than inventing a second visual language.
  reportBtn: {
    marginTop: SPACING.sm,
    alignSelf: 'flex-start',
    paddingVertical: SPACING.xs,
    minHeight: 32,
    justifyContent: 'center',
  },
  reportText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
    letterSpacing: 0.6,
    textDecorationLine: 'underline',
  },
  matchSummary: {
    marginTop: SPACING.lg,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.cream,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  matchSummaryLabel: {
    ...LUXURY.typography.caption,
    marginBottom: SPACING.xs,
  },
  matchSummaryValue: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           SPACING.sm,
    marginTop:     SPACING.xl,
  },
  guidanceBox: {
    marginTop: SPACING.xl,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.cream,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  guidanceTitle: {
    ...LUXURY.typography.caption,
    marginBottom: SPACING.xs,
  },
  guidanceText: {
    ...LUXURY.typography.body,
    fontSize: 13,
  },
  emptyState: {
    marginTop: SPACING.xl,
    alignItems: 'center',
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.cream,
    padding: SPACING.lg,
  },
  noMatchNote: {
    ...LUXURY.typography.bodyStrong,
    textAlign:     'center' as const,
    color: LUXURY.colors.ink,
  },
  noMatchSub: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center' as const,
    marginTop: SPACING.sm,
    color: LUXURY.colors.graphite,
  },
  scanRoomCta: {
    width: '100%',
    minHeight: 52,
    borderRadius: RADIUS.pill,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.gold,
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: SPACING.xl,
  },
  scanRoomCtaText: {
    ...LUXURY.typography.ctaSecondary,
    textAlign: 'center',
  },
  scanRoomCtaDisabled: {
    borderColor: LUXURY.colors.border,
    opacity: 0.6,
    gap: 2,
  },
  scanRoomCtaTextDisabled: {
    color: LUXURY.colors.stone,
  },
  scanRoomCtaReasonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    textAlign: 'center',
  },
  candidatePanel: {
    marginTop: SPACING.lg,
    gap: SPACING.sm,
  },
  candidateEyebrow: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 10,
    letterSpacing: 2.2,
    color: LUXURY.colors.goldBrushed,
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
  cta: {
    width:          '100%',
    minHeight:      card.ctaMinHeight,
    borderRadius:   RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    justifyContent: 'center',
    alignItems:     'center',
    marginTop:      SPACING.xl,
    ...SHADOWS.editorialSmall,
  },
  ctaText: {
    ...LUXURY.typography.cta,
    textAlign: 'center',
  },
});
