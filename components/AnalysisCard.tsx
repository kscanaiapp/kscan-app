import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
  Animated,
  Dimensions,
  PanResponder,
  Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MetadataChip } from './MetadataChip';
import { ProductShelf, type Product } from './ProductShelf';
import { PurchaseOptionsPanel } from './scan-results/PurchaseOptionsPanel';
import type { PurchaseOption } from './scan-results/types';
import { ScanResultCard } from './scan/ScanResultCard';
import { SecondhandShelf } from './SecondhandShelf';
import { SneakerMatchCard } from './SneakerMatchCard';
import { useFeatureFreeze } from '../hooks/useFeatureFreeze';
import { normalizePurchaseOptions } from '../services/purchaseOptions';
import { reportAiOutput } from '../services/reportAiOutput';
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
import { useReducedMotion } from '../hooks/useReducedMotion';
import type { VintedSecondhandSearchResponse } from '../types/scan';
import type { SneakerReference } from '../services/sneakers/types';
import type { ScanResultObject } from '../types/scanResultObject';
import { SavedItemUtilityPanel } from './free-tier/SavedItemUtilityPanel';
import { normalizeItem, normalizeItems } from '../services/free-tier/itemNormalization';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const FROM_Y     = SCREEN_HEIGHT * 0.36;
const EMPTY_VALUE = '—';

function formatPersistedPrice(price: number, currency: unknown): string {
  const code = typeof currency === 'string' && currency.trim()
    ? currency.trim().toUpperCase()
    : 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(price);
  } catch {
    return `${code} ${price.toFixed(2)}`;
  }
}

function toPurchaseOptions(value: unknown): PurchaseOption[] {
  return normalizePurchaseOptions(value)
    .map((raw, index) => {
      const option = raw as Record<string, unknown>;
      const productUrl = typeof option.productUrl === 'string'
        ? option.productUrl
        : undefined;
      const priceLabel = typeof option.priceLabel === 'string'
        ? option.priceLabel
        : typeof option.price === 'string'
        ? option.price
        : typeof option.price === 'number' && Number.isFinite(option.price)
        ? formatPersistedPrice(option.price, option.currency)
        : undefined;
      return {
        id: String(option.id ?? `purchase-${index}`),
        retailer:
          typeof option.retailer === 'string'
            ? option.retailer
            : 'Retailer',
        title:
          typeof option.title === 'string'
            ? option.title
            : typeof option.name === 'string'
            ? option.name
            : undefined,
        priceLabel,
        availabilityLabel:
          typeof option.availabilityLabel === 'string'
            ? option.availabilityLabel
            : undefined,
        productUrl,
      };
    });
}

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
  /** Persisted or live commerce snapshot — distinct from catalog products. */
  purchaseOptions?: Product[] | PurchaseOption[] | unknown[];
  /**
   * v127 (P1-B): deferred commerce lifecycle. Undefined/'idle' leaves this
   * panel's visibility exactly as it behaves without this prop — hidden when
   * `purchaseOptions` is empty. 'pending'/'error' additionally show the panel
   * (with its own pending/error treatment) only while still empty; once any
   * options arrive the panel renders them and this status is moot.
   */
  commerceStatus?: 'idle' | 'pending' | 'success' | 'empty' | 'error';
  /** Present only when a failed deferred fetch is retryable. */
  onRetryCommerce?: () => void;
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
 * Whether the "MATCHING PRODUCTS" panel renders at all. Pulled out of the
 * JSX branch so this exact precedence is independently testable. Options in
 * hand always win, regardless of status; pending, error, and a completed
 * zero-result search each render the panel with their own treatment.
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
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const priceDiscoveryEnabled = !featureFreezeLoading && isFeatureEnabled('priceDiscovery');
  const resaleValuationEnabled = !featureFreezeLoading && isFeatureEnabled('resaleValuation');
  const commerceOptions = toPurchaseOptions(purchaseOptions);
  const purchaseShelfMode = resolvePurchaseShelfMode(
    commerceOptions.length,
    priceDiscoveryEnabled,
    commerceStatus,
  );
  const reducedMotion = useReducedMotion();
  const translateY    = useRef(new Animated.Value(FROM_Y)).current;
  const opacity       = useRef(new Animated.Value(0)).current;
  const chip1Opacity  = useRef(new Animated.Value(0)).current;
  const chip2Opacity  = useRef(new Animated.Value(0)).current;
  const chip3Opacity  = useRef(new Animated.Value(0)).current;
  const isExiting     = useRef(false);

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
    isExiting.current = false;

    if (reducedMotion) {
      // Reduced motion: no entrance or chip stagger animation.
      translateY.setValue(0);
      opacity.setValue(1);
      chip1Opacity.setValue(1);
      chip2Opacity.setValue(1);
      chip3Opacity.setValue(1);
      return;
    }

    translateY.setValue(FROM_Y);
    opacity.setValue(0);
    chip1Opacity.setValue(0);
    chip2Opacity.setValue(0);
    chip3Opacity.setValue(0);

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
  }, [translateY, opacity, chip1Opacity, chip2Opacity, chip3Opacity, reducedMotion]);

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
  const isLibraryScan = scanSourceType === 'style_library_scan';

  return (
    <Modal transparent animationType="none" onRequestClose={runExit}>
      <View style={styles.backdrop} pointerEvents="box-none">
        <Animated.View
          testID="analysis-card"
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
          {/* Subtle gold glow behind card */}
          <View style={styles.glow} pointerEvents="none" />

          <View style={styles.card}>
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
                  onPress={() => reportAiOutput('Scan Results', { itemId: scanSourceId ?? null })}
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

              {onAddToDressingRoom ? (
                <TouchableOpacity
                  style={styles.scanRoomCta}
                  onPress={onAddToDressingRoom}
                  activeOpacity={0.86}
                  accessibilityRole="button"
                  accessibilityLabel="Add this scan to a Dressing Room"
                >
                  <Text style={styles.scanRoomCtaText}>Add Scan to Dressing Room</Text>
                </TouchableOpacity>
              ) : addToDressingRoomUnavailableReason ? (
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

              {onAddToCloset ? (
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

              {onAskStyleChat ? (
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

              {/* Catalog similarity matches: hide the entire section unless there
                  are at least 2 meaningful matches. */}
              {priceDiscoveryEnabled && products.length >= 2 ? (
                <ProductShelf products={products} />
              ) : null}

              {/* Persisted/live commerce options — same panel contract as ScanResultV2. */}
              {purchaseShelfMode === 'options' ? (
                <PurchaseOptionsPanel purchaseOptions={commerceOptions} />
              ) : purchaseShelfMode === 'pending' || purchaseShelfMode === 'error' || purchaseShelfMode === 'empty' ? (
                // A completed zero-result search is a real answer, not the
                // same as "never checked" — it still mounts the panel so its
                // governed empty state renders instead of nothing at all.
                <PurchaseOptionsPanel
                  purchaseOptions={[]}
                  commerceStatus={purchaseShelfMode}
                  onRetry={onRetryCommerce}
                />
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
    maxHeight:        SCREEN_HEIGHT * 0.86,
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
