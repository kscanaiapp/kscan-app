/**
 * ScanResultCard (Part 2 activation).
 *
 * A lightweight result card that renders a ResultCardViewModel derived from a
 * ScanResultObject. It does NOT replace AnalysisCard or ProductShelf — it is an
 * additive summary card rendered above the product shelf.
 *
 * Save reuses the EXISTING Dressing Room save UX (`AddToRoomModal` from
 * ProductShelf → `addProductToDressingRoom`). No duplicate modal, no parallel
 * save system. Share is text-only via React Native's built-in `Share` API.
 * Compare is intentionally a disabled affordance — there is no safe source of a
 * second ScanResultObject yet (COMPARE deferred).
 *
 * PRIVACY: the hero image and any product link come only from catalog/product
 * match data on the ScanResultObject; no raw/local/captured scan image is ever
 * rendered or shared.
 */

import React, { useState } from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity, Share } from 'react-native';
import { LUXURY, RADIUS, SPACING, SHADOWS } from '../../constants/theme';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { AddToRoomModal, canAddProductToDressingRoom, type Product } from '../ProductShelf';
import { createResultCardViewModel, buildScanShareMessage } from '../../services/scanResultObject';
import type { ScanResultObject } from '../../types/scanResultObject';

export interface ScanResultCardProps {
  scanResultObject: ScanResultObject;
  /**
   * Optional second result to enable Compare. Until a safe saved-scan source
   * exists this stays undefined and Compare renders disabled.
   */
  compareSource?: ScanResultObject | null;
}

const CONFIDENCE_COPY: Record<string, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  exploratory: 'Exploratory',
};

