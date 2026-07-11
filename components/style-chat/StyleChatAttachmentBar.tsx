// StyleChat composer attachment bar (Phase 2 — Closet Intelligence).
//
// Restrained ATTACH control + state-aware chips above the composer. Menu:
// ADD FROM CLOSET / ADD A LOOK / UPLOAD A PHOTO. Pickers reuse the Phase 1
// owned-item loading (useOwnedClosetItems) and Looks loading (useLooks) — no
// second closet loading path, no new UI library.

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { LUXURY, SPACING } from '../../constants/theme';
import { EmptyStateCard, InlineNotice, SecondaryButton } from '../luxury';
import { useOwnedClosetItems } from '../../hooks/useOwnedClosetItems';
import { useLooks } from '../../hooks/useStyleObjects';
import { ownedItemKey, type OwnedClosetItem } from '../../types/ownedClosetItem';
import type { DraftAttachment } from '../../types/styleChatAttachments';
import type { Look } from '../../types/styleObjects';

const STATE_COPY: Record<string, string> = {
  selected: 'Preparing…',
  sanitizing: 'Checking image…',
  identifying: 'Identifying…',
  awaiting_review: 'Review needed',
  creating_record: 'Syncing item…',
  uploading_media: 'Uploading image…',
  finalizing: 'Finishing…',
  failed_retryable: "Couldn't sync. Tap to retry or remove.",
  rejected: 'Item unavailable',
  unavailable: 'Item unavailable',
};

