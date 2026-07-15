import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { EliseVisualContext } from '../../types/eliseVisualContext';

const SCAN_LABEL = 'Scan';
const UPLOAD_LABEL = 'Upload';

interface EliseVisualContextBarProps {
  context: EliseVisualContext | null;
  isProcessing: boolean;
  error: string | null;
  onScan: () => void;
  onUpload: () => void;
  onRemove: () => void;
  onRetry: () => void;
  disabled?: boolean;
  uploadDisabled?: boolean;
  uploadUnavailableReason?: string;
}

export function EliseVisualContextBar({
  context,
  isProcessing,
  error,
  onScan,
  onUpload,
  onRemove,
  onRetry,
  disabled = false,
  uploadDisabled = false,
  uploadUnavailableReason,
}: EliseVisualContextBarProps) {
  if (isProcessing || context?.status === 'failed') {
    const label = isProcessing
      ? context?.status === 'analyzing'
        ? 'Analyzing item…'
        : 'Preparing image…'
      : error ?? 'Something went wrong';

    return (
      <View style={styles.bar} testID="elise-visual-context-processing">
        <View style={styles.statusRow}>
          {isProcessing ? (
            <ActivityIndicator size="small" color={LUXURY.colors.plum} />
          ) : null}
          <Text style={styles.statusText} numberOfLines={1}>
            {label}
          </Text>
        </View>
        {!isProcessing && context?.status === 'failed' ? (
          <View style={styles.actionRow}>
            <Pressable
              onPress={onRetry}
              style={styles.textBtn}
              accessibilityRole="button"
              accessibilityLabel="Retry upload"
            >
              <Text style={styles.textBtnLabel}>Retry</Text>
            </Pressable>
            <Pressable
              onPress={onRemove}
              style={styles.textBtn}
              accessibilityRole="button"
              accessibilityLabel="Remove failed attachment"
            >
              <Text style={[styles.textBtnLabel, styles.removeLabel]}>Remove</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  if (context?.status === 'ready') {
    return (
      <View style={styles.bar} testID="elise-visual-context-ready">
        <View style={styles.previewRow}>
          <View style={styles.previewText}>
            <Text style={styles.previewLabel}>Attached</Text>
            <Text style={styles.previewTitle} numberOfLines={1} accessibilityLabel={`Attached item: ${context.title}`}>
              {context.title}
            </Text>
          </View>
          <View style={styles.actionRow}>
            <Text style={styles.sourceTag}>{context.source === 'scan' ? 'Scan' : 'Upload'}</Text>
            <Pressable
              onPress={onRemove}
              style={styles.removeBtn}
              accessibilityRole="button"
              accessibilityLabel="Remove attached visual context"
              accessibilityHint="Clear the attached item"
              hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
            >
              <Text style={styles.removeX}>×</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.bar} testID="elise-visual-context-resting">
      <Text style={styles.prompt}>Show Elise what you’re styling</Text>
      <View style={styles.actionRow}>
        <Pressable
          onPress={onScan}
          disabled={disabled}
          style={({ pressed }) => [
            styles.smallBtn,
            pressed && !disabled ? styles.smallBtnPressed : null,
            disabled ? styles.smallBtnDisabled : null,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Scan an item"
          accessibilityHint="Open the K Scan camera"
        >
          <Text style={styles.smallBtnLabel}>{SCAN_LABEL}</Text>
        </Pressable>
        <Pressable
          onPress={onUpload}
          disabled={disabled || uploadDisabled}
          style={({ pressed }) => [
            styles.smallBtn,
            styles.smallBtnSecondary,
            pressed && !disabled && !uploadDisabled ? styles.smallBtnPressed : null,
            disabled || uploadDisabled ? styles.smallBtnDisabled : null,
          ]}
          accessibilityRole="button"
          accessibilityState={{ disabled: disabled || uploadDisabled }}
          accessibilityLabel={uploadDisabled ? 'Upload unavailable' : 'Upload a photo'}
          accessibilityHint={uploadDisabled ? uploadUnavailableReason : 'Choose a photo from your library'}
        >
          <Text style={[styles.smallBtnLabel, styles.smallBtnSecondaryLabel]}>
            {uploadDisabled ? 'Upload unavailable' : UPLOAD_LABEL}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: SPACING.xl,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    minHeight: 48,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.pearl,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    gap: SPACING.sm,
  },
  prompt: {
    ...LUXURY.typography.body,
    fontSize: 13,
    color: LUXURY.colors.graphite,
    flexShrink: 1,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flexShrink: 0,
  },
  smallBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    minWidth: 64,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallBtnSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: LUXURY.colors.plum,
  },
  smallBtnPressed: {
    opacity: 0.8,
  },
  smallBtnDisabled: {
    opacity: 0.5,
  },
  smallBtnLabel: {
    ...LUXURY.typography.cta,
    fontSize: 12,
    color: LUXURY.colors.inverse,
  },
  smallBtnSecondaryLabel: {
    color: LUXURY.colors.plum,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flex: 1,
  },
  statusText: {
    ...LUXURY.typography.body,
    fontSize: 13,
    color: LUXURY.colors.graphite,
  },
  textBtn: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  textBtnLabel: {
    ...LUXURY.typography.cta,
    fontSize: 12,
    color: LUXURY.colors.plum,
  },
  removeLabel: {
    color: LUXURY.colors.error,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flex: 1,
  },
  previewText: {
    flex: 1,
    flexShrink: 1,
    marginRight: SPACING.sm,
  },
  previewLabel: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  previewTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    color: LUXURY.colors.ink,
  },
  sourceTag: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
  },
  removeBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeX: {
    fontSize: 22,
    lineHeight: 24,
    color: LUXURY.colors.stone,
  },
});
