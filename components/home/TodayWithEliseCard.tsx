/**
 * Build 5 — Today with Elise V1 Home card (presentation only).
 *
 * PURELY VISUAL. It receives an already-committed, already-actor-validated
 * discriminated card state plus its display projection and renders them. It
 * performs no orchestration, reads no store, evaluates no priority, resolves no
 * ownership and creates no session — every one of those lives in
 * services/todayWithElise/** and the Home hook that drives it. Keeping the
 * split absolute is what lets the state machine be tested without a renderer.
 *
 * ONE RENDERING PATH FOR EVERY STATE. There is no per-state component: each
 * approved state resolves to the same header, the same optional garment row,
 * the same explanation and at most two buttons. A state that offers no runnable
 * action simply has no button, which is how `fallback`, `unauthorized`,
 * `unavailable`, `incompatible` and `stale` render without a dead control.
 *
 * ACCESSIBILITY IS STRUCTURAL, NOT DECORATIVE:
 *   - the section heading is a real `header`, and is the stable focus target a
 *     return from the Dressing Room aims at;
 *   - the garment row is ONE accessible element with a spoken summary, because
 *     swiping through three unlabelled thumbnails tells a screen-reader user
 *     nothing;
 *   - a missing slot is announced as missing, never conveyed by a dashed border
 *     alone;
 *   - nothing is communicated by colour or motion alone — the card has no
 *     animation at all, so reduced-motion changes nothing about what it says.
 *
 * DYNAMIC TYPE: every string is a plain `Text` with no fixed height container
 * and no `numberOfLines` on the explanatory copy, so large text grows the card
 * instead of truncating the sentence that explains what Elise found.
 */

import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { PrimaryButton, SecondaryButton } from '../luxury';
import type { TodayCardPresentation, TodayItemDisplay } from '../../services/todayWithElise/presentation';
import type { TodayWithEliseCardState } from '../../types/todayWithElise';

export const TODAY_CARD_TEST_IDS = Object.freeze({
  section: 'home-today-with-elise',
  heading: 'home-today-with-elise-heading',
  loading: 'home-today-with-elise-loading',
  body: 'home-today-with-elise-body',
  items: 'home-today-with-elise-items',
  missing: 'home-today-with-elise-missing',
  primary: 'home-today-with-elise-primary',
  secondary: 'home-today-with-elise-secondary',
});

/** Section label. Stable across every state so the surface never renames itself. */
export const TODAY_CARD_HEADING = 'TODAY WITH ELISE';

/**
 * The button contract requires a handler. A control rendered without one is
 * ALSO disabled below, so this is unreachable rather than a silent no-op
 * button — but it must exist, because a dead control is worse than none.
 */
const NO_HANDLER = () => {};

export type TodayWithEliseCardProps = {
  /** Bounded loading treatment while the first generation resolves. */
  loading: boolean;
  card: TodayWithEliseCardState | null;
  presentation: TodayCardPresentation | null;
  onPrimaryPress?: () => void;
  onSecondaryPress?: () => void;
  /** True while a handoff is in flight. Disables both controls. */
  busy?: boolean;
  /** Deterministic, bounded failure copy. Never an exception message. */
  actionError?: string | null;
  headingRef?: React.Ref<Text>;
};

/**
 * One garment tile.
 *
 * NEVER BLANK SPACE, and never a broken-image box: a record with no usable
 * image, or an image that fails to decode, falls back to its slot label on a
 * placeholder tile — the same rule the Dressing Room's own thumbnails follow.
 * No fashion photography is invented and no retailer image is substituted.
 */
function TodayItemTile({ item }: { item: TodayItemDisplay }) {
  const [failed, setFailed] = useState(false);
  const onError = useCallback(() => setFailed(true), []);
  const showImage = !!item.imageUri && !failed;

  return (
    <View style={styles.tile}>
      {showImage ? (
        <Image
          source={{ uri: item.imageUri as string }}
          style={styles.tileImage}
          resizeMode="cover"
          onError={onError}
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ) : (
        <View style={styles.tilePlaceholder}>
          <Text style={styles.tilePlaceholderText} numberOfLines={2}>
            {item.slotLabel}
          </Text>
        </View>
      )}
      <Text style={styles.tileCaption} numberOfLines={1}>
        {item.slotLabel}
      </Text>
    </View>
  );
}

