import React from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Pressable,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import type { StyleChatHandoffContext } from '../../services/style-chat/styleChatHandoffContext';

interface StyleChatContextPreviewProps {
  context: StyleChatHandoffContext;
  onDismiss?: () => void;
}

function sourceLabel(source: StyleChatHandoffContext['source']): string {
  switch (source) {
    case 'camera':
      return 'From Scan';
    case 'upload':
      return 'From Upload';
    case 'text-scan':
      return 'From TextScan';
    default:
      return 'From Scan';
  }
}

export function StyleChatContextPreview({ context, onDismiss }: StyleChatContextPreviewProps) {
  const hasImage = typeof context.imageUri === 'string' && context.imageUri.length > 0;
  const hasQuery = typeof context.query === 'string' && context.query.length > 0;
  const hasAnalysisText = typeof context.analysisText === 'string' && context.analysisText.length > 0;

  const attributes = [
    context.category,
    context.color,
    context.silhouette,
    context.material,
  ].filter((a): a is string => typeof a === 'string' && a.length > 0);

  const descriptors = Array.isArray(context.descriptors)
    ? context.descriptors.filter((d): d is string => typeof d === 'string' && d.length > 0)
    : [];
  const hasDetailSignals = hasImage || hasQuery || hasAnalysisText || attributes.length > 0 || descriptors.length > 0;
  const summaryText = hasQuery
    ? context.query
    : hasAnalysisText
      ? context.analysisText
      : hasDetailSignals
        ? 'Reference details from this item are shown below.'
        : 'Only limited item details are available right now. Ask a broader styling question or rescan for more specifics.';
  const microcopy = hasDetailSignals
    ? 'Keep this reference in view while you chat. If details are missing, Elise may keep the guidance general.'
    : 'This item came through with limited detail, so the next reply may stay broad until you add more context.';

  return (
    <View style={styles.card} testID="style-chat-context-preview">
      {/* Header row with badge and optional dismiss */}
      <View style={styles.headerRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{sourceLabel(context.source)}</Text>
        </View>
        {onDismiss ? (
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss context"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.dismissBtn}
          >
            <Text style={styles.dismissText}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Thumbnail + query/analysis row */}
      <View style={styles.bodyRow}>
        {hasImage ? (
          <Image
            source={{ uri: context.imageUri }}
            style={styles.thumbnail}
            resizeMode="cover"
            accessibilityLabel="Scan context thumbnail"
          />
        ) : null}
        <View style={styles.textCol}>
          <Text style={styles.queryText} numberOfLines={hasDetailSignals ? 3 : 4}>
            {summaryText}
          </Text>
        </View>
      </View>

      {/* Attribute chips — real data only */}
      {attributes.length > 0 || descriptors.length > 0 ? (
        <View style={styles.chipRow}>
          {attributes.map((attr) => (
            <View key={attr} style={styles.chip}>
              <Text style={styles.chipText}>{attr}</Text>
            </View>
          ))}
          {descriptors.map((d) => (
            <View key={d} style={[styles.chip, styles.chipDescriptor]}>
              <Text style={styles.chipText}>{d}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Microcopy expectation setter */}
      <Text style={styles.microcopy}>
        {microcopy}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: SPACING.xl,
    marginTop: SPACING.lg,
    marginBottom: SPACING.md,
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
    marginBottom: SPACING.sm,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
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
  dismissBtn: {
    minHeight: 32,
    minWidth: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissText: {
    fontSize: 14,
    color: LUXURY.colors.stone,
    fontWeight: '600',
  },
  bodyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.md,
    marginBottom: SPACING.sm,
  },
  thumbnail: {
    width: 56,
    height: 70,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.pearl,
  },
  textCol: {
    flex: 1,
    minWidth: 0,
  },
  queryText: {
    ...LUXURY.typography.body,
    fontSize: 14,
    lineHeight: 20,
    color: LUXURY.colors.plumDeep,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.sm,
  },
  chip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
  },
  chipDescriptor: {
    borderColor: 'rgba(198, 161, 91, 0.35)',
    backgroundColor: 'rgba(198, 161, 91, 0.08)',
  },
  chipText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.graphite,
    letterSpacing: 0.4,
  },
  microcopy: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    marginTop: SPACING.sm,
    lineHeight: 14,
  },
});
