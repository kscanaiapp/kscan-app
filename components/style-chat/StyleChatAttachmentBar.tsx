// StyleChat composer attachment bar — Elise visual attachment composer.
//
// Preview chips sit above the composer. The attach menu offers Take Photo,
// Choose from Photos, Recent Scans, Closet & Saved, and Dressing Rooms.
// Product copy only — no wire/contract vocabulary in the UI.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { MODAL_MAX_WIDTH } from '../../services/responsiveLayout';
import { EmptyStateCard, InlineNotice, SecondaryButton } from '../luxury';
import { ELISE_IDENTITY, ELISE_ATTACHMENT_COPY } from '../../constants/elise';
import {
  ELISE_ATTACHMENT_LIMIT_MESSAGE,
  ELISE_DIRECT_IMAGE_LIMIT_MESSAGE,
} from '../../types/eliseVisualAttachments';
import { useOwnedClosetItems } from '../../hooks/useOwnedClosetItems';
import { useDressingRooms, useLooks } from '../../hooks/useStyleObjects';
import { useSharedRoomMemberships } from '../../hooks/useSharedRoomMemberships';
import { getDressingRoomDetail } from '../../services/styleObjects';
import { joinSharedRoom } from '../../services/roomMessages';
import { sharedRoomDisplayTitle } from '../../services/sharedWithMeListLogic';
import type { SharedRoomMembershipSummary } from '../../services/sharedRoomMemberships';
import {
  OWNED_ITEM_CONTRACT_VERSION,
  ownedItemKey,
  type OwnedClosetItem,
} from '../../types/ownedClosetItem';
import type { DraftAttachment } from '../../types/styleChatAttachments';
import type { DressingRoom, DressingRoomItem, Look } from '../../types/styleObjects';
import type { SavedScanModel } from '../../services/savedScansCloud';

const STATE_COPY: Record<string, string> = ELISE_ATTACHMENT_COPY;

type AddResult = { ok: boolean; message?: string };
type PickerKind = 'recent' | 'closet' | 'rooms' | null;
type RoomSelection =
  | { kind: 'owned'; room: DressingRoom }
  | { kind: 'shared'; room: SharedRoomMembershipSummary };

export type StyleChatAttachmentBarProps = {
  attachments: DraftAttachment[];
  focusedDraftId?: string | null;
  onAddOwnedItem: (item: OwnedClosetItem, localScan?: SavedScanModel | null) => AddResult;
  onAddLook?: (look: Look) => AddResult;
  /** Prefer when parent owns camera/gallery resolution. Receives the picked URI. */
  onTakePhoto?: (uri: string) => void | Promise<void>;
  onChoosePhotos?: (uri: string) => void | Promise<void>;
  /** Prefer when parent uses addDirectImage(uri, source). */
  onDirectImage?: (
    uri: string,
    source: 'camera' | 'photo_library',
  ) => void | Promise<AddResult | void>;
  /** @deprecated Prefer onDirectImage / onChoosePhotos. Opens legacy photo intake when set alone. */
  onUploadPhoto?: () => void;
  onAddSharedItem?: (input: {
    sourceId: string;
    title: string;
    imageUri?: string | null;
    subtitle?: string | null;
  }) => AddResult;
  onAddDressingRoomItem?: (input: {
    sourceId: string;
    title: string;
    imageUri?: string | null;
    shared?: boolean;
    subtitle?: string | null;
  }) => AddResult;
  onRemove: (draftId: string) => void;
  onRetry: (draftId: string, items: OwnedClosetItem[], localScans?: SavedScanModel[]) => void;
  onFocus?: (draftId: string) => void;
  disabled?: boolean;
  atAttachmentLimit?: boolean;
  atDirectImageLimit?: boolean;
  /** When false, hide the in-bar attach control (use StyleChatInput attach instead). */
  showAttachButton?: boolean;
  /** Optional controlled menu visibility for composer attach wiring. */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
};

