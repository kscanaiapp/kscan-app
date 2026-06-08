import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Dimensions,
  Image,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import { FeatureFreezeFallback } from '../../components/FeatureFreezeFallback';
import { InspirationUploadModal } from '../../components/InspirationUploadModal';
import {
  EmptyState,
  Header,
  ItemTile,
  LoadingOrError,
  PrimaryButton,
  TextField,
  styleObjectStyles,
} from '../../components/StyleObjectCards';
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import {
  createOrGetRoomShare,
  createLookFromDressingRoomItems,
  deleteDressingRoom,
  getItemReactionCounts,
  getMyItemReaction,
  getDressingRoomDetail,
  listDressingRoomInspirationItems,
  removeDressingRoomItem,
  removeInspirationFromDressingRoom,
  removeItemReaction,
  revokeRoomShare,
  ROOM_NOTE_MAX_LENGTH,
  ROOM_TITLE_MAX_LENGTH,
  setItemReaction,
  normalizeRoomNoteValue,
  updateDressingRoom,
  updateDressingRoomNote,
} from '../../services/styleObjects';
import {
  isActiveDressingRoomReactionType,
  type DressingRoomReactionType,
  type DressingRoom,
  type DressingRoomItem,
  type InspirationItem,
  type ItemReactionCount,
} from '../../types/styleObjects';
import {
  ItemReactions,
  type ReactionCountsForItem,
} from '../../components/dressing-rooms/ItemReactions';

const { width: SCREEN_W } = Dimensions.get('window');
const INSPIRATION_CARD_W = Math.floor((SCREEN_W - SPACING.xl * 2 - SPACING.md) / 2);

const KSCAN_PUBLIC_BASE_URL = 'https://kscan.app';
const EMPTY_REACTION_COUNTS: ReactionCountsForItem = {
  love: 0,
  like: 0,
  looking: 0,
  thumbs_down: 0,
};

const buildRoomSharePayload = (shareUrl: string) => {
  const message = `Join my K Scan Dressing Room: ${shareUrl}`;

  if (Platform.OS === 'ios') {
    return {
      title: 'K Scan Dressing Room',
      message,
      url: shareUrl,
    };
  }

  return {
    title: 'K Scan Dressing Room',
    message,
  };
};

function getRoomNoteDraft(note?: string | null) {
  return note ?? '';
}

type ReactionCountsByItem = Record<string, ReactionCountsForItem>;
type SelectedReactionsByItem = Record<string, DressingRoomReactionType | null>;

function createEmptyReactionCounts() {
  return { ...EMPTY_REACTION_COUNTS };
}

function normalizeReactionItemId(itemId?: string | null) {
  const normalizedItemId = String(itemId || '').trim();
  return normalizedItemId.length > 0 ? normalizedItemId : null;
}

function buildReactionCountsByItem(itemIds: string[], rows: ItemReactionCount[]): ReactionCountsByItem {
  const base = Object.fromEntries(itemIds.map((itemId) => [itemId, createEmptyReactionCounts()])) as ReactionCountsByItem;
  rows.forEach((row) => {
    const itemId = String(row.item_id || '').trim();
    if (!itemId || !base[itemId]) return;
    if (!isActiveDressingRoomReactionType(row.reaction_type)) return;
    base[itemId][row.reaction_type] = Number.isFinite(row.count) ? row.count : 0;
  });
  return base;
}

function EditRoomModal({
  room,
  visible,
  onClose,
  onSaved,
}: {
  room: DressingRoom | null;
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(room?.title ?? '');
    setDescription(room?.description ?? '');
    setError(null);
  }, [room, visible]);

  const handleSave = async () => {
    if (!room || !title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateDressingRoom(room.id, { title, description });
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Unable to update Dressing Room.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Edit Dressing Room</Text>
          <TextField label="Title" value={title} onChangeText={setTitle} maxLength={ROOM_TITLE_MAX_LENGTH} />
          <TextField label="Description" value={description} onChangeText={setDescription} multiline />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton label={saving ? 'Saving' : 'Save Changes'} onPress={handleSave} disabled={!title.trim() || saving} />
          <PrimaryButton label="Cancel" onPress={onClose} variant="secondary" disabled={saving} />
        </View>
      </View>
    </Modal>
  );
}

