import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Image,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import {
  ELISE_VISUAL_CONTEXT_MAX_ENTRIES,
  type EliseVisualContextEntry,
} from '../../types/eliseVisualContext';

const SCAN_LABEL = 'Scan';
const UPLOAD_LABEL = 'Upload';
const OBSIDIAN_VIOLET = '#2D1F5E';
const MUTED_LAVENDER = '#E8E4F0';

interface EliseVisualContextBarProps {
  mode?: 'all' | 'actions' | 'tray';
  entries: EliseVisualContextEntry[];
  focusedEntryId: string | null;
  isProcessing: boolean;
  hasBlockedEntry: boolean;
  remainingSlots: number;
  onScan: () => void;
  onUpload: () => void;
  onRemove: (entryId: string) => void;
  onRetry: (entryId: string) => void;
  onFocus: (entryId: string) => void;
  disabled?: boolean;
  uploadUnavailableReason?: string;
}

function chipLabel(entry: EliseVisualContextEntry): string {
  if (entry.status === 'preparing') return 'Preparing…';
  if (entry.status === 'analyzing') return 'Analyzing…';
  if (entry.status === 'failed') return entry.title || 'Upload failed';
  if (entry.status === 'blocked') return entry.title || 'Uploaded photo';
  return entry.title;
}

function chipAccessibilityLabel(
  entry: EliseVisualContextEntry,
  isFocused: boolean,
  position: number,
  total: number,
): string {
  const focus = isFocused ? 'focused' : 'not focused';
  const status = entry.status;
  return `Reference ${position} of ${total}, ${entry.source === 'scan' ? 'scan' : 'upload'}: ${chipLabel(entry)}, ${status}, ${focus}`;
}

