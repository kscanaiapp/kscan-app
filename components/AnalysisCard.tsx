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
import { ScanResultCard } from './scan/ScanResultCard';
import { SecondhandShelf } from './SecondhandShelf';
import { SneakerMatchCard } from './SneakerMatchCard';
import { useFeatureFreeze } from '../hooks/useFeatureFreeze';
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
import { SavedItemUtilityPanel } from './free-tier/SavedItemUtilityPanel';
import { normalizeItem, normalizeItems } from '../services/free-tier/itemNormalization';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const FROM_Y     = SCREEN_HEIGHT * 0.36;
const EMPTY_VALUE = '—';

export interface AnalysisCardProps {
  result:    string;
  metadata:  {
    category: string;
    color: string;
    silhouette: string;
    confidenceScore?: number;
    scanQualityNote?: string | null;
    stylingSuggestions?: string[];
  };
  products?: Product[];
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
}

function sanitizeText(value?: string) {
  return value?.trim() || EMPTY_VALUE;
}

export function AnalysisCard({
  result,
  metadata,
  products = [],
  scanResultObject,
  secondhand,
  sneakerReference,
  scanImageUri,
  scanSourceId,
  scanSourceType = 'live_scan',
  relatedSavedScans,
  onDismiss,
  onAddToDressingRoom,
}: AnalysisCardProps) {
  const insets = useSafeAreaInsets();
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const priceDiscoveryEnabled = !featureFreezeLoading && isFeatureEnabled('priceDiscovery');
  const resaleValuationEnabled = !featureFreezeLoading && isFeatureEnabled('resaleValuation');
  const translateY    = useRef(new Animated.Value(FROM_Y)).current;
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
    translateY.setValue(FROM_Y);
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
  const confidenceScore = typeof meta.confidenceScore === 'number' ? meta.confidenceScore : undefined;
  const scanQualityNote = meta.scanQualityNote ?? undefined;
  const showLowConfidence = confidenceScore !== undefined && confidenceScore < 0.70;

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

              {/* Match summary */}
              <View style={styles.matchSummary}>
                <Text style={styles.matchSummaryLabel}>K Scan understood:</Text>
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

              {scanImageUri && onAddToDressingRoom ? (
                <TouchableOpacity
                  style={styles.scanRoomCta}
                  onPress={onAddToDressingRoom}
                  activeOpacity={0.86}
                  accessibilityRole="button"
                  accessibilityLabel="Add this scan to a Dressing Room"
                >
                  <Text style={styles.scanRoomCtaText}>Add Scan to Dressing Room</Text>
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

              {resaleValuationEnabled && secondhand?.enabled && secondhand.items.length > 0 ? (
                <SecondhandShelf items={secondhand.items} />
              ) : null}

              {/* Primary CTA */}
              <TouchableOpacity
                style={styles.cta}
                onPress={runExit}
                activeOpacity={0.86}
                accessibilityRole="button"
                accessibilityLabel="Scan another item"
              >
                <Text style={styles.ctaText}>Scan Again</Text>
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
                  context="library"
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
  cardInner: {
    backgroundColor:   LUXURY.colors.pearl,
    paddingHorizontal: card.paddingHorizontal,
    paddingVertical:   card.paddingVertical,
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
