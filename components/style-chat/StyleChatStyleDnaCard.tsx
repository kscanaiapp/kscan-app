import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import type { LocalStyleDnaProfileSummary } from '../../services/style-dna/localStyleDnaProfile';

interface StyleChatStyleDnaCardProps {
  summary: LocalStyleDnaProfileSummary | null;
  summaryText?: string | null;
  loading?: boolean;
  resetting?: boolean;
  onReset?: () => void;
}

function formatRatio(summary: LocalStyleDnaProfileSummary | null): string | null {
  if (!summary || summary.helpfulRatio == null) return null;
  return `${Math.round(summary.helpfulRatio * 100)}% helpful`;
}

// Compact collapsed status row (default) + on-demand details sheet. Keeps the chat
// window visible: the row is a fixed ~48px band, and full stats/reset live behind a
// tap in a modal sheet so Style DNA supports the conversation rather than replacing it.
export function StyleChatStyleDnaCard({
  summary,
  summaryText,
  loading = false,
  resetting = false,
  onReset,
}: StyleChatStyleDnaCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const totalSignals = summary?.totalSignals ?? 0;
  const hasSignals = totalSignals > 0;
  const ratioLabel = formatRatio(summary);

  const collapsedLabel = loading
    ? 'Style DNA · On-device'
    : hasSignals
      ? `Style DNA · ${totalSignals} signal${totalSignals === 1 ? '' : 's'} · On-device`
      : 'Style DNA is learning · Rate a few replies';

  return (
    <>
      <Pressable
        style={styles.row}
        testID="style-chat-style-dna-card"
        onPress={() => setDetailsOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Style DNA details"
        accessibilityHint="Opens your on-device Style DNA summary and reset option"
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
                <Text style={styles.badgeText}>LOCAL STYLE DNA</Text>
              </View>
              <Text style={styles.privacyText}>On this device only</Text>
            </View>

            <Text style={styles.title}>
              {hasSignals ? 'StyleChat is learning from your feedback.' : 'No local style signal yet.'}
            </Text>

            <Text style={styles.body}>
              {hasSignals
                ? 'Helpful and Not my style taps shape a cautious local summary without storing message text.'
                : 'Tap Helpful or Not my style on assistant replies to build a grounded local signal for future chats.'}
            </Text>

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
                  ? 'StyleChat keeps this signal light-touch so it does not invent preferences or overstate personalization.'
                  : 'Once you react to a few replies, this summary will reflect what has resonated locally.')}
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
                accessibilityLabel="Reset local Style DNA signals"
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
                accessibilityLabel="Close Style DNA details"
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
  // Compact collapsed row (enforced ~44–64px band).
  row: {
    minHeight: 44,
    maxHeight: 64,
    marginHorizontal: SPACING.xl,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.warmWhite,
  },
  rowLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingRight: SPACING.sm,
  },
  rowLabel: {
    ...LUXURY.typography.caption,
    flexShrink: 1,
    minWidth: 0,
    fontSize: 12,
    letterSpacing: 0.6,
    color: LUXURY.colors.graphite,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  detailsText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 0.8,
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  chevron: {
    fontSize: 18,
    lineHeight: 18,
    color: LUXURY.colors.plum,
    marginTop: -2,
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
