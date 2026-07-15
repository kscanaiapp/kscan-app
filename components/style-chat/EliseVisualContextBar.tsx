import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Image,
} from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import {
  ELISE_VISUAL_CONTEXT_MAX_ENTRIES,
  type EliseVisualContextEntry,
} from '../../types/eliseVisualContext';

const OBSIDIAN_VIOLET = '#2D1F5E';

interface EliseVisualContextBarProps {
  entries: EliseVisualContextEntry[];
  focusedEntryId: string | null;
  hasBlockedEntry: boolean;
  onRemove: (entryId: string) => void;
  onRetry: (entryId: string) => void;
  onFocus: (entryId: string) => void;
  onClear: () => void;
  uploadUnavailableReason?: string;
}

function chipLabel(entry: EliseVisualContextEntry): string {
  if (entry.status === 'preparing') return 'Preparing...';
  if (entry.status === 'analyzing') return 'Analyzing...';
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
  return `Reference ${position} of ${total}, ${entry.source === 'scan' ? 'scan' : 'upload'}: ${chipLabel(entry)}, ${entry.status}, ${focus}`;
}

export function EliseVisualContextBar({
  entries,
  focusedEntryId,
  hasBlockedEntry,
  onRemove,
  onRetry,
  onFocus,
  onClear,
  uploadUnavailableReason,
}: EliseVisualContextBarProps) {
  const count = entries.length;
  if (count === 0) return null;

  return (
    <View style={styles.container} testID="elise-visual-context-tray-region">
      <View style={styles.trayHeader}>
        <Text style={styles.trayTitle}>Pending for next message</Text>
        <View style={styles.trayMeta}>
          <Text style={styles.count} testID="elise-visual-context-count">
            {count} of {ELISE_VISUAL_CONTEXT_MAX_ENTRIES}
          </Text>
          <Pressable
            onPress={onClear}
            style={({ pressed }) => [styles.clearButton, pressed ? styles.clearButtonPressed : null]}
            accessibilityRole="button"
            accessibilityLabel="Clear visual collection"
            accessibilityHint="Remove all pending visual references"
          >
            <Text style={styles.clearText}>Clear</Text>
          </Pressable>
        </View>
      </View>

      {hasBlockedEntry ? (
        <Text style={styles.blockedHint} accessibilityLiveRegion="polite">
          Some uploads can't be analyzed yet. Remove them to send. {uploadUnavailableReason}
        </Text>
      ) : null}

      <ScrollView
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
                  {isFocused ? <Text style={styles.focusBadge}>Focused</Text> : null}
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
                  <Text style={styles.retryText}>{'\u21BB'}</Text>
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
                <Text style={styles.removeX}>{'\u00D7'}</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const CHIP_SIZE = 52;

const styles = StyleSheet.create({
  container: {
    marginHorizontal: SPACING.xl,
    marginTop: SPACING.xs,
    marginBottom: SPACING.xs,
    gap: SPACING.xs,
    paddingTop: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: 'rgba(45, 31, 94, 0.18)',
    backgroundColor: LUXURY.colors.pearl,
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
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  trayTitle: {
    ...LUXURY.typography.caption,
    flexShrink: 1,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
    color: LUXURY.colors.graphite,
  },
  trayMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    flexShrink: 0,
  },
  clearButton: {
    minWidth: 48,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearButtonPressed: {
    opacity: 0.6,
  },
  clearText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontSize: 10,
    letterSpacing: 0.8,
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
    minWidth: 44,
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
    fontSize: 20,
    lineHeight: 22,
    color: LUXURY.colors.stone,
  },
});