export function EliseVisualContextBar({
  mode = 'all',
  entries,
  focusedEntryId,
  isProcessing,
  hasBlockedEntry,
  remainingSlots,
  onScan,
  onUpload,
  onRemove,
  onRetry,
  onFocus,
  disabled = false,
  uploadUnavailableReason,
}: EliseVisualContextBarProps) {
  const count = entries.length;
  const isFull = remainingSlots === 0;
  const showActions = mode !== 'tray';
  const showTray = mode !== 'actions' && count > 0;

  if (mode === 'tray' && count === 0) return null;

  return (
    <View
      style={[styles.container, mode === 'tray' ? styles.trayContainer : styles.utilityContainer]}
      testID={mode === 'tray' ? 'elise-visual-context-tray-region' : 'elise-visual-context-bar'}
    >
      {showActions ? <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Visual references</Text>
          <Text style={styles.count} testID="elise-visual-context-count">
            {count}/{ELISE_VISUAL_CONTEXT_MAX_ENTRIES}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            onPress={onScan}
            disabled={disabled || isFull}
            style={({ pressed }) => [
              styles.smallBtn,
              pressed && !disabled && !isFull ? styles.smallBtnPressed : null,
              disabled || isFull ? styles.smallBtnDisabled : null,
            ]}
            accessibilityRole="button"
            accessibilityState={{ disabled: disabled || isFull }}
            accessibilityLabel="Scan an item"
            accessibilityHint="Open the K Scan camera"
          >
            <Text style={styles.smallBtnLabel}>{SCAN_LABEL}</Text>
          </Pressable>
          <Pressable
            onPress={onUpload}
            disabled={disabled || isFull}
            style={({ pressed }) => [
              styles.smallBtn,
              styles.smallBtnSecondary,
              pressed && !disabled && !isFull ? styles.smallBtnPressed : null,
              disabled || isFull ? styles.smallBtnDisabled : null,
            ]}
            accessibilityRole="button"
            accessibilityState={{ disabled: disabled || isFull }}
            accessibilityLabel={isFull ? 'Collection full' : 'Upload a photo'}
            accessibilityHint={isFull ? 'You can add up to 6 visual references' : 'Choose photos from your library'}
          >
            <Text style={[styles.smallBtnLabel, styles.smallBtnSecondaryLabel]}>
              {isFull ? 'Full' : UPLOAD_LABEL}
            </Text>
          </Pressable>
        </View>
      </View> : null}

      {showTray ? <View style={styles.trayHeader}>
        <Text style={styles.trayTitle}>Pending for next message</Text>
        <Text style={styles.count}>
          {count}/{ELISE_VISUAL_CONTEXT_MAX_ENTRIES}
        </Text>
      </View> : null}

      {showTray && hasBlockedEntry ? (
        <Text style={styles.blockedHint} accessibilityLiveRegion="polite">
          Some uploads can’t be analyzed yet. Remove them to send. {uploadUnavailableReason}
        </Text>
      ) : null}

      {showTray ? <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.trayContent}
        testID="elise-visual-context-tray"
      >
        {entries.map((entry, index) => {
          const isFocused = focusedEntryId === entry.id;
          const previewUri = entry.sanitizedPreviewUri ?? entry.rawImageUri;
          return (
            <View
              key={entry.id}
              style={[
                styles.chip,
                isFocused ? styles.chipFocused : null,
                entry.status === 'failed' ? styles.chipFailed : null,
              ]}
            >
              <Pressable
                onPress={() => onFocus(entry.id)}
                style={styles.chipBody}
                accessibilityRole="button"
                accessibilityLabel={chipAccessibilityLabel(entry, isFocused, index + 1, count)}
                accessibilityHint={isFocused ? 'Tap to clear focus' : 'Tap to emphasize this reference'}
              >
                {previewUri ? (
                  <Image
                    source={{ uri: previewUri }}
                    style={styles.thumbnail}
                    resizeMode="cover"
                    accessible={false}
                  />
                ) : (
                  <View style={[styles.thumbnail, styles.thumbnailPlaceholder]}>
                    <Text style={styles.placeholderText}>
                      {entry.source === 'scan' ? 'S' : 'U'}
                    </Text>
                  </View>
                )}
                <View style={styles.chipText}>
                  {entry.status === 'preparing' || entry.status === 'analyzing' ? (
                    <ActivityIndicator size="small" color={LUXURY.colors.plum} />
                  ) : null}
                  <Text style={styles.chipLabel} numberOfLines={1} accessibilityLiveRegion="polite">
                    {chipLabel(entry)}
                  </Text>
                  {isFocused ? (
                    <Text style={styles.focusBadge}>Focused</Text>
                  ) : null}
                  {entry.status === 'blocked' ? (
                    <Text style={styles.chipSubtext} numberOfLines={1}>
                      Analysis unavailable
                    </Text>
                  ) : null}
                </View>
              </Pressable>

              {entry.status === 'failed' ? (
                <Pressable
                  onPress={() => onRetry(entry.id)}
                  style={styles.actionBtn}
                  accessibilityRole="button"
                  accessibilityLabel={`Retry reference ${index + 1}, ${chipLabel(entry)}`}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.retryText}>↻</Text>
                </Pressable>
              ) : null}

              <Pressable
                onPress={() => onRemove(entry.id)}
                style={styles.actionBtn}
                accessibilityRole="button"
                accessibilityLabel={`Remove reference ${index + 1}, ${chipLabel(entry)}`}
                accessibilityHint="Remove this visual reference"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.removeX}>×</Text>
              </Pressable>
            </View>
          );
        })}

        {remainingSlots > 0 ? (
          <>
            <Pressable
              onPress={onScan}
              disabled={disabled}
              style={({ pressed }) => [
                styles.addChip,
                pressed && !disabled ? styles.addChipPressed : null,
                disabled ? styles.addChipDisabled : null,
              ]}
              accessibilityRole="button"
              accessibilityState={{ disabled }}
              accessibilityLabel="Scan another item"
              accessibilityHint="Open the K Scan camera"
            >
              <Text style={styles.addChipText}>+</Text>
              <Text style={styles.addChipLabel}>{SCAN_LABEL}</Text>
            </Pressable>
            <Pressable
              onPress={onUpload}
              disabled={disabled}
              style={({ pressed }) => [
                styles.addChip,
                pressed && !disabled ? styles.addChipPressed : null,
                disabled ? styles.addChipDisabled : null,
              ]}
              accessibilityRole="button"
              accessibilityState={{ disabled }}
              accessibilityLabel="Upload another photo"
              accessibilityHint="Choose photos from your library"
            >
              <Text style={styles.addChipText}>+</Text>
              <Text style={styles.addChipLabel}>{UPLOAD_LABEL}</Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView> : null}
    </View>
  );
}

