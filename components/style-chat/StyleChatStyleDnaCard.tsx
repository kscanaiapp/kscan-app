import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { STYLE_MEMORY_COPY } from '../../constants/elise';
import type { LocalStyleDnaProfileSummary } from '../../services/style-dna/localStyleDnaProfile';

interface StyleChatStyleDnaCardProps {
  summary: LocalStyleDnaProfileSummary | null;
  summaryText?: string | null;
  loading?: boolean;
  resetting?: boolean;
  learnFromFeedback?: boolean;
  onReset?: () => void;
}

function formatRatio(summary: LocalStyleDnaProfileSummary | null): string | null {
  if (!summary || summary.helpfulRatio == null) return null;
  return `${Math.round(summary.helpfulRatio * 100)}% helpful`;
}

// Compact collapsed status row (default) + on-demand details sheet. Keeps the chat
// window visible: the row is a quiet utility band, and full stats/reset live behind a
// tap in a modal sheet so Style Memory supports the conversation rather than replacing it.
export function StyleChatStyleDnaCard({
  summary,
  summaryText,
  loading = false,
  resetting = false,
  learnFromFeedback = true,
  onReset,
}: StyleChatStyleDnaCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const totalSignals = summary?.totalSignals ?? 0;
  const hasSignals = totalSignals > 0;
  const ratioLabel = formatRatio(summary);

  const progressLabel = hasSignals
    ? totalSignals <= 2
      ? 'Learning'
      : totalSignals <= 5
        ? 'Emerging'
        : 'Established'
    : null;
  const collapsedLabel = loading
    ? STYLE_MEMORY_COPY.onDeviceLabel
    : hasSignals && progressLabel
      ? `Signature Style · ${progressLabel} · On-device`
      : learnFromFeedback
        ? STYLE_MEMORY_COPY.learningLabel
        : 'Signature Style learning is off';

  return (
    <>
      <Pressable
        style={styles.row}
        testID="style-chat-style-dna-card"
        onPress={() => setDetailsOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={STYLE_MEMORY_COPY.detailsAccessibilityLabel}
        accessibilityHint={STYLE_MEMORY_COPY.detailsHint}
        hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
      >
        <View style={styles.rowLeft}>
          {loading ? <ActivityIndicator size="small" color={LUXURY.colors.plum} /> : null}
          <Text style={styles.rowLabel} numberOfLines={1}>
            {collapsedLabel}
          </Text>
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.detailsText}>Details</Text>
          <Text style={styles.chevron}>›</Text>
        </View>
      </Pressable>

      <Modal
        visible={detailsOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setDetailsOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setDetailsOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <View style={styles.headerRow}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{STYLE_MEMORY_COPY.localBadge}</Text>
              </View>
              <Text style={styles.privacyText}>On this device only</Text>
            </View>

            <Text style={styles.title}>
              {hasSignals ? 'Elise is learning your Signature Style.' : 'Your Signature Style is just getting started.'}
            </Text>

            <Text style={styles.body}>
              {hasSignals
                ? 'Signature Style evolves as Elise learns from what you scan, save, wear, and love.'
                : 'Your Signature Style helps Elise recommend outfits, discover complementary pieces, and understand your personal aesthetic over time.'}
            </Text>

            {!learnFromFeedback && !hasSignals ? (
              <Text style={styles.body}>
                Turn on &quot;Learn from my feedback&quot; in Settings to let Elise build a local
                Signature Style from your taps.
              </Text>
            ) : null}

            {hasSignals && summary ? (
              <View style={styles.statsWrap}>
                <View style={styles.statChip}>
                  <Text style={styles.statValue}>{summary.helpfulCount}</Text>
                  <Text style={styles.statLabel}>Helpful</Text>
                </View>
                <View style={styles.statChip}>
                  <Text style={styles.statValue}>{summary.notMyStyleCount}</Text>
                  <Text style={styles.statLabel}>Not my style</Text>
                </View>
                <View style={styles.statChip}>
                  <Text style={styles.statValue}>{summary.sessionsWithFeedback}</Text>
                  <Text style={styles.statLabel}>Sessions</Text>
                </View>
                {ratioLabel ? (
                  <View style={[styles.statChip, styles.statChipAccent]}>
                    <Text style={styles.statValue}>{ratioLabel}</Text>
                    <Text style={styles.statLabel}>Signal mix</Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            <Text style={styles.microcopy}>
              {summaryText ??
                (hasSignals
                  ? 'Signature Style stays light-touch and private: it learns from your feedback without storing message text or inventing preferences.'
                  : 'Tap Helpful or Not my style on replies and your Signature Style will begin to reflect what resonates with you.')}
            </Text>

            <View style={styles.sheetActions}>
              <Pressable
                onPress={onReset}
                disabled={!hasSignals || resetting}
                style={({ pressed }) => [
                  styles.resetButton,
                  (!hasSignals || resetting) ? styles.resetButtonDisabled : null,
                  pressed && hasSignals && !resetting ? styles.resetButtonPressed : null,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Reset local Signature Style signals"
                accessibilityHint="Clears device-local Helpful and Not my style feedback for this account on this device"
                accessibilityState={{ disabled: !hasSignals || resetting, busy: resetting }}
              >
                {resetting ? (
                  <ActivityIndicator size="small" color={LUXURY.colors.error} />
                ) : (
                  <Text style={[styles.resetText, !hasSignals ? styles.resetTextDisabled : null]}>
                    Reset local signals
                  </Text>
                )}
              </Pressable>
              <Pressable
                onPress={() => setDetailsOpen(false)}
                style={({ pressed }) => [styles.doneButton, pressed ? styles.doneButtonPressed : null]}
                accessibilityRole="button"
                accessibilityLabel="Close Signature Style details"
              >
                <Text style={styles.doneText}>Done</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // Compact collapsed row. Hit slop preserves a >= 48dp touch target.
  row: {
    minHeight: 36,
    maxHeight: 40,
    marginHorizontal: SPACING.xl,
    marginTop: SPACING.xs,
    marginBottom: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: 'transparent',
  },
  rowLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingRight: SPACING.xs,
  },
  rowLabel: {
    ...LUXURY.typography.caption,
    flexShrink: 1,
    minWidth: 0,
    fontSize: 11,
    letterSpacing: 0.4,
    color: LUXURY.colors.stone,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  detailsText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 0.4,
    color: LUXURY.colors.graphite,
    fontWeight: '500',
  },
  chevron: {
    fontSize: 15,
    lineHeight: 16,
    color: LUXURY.colors.graphite,
    marginTop: -1,
  },
  // Details sheet
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20, 16, 12, 0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xxl,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    backgroundColor: LUXURY.colors.warmWhite,
    ...SHADOWS.editorialSmall,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: LUXURY.colors.hairline,
    marginBottom: SPACING.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.sm,
    paddingVertical: 4,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    backgroundColor: 'rgba(198, 161, 91, 0.10)',
  },
  badgeText: {
    ...LUXURY.typography.caption,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.8,
    color: LUXURY.colors.goldText,
  },
  privacyText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    letterSpacing: 0.6,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 15,
    color: LUXURY.colors.ink,
    marginTop: SPACING.md,
  },
  body: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
  },
  statsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  statChip: {
    minWidth: 88,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.ivory,
  },
  statChipAccent: {
    borderColor: 'rgba(198, 161, 91, 0.35)',
    backgroundColor: 'rgba(198, 161, 91, 0.08)',
  },
  statValue: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    color: LUXURY.colors.plumDeep,
  },
  statLabel: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    marginTop: 2,
    letterSpacing: 0.4,
  },
  microcopy: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    lineHeight: 15,
    marginTop: SPACING.md,
  },
  sheetActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACING.lg,
  },
  resetButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  resetButtonDisabled: {
    opacity: 0.45,
  },
  resetButtonPressed: {
    opacity: 0.68,
  },
  resetText: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    color: LUXURY.colors.error,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  resetTextDisabled: {
    color: LUXURY.colors.stone,
  },
  doneButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
  },
  doneButtonPressed: {
    opacity: 0.7,
  },
  doneText: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    color: LUXURY.colors.plum,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
});