export function ScanResultCard({ scanResultObject, compareSource = null }: ScanResultCardProps) {
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const { isAuthenticated } = useAuthSession();
  const dressingRoomsEnabled = !featureFreezeLoading && isFeatureEnabled('dressingRooms');
  const [saveModalVisible, setSaveModalVisible] = useState(false);

  const vm = createResultCardViewModel(scanResultObject);
  const primaryMatch = (vm.primaryMatch as Product | null) ?? null;
  const canSave =
    isAuthenticated && dressingRoomsEnabled && !!primaryMatch && canAddProductToDressingRoom(primaryMatch);
  const compareAvailable = !!compareSource;

  const handleShare = async () => {
    const message = buildScanShareMessage(scanResultObject);
    if (!message) return;
    try {
      await Share.share({ message });
    } catch {
      // User cancelled or share unavailable — no-op, never surface raw data.
    }
  };

  return (
    <View testID="scan-result-card" style={styles.card}>
      <Text style={styles.sectionLabel}>SIGNATURE STYLE</Text>

      {vm.heroImageUrl ? (
        <Image
          testID="scan-result-card-hero"
          source={{ uri: vm.heroImageUrl }}
          style={styles.hero}
          resizeMode="cover"
        />
      ) : (
        <View style={styles.heroFallback}>
          <Text style={styles.heroFallbackLabel}>{vm.heroFallbackLabel}</Text>
          <Text style={styles.heroFallbackText}>Catalog image still learning</Text>
        </View>
      )}

      <View style={styles.qualityRow}>
        <View style={styles.qualityPill}>
          <Text style={styles.qualityText}>{vm.matchQualityLabel}</Text>
        </View>
        <Text style={styles.resultType}>{vm.resultType.toUpperCase()}</Text>
      </View>

      <Text testID="scan-result-card-title" style={styles.title}>
        {vm.title}
      </Text>
      <Text style={styles.subtitle}>{vm.subtitle}</Text>

      <View style={styles.metaRow}>
        <View style={styles.confidencePill}>
          <Text style={styles.confidenceText}>
            {CONFIDENCE_COPY[vm.confidenceLabel] ?? 'Exploratory'}
          </Text>
        </View>
        <Text style={styles.matchCount}>
          {vm.matchCount > 0
            ? `${vm.matchCount} ${vm.matchCount === 1 ? 'match' : 'matches'}`
            : 'No matches yet'}
        </Text>
      </View>

      {vm.badges.length > 0 ? (
        <View style={styles.badgeRow}>
          {vm.badges.map((badge, i) => (
            <View key={`${badge}-${i}`} style={styles.badge}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.reasonBlock}>
        <Text style={styles.blockTitle}>Why this matched</Text>
        <Text style={styles.blockBody}>{vm.primaryReason}</Text>
        {vm.secondaryReasons.map((reason, i) => (
          <Text key={`${reason}-${i}`} style={styles.reasonLine}>
            {reason}
          </Text>
        ))}
      </View>

      {vm.signalsFound.length > 0 ? (
        <View style={styles.signalsBlock}>
          <Text style={styles.blockTitle}>Signals found</Text>
          <View style={styles.signalGrid}>
            {vm.signalsFound.map((signal) => (
              <View key={signal.label} style={styles.signalItem}>
                <Text style={styles.signalLabel}>{signal.label}</Text>
                <Text style={styles.signalValue} numberOfLines={2}>{signal.value}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {vm.missingSignals.length > 0 ? (
        <View style={styles.learningBlock}>
          <Text style={styles.blockTitle}>Still learning</Text>
          <Text style={styles.blockBody}>
            A clearer brand, product name, or catalog image would raise match confidence.
          </Text>
        </View>
      ) : null}

      {vm.matchCount === 0 ? (
        <Text style={styles.emptyMatchMessage}>{vm.emptyMatchMessage}</Text>
      ) : null}

      <Text style={styles.privacyCaption}>{vm.privacyCaption}</Text>

      {/* Action row */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          testID="scan-result-card-save"
          style={[styles.actionButton, styles.savePrimary, !canSave ? styles.actionDisabled : null]}
          onPress={() => canSave && setSaveModalVisible(true)}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave }}
          accessibilityLabel="Save to a Dressing Room"
        >
          <Text style={[styles.saveText, !canSave ? styles.actionDisabledText : null]}>Save</Text>
        </TouchableOpacity>

        <TouchableOpacity
          testID="scan-result-card-share"
          style={[styles.actionButton, styles.actionSecondary]}
          onPress={handleShare}
          accessibilityRole="button"
          accessibilityLabel="Share this style"
        >
          <Text style={styles.secondaryText}>Share</Text>
        </TouchableOpacity>

        <TouchableOpacity
          testID="scan-result-card-compare"
          style={[styles.actionButton, styles.actionSecondary, !compareAvailable ? styles.actionDisabled : null]}
          disabled={!compareAvailable}
          accessibilityRole="button"
          accessibilityState={{ disabled: !compareAvailable }}
          accessibilityLabel="Compare with another scan"
        >
          <Text style={[styles.secondaryText, !compareAvailable ? styles.actionDisabledText : null]}>
            Compare
          </Text>
        </TouchableOpacity>
      </View>

      {!canSave ? (
        <Text style={styles.helperText}>
          {isAuthenticated
            ? 'Save unlocks after a safe catalog match is found.'
            : 'Create an account to save this scan to your Signature Style.'}
        </Text>
      ) : (
        <Text style={styles.helperText}>{vm.cardCtaLabel}</Text>
      )}
      {!compareAvailable ? (
        <Text style={styles.helperText}>Compare unlocks after another saved scan.</Text>
      ) : null}

      {dressingRoomsEnabled && canSave ? (
        <AddToRoomModal
          product={primaryMatch}
          visible={saveModalVisible}
          onClose={() => setSaveModalVisible(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: SPACING.xl,
    padding: SPACING.lg,
    borderRadius: RADIUS.lg,
    backgroundColor: LUXURY.colors.warmWhite,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    ...SHADOWS.editorialSmall,
  },
  sectionLabel: {
    ...LUXURY.typography.sectionLabel,
    marginBottom: SPACING.sm,
  },
  hero: {
    width: '100%',
    height: 168,
    borderRadius: RADIUS.md,
    marginBottom: SPACING.md,
    backgroundColor: LUXURY.colors.cream,
  },
  heroFallback: {
    width: '100%',
    minHeight: 132,
    borderRadius: RADIUS.md,
    marginBottom: SPACING.md,
    backgroundColor: LUXURY.colors.cream,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
  },
  heroFallbackLabel: {
    ...LUXURY.typography.displayTitle,
    fontSize: 20,
    textAlign: 'center',
    color: LUXURY.colors.plum,
  },
  heroFallbackText: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.xs,
    color: LUXURY.colors.stone,
    textAlign: 'center',
  },
  qualityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  qualityPill: {
    flexShrink: 1,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plumMuted,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  qualityText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
  },
  resultType: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldText,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    fontSize: 24,
  },
  subtitle: {
    ...LUXURY.typography.body,
    marginTop: SPACING.xs,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACING.md,
  },
  confidencePill: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.cream,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  confidenceText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
  },
  matchCount: {
    ...LUXURY.typography.caption,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  badge: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.champagne,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  badgeText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  reasonBlock: {
    marginTop: SPACING.lg,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.pearl,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  blockTitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    marginBottom: SPACING.xs,
  },
  blockBody: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 19,
    color: LUXURY.colors.graphite,
  },
  reasonLine: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.xs,
    color: LUXURY.colors.stone,
  },
  signalsBlock: {
    marginTop: SPACING.md,
  },
  signalGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  signalItem: {
    width: '48%',
    minHeight: 62,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.cream,
    padding: SPACING.sm,
    justifyContent: 'center',
  },
  signalLabel: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
  },
  signalValue: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    lineHeight: 18,
    color: LUXURY.colors.ink,
    marginTop: SPACING.xxs,
  },
  learningBlock: {
    marginTop: SPACING.md,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.champagne,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
  },
  emptyMatchMessage: {
    ...LUXURY.typography.bodyStrong,
    marginTop: SPACING.md,
    color: LUXURY.colors.plum,
  },
  privacyCaption: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    marginTop: SPACING.md,
    color: LUXURY.colors.stone,
  },
  actionRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginTop: SPACING.lg,
  },
  actionButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: RADIUS.pill,
    justifyContent: 'center',
    alignItems: 'center',
  },
  savePrimary: {
    backgroundColor: LUXURY.colors.plum,
    ...SHADOWS.editorialSmall,
  },
  actionSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: LUXURY.colors.plum,
  },
  actionDisabled: {
    backgroundColor: LUXURY.colors.cream,
    borderColor: LUXURY.colors.border,
    opacity: 0.7,
  },
  actionDisabledText: {
    color: LUXURY.colors.stone,
  },
  saveText: {
    ...LUXURY.typography.cta,
    color: LUXURY.colors.inverse,
  },
  secondaryText: {
    ...LUXURY.typography.ctaSecondary,
  },
  helperText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    marginTop: SPACING.sm,
    color: LUXURY.colors.stone,
  },
});
