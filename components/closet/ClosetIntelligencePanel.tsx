// Closet Intelligence V1 — the surface (PR B, sections 57/58/66).
//
// TWO TIERS, AND THE SPLIT IS DELIBERATE (section 57):
//
//   CORE / FREE      total item count, category counts, review count.
//                    Basic wardrobe management. "42 items" is not a premium
//                    feature and must never become one.
//
//   K+               coverage and completeness analysis, recent inventory
//                    patterns, metadata-quality insight, conservative duplicate
//                    candidates.
//
// ENTITLEMENT ORDER (section 66): FEATURE STATE -> ENTITLEMENT RESOLUTION ->
// INTELLIGENCE ACCESS. RESOLVING is not LOCKED: while the authority has not
// answered, the K+ section renders a neutral loading state — no paywall, no
// pitch, no locked claim.
//
// NO COMMERCE LANGUAGE (section 11). This build has no Closet purchase path, so
// the words Subscribe / Upgrade / Buy / Price / Renew / Purchase appear nowhere
// here. A non-entitled actor is offered the existing shared K+ Early Access
// surface through KPlusGate, in availability language.

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { KPlusGate } from '../kplus/KPlusGate';
import { LUXURY, SPACING, FONTS } from '../../constants/theme';
import {
  describeCategory,
  describeCoverage,
  type ClosetIntelligence,
} from '../../services/closet/closetIntelligence';

/** Field labels, in the sentence form describeCoverage expects. */
const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  brand: 'a brand',
  primaryColor: 'a main colour',
  clothingType: 'a type',
  subtype: 'a style',
  material: 'a material',
  secondaryColors: 'other colours',
  size: 'a size',
});

function Row({ text, testID }: { text: string; testID?: string }) {
  return (
    <Text style={styles.row} testID={testID} accessibilityRole="text">
      {text}
    </Text>
  );
}

export interface ClosetIntelligencePanelProps {
  intelligence: ClosetIntelligence;
}

export function ClosetIntelligencePanel({ intelligence }: ClosetIntelligencePanelProps) {
  // Section 24: no analytics over an empty Closet. There is nothing true to say
  // about a wardrobe with no records in it.
  if (intelligence.totalItems === 0) return null;

  const topCategories = intelligence.categoryCounts.slice(0, 4);

  return (
    <View style={styles.root} testID="closet-intelligence-panel">
      <Text style={styles.heading}>Your Closet at a glance</Text>

      {/* CORE / FREE — basic wardrobe management, never gated. */}
      <View testID="closet-intelligence-core">
        <Row
          testID="closet-intelligence-total"
          text={
            intelligence.totalItems === 1
              ? 'You have 1 item in K Scan AI.'
              : `You have ${intelligence.totalItems} items in K Scan AI.`
          }
        />
        {topCategories.map((entry) => (
          <Row key={entry.value} text={describeCategory(entry)} />
        ))}
        {intelligence.reviewRequiredCount > 0 ? (
          <Row
            testID="closet-intelligence-review-count"
            text={
              intelligence.reviewRequiredCount === 1
                ? '1 item could use a quick review.'
                : `${intelligence.reviewRequiredCount} items could use a quick review.`
            }
          />
        ) : null}
      </View>

      {/* K+ — richer derived structure. */}
      <KPlusGate source="closet_intelligence">
        {({ state, isActive, openUpgrade }) => {
          // RESOLVING IS NOT INACTIVE (section 12). No pitch, no lock, no claim
          // — a neutral placeholder until the authority answers.
          if (state === 'loading') {
            return (
              <View style={styles.kplus} testID="closet-intelligence-kplus-resolving">
                <Text style={styles.muted}>Checking your K+ status…</Text>
              </View>
            );
          }

          if (!isActive) {
            return (
              <View style={styles.kplus}>
                <Text style={styles.muted} testID="closet-intelligence-unavailable">
                  Closet Intelligence isn&apos;t currently available on this account.
                </Text>
                <TouchableOpacity
                  onPress={openUpgrade}
                  testID="closet-intelligence-learn-more"
                  accessibilityRole="button"
                  accessibilityLabel="Learn more about K Plus"
                  style={styles.learnMore}
                >
                  <Text style={styles.learnMoreText}>Learn more</Text>
                </TouchableOpacity>
              </View>
            );
          }

          return (
            <View style={styles.kplus} testID="closet-intelligence-kplus">
              <Row
                testID="closet-intelligence-classification-coverage"
                text={describeCoverage(intelligence.classificationCoverage, 'a category')}
              />
              {/* Only fields with credible coverage are stated at all
                  (section 60). A "favourite brand" derived from three records
                  out of two hundred would be a confident claim about a biased
                  sample, so a below-floor field is reported as coverage — a
                  fact about the data — and never as an insight about taste. */}
              {intelligence.fieldCoverage
                .filter((entry) => entry.populated > 0)
                .slice(0, 3)
                .map((entry) => (
                  <Row
                    key={entry.field}
                    testID={`closet-intelligence-coverage-${entry.field}`}
                    text={describeCoverage(entry, FIELD_LABELS[entry.field] ?? entry.field)}
                  />
                ))}
              {intelligence.recentlyAddedCount > 0 ? (
                <Row
                  testID="closet-intelligence-recent"
                  text={`${intelligence.recentlyAddedCount} added in the last ${intelligence.recentlyAddedWindowDays} days.`}
                />
              ) : null}
              {intelligence.unclassifiedItems > 0 ? (
                <Row
                  testID="closet-intelligence-unclassified"
                  text={`${intelligence.unclassifiedItems} of your K Scan AI Closet items have no structured details yet.`}
                />
              ) : null}
            </View>
          );
        }}
      </KPlusGate>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginHorizontal: SPACING.lg,
    marginBottom: SPACING.md,
    padding: SPACING.md,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.warmWhite,
    gap: SPACING.xs,
  },
  heading: {
    fontFamily: FONTS.serif,
    fontSize: 16,
    color: LUXURY.colors.ink,
    marginBottom: SPACING.xs,
  },
  row: { fontFamily: FONTS.sans, fontSize: 13, color: LUXURY.colors.graphite, lineHeight: 20 },
  kplus: {
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: LUXURY.colors.border,
    gap: SPACING.xs,
  },
  muted: { fontFamily: FONTS.sans, fontSize: 13, color: LUXURY.colors.stone },
  learnMore: { paddingVertical: SPACING.xs, alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  learnMoreText: { fontFamily: FONTS.sans, fontSize: 13, color: LUXURY.colors.plum },
});