function CreateLookModal({
  visible,
  selectedCount,
  onClose,
  onCreate,
}: {
  visible: boolean;
  selectedCount: number;
  onClose: () => void;
  onCreate: (title: string, description: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate(title, description);
      setTitle('');
      setDescription('');
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Unable to create Look.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Create Look</Text>
          <Text style={styles.modalNote}>{selectedCount} selected item{selectedCount === 1 ? '' : 's'}</Text>
          <TextField label="Title" value={title} onChangeText={setTitle} placeholder="Dinner Fit" />
          <TextField label="Description" value={description} onChangeText={setDescription} multiline />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton label={saving ? 'Creating' : 'Create Look'} onPress={handleCreate} disabled={!title.trim() || saving} />
          <PrimaryButton label="Cancel" onPress={onClose} variant="secondary" disabled={saving} />
        </View>
      </View>
    </Modal>
  );
}

function DressingRoomDetailContent() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isAuthenticated, user } = useAuthSession();
  const roomId = String(id || '');
  const [room, setRoom] = useState<DressingRoom | null>(null);
  const [items, setItems] = useState<DressingRoomItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [revokingShare, setRevokingShare] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [creatingLook, setCreatingLook] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteMessage, setNoteMessage] = useState<string | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const [reactionCounts, setReactionCounts] = useState<ReactionCountsByItem>({});
  const [selectedReactions, setSelectedReactions] = useState<SelectedReactionsByItem>({});
  const [mutatingReactionItemId, setMutatingReactionItemId] = useState<string | null>(null);

  const [inspirations, setInspirations] = useState<InspirationItem[]>([]);
  const [inspirationLoading, setInspirationLoading] = useState(false);
  const [selectedInspirationUri, setSelectedInspirationUri] = useState<string | null>(null);
  const [showInspirationModal, setShowInspirationModal] = useState(false);

  const loadInspirations = useCallback(async () => {
    if (!roomId) return;
    setInspirationLoading(true);
    try {
      setInspirations(await listDressingRoomInspirationItems(roomId));
    } catch {
      // Non-blocking — inspiration load failure does not block room usage.
    } finally {
      setInspirationLoading(false);
    }
  }, [roomId]);

  const reload = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await getDressingRoomDetail(roomId);
      setRoom(detail.room);
      setItems(detail.items);
      setNoteDraft(getRoomNoteDraft(detail.room.roomNote));
      setSelectedIds((current) => current.filter((itemId) => detail.items.some((item) => item.id === itemId)));
      setShareError(null);
      setShareMessage(null);
    } catch (err: any) {
      setError(err?.message || 'Unable to load Dressing Room.');
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    void reload();
    void loadInspirations();
  }, [reload, loadInspirations]);

  const reactionItemIds = useMemo(
    () => Array.from(new Set(items.map((item) => normalizeReactionItemId(item.id)).filter(Boolean))) as string[],
    [items],
  );

  useEffect(() => {
    if (reactionItemIds.length === 0) {
      setReactionCounts({});
      setSelectedReactions({});
      return;
    }

    setReactionCounts((current) => ({
      ...buildReactionCountsByItem(reactionItemIds, []),
      ...current,
    }));
    setSelectedReactions((current) => ({
      ...Object.fromEntries(reactionItemIds.map((itemId) => [itemId, null])),
      ...current,
    }));

    let cancelled = false;

    const loadReactions = async () => {
      try {
        const counts = await getItemReactionCounts(reactionItemIds);
        if (!cancelled) {
          setReactionCounts(buildReactionCountsByItem(reactionItemIds, counts));
        }
      } catch {
        if (!cancelled) {
          setReactionCounts(buildReactionCountsByItem(reactionItemIds, []));
        }
      }

      if (!isAuthenticated) {
        if (!cancelled) {
          setSelectedReactions(
            Object.fromEntries(reactionItemIds.map((itemId) => [itemId, null])) as SelectedReactionsByItem,
          );
        }
        return;
      }

      try {
        const mine = await getMyItemReaction(reactionItemIds);
        if (!cancelled) {
          setSelectedReactions(mine);
        }
      } catch {
        if (!cancelled) {
          setSelectedReactions(
            Object.fromEntries(reactionItemIds.map((itemId) => [itemId, null])) as SelectedReactionsByItem,
          );
        }
      }
    };

    void loadReactions();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, reactionItemIds]);

  const selectedCount = selectedIds.length;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const normalizedOriginalNote = normalizeRoomNoteValue(room?.roomNote ?? null);
  const normalizedDraftNote = normalizeRoomNoteValue(noteDraft);
  const noteLength = noteDraft.trim().length;
  const noteTooLong = noteLength > ROOM_NOTE_MAX_LENGTH;
  const noteChanged = normalizedDraftNote !== normalizedOriginalNote;
  const disableNoteSave = savingNote || noteTooLong || !noteChanged;
  const { isFeatureEnabled } = useFeatureFreeze();
  const canShareRoom = Boolean(
    isFeatureEnabled('shareRooms') &&
    isAuthenticated &&
    user?.id &&
    room?.userId &&
    room.userId === user.id,
  );
  const toggleItem = (itemId: string) => {
    setSelectedIds((current) => (
      current.includes(itemId)
        ? current.filter((idValue) => idValue !== itemId)
        : [...current, itemId]
    ));
  };

  const handleRemoveItem = async (itemId: string) => {
    try {
      await removeDressingRoomItem(itemId);
      await reload();
    } catch (err: any) {
      Alert.alert('Could not remove item', err?.message || 'Try again.');
    }
  };

  const handleDeleteRoom = () => {
    if (!room) return;
    Alert.alert(
      'Delete Dressing Room?',
      'Room items will be removed. Looks already created from this room will remain as standalone Looks.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteDressingRoom(room.id);
              router.replace('/dressing-rooms');
            } catch (err: any) {
              Alert.alert('Could not delete room', err?.message || 'Try again.');
            }
          },
        },
      ],
    );
  };

  const handleCreateLook = async (title: string, description: string) => {
    const created = await createLookFromDressingRoomItems({
      dressingRoomId: roomId,
      title,
      description,
      itemIds: selectedIds,
    });
    setSelectedIds([]);
    router.push(`/looks/${created.id}`);
  };

  const handleShareRoom = async () => {
    if (!room || sharing) return;
    setShareError(null);
    setShareMessage(null);
    setSharing(true);
    try {
      const shareToken = await createOrGetRoomShare(room.id);
      const shareUrl = `${KSCAN_PUBLIC_BASE_URL}/rooms/${encodeURIComponent(shareToken)}`;
      await Share.share(buildRoomSharePayload(shareUrl));
      setShareMessage('Room link ready to share.');
    } catch (err: any) {
      setShareError(err?.message || 'Could not open sharing. Please try again.');
    } finally {
      setSharing(false);
    }
  };

  const handleStartEditingNote = () => {
    setNoteDraft(getRoomNoteDraft(room?.roomNote));
    setNoteError(null);
    setNoteMessage(null);
    setEditingNote(true);
  };

  const handleCancelNoteEdit = () => {
    setNoteDraft(getRoomNoteDraft(room?.roomNote));
    setNoteError(null);
    setEditingNote(false);
  };

  const handleSaveNote = async () => {
    if (!room || disableNoteSave) return;
    setSavingNote(true);
    setNoteError(null);
    setNoteMessage(null);
    try {
      const savedNote = await updateDressingRoomNote(room.id, noteDraft);
      setRoom((current) => (current ? { ...current, roomNote: savedNote } : current));
      setNoteDraft(getRoomNoteDraft(savedNote));
      setNoteMessage(savedNote ? 'Room note saved.' : 'Room note cleared.');
      setEditingNote(false);
    } catch (err: any) {
      setNoteError(err?.message || 'Could not save note.');
    } finally {
      setSavingNote(false);
    }
  };

  const handleRevokeShare = () => {
    if (!room || revokingShare) return;
    Alert.alert(
      'Disable shared link?',
      'Anyone with the current shared room link will no longer be able to view this room preview.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disable Link',
          style: 'destructive',
          onPress: async () => {
            setShareError(null);
            setShareMessage(null);
            setRevokingShare(true);
            try {
              const revoked = await revokeRoomShare(room.id);
              setShareMessage(revoked ? 'Shared link disabled.' : 'No active shared link to disable.');
            } catch (err: any) {
              setShareError(err?.message || 'Could not disable shared link.');
            } finally {
              setRevokingShare(false);
            }
          },
        },
      ],
    );
  };

  const refreshItemReactions = useCallback(async (itemIds: string[]) => {
    const normalizedItemIds = Array.from(new Set(itemIds.map((itemId) => String(itemId || '').trim()).filter(Boolean)));
    if (normalizedItemIds.length === 0) return;

    try {
      const counts = await getItemReactionCounts(normalizedItemIds);
      setReactionCounts((current) => ({
        ...current,
        ...buildReactionCountsByItem(normalizedItemIds, counts),
      }));
    } catch {
      setReactionCounts((current) => ({
        ...current,
        ...buildReactionCountsByItem(normalizedItemIds, []),
      }));
    }

    if (!isAuthenticated) {
      setSelectedReactions((current) => ({
        ...current,
        ...Object.fromEntries(normalizedItemIds.map((itemId) => [itemId, null])),
      }));
      return;
    }

    try {
      const mine = await getMyItemReaction(normalizedItemIds);
      setSelectedReactions((current) => ({ ...current, ...mine }));
    } catch {
      setSelectedReactions((current) => ({
        ...current,
        ...Object.fromEntries(normalizedItemIds.map((itemId) => [itemId, null])),
      }));
    }
  }, [isAuthenticated]);

  const handleReact = useCallback(async (itemId: string, reactionType: DressingRoomReactionType) => {
    if (!isAuthenticated || mutatingReactionItemId === itemId) return;

    const currentReaction = selectedReactions[itemId] ?? null;
    setMutatingReactionItemId(itemId);
    try {
      if (currentReaction === reactionType) {
        await removeItemReaction(itemId);
      } else {
        await setItemReaction(itemId, reactionType);
      }
      await refreshItemReactions([itemId]);
    } catch {
      Alert.alert('Unable to save reaction.', 'Please try again.');
    } finally {
      setMutatingReactionItemId((current) => (current === itemId ? null : current));
    }
  }, [isAuthenticated, mutatingReactionItemId, refreshItemReactions, selectedReactions]);

  const handleUploadInspiration = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Photo Access Required', 'Allow K Scan to access your photo library in Settings to upload inspiration.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
      allowsEditing: false,
      allowsMultipleSelection: false,
    });
    if (!result.canceled && result.assets?.[0]?.uri) {
      setSelectedInspirationUri(result.assets[0].uri);
      setShowInspirationModal(true);
    }
  };

  const handleInspirationSuccess = (item: InspirationItem) => {
    setInspirations((current) => [item, ...current]);
  };

  const handleCloseInspirationModal = () => {
    setShowInspirationModal(false);
    setSelectedInspirationUri(null);
  };

  const handleRemoveInspiration = async (inspirationId: string) => {
    if (!roomId) return;
    Alert.alert(
      'Remove from Room?',
      'The image will remain in your Style Library.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeInspirationFromDressingRoom(roomId, inspirationId);
              setInspirations((current) => current.filter((item) => item.id !== inspirationId));
            } catch (err: any) {
              Alert.alert('Could not remove', err?.message || 'Try again.');
            }
          },
        },
      ],
    );
  };

  const blocking = loading || !!error;

  return (
    <View style={styleObjectStyles.screen}>
      <StatusBar style="dark" />
      <Header title={room?.title || 'Untitled Room'} eyebrow="Room Detail" onBack={() => router.back()} />
      {blocking ? (
        <LoadingOrError loading={loading} error={error} onRetry={reload} />
      ) : (
        <ScrollView contentContainerStyle={styleObjectStyles.content}>
          {room?.description ? <Text style={styles.description}>{room.description}</Text> : null}
          <View style={styles.noteSection}>
            <Text style={styles.noteLabel}>ROOM NOTE</Text>
            {editingNote ? (
              <>
                <TextInput
                  value={noteDraft}
                  onChangeText={setNoteDraft}
                  placeholder="Add a note..."
                  placeholderTextColor={COLORS.editorialTextMuted}
                  multiline
                  textAlignVertical="top"
                  style={styles.noteInput}
                />
                <Text style={[styles.noteCount, noteTooLong ? styles.noteCountError : null]}>
                  {noteLength}/{ROOM_NOTE_MAX_LENGTH}
                </Text>
                {noteError ? <Text style={styles.noteError}>{noteError}</Text> : null}
                {noteMessage ? <Text style={styles.noteMessage}>{noteMessage}</Text> : null}
                <PrimaryButton
                  label={savingNote ? 'SAVING NOTE' : 'SAVE NOTE'}
                  onPress={handleSaveNote}
                  disabled={disableNoteSave}
                />
                <PrimaryButton
                  label="CANCEL"
                  onPress={handleCancelNoteEdit}
                  variant="secondary"
                  disabled={savingNote}
                />
              </>
            ) : (
              <>
                <View style={styles.noteCard}>
                  <Text style={room?.roomNote ? styles.noteText : styles.notePlaceholder}>
                    {room?.roomNote || 'Add a note...'}
                  </Text>
                </View>
                {noteMessage ? <Text style={styles.noteMessage}>{noteMessage}</Text> : null}
                <PrimaryButton
                  label={room?.roomNote ? 'EDIT NOTE' : 'ADD NOTE'}
                  onPress={handleStartEditingNote}
                  variant="secondary"
                />
              </>
            )}
          </View>
          <PrimaryButton label="Edit Room" onPress={() => setEditing(true)} variant="secondary" />
          {canShareRoom ? (
            <>
              <PrimaryButton
                label={sharing ? 'PREPARING LINK' : 'SHARE ROOM'}
                onPress={handleShareRoom}
                variant="secondary"
                disabled={sharing}
                testID="share-room-button"
              />
              <PrimaryButton
                label={revokingShare ? 'DISABLING LINK' : 'DISABLE SHARED LINK'}
                onPress={handleRevokeShare}
                variant="secondary"
                disabled={revokingShare}
              />
              {shareError ? <Text style={styles.shareError}>{shareError}</Text> : null}
              {shareMessage ? <Text style={styles.shareMessage}>{shareMessage}</Text> : null}
            </>
          ) : null}
          <PrimaryButton
            label={selectedCount > 0 ? `Create Look (${selectedCount})` : 'Select Items For Look'}
            onPress={() => setCreatingLook(true)}
            disabled={selectedCount === 0}
          />
          {items.length === 0 ? (
            <EmptyState
              title="No items in this room yet."
              body="Add catalog matches from scan results when they include remote product images."
            />
          ) : (
            <View style={styles.items}>
              {items.map((item) => {
                const reactionItemId = normalizeReactionItemId(item.id);

                return (
                  <ItemTile
                    key={item.id}
                    item={item}
                    selected={selectedSet.has(item.id)}
                    onPress={() => toggleItem(item.id)}
                    onRemove={() => handleRemoveItem(item.id)}
                    footer={reactionItemId ? (
                      <ItemReactions
                        itemId={reactionItemId}
                        counts={reactionCounts[reactionItemId] ?? createEmptyReactionCounts()}
                        selectedReaction={selectedReactions[reactionItemId] ?? null}
                        disabled={!isAuthenticated}
                        isMutating={mutatingReactionItemId === reactionItemId}
                        onReact={handleReact}
                      />
                    ) : null}
                  />
                );
              })}
            </View>
          )}

          {/* ── Room Inspiration ─────────────────────────────────────────── */}
          <View style={styles.inspirationSection}>
            <View style={styles.inspirationHeader}>
              <Text style={styles.inspirationLabel}>ROOM INSPIRATION</Text>
              {isAuthenticated ? (
                <TouchableOpacity
                  style={styles.uploadBtn}
                  onPress={handleUploadInspiration}
                  testID="upload-room-inspiration-button"
                >
                  <Text style={styles.uploadBtnText}>UPLOAD</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {inspirationLoading ? (
              <>
                {[0, 1, 2].map((row) => (
                  <View key={`inspiration-skeleton-row-${row}`} style={styles.inspirationRow}>
                    <View style={styles.inspirationSkeletonTile} />
                    <View style={styles.inspirationSkeletonTile} />
                  </View>
                ))}
              </>
            ) : inspirations.length === 0 ? (
              <Text style={styles.inspirationEmpty}>
                Upload screenshots and outfit references for this room.
              </Text>
            ) : (
              <View>
                {inspirations.reduce<[InspirationItem, InspirationItem | null][]>((pairs, item, i) => {
                  if (i % 2 === 0) pairs.push([item, inspirations[i + 1] ?? null]);
                  return pairs;
                }, []).map(([a, b]) => (
                  <View key={a.id} style={styles.inspirationRow}>
                    <RoomInspirationCard item={a} onRemove={handleRemoveInspiration} />
                    {b ? (
                      <RoomInspirationCard item={b} onRemove={handleRemoveInspiration} />
                    ) : (
                      <View style={{ width: INSPIRATION_CARD_W }} />
                    )}
                  </View>
                ))}
              </View>
            )}
          </View>

          <PrimaryButton label="Delete Room" onPress={handleDeleteRoom} variant="danger" />
        </ScrollView>
      )}
      <EditRoomModal room={room} visible={editing} onClose={() => setEditing(false)} onSaved={reload} />
      <CreateLookModal
        visible={creatingLook}
        selectedCount={selectedCount}
        onClose={() => setCreatingLook(false)}
        onCreate={handleCreateLook}
      />
      <InspirationUploadModal
        visible={showInspirationModal}
        selectedUri={selectedInspirationUri}
        roomId={roomId}
        onClose={handleCloseInspirationModal}
        onSuccess={handleInspirationSuccess}
      />
    </View>
  );
}

function RoomInspirationCard({
  item,
  onRemove,
}: {
  item: InspirationItem;
  onRemove: (id: string) => void;
}) {
  return (
    <View style={inspirationCardStyles.card}>
      {item.imageUrl ? (
        <Image
          source={{ uri: item.imageUrl }}
          style={[inspirationCardStyles.thumb, { width: INSPIRATION_CARD_W, height: INSPIRATION_CARD_W }]}
          resizeMode="cover"
        />
      ) : (
        <View style={[inspirationCardStyles.thumb, inspirationCardStyles.thumbPlaceholder, { width: INSPIRATION_CARD_W, height: INSPIRATION_CARD_W }]} />
      )}
      {item.note ? (
        <View style={inspirationCardStyles.noteWrap}>
          <Text style={inspirationCardStyles.noteText} numberOfLines={2}>{item.note}</Text>
        </View>
      ) : null}
      <TouchableOpacity
        style={inspirationCardStyles.removeBtn}
        onPress={() => onRemove(item.id)}
        hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
      >
        <Text style={inspirationCardStyles.removeBtnText}>×</Text>
      </TouchableOpacity>
    </View>
  );
}

const inspirationCardStyles = StyleSheet.create({
  card: {
    width: INSPIRATION_CARD_W,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  thumb: {
    // width/height set inline
  },
  thumbPlaceholder: {
    backgroundColor: COLORS.surfaceMuted,
  },
  noteWrap: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  noteText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextSecondary,
    lineHeight: 16,
  },
  removeBtn: {
    position: 'absolute',
    top: SPACING.xs,
    right: SPACING.xs,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: {
    fontSize: 14,
    color: COLORS.editorialTextSecondary,
    lineHeight: 16,
  },
});

export default function DressingRoomDetailScreen() {
  const { isFeatureEnabled, isLoading } = useFeatureFreeze();
  if (isLoading) {
    return <FeatureFreezeFallback cta="closet" loading />;
  }
  if (!isFeatureEnabled('dressingRooms')) {
    return <FeatureFreezeFallback cta="closet" />;
  }

  return <DressingRoomDetailContent />;
}

const styles = StyleSheet.create({
  description: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextSecondary,
    marginBottom: SPACING.sm,
  },
  noteSection: {
    marginTop: SPACING.sm,
    marginBottom: SPACING.md,
  },
  noteLabel: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    letterSpacing: 2.2,
    marginBottom: SPACING.sm,
  },
  noteCard: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.lg,
    ...SHADOWS.editorialSmall,
  },
  noteText: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextPrimary,
    lineHeight: 22,
  },
  notePlaceholder: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextMuted,
    lineHeight: 22,
  },
  noteInput: {
    minHeight: 120,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    color: COLORS.editorialTextPrimary,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    fontSize: 15,
    lineHeight: 22,
  },
  noteCount: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
    textAlign: 'right',
    marginTop: SPACING.xs,
  },
  noteCountError: {
    color: COLORS.error,
  },
  noteError: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.error,
    marginTop: SPACING.sm,
  },
  noteMessage: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.editorialTextSecondary,
    marginTop: SPACING.sm,
  },
  items: {
    marginTop: SPACING.lg,
  },
  inspirationSection: {
    marginTop: SPACING.xxl,
    marginBottom: SPACING.md,
  },
  inspirationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  inspirationLabel: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    letterSpacing: 2.2,
  },
  uploadBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.gold,
    backgroundColor: COLORS.surfaceCard,
  },
  uploadBtnText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    letterSpacing: 1.4,
  },
  inspirationEmpty: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
    textAlign: 'center',
    paddingVertical: SPACING.lg,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    paddingHorizontal: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  inspirationRow: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginBottom: SPACING.md,
  },
  inspirationSkeletonTile: {
    width: INSPIRATION_CARD_W,
    height: INSPIRATION_CARD_W,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surfaceMuted,
    opacity: 0.55,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: COLORS.backdrop,
    padding: SPACING.xl,
  },
  modalCard: {
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.xl,
    ...SHADOWS.editorialRaised,
  },
  modalTitle: {
    ...TYPOGRAPHY.title,
    color: COLORS.editorialTextPrimary,
  },
  modalNote: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    marginTop: SPACING.xs,
  },
  error: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.error,
    marginTop: SPACING.md,
    textAlign: 'center',
  },
  shareError: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.error,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
  shareMessage: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.editorialTextSecondary,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
});
