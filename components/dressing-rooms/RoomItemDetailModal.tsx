import React, { useCallback, useMemo } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import {
  COLORS,
  LUXURY,
  RADIUS,
  SHADOWS,
  SPACING,
} from '../../constants/theme';
import { setStyleChatHandoffContext } from '../../services/style-chat/styleChatHandoffContext';
import type { StyleChatHandoffSource } from '../../services/style-chat/styleChatHandoffContext';
import type { DressingRoomItem } from '../../types/styleObjects';

type Props = {
  visible: boolean;
  item: DressingRoomItem | null;
  selected?: boolean;
  onClose: () => void;
  onRemove: () => void;
  onToggleSelected?: () => void;
};

function getSourceBadgeLabel(sourceType?: string | null): string {
  switch (sourceType) {
    case 'live_scan':
      return 'Camera Scan';
    case 'upload_inspiration':
      return 'Upload';
    case 'style_library_scan':
      return 'Closet';
    case 'text-scan':
    case 'textScan':
      return 'TextScan';
    default:
      return 'Saved Item';
  }
}

function mapSourceToHandoff(sourceType?: string | null): StyleChatHandoffSource {
  if (sourceType === 'upload_inspiration') return 'upload';
  if (sourceType === 'text-scan' || sourceType === 'textScan') return 'text-scan';
  return 'camera';
}

export function RoomItemDetailModal({
  visible,
  item,
  selected,
  onClose,
  onRemove,
  onToggleSelected,
}: Props) {
  const handleAskStyleChat = useCallback(() => {
    if (!item) return;
    const source = mapSourceToHandoff(item.sourceType);
    const payload = (item.snapshotPayload || {}) as Record<string, any>;
    const meta = payload.metadata || payload;

    setStyleChatHandoffContext({
      source,
      imageUri: item.imageUrl ?? null,
      category: item.category || meta?.category || null,
      color: meta?.color || null,
      silhouette: meta?.silhouette || null,
      material: meta?.material || null,
      descriptors: Array.isArray(meta?.styleTags) ? meta.styleTags : Array.isArray(payload?.styleTags) ? payload.styleTags : undefined,
      analysisText: payload?.result || item.title || null,
      createdAt: item.createdAt,
    });
    onClose();
    router.push('/style-chat');
  }, [item, onClose]);

  const attributeChips = useMemo(() => {
    if (!item) return [];
    const payload = (item.snapshotPayload || {}) as Record<string, any>;
    const meta = payload.metadata || payload;
    const chips: { label: string; value: string }[] = [];
    if (meta?.color) chips.push({ label: 'Color', value: meta.color });
    if (meta?.silhouette) chips.push({ label: 'Silhouette', value: meta.silhouette });
    if (meta?.material) chips.push({ label: 'Material', value: meta.material });
    return chips;
  }, [item]);

  if (!item) return null;

  const versionOk = item.snapshotVersion >= 1;
  const sourceLabel = getSourceBadgeLabel(item.sourceType);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.card}>
          <ScrollView showsVerticalScrollIndicator={false}>
            {versionOk && item.imageUrl ? (
              <Image source={{ uri: item.imageUrl }} style={styles.image} resizeMode="cover" />
            ) : (
              <View style={[styles.image, styles.imageFallback]}>
                <Text style={styles.fallbackText}>UNAVAILABLE</Text>
              </View>
            )}

            <View style={styles.badgeRow}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{sourceLabel}</Text>
              </View>
            </View>

            <View style={styles.metaSection}>
              <Text style={styles.brandText} numberOfLines={1}>
                {item.brand || item.category || 'K-SCAN'}
              </Text>
              <Text style={styles.titleText} numberOfLines={3}>
                {versionOk ? item.title || 'Untitled item' : 'Snapshot unavailable'}
              </Text>
              {item.category ? (
                <Text style={styles.categoryText}>{item.category}</Text>
              ) : null}
            </View>

            {attributeChips.length > 0 ? (
              <View style={styles.chipsRow}>
                {attributeChips.map((chip) => (
                  <View key={chip.label} style={styles.chip}>
                    <Text style={styles.chipLabel}>{chip.label}</Text>
                    <Text style={styles.chipValue}>{chip.value}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleAskStyleChat}
                activeOpacity={0.84}
                accessibilityRole="button"
                accessibilityLabel="Ask StyleChat about this item"
              >
                <Text style={styles.primaryButtonText}>Ask StyleChat</Text>
              </TouchableOpacity>

              {onToggleSelected ? (
                <TouchableOpacity
                  style={selected ? styles.selectedButton : styles.secondaryButton}
                  onPress={onToggleSelected}
                  activeOpacity={0.84}
                  accessibilityRole="button"
                  accessibilityLabel={selected ? 'Deselect item for look' : 'Select item for look'}
                >
                  <Text style={selected ? styles.selectedButtonText : styles.secondaryButtonText}>
                    {selected ? 'Selected for Look' : 'Select for Look'}
                  </Text>
                </TouchableOpacity>
              ) : null}

              <TouchableOpacity
                style={styles.dangerButton}
                onPress={onRemove}
                activeOpacity={0.84}
                accessibilityRole="button"
                accessibilityLabel="Remove item from room"
              >
                <Text style={styles.dangerButtonText}>Remove from Room</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.closeButton}
                onPress={onClose}
                activeOpacity={0.84}
                accessibilityRole="button"
                accessibilityLabel="Close item detail"
              >
                <Text style={styles.closeButtonText}>Close</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: COLORS.backdrop,
    padding: SPACING.lg,
  },
  card: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    maxHeight: '88%',
    ...SHADOWS.editorialRaised,
  },
  image: {
    width: '100%',
    aspectRatio: 1,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    backgroundColor: LUXURY.colors.champagne,
  },
  imageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  badgeRow: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.xs,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    backgroundColor: LUXURY.colors.plumMuted,
    borderWidth: 1,
    borderColor: LUXURY.colors.plumSoft,
  },
  badgeText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  metaSection: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    gap: SPACING.xs,
  },
  brandText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    fontSize: 11,
    letterSpacing: 1.4,
  },
  titleText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    fontSize: 17,
  },
  categoryText: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  chip: {
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    backgroundColor: LUXURY.colors.ivory,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    fontSize: 10,
  },
  chipValue: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    fontSize: 13,
  },
  actions: {
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  primaryButton: {
    minHeight: 52,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  primaryButtonText: {
    ...LUXURY.typography.cta,
    color: LUXURY.colors.inverse,
  },
  secondaryButton: {
    minHeight: 48,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.pearl,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  secondaryButtonText: {
    ...LUXURY.typography.ctaSecondary,
    color: LUXURY.colors.plum,
  },
  selectedButton: {
    minHeight: 48,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.plumMuted,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  selectedButtonText: {
    ...LUXURY.typography.ctaSecondary,
    color: LUXURY.colors.plum,
  },
  dangerButton: {
    minHeight: 48,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: 'rgba(130, 48, 56, 0.35)',
    backgroundColor: 'rgba(130, 48, 56, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  dangerButtonText: {
    ...LUXURY.typography.ctaSecondary,
    color: LUXURY.colors.error,
  },
  closeButton: {
    minHeight: 44,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  closeButtonText: {
    ...LUXURY.typography.ctaSecondary,
    color: LUXURY.colors.graphite,
  },
});