function AttachmentChip({
  draft,
  onRemove,
  onRetry,
}: {
  draft: DraftAttachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const pending = !['ready', 'failed_retryable', 'rejected', 'unavailable', 'cancelled'].includes(draft.state);
  const failed = draft.state === 'failed_retryable';
  const unavailable = draft.state === 'rejected' || draft.state === 'unavailable';
  const stateCopy = draft.state === 'ready' ? null : STATE_COPY[draft.state] ?? null;

  return (
    <View
      style={[styles.chip, unavailable && styles.chipUnavailable]}
      accessibilityLabel={`Attachment: ${draft.summary.title}${stateCopy ? `, ${stateCopy}` : ''}`}
    >
      {!unavailable && draft.summary.imageUri ? (
        <Image source={{ uri: draft.summary.imageUri }} style={styles.chipImage} resizeMode="cover" />
      ) : (
        <View style={[styles.chipImage, styles.chipImageFallback]}>
          {pending ? (
            <ActivityIndicator size="small" color={LUXURY.colors.plum} />
          ) : (
            <Text style={styles.chipFallbackText}>{draft.summary.title.slice(0, 1)}</Text>
          )}
        </View>
      )}
      <View style={styles.chipMeta}>
        <Text style={styles.chipTitle} numberOfLines={1}>
          {unavailable ? 'Unavailable' : draft.summary.title}
        </Text>
        {stateCopy ? (
          <Text style={[styles.chipState, failed && styles.chipStateFailed]} numberOfLines={1}>
            {stateCopy}
          </Text>
        ) : draft.summary.itemCount && draft.summary.itemCount > 1 ? (
          <Text style={styles.chipState}>{draft.summary.itemCount} items</Text>
        ) : null}
      </View>
      {failed ? (
        <TouchableOpacity
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={`Retry ${draft.summary.title}`}
          style={styles.chipAction}
        >
          <Text style={styles.chipActionText}>↻</Text>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${draft.summary.title}`}
        style={styles.chipAction}
      >
        <Text style={styles.chipActionText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

export function StyleChatAttachmentBar({
  attachments,
  onAddOwnedItem,
  onAddLook,
  onUploadPhoto,
  onRemove,
  onRetry,
  disabled,
}: {
  attachments: DraftAttachment[];
  onAddOwnedItem: (item: OwnedClosetItem) => { ok: boolean; message?: string };
  onAddLook: (look: Look) => { ok: boolean; message?: string };
  onUploadPhoto: () => void;
  onRemove: (draftId: string) => void;
  onRetry: (draftId: string) => void;
  disabled?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [picker, setPicker] = useState<'closet' | 'look' | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  return (
    <View style={styles.bar}>
      {validationMessage ? (
        <InlineNotice variant="info" body={validationMessage} />
      ) : null}
      <View style={styles.row}>
        <TouchableOpacity
          style={styles.attachButton}
          onPress={() => setMenuOpen(true)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel="Attach from your closet"
          testID="stylechat-attach-button"
        >
          <Text style={styles.attachButtonText}>＋</Text>
        </TouchableOpacity>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {attachments.map((draft) => (
            <AttachmentChip
              key={draft.draftId}
              draft={draft}
              onRemove={() => onRemove(draft.draftId)}
              onRetry={() => onRetry(draft.draftId)}
            />
          ))}
        </ScrollView>
      </View>

      {/* Attach menu */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>Attach</Text>
            <SecondaryButton
              title="Add From Closet"
              onPress={() => {
                setMenuOpen(false);
                setPicker('closet');
              }}
              accessibilityLabel="Add from closet"
            />
            <SecondaryButton
              title="Add a Look"
              onPress={() => {
                setMenuOpen(false);
                setPicker('look');
              }}
              accessibilityLabel="Add a look"
            />
            <SecondaryButton
              title="Upload a Photo"
              onPress={() => {
                setMenuOpen(false);
                onUploadPhoto();
              }}
              accessibilityLabel="Upload a photo"
            />
            <SecondaryButton title="Cancel" onPress={() => setMenuOpen(false)} />
          </View>
        </View>
      </Modal>

      {picker === 'closet' ? (
        <ClosetPickerModal
          onClose={() => setPicker(null)}
          onSelect={(item) => {
            const result = onAddOwnedItem(item);
            setValidationMessage(result.ok ? null : result.message ?? null);
            if (result.ok) setPicker(null);
          }}
        />
      ) : null}
      {picker === 'look' ? (
        <LookPickerModal
          onClose={() => setPicker(null)}
          onSelect={(look) => {
            const result = onAddLook(look);
            setValidationMessage(result.ok ? null : result.message ?? null);
            if (result.ok) setPicker(null);
          }}
        />
      ) : null}
    </View>
  );
}

function ClosetPickerModal({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (item: OwnedClosetItem) => void;
}) {
  const { items, loading, error } = useOwnedClosetItems();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.pickerCard}>
          <Text style={styles.menuTitle}>Add From Closet</Text>
          {loading ? (
            <ActivityIndicator color={LUXURY.colors.plum} />
          ) : error ? (
            <InlineNotice variant="error" title="Closet" body={error} />
          ) : items.length === 0 ? (
            <EmptyStateCard title="Nothing here yet" subtitle="Scan or upload pieces to your Closet first." />
          ) : (
            <ScrollView style={styles.pickerScroll} showsVerticalScrollIndicator={false}>
              <View style={styles.pickerGrid}>
                {items
                  .filter((item) => !item.unavailable)
                  .map((item) => (
                    <TouchableOpacity
                      key={ownedItemKey(item)}
                      style={styles.pickerTile}
                      onPress={() => onSelect(item)}
                      accessibilityRole="button"
                      accessibilityLabel={`Attach ${item.title}`}
                      testID="stylechat-closet-pick"
                    >
                      {item.imageUri ? (
                        <Image source={{ uri: item.imageUri }} style={styles.pickerImage} resizeMode="cover" />
                      ) : (
                        <View style={[styles.pickerImage, styles.chipImageFallback]}>
                          <Text style={styles.chipFallbackText}>{item.title.slice(0, 1)}</Text>
                        </View>
                      )}
                      <Text style={styles.pickerTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                    </TouchableOpacity>
                  ))}
              </View>
            </ScrollView>
          )}
          <SecondaryButton title="Cancel" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function LookPickerModal({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (look: Look) => void;
}) {
  const { looks, loading, error } = useLooks();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.pickerCard}>
          <Text style={styles.menuTitle}>Add a Look</Text>
          {loading ? (
            <ActivityIndicator color={LUXURY.colors.plum} />
          ) : error ? (
            <InlineNotice variant="error" title="Looks" body={error} />
          ) : looks.length === 0 ? (
            <EmptyStateCard title="No Looks yet" subtitle="Build a Look from your closet first." />
          ) : (
            <ScrollView style={styles.pickerScroll} showsVerticalScrollIndicator={false}>
              {looks.map((look) => (
                <TouchableOpacity
                  key={look.id}
                  style={styles.lookRow}
                  onPress={() => onSelect(look)}
                  accessibilityRole="button"
                  accessibilityLabel={`Attach Look ${look.title}`}
                  testID="stylechat-look-pick"
                >
                  {look.coverImageUrl || look.coverFallbackUrl ? (
                    <Image
                      source={{ uri: (look.coverImageUrl || look.coverFallbackUrl) as string }}
                      style={styles.lookImage}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={[styles.lookImage, styles.chipImageFallback]}>
                      <Text style={styles.chipFallbackText}>{look.title.slice(0, 1)}</Text>
                    </View>
                  )}
                  <View style={styles.chipMeta}>
                    <Text style={styles.chipTitle} numberOfLines={1}>{look.title}</Text>
                    <Text style={styles.chipState}>
                      {[look.occasion, `${look.itemCount ?? 0} items`].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
          <SecondaryButton title="Cancel" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bar: { gap: SPACING.xs, paddingHorizontal: SPACING.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  attachButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.pearl,
  },
  attachButtonText: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.plum },
  chipRow: { gap: SPACING.sm, paddingVertical: SPACING.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.xs,
    paddingVertical: SPACING.xs,
    maxWidth: 240,
  },
  chipUnavailable: { opacity: 0.55 },
  chipImage: { width: 34, height: 34, borderRadius: 8, backgroundColor: LUXURY.colors.ivory },
  chipImageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
  },
  chipFallbackText: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.goldBrushed },
  chipMeta: { flexShrink: 1, gap: 1 },
  chipTitle: { ...LUXURY.typography.caption, color: LUXURY.colors.ink },
  chipState: { ...LUXURY.typography.caption, color: LUXURY.colors.graphite, fontSize: 10 },
  chipStateFailed: { color: LUXURY.colors.error },
  chipAction: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActionText: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.graphite },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: LUXURY.colors.plumDeep + 'C2',
    padding: SPACING.xl,
  },
  menuCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.sm,
  },
  menuTitle: { ...LUXURY.typography.displayTitle, color: LUXURY.colors.ink },
  pickerCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.md,
    maxHeight: '84%',
  },
  pickerScroll: { flexGrow: 0 },
  pickerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  pickerTile: { width: '30%', gap: 2 },
  pickerImage: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: LUXURY.colors.ivory },
  pickerTitle: { ...LUXURY.typography.caption, color: LUXURY.colors.graphite },
  lookRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  lookImage: { width: 52, height: 64, borderRadius: 10, backgroundColor: LUXURY.colors.ivory },
});