/** A slot the Look does not have. Announced, not merely styled. */
function TodayMissingTile({ label }: { label: string }) {
  return (
    <View style={styles.tile}>
      <View style={[styles.tilePlaceholder, styles.tileMissing]}>
        <Text style={styles.tileMissingText} numberOfLines={2}>
          Missing
        </Text>
      </View>
      <Text style={styles.tileCaption} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function TodayWithEliseCard({
  loading,
  card,
  presentation,
  onPrimaryPress,
  onSecondaryPress,
  busy = false,
  actionError = null,
  headingRef,
}: TodayWithEliseCardProps) {
  const showBody = !loading && !!card && !!presentation;
  const hasItems = showBody && presentation.items.length > 0;
  const hasMissing = showBody && presentation.missingSlotLabels.length > 0;

  return (
    <View testID={TODAY_CARD_TEST_IDS.section} style={styles.section}>
      <View style={styles.headerRow}>
        <Text style={styles.sparkle} accessibilityElementsHidden importantForAccessibility="no">
          ✦
        </Text>
        <Text
          ref={headingRef}
          testID={TODAY_CARD_TEST_IDS.heading}
          style={styles.heading}
          accessibilityRole="header"
          accessibilityLabel="Today with Elise"
        >
          {TODAY_CARD_HEADING}
        </Text>
      </View>

      {!showBody ? (
        <View
          testID={TODAY_CARD_TEST_IDS.loading}
          style={styles.loadingCard}
          accessibilityRole="progressbar"
          accessibilityLabel="Elise is checking your Closet for today."
          accessibilityLiveRegion="polite"
        >
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
          <Text style={styles.loadingText}>Elise is looking at your Closet…</Text>
        </View>
      ) : (
        <View testID={TODAY_CARD_TEST_IDS.body} style={styles.card}>
          <Text style={styles.headline}>{presentation.headline}</Text>
          <Text style={styles.explanation}>{presentation.explanation}</Text>

          {hasItems || hasMissing ? (
            <View
              testID={TODAY_CARD_TEST_IDS.items}
              style={styles.tileRow}
              accessible
              accessibilityLabel={presentation.accessibilityLabel}
            >
              {presentation.items.map((item) => (
                <TodayItemTile key={item.closetItemId} item={item} />
              ))}
              {presentation.missingSlotLabels.map((label) => (
                <TodayMissingTile key={`missing-${label}`} label={label} />
              ))}
            </View>
          ) : null}

          {presentation.missingSummary ? (
            <Text testID={TODAY_CARD_TEST_IDS.missing} style={styles.missingSummary}>
              {presentation.missingSummary}
            </Text>
          ) : null}

          {presentation.primaryLabel ? (
            <PrimaryButton
              testID={TODAY_CARD_TEST_IDS.primary}
              title={presentation.primaryLabel}
              onPress={onPrimaryPress ?? NO_HANDLER}
              disabled={busy || !onPrimaryPress}
              loading={busy}
              accessibilityLabel={presentation.primaryLabel}
              style={styles.primaryButton}
              textStyle={styles.primaryButtonText}
            />
          ) : null}

          {presentation.secondaryLabel ? (
            <SecondaryButton
              testID={TODAY_CARD_TEST_IDS.secondary}
              title={presentation.secondaryLabel}
              onPress={onSecondaryPress ?? NO_HANDLER}
              disabled={busy || !onSecondaryPress}
              accessibilityLabel={presentation.secondaryLabel}
              style={styles.secondaryButton}
            />
          ) : null}

          {actionError ? (
            <Text style={styles.actionError} accessibilityRole="alert">
              {actionError}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: SPACING.xxl,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.md,
  },
  sparkle: {
    fontSize: 14,
    color: LUXURY.colors.goldBrushed,
  },
  heading: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.stone,
  },
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
  },
  loadingText: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
    flexShrink: 1,
  },
  card: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  headline: {
    ...LUXURY.typography.displayTitle,
    fontSize: 18,
    color: LUXURY.colors.ink,
  },
  explanation: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
  },
  tileRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  tile: {
    width: 76,
    gap: SPACING.xs,
  },
  tileImage: {
    width: 76,
    height: 92,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.cream,
  },
  tilePlaceholder: {
    width: 76,
    height: 92,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.cream,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
  },
  tilePlaceholderText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
  },
  tileMissing: {
    borderStyle: 'dashed',
    borderColor: LUXURY.colors.stone,
    backgroundColor: LUXURY.colors.ivory,
  },
  tileMissingText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    textAlign: 'center',
  },
  tileCaption: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 0.4,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
  },
  missingSummary: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.ink,
  },
  primaryButton: {
    alignSelf: 'stretch',
    minWidth: 0,
    minHeight: 48,
    marginTop: SPACING.xs,
  },
  primaryButtonText: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.2,
    textTransform: 'none',
    textAlign: 'center',
  },
  secondaryButton: {
    alignSelf: 'stretch',
    minWidth: 0,
    minHeight: 44,
  },
  actionError: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    lineHeight: 17,
    color: LUXURY.colors.error,
  },
});

export default TodayWithEliseCard;
