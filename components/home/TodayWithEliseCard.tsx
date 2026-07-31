/**
 * Build 5 — Today with Elise V1 Home card (presentation only).
 *
 * PURELY VISUAL. It receives an already-committed, already-actor-validated
 * discriminated card state and renders it. It performs no orchestration, reads
 * no store, evaluates no priority, resolves no ownership and creates no
 * session — every one of those lives in services/todayWithElise/** and the
 * Home hook that drives it. Keeping the split absolute is what lets the state
 * machine be tested without a renderer.
 *
 * The bounded loading treatment replaces only this card's body — never Home,
 * and never as a full-screen spinner.
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { TodayCardPresentation } from '../../services/todayWithElise/presentation';
import type { TodayWithEliseCardState } from '../../types/todayWithElise';

export const TODAY_CARD_TEST_IDS = Object.freeze({
  section: 'home-today-with-elise',
  heading: 'home-today-with-elise-heading',
  loading: 'home-today-with-elise-loading',
  body: 'home-today-with-elise-body',
});

/** Section label. Stable across every state so the surface never renames itself. */
export const TODAY_CARD_HEADING = 'TODAY WITH ELISE';

export type TodayWithEliseCardProps = {
  /** Bounded loading treatment while the first generation resolves. */
  loading: boolean;
  card: TodayWithEliseCardState | null;
  presentation: TodayCardPresentation | null;
};

export function TodayWithEliseCard({ loading, card, presentation }: TodayWithEliseCardProps) {
  return (
    <View testID={TODAY_CARD_TEST_IDS.section} style={styles.section}>
      <View style={styles.headerRow}>
        <Text style={styles.sparkle} accessibilityElementsHidden importantForAccessibility="no">
          ✦
        </Text>
        <Text
          testID={TODAY_CARD_TEST_IDS.heading}
          style={styles.heading}
          accessibilityRole="header"
        >
          {TODAY_CARD_HEADING}
        </Text>
      </View>

      {loading || !card || !presentation ? (
        <View
          testID={TODAY_CARD_TEST_IDS.loading}
          style={styles.card}
          accessibilityRole="progressbar"
          accessibilityLabel="Elise is checking your Closet for today."
        >
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
          <Text style={styles.loadingText}>Elise is looking at your Closet…</Text>
        </View>
      ) : (
        <View
          testID={TODAY_CARD_TEST_IDS.body}
          style={styles.cardColumn}
          accessible
          accessibilityLabel={presentation.accessibilityLabel}
        >
          <Text style={styles.headline}>{presentation.headline}</Text>
          <Text style={styles.explanation}>{presentation.explanation}</Text>
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
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
  },
  cardColumn: {
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
  loadingText: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
    flexShrink: 1,
  },
});

export default TodayWithEliseCard;