const CHIP_SIZE = 52;

const styles = StyleSheet.create({
  container: {
    marginHorizontal: SPACING.xl,
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: 'rgba(45, 31, 94, 0.18)',
  },
  utilityContainer: {
    marginTop: SPACING.xs,
    marginBottom: SPACING.md,
    paddingVertical: SPACING.xs,
    backgroundColor: MUTED_LAVENDER,
    ...SHADOWS.editorialSmall,
  },
  trayContainer: {
    marginTop: SPACING.xs,
    marginBottom: SPACING.xs,
    paddingTop: SPACING.xs,
    paddingBottom: 0,
    backgroundColor: LUXURY.colors.pearl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  headerText: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: SPACING.xs,
    flexShrink: 1,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    color: LUXURY.colors.ink,
  },
  count: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    color: LUXURY.colors.stone,
  },
  blockedHint: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
    flexShrink: 1,
    textAlign: 'left',
  },
  trayHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  trayTitle: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
    color: LUXURY.colors.graphite,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flexShrink: 0,
  },
  smallBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    backgroundColor: OBSIDIAN_VIOLET,
    minWidth: 72,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallBtnSecondary: {
    backgroundColor: OBSIDIAN_VIOLET,
  },
  smallBtnPressed: {
    opacity: 0.8,
  },
  smallBtnDisabled: {
    opacity: 0.45,
  },
  smallBtnLabel: {
    ...LUXURY.typography.cta,
    fontSize: 11,
    color: LUXURY.colors.inverse,
  },
  smallBtnSecondaryLabel: {
    color: '#FFFFFF',
  },
  trayContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.xs,
    minHeight: 72,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    padding: SPACING.xs,
    gap: SPACING.xs,
  },
  chipFocused: {
    borderColor: OBSIDIAN_VIOLET,
    borderWidth: 2,
  },
  chipFailed: {
    borderColor: LUXURY.colors.error,
  },
  chipBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  thumbnail: {
    width: CHIP_SIZE,
    height: CHIP_SIZE,
    borderRadius: RADIUS.sm,
    backgroundColor: LUXURY.colors.ivory,
  },
  thumbnailPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 20,
    color: LUXURY.colors.stone,
  },
  chipText: {
    maxWidth: 88,
    gap: SPACING.xxs,
  },
  chipLabel: {
    ...LUXURY.typography.body,
    fontSize: 12,
    color: LUXURY.colors.ink,
  },
  chipSubtext: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
  },
  focusBadge: {
    ...LUXURY.typography.caption,
    alignSelf: 'flex-start',
    fontSize: 9,
    color: '#FFFFFF',
    backgroundColor: OBSIDIAN_VIOLET,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.xs,
    paddingVertical: 2,
  },
  actionBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: {
    fontSize: 20,
    lineHeight: 22,
    color: LUXURY.colors.plum,
  },
  removeX: {
    fontSize: 22,
    lineHeight: 24,
    color: LUXURY.colors.stone,
  },
  addChip: {
    width: 72,
    height: CHIP_SIZE + 16,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    borderStyle: 'dashed',
    backgroundColor: LUXURY.colors.pearl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xxs,
  },
  addChipPressed: {
    opacity: 0.8,
  },
  addChipDisabled: {
    opacity: 0.45,
  },
  addChipText: {
    fontSize: 24,
    lineHeight: 26,
    color: LUXURY.colors.plum,
  },
  addChipLabel: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.stone,
  },
});