function formatScanDate(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function closetSourceLabel(item: OwnedClosetItem): 'In your Closet' | 'Saved' {
  return item.sourceType === 'inspiration_item' ? 'Saved' : 'In your Closet';
}

function isSharedDraft(draft: DraftAttachment): boolean {
  if (draft.resolved?.attachmentType === 'shared_item') return true;
  const subtitle = (draft.summary.subtitle ?? '').trim().toLowerCase();
  return subtitle === 'shared';
}

function truthfulChipLabel(
  draft: DraftAttachment,
  recentScanIds: Set<string>,
): string {
  if (isSharedDraft(draft)) return 'Shared';

  const subtitle = (draft.summary.subtitle ?? '').trim().toLowerCase();
  if (subtitle === 'photo' || draft.summary.title === 'Photo') return 'Photo';
  if (subtitle === 'dressing room') return 'Dressing Room';
  if (subtitle === 'recent scan') return 'Recent Scan';
  if (subtitle === 'saved') return 'Saved';
  if (subtitle === 'in your closet') return 'In your Closet';
  if (subtitle === 'shared') return 'Shared';

  const resolved = draft.resolved;
  if (resolved?.attachmentType === 'owned_item') {
    if (resolved.sourceType === 'dressing_room_item') return 'Dressing Room';
    if (resolved.sourceType === 'inspiration_item') return 'Saved';
    if (resolved.sourceType === 'saved_scan') {
      if (
        draft.selection.localScanId &&
        recentScanIds.has(draft.selection.localScanId)
      ) {
        return 'Recent Scan';
      }
      return 'In your Closet';
    }
  }

  if (
    draft.selection.localScanId &&
    recentScanIds.has(draft.selection.localScanId)
  ) {
    return 'Recent Scan';
  }

  if (draft.selection.localImageUri || draft.selection.sanitizedImageUri) {
    return 'Photo';
  }

  return 'In your Closet';
}

function AttachmentChip({
  draft,
  focused,
  shared,
  label,
  onRemove,
  onRetry,
  onFocus,
}: {
  draft: DraftAttachment;
  focused: boolean;
  shared: boolean;
  label: string;
  onRemove: () => void;
  onRetry: () => void;
  onFocus: () => void;
}) {
  const pending = !['ready', 'failed_retryable', 'rejected', 'unavailable', 'cancelled'].includes(
    draft.state,
  );
  const failed = draft.state === 'failed_retryable';
  const unavailable = draft.state === 'rejected' || draft.state === 'unavailable';
  const stateCopy = draft.state === 'ready' ? null : STATE_COPY[draft.state] ?? null;
  const preparationLabel = stateCopy ?? (pending ? 'Preparing for Elise…' : null);

  const accessibilityParts = [
    `Attachment for Elise: ${draft.summary.title}`,
    label,
    focused ? 'Focus' : null,
    shared ? 'Shared' : null,
    preparationLabel,
  ].filter(Boolean);

  return (
    <View
      style={[
        styles.chip,
        focused && styles.chipFocused,
        unavailable && styles.chipUnavailable,
      ]}
      accessibilityLabel={accessibilityParts.join(', ')}
    >
      <Pressable
        onPress={onFocus}
        style={styles.chipBody}
        accessibilityRole="button"
        accessibilityLabel={`${focused ? 'Focused' : 'Focus'} attachment: ${draft.summary.title}, ${label}`}
        accessibilityHint={focused ? 'Already in focus for Elise' : 'Set this attachment as focus for Elise'}
        disabled={unavailable}
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
          <Text style={styles.chipLabel} numberOfLines={1}>
            {label}
          </Text>
          {preparationLabel ? (
            <Text
              style={[styles.chipState, failed && styles.chipStateFailed]}
              numberOfLines={1}
              accessibilityLiveRegion="polite"
            >
              {preparationLabel}
            </Text>
          ) : null}
          {focused ? <Text style={styles.focusBadge}>Focus</Text> : null}
          {shared ? <Text style={styles.sharedBadge}>Shared</Text> : null}
        </View>
      </Pressable>
      {failed && !shared ? (
        <TouchableOpacity
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={`${ELISE_IDENTITY.retryAttachmentAccessibilityLabel}: ${draft.summary.title}`}
          style={styles.chipAction}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.chipActionText}>↻</Text>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel={`${ELISE_IDENTITY.removeAttachmentAccessibilityLabel}: ${draft.summary.title}`}
        style={styles.chipAction}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.chipActionText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

export function StyleChatAttachmentBar({
  attachments,
  focusedDraftId = null,
  onAddOwnedItem,
  onAddLook,
  onTakePhoto,
  onChoosePhotos,
  onDirectImage,
  onUploadPhoto,
  onAddSharedItem,
  onAddDressingRoomItem,
  onRemove,
  onRetry,
  onFocus,
  disabled = false,
  atAttachmentLimit = false,
  atDirectImageLimit = false,
  showAttachButton = true,
  menuOpen: menuOpenProp,
  onMenuOpenChange,
}: StyleChatAttachmentBarProps) {
  const closet = useOwnedClosetItems();
  const insets = useSafeAreaInsets();
  const [menuOpenInternal, setMenuOpenInternal] = useState(false);
  const menuOpen = menuOpenProp ?? menuOpenInternal;
  const setMenuOpen = useCallback(
    (open: boolean) => {
      if (menuOpenProp === undefined) setMenuOpenInternal(open);
      onMenuOpenChange?.(open);
    },
    [menuOpenProp, onMenuOpenChange],
  );

  const [picker, setPicker] = useState<PickerKind>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [pickingImage, setPickingImage] = useState(false);
  const choiceInFlightRef = useRef(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  const localScans = useMemo(
    () => (closet.localScans ?? []) as SavedScanModel[],
    [closet.localScans],
  );

  const recentScanIds = useMemo(() => {
    const ids = new Set<string>();
    for (const scan of localScans) {
      if (scan?.id) ids.add(scan.id);
    }
    return ids;
  }, [localScans]);

  const limitNotice = atAttachmentLimit
    ? ELISE_ATTACHMENT_LIMIT_MESSAGE
    : atDirectImageLimit
      ? ELISE_DIRECT_IMAGE_LIMIT_MESSAGE
      : validationMessage;

  const directImageDisabled = disabled || atAttachmentLimit || atDirectImageLimit || pickingImage;
  const libraryDisabled = disabled || atAttachmentLimit;
  const canTakePhoto = Boolean(onDirectImage || onTakePhoto);
  const canChoosePhotos = Boolean(onDirectImage || onChoosePhotos || onUploadPhoto);

  useEffect(() => {
    if (menuOpen) {
      choiceInFlightRef.current = false;
      pendingActionRef.current = null;
    }
  }, [menuOpen]);

  const runPendingAction = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    action?.();
  }, []);

  const chooseMenuAction = useCallback(
    (action: () => void, optionDisabled: boolean) => {
      if (optionDisabled || choiceInFlightRef.current) return;
      choiceInFlightRef.current = true;
      pendingActionRef.current = action;
      setMenuOpen(false);
      if (Platform.OS !== 'ios') setTimeout(runPendingAction, 0);
    },
    [runPendingAction, setMenuOpen],
  );

  const applyAddResult = useCallback((result: AddResult) => {
    setValidationMessage(result.ok ? null : result.message ?? 'Could not add that item.');
    return result.ok;
  }, []);

  const deliverDirectImage = useCallback(
    async (uri: string, source: 'camera' | 'photo_library') => {
      if (onDirectImage) {
        const result = await onDirectImage(uri, source);
        if (result && typeof result === 'object' && 'ok' in result) {
          applyAddResult(result);
        }
        return;
      }
      if (source === 'camera' && onTakePhoto) {
        await onTakePhoto(uri);
        return;
      }
      if (source === 'photo_library' && onChoosePhotos) {
        await onChoosePhotos(uri);
      }
    },
    [onDirectImage, onTakePhoto, onChoosePhotos, applyAddResult],
  );

  const handleTakePhoto = useCallback(async () => {
    if (directImageDisabled) return;
    setPickingImage(true);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert(
          'Camera Access Required',
          'Allow K Scan to use the camera in Settings to take a photo. You can still choose from Photos or your Closet.',
          [{ text: 'OK' }],
        );
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsEditing: false,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      await deliverDirectImage(result.assets[0].uri, 'camera');
    } catch {
      Alert.alert('Camera unavailable', 'K Scan could not open the camera. Try again or choose from Photos.');
    } finally {
      setPickingImage(false);
    }
  }, [directImageDisabled, deliverDirectImage]);

  const handleChoosePhotos = useCallback(async () => {
    if (directImageDisabled) return;
    // Legacy intake owns its own picker — do not double-prompt.
    if (!onDirectImage && !onChoosePhotos && onUploadPhoto) {
      onUploadPhoto();
      return;
    }
    setPickingImage(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert(
          'Photo Access Required',
          'Allow K Scan to access your photo library in Settings to choose a photo. You can still take a photo or add from your Closet.',
          [{ text: 'OK' }],
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsEditing: false,
        allowsMultipleSelection: false,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      await deliverDirectImage(result.assets[0].uri, 'photo_library');
    } catch {
      Alert.alert('Photos unavailable', 'K Scan could not open your photo library. Try again.');
    } finally {
      setPickingImage(false);
    }
  }, [directImageDisabled, deliverDirectImage, onDirectImage, onChoosePhotos, onUploadPhoto]);

  const visibleAttachments = attachments.filter((entry) => entry.state !== 'cancelled');

  return (
    <View style={styles.bar}>
      {limitNotice ? (
        <InlineNotice
          variant={atAttachmentLimit || atDirectImageLimit ? 'warning' : 'info'}
          body={limitNotice}
        />
      ) : null}

      {visibleAttachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
          accessibilityLabel="Attachments for Elise"
        >
          {visibleAttachments.map((draft) => {
            const shared = isSharedDraft(draft);
            return (
              <AttachmentChip
                key={draft.draftId}
                draft={draft}
                focused={focusedDraftId === draft.draftId}
                shared={shared}
                label={truthfulChipLabel(draft, recentScanIds)}
                onRemove={() => onRemove(draft.draftId)}
                onRetry={() => onRetry(draft.draftId, closet.items, localScans)}
                onFocus={() => onFocus?.(draft.draftId)}
              />
            );
          })}
        </ScrollView>
      ) : null}

      {showAttachButton ? (
        <View style={styles.attachRow}>
          <TouchableOpacity
            style={[styles.attachButton, (disabled || pickingImage) && styles.attachButtonDisabled]}
            onPress={() => setMenuOpen(true)}
            disabled={disabled || pickingImage}
            accessibilityRole="button"
            accessibilityLabel={ELISE_IDENTITY.attachAccessibilityLabel}
            accessibilityHint="Opens options to add a photo, scan, Closet item, or Dressing Room piece"
            testID="stylechat-attach-button"
          >
            <Text style={styles.attachButtonText}>＋</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
        onDismiss={runPendingAction}
        accessibilityViewIsModal
        testID="stylechat-attach-menu"
      >
        <View style={styles.backdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              if (choiceInFlightRef.current) return;
              setMenuOpen(false);
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          />
          <View
            style={[styles.menuCard, { paddingBottom: Math.max(SPACING.xl, insets.bottom + SPACING.md) }]}
            accessibilityRole="menu"
          >
            <View style={styles.handle} />
            <Text style={styles.menuTitle} accessibilityRole="header">
              Add for Elise
            </Text>

            <SecondaryButton
              title="Take Photo"
              onPress={() => chooseMenuAction(() => { void handleTakePhoto(); }, directImageDisabled || !canTakePhoto)}
              disabled={directImageDisabled || !canTakePhoto}
              accessibilityLabel="Take a photo for Elise"
              testID="stylechat-attach-take-photo"
            />
            <SecondaryButton
              title="Choose from Photos"
              onPress={() => chooseMenuAction(() => { void handleChoosePhotos(); }, directImageDisabled || !canChoosePhotos)}
              disabled={directImageDisabled || !canChoosePhotos}
              accessibilityLabel="Choose a photo for Elise"
              testID="stylechat-attach-choose-photos"
            />
            <SecondaryButton
              title="Recent Scans"
              onPress={() =>
                chooseMenuAction(() => {
                  setPicker('recent');
                }, libraryDisabled)
              }
              disabled={libraryDisabled}
              accessibilityLabel="Add from recent scans for Elise"
              testID="stylechat-attach-recent"
            />
            <SecondaryButton
              title="Closet & Saved"
              onPress={() =>
                chooseMenuAction(() => {
                  setPicker('closet');
                }, libraryDisabled)
              }
              disabled={libraryDisabled}
              accessibilityLabel="Add from Closet and Saved for Elise"
              testID="stylechat-attach-closet"
            />
            <SecondaryButton
              title="Dressing Rooms"
              onPress={() =>
                chooseMenuAction(() => {
                  setPicker('rooms');
                }, libraryDisabled)
              }
              disabled={libraryDisabled}
              accessibilityLabel="Add from Dressing Rooms for Elise"
              testID="stylechat-attach-rooms"
            />
            <SecondaryButton
              title="Cancel"
              onPress={() => {
                if (choiceInFlightRef.current) return;
                setMenuOpen(false);
              }}
              accessibilityLabel="Cancel"
            />
          </View>
        </View>
      </Modal>

      {picker === 'recent' ? (
        <RecentScansPickerModal
          scans={localScans}
          ownedItems={closet.items}
          loading={closet.loading}
          error={closet.error}
          onClose={() => setPicker(null)}
          onSelect={(item, scan) => {
            if (applyAddResult(onAddOwnedItem(item, scan))) setPicker(null);
          }}
        />
      ) : null}

      {picker === 'closet' ? (
        <ClosetSavedPickerModal
          items={closet.items}
          loading={closet.loading}
          error={closet.error}
          onClose={() => setPicker(null)}
          onSelect={(item) => {
            if (applyAddResult(onAddOwnedItem(item))) setPicker(null);
          }}
          onAddLook={onAddLook}
          onSelectLook={(look) => {
            if (!onAddLook) return;
            if (applyAddResult(onAddLook(look))) setPicker(null);
          }}
        />
      ) : null}

      {picker === 'rooms' ? (
        <DressingRoomsPickerModal
          onClose={() => setPicker(null)}
          onSelectOwned={(item) => {
            if (!onAddDressingRoomItem) {
              setValidationMessage('Dressing Room attachments are unavailable right now.');
              return;
            }
            if (
              applyAddResult(
                onAddDressingRoomItem({
                  sourceId: item.id,
                  title: item.title?.trim() || 'Dressing Room item',
                  imageUri: item.imageUrl ?? null,
                  shared: false,
                  subtitle: 'Dressing Room',
                }),
              )
            ) {
              setPicker(null);
            }
          }}
          onSelectShared={(item) => {
            const payload = {
              sourceId: item.id,
              title: item.title?.trim() || 'Shared item',
              imageUri: item.imageUrl ?? null,
              subtitle: 'Shared',
            };
            const result = onAddDressingRoomItem
              ? onAddDressingRoomItem({ ...payload, shared: true })
              : onAddSharedItem
                ? onAddSharedItem(payload)
                : { ok: false, message: 'Shared attachments are unavailable right now.' };
            if (applyAddResult(result)) setPicker(null);
          }}
        />
      ) : null}
    </View>
  );
}

function RecentScansPickerModal({
  scans,
  ownedItems,
  loading,
  error,
  onClose,
  onSelect,
}: {
  scans: SavedScanModel[];
  ownedItems: OwnedClosetItem[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (item: OwnedClosetItem, scan: SavedScanModel | null) => void;
}) {
  const rows = useMemo(() => {
    const byLocalId = new Map(
      ownedItems
        .filter((item) => item.sourceType === 'saved_scan' && item.localId)
        .map((item) => [item.localId as string, item]),
    );
    const sorted = [...scans].sort((a, b) => {
      const aTime = Date.parse(a.savedAt || a.createdAt || '0');
      const bTime = Date.parse(b.savedAt || b.createdAt || '0');
      return bTime - aTime;
    });
    return sorted.map((scan) => {
      const owned =
        byLocalId.get(scan.id) ??
        ownedItems.find(
          (item) =>
            item.sourceType === 'saved_scan' &&
            (item.sourceId === scan.cloudId || item.sourceId === scan.id),
        );
      const title =
        owned?.title ||
        scan.attributes?.category ||
        (typeof scan.result === 'string' && scan.result.trim() ? scan.result.trim() : 'Recent Scan');
      return {
        scan,
        owned,
        title,
        category: owned?.category || scan.attributes?.category || null,
        imageUri: owned?.imageUri || scan.thumbnailUri || scan.imageUri || null,
        dateLabel: formatScanDate(scan.savedAt || scan.createdAt),
      };
    });
  }, [scans, ownedItems]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.pickerCard}>
          <Text style={styles.menuTitle}>Recent Scans</Text>
          {loading ? (
            <ActivityIndicator color={LUXURY.colors.plum} />
          ) : error ? (
            <InlineNotice variant="error" title="Recent Scans" body={error} />
          ) : rows.length === 0 ? (
            <EmptyStateCard title="No recent scans" subtitle="Scan a piece first, then add it for Elise." />
          ) : (
            <ScrollView style={styles.pickerScroll} showsVerticalScrollIndicator={false}>
              {rows.map((row) => (
                <TouchableOpacity
                  key={row.scan.id}
                  style={styles.listRow}
                  onPress={() => {
                    if (row.owned) {
                      onSelect(row.owned, row.scan);
                      return;
                    }
                    // Local-only: synthesize a minimal owned item from the scan.
                    onSelect(
                      {
                        sourceType: 'saved_scan',
                        sourceId: row.scan.cloudId ?? null,
                        localId: row.scan.id,
                        title: row.title,
                        imageUri: row.imageUri,
                        storageBucket: row.scan.storageBucket ?? null,
                        storagePath: row.scan.storagePath ?? null,
                        category: row.category,
                        subcategory: null,
                        color: null,
                        pattern: null,
                        material: null,
                        silhouette: row.scan.attributes?.silhouette ?? null,
                        fit: null,
                        brand: null,
                        styleTags: row.scan.attributes?.style_tags ?? [],
                        normalizedAttributes: {},
                        sourceMetadata: {},
                        unavailable: false,
                        remoteBacked: Boolean(row.scan.cloudId),
                        aiEligible: true,
                        contractVersion: OWNED_ITEM_CONTRACT_VERSION,
                      },
                      row.scan,
                    );
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Attach recent scan ${row.title}${row.dateLabel ? `, ${row.dateLabel}` : ''}`}
                  testID="stylechat-recent-pick"
                >
                  {row.imageUri ? (
                    <Image source={{ uri: row.imageUri }} style={styles.listImage} resizeMode="cover" />
                  ) : (
                    <View style={[styles.listImage, styles.chipImageFallback]}>
                      <Text style={styles.chipFallbackText}>{row.title.slice(0, 1)}</Text>
                    </View>
                  )}
                  <View style={styles.chipMeta}>
                    <Text style={styles.chipTitle} numberOfLines={1}>
                      {row.title}
                    </Text>
                    <Text style={styles.chipState} numberOfLines={1}>
                      {[row.category, row.dateLabel].filter(Boolean).join(' · ') || 'Recent Scan'}
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

function ClosetSavedPickerModal({
  items,
  loading,
  error,
  onClose,
  onSelect,
  onAddLook,
  onSelectLook,
}: {
  items: OwnedClosetItem[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (item: OwnedClosetItem) => void;
  onAddLook?: (look: Look) => AddResult;
  onSelectLook: (look: Look) => void;
}) {
  const showLooks = Boolean(onAddLook);
  const { looks, loading: looksLoading, error: looksError } = useLooks();
  const available = items.filter((item) => !item.unavailable);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.pickerCard}>
          <Text style={styles.menuTitle}>Closet & Saved</Text>
          {loading ? (
            <ActivityIndicator color={LUXURY.colors.plum} />
          ) : error ? (
            <InlineNotice variant="error" title="Closet" body={error} />
          ) : available.length === 0 && !(showLooks && looks.length > 0) ? (
            <EmptyStateCard title="Nothing here yet" subtitle="Scan or save pieces to your Closet first." />
          ) : (
            <ScrollView style={styles.pickerScroll} showsVerticalScrollIndicator={false}>
              <View style={styles.pickerGrid}>
                {available.map((item) => {
                  const sourceLabel = closetSourceLabel(item);
                  return (
                    <TouchableOpacity
                      key={ownedItemKey(item)}
                      style={styles.pickerTile}
                      onPress={() => onSelect(item)}
                      accessibilityRole="button"
                      accessibilityLabel={`Attach ${item.title}, ${sourceLabel}`}
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
                      <Text style={styles.pickerSubtitle} numberOfLines={1}>
                        {sourceLabel}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {showLooks ? (
                <View style={styles.lookSection}>
                  <Text style={styles.sectionLabel}>Looks</Text>
                  {looksLoading ? (
                    <ActivityIndicator color={LUXURY.colors.plum} />
                  ) : looksError ? (
                    <InlineNotice variant="error" body={looksError} />
                  ) : looks.length === 0 ? (
                    <Text style={styles.chipState}>No Looks yet</Text>
                  ) : (
                    looks.map((look) => (
                      <TouchableOpacity
                        key={look.id}
                        style={styles.listRow}
                        onPress={() => onSelectLook(look)}
                        accessibilityRole="button"
                        accessibilityLabel={`Attach Look ${look.title}`}
                        testID="stylechat-look-pick"
                      >
                        {look.coverImageUrl || look.coverFallbackUrl ? (
                          <Image
                            source={{ uri: (look.coverImageUrl || look.coverFallbackUrl) as string }}
                            style={styles.listImage}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={[styles.listImage, styles.chipImageFallback]}>
                            <Text style={styles.chipFallbackText}>{look.title.slice(0, 1)}</Text>
                          </View>
                        )}
                        <View style={styles.chipMeta}>
                          <Text style={styles.chipTitle} numberOfLines={1}>
                            {look.title}
                          </Text>
                          <Text style={styles.chipState}>
                            {[look.occasion, `${look.itemCount ?? 0} items`].filter(Boolean).join(' · ')}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    ))
                  )}
                </View>
              ) : null}
            </ScrollView>
          )}
          <SecondaryButton title="Cancel" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function DressingRoomsPickerModal({
  onClose,
  onSelectOwned,
  onSelectShared,
}: {
  onClose: () => void;
  onSelectOwned: (item: DressingRoomItem) => void;
  onSelectShared: (item: DressingRoomItem) => void;
}) {
  const owned = useDressingRooms();
  const shared = useSharedRoomMemberships();
  const [selected, setSelected] = useState<RoomSelection | null>(null);
  const [items, setItems] = useState<DressingRoomItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) {
      setItems([]);
      setItemsError(null);
      setLoadingItems(false);
      return;
    }

    let cancelled = false;
    setLoadingItems(true);
    setItemsError(null);

    void (async () => {
      try {
        let roomId: string;
        if (selected.kind === 'owned') {
          roomId = selected.room.id;
        } else {
          roomId = await joinSharedRoom(selected.room.shareToken);
        }
        const detail = await getDressingRoomDetail(roomId);
        if (!cancelled) setItems(detail.items);
      } catch (err: unknown) {
        if (!cancelled) {
          const message =
            err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string'
              ? (err as { message: string }).message
              : 'Unable to load this Dressing Room.';
          setItemsError(message);
        }
      } finally {
        if (!cancelled) setLoadingItems(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected]);

  const sharedAvailable = shared.rooms.filter(
    (room) => room.availability === 'available' || room.availability === 'empty',
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.pickerCard}>
          <Text style={styles.menuTitle}>
            {selected
              ? selected.kind === 'owned'
                ? selected.room.title
                : sharedRoomDisplayTitle(selected.room)
              : 'Dressing Rooms'}
          </Text>

          {!selected ? (
            owned.loading || shared.loading ? (
              <ActivityIndicator color={LUXURY.colors.plum} />
            ) : owned.error && shared.rooms.length === 0 ? (
              <InlineNotice variant="error" title="Dressing Rooms" body={owned.error} />
            ) : owned.rooms.length === 0 && sharedAvailable.length === 0 ? (
              <EmptyStateCard
                title="No Dressing Rooms yet"
                subtitle="Create a room or open one shared with you."
              />
            ) : (
              <ScrollView style={styles.pickerScroll} showsVerticalScrollIndicator={false}>
                {owned.rooms.map((room) => (
                  <TouchableOpacity
                    key={room.id}
                    style={styles.listRow}
                    onPress={() => setSelected({ kind: 'owned', room })}
                    accessibilityRole="button"
                    accessibilityLabel={`Open Dressing Room ${room.title}`}
                    testID="stylechat-room-pick"
                  >
                    {room.coverImageUrl || room.coverFallbackUrl ? (
                      <Image
                        source={{ uri: (room.coverImageUrl || room.coverFallbackUrl) as string }}
                        style={styles.listImage}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={[styles.listImage, styles.chipImageFallback]}>
                        <Text style={styles.chipFallbackText}>{room.title.slice(0, 1)}</Text>
                      </View>
                    )}
                    <View style={styles.chipMeta}>
                      <Text style={styles.chipTitle} numberOfLines={1}>
                        {room.title}
                      </Text>
                      <Text style={styles.chipState}>
                        {typeof room.itemCount === 'number' ? `${room.itemCount} items` : 'Your room'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}

                {sharedAvailable.map((room) => (
                  <TouchableOpacity
                    key={room.shareToken}
                    style={styles.listRow}
                    onPress={() => setSelected({ kind: 'shared', room })}
                    accessibilityRole="button"
                    accessibilityLabel={`Open shared Dressing Room ${sharedRoomDisplayTitle(room)}`}
                    testID="stylechat-shared-room-pick"
                  >
                    <View style={[styles.listImage, styles.chipImageFallback]}>
                      <Text style={styles.chipFallbackText}>
                        {sharedRoomDisplayTitle(room).slice(0, 1)}
                      </Text>
                    </View>
                    <View style={styles.chipMeta}>
                      <Text style={styles.chipTitle} numberOfLines={1}>
                        {sharedRoomDisplayTitle(room)}
                      </Text>
                      <Text style={styles.sharedBadge}>Shared with you</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )
          ) : loadingItems ? (
            <ActivityIndicator color={LUXURY.colors.plum} />
          ) : itemsError ? (
            <InlineNotice variant="error" body={itemsError} />
          ) : items.length === 0 ? (
            <EmptyStateCard title="This room is empty" subtitle="Add pieces to the room, then try again." />
          ) : (
            <ScrollView style={styles.pickerScroll} showsVerticalScrollIndicator={false}>
              <View style={styles.pickerGrid}>
                {items.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.pickerTile}
                    onPress={() => {
                      if (selected.kind === 'shared') onSelectShared(item);
                      else onSelectOwned(item);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Attach ${item.title || 'Dressing Room item'}${
                      selected.kind === 'shared' ? ', Shared' : ''
                    }`}
                    testID="stylechat-room-item-pick"
                  >
                    {item.imageUrl ? (
                      <Image source={{ uri: item.imageUrl }} style={styles.pickerImage} resizeMode="cover" />
                    ) : (
                      <View style={[styles.pickerImage, styles.chipImageFallback]}>
                        <Text style={styles.chipFallbackText}>
                          {(item.title || 'R').slice(0, 1)}
                        </Text>
                      </View>
                    )}
                    <Text style={styles.pickerTitle} numberOfLines={1}>
                      {item.title || 'Room item'}
                    </Text>
                    <Text style={styles.pickerSubtitle} numberOfLines={1}>
                      {selected.kind === 'shared' ? 'Shared' : 'Dressing Room'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          )}

          {selected ? (
            <SecondaryButton title="Back" onPress={() => setSelected(null)} />
          ) : null}
          <SecondaryButton title="Cancel" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bar: { gap: SPACING.xs, paddingHorizontal: SPACING.md },
  attachRow: { flexDirection: 'row', alignItems: 'center' },
  attachButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.pearl,
  },
  attachButtonDisabled: { opacity: 0.45 },
  attachButtonText: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.plum, fontSize: 22 },
  chipRow: { gap: SPACING.sm, paddingVertical: SPACING.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.xs,
    paddingVertical: SPACING.xs,
    maxWidth: 260,
  },
  chipFocused: {
    borderColor: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.champagne,
  },
  chipUnavailable: { opacity: 0.55 },
  chipBody: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, flexShrink: 1 },
  chipImage: { width: 34, height: 34, borderRadius: 8, backgroundColor: LUXURY.colors.ivory },
  chipImageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
  },
  chipFallbackText: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.goldBrushed },
  chipMeta: { flexShrink: 1, gap: 1, minWidth: 0 },
  chipTitle: { ...LUXURY.typography.caption, color: LUXURY.colors.ink },
  chipLabel: { ...LUXURY.typography.caption, color: LUXURY.colors.plum, fontSize: 10 },
  chipState: { ...LUXURY.typography.caption, color: LUXURY.colors.graphite, fontSize: 10 },
  chipStateFailed: { color: LUXURY.colors.error },
  focusBadge: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    fontSize: 9,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sharedBadge: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontSize: 9,
    letterSpacing: 0.6,
  },
  chipAction: {
    width: 28,
    height: 28,
    minWidth: 28,
    minHeight: 28,
    borderRadius: 14,
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
    borderTopLeftRadius: RADIUS.xl ?? 18,
    borderTopRightRadius: RADIUS.xl ?? 18,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.sm,
    // Inert on phones; caps the sheet on regular-width iPad windows.
    width: '100%',
    maxWidth: MODAL_MAX_WIDTH,
    alignSelf: 'center',
    ...SHADOWS.editorialRaised,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.hairline,
    marginBottom: SPACING.xs,
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
    // Inert on phones; caps the sheet on regular-width iPad windows.
    width: '100%',
    maxWidth: MODAL_MAX_WIDTH,
    alignSelf: 'center',
  },
  pickerScroll: { flexGrow: 0 },
  pickerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  pickerTile: { width: '30%', gap: 2 },
  pickerImage: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: LUXURY.colors.ivory },
  pickerTitle: { ...LUXURY.typography.caption, color: LUXURY.colors.ink },
  pickerSubtitle: { ...LUXURY.typography.caption, color: LUXURY.colors.graphite, fontSize: 10 },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  listImage: { width: 52, height: 64, borderRadius: 10, backgroundColor: LUXURY.colors.ivory },
  lookSection: { marginTop: SPACING.lg, gap: SPACING.sm },
  sectionLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
});
