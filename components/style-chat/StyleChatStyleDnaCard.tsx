import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
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

export function StyleChatStyleDnaCard({
  summary,
  summaryText,
  loading = false,
  resetting = false,
  onReset,
}: StyleChatStyleDnaCardProps) {
  const totalSignals = summary?.totalSignals ?? 0;
  const hasSignals = totalSignals > 0;
  const ratioLabel = formatRatio(summary);

  return (
    <View style={styles.card} testID="style-chat-style-dna-card">
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

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
          <Text style={styles.loadingText}>Loading local profile…</Text>
        </View>
      ) : hasSignals && summary ? (
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
            : 'Once you react to a few replies, this card will summarize what has resonated locally.' )}
      </Text>

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
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: SPACING.xl,
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
    padding: SPACING.lg,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.warmWhite,
    ...SHADOWS.editorialSmall,
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
    marginTop: SPACING.sm,
  },
  body: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  loadingText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
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
  resetButton: {
    minHeight: 40,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    marginTop: SPACING.md,
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
});
