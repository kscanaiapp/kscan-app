import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  Linking,
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
  TextField,
  styleObjectStyles,
} from '../../components/StyleObjectCards';
import {
  KScanHeader,
  LuxuryScreen,
  PrimaryButton,
  SecondaryButton,
  TertiaryButton,
  SectionHeader,
  InlineNotice,
  PrivacyFooter,
} from '../../components/luxury';
import { COLORS, LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
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
import { type ReactionCountsForItem } from '../../components/dressing-rooms/ItemReactions';
import { RoomDetailTabs, type RoomDetailTab } from '../../components/dressing-rooms/RoomDetailTabs';
import { RoomChatBoard } from '../../components/dressing-rooms/RoomChatBoard';
import { RoomScansGrid } from '../../components/dressing-rooms/RoomScansGrid';
import { RoomSavedPanel } from '../../components/dressing-rooms/RoomSavedPanel';
import { RoomInfoPanel } from '../../components/dressing-rooms/RoomInfoPanel';

const { width: SCREEN_W } = Dimensions.get('window');
const INSPIRATION_CARD_W = Math.floor((SCREEN_W - SPACING.xl * 2 - SPACING.md) / 2);

const KSCAN_PUBLIC_BASE_URL = 'https://kscan.app';
const DRESSING_ROOM_SAVE_ERROR = "We couldn't save that change. Please try again.";
const DRESSING_ROOM_LOAD_ERROR = "We couldn't load this room. Please refresh and try again.";
const DRESSING_ROOM_SHARE_ERROR = "We couldn't update sharing right now. Please try again.";
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
      console.error('Update dressing room failed', err);
      setError(DRESSING_ROOM_SAVE_ERROR);
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
          <PrimaryButton
            title={saving ? 'Saving' : 'Save Changes'}
            onPress={handleSave}
            disabled={!title.trim() || saving}
            loading={saving}
            accessibilityLabel="Save dressing room changes"
          />
          <SecondaryButton
            title="Cancel"
            onPress={onClose}
            disabled={saving}
            accessibilityLabel="Cancel edit"
          />
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
      console.error('Create look from dressing room failed', err);
      setError(DRESSING_ROOM_SAVE_ERROR);
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
          <PrimaryButton
            title={saving ? 'Creating' : 'Create Look'}
            onPress={handleCreate}
            disabled={!title.trim() || saving}
            loading={saving}
            accessibilityLabel="Create look from selected items"
          />
          <SecondaryButton
            title="Cancel"
            onPress={onClose}
            disabled={saving}
            accessibilityLabel="Cancel create look"
          />
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
  const [activeTab, setActiveTab] = useState<RoomDetailTab>('chat');

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
      console.error('Load dressing room failed', err);
      setError(DRESSING_ROOM_LOAD_ERROR);
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
      console.error('Remove dressing room item failed', err);
      Alert.alert('Could not remove item', DRESSING_ROOM_SAVE_ERROR);
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
              console.error('Delete dressing room failed', err);
              Alert.alert('Could not delete room', DRESSING_ROOM_SAVE_ERROR);
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
      console.error('Share dressing room failed', err);
      setShareError(DRESSING_ROOM_SHARE_ERROR);
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
      console.error('Save dressing room note failed', err);
      setNoteError(DRESSING_ROOM_SAVE_ERROR);
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
              console.error('Revoke dressing room share failed', err);
              setShareError(DRESSING_ROOM_SHARE_ERROR);
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
              console.error('Remove dressing room inspiration failed', err);
              Alert.alert('Could not remove', DRESSING_ROOM_SAVE_ERROR);
            }
          },
        },
      ],
    );
  };

  const blocking = loading || !!error;

  return (
    <LuxuryScreen
      scrollable={false}
      safeArea={false}
      backgroundColor={LUXURY.colors.ivory}
      accessibilityLabel={`Dressing Room ${room?.title ?? 'detail'}`}
    >
      <StatusBar style="dark" />
      <KScanHeader
        title={room?.title || 'Untitled Room'}
        subtitle="ROOM DETAIL"
        onBack={() => router.back()}
        backLabel="Back"
      />
      {blocking ? (
        <View style={styles.centeredFill}>
          {loading ? (
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          ) : (
            <InlineNotice
              variant="error"
              title="Unable to load Dressing Room"
              body={error || 'Something went wrong. Please try again.'}
              action={{ label: 'Retry', onPress: reload, accessibilityLabel: 'Retry loading dressing room' }}
            />
          )}
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <View style={styles.flex}>
            <RoomDetailTabs activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'chat' && (
              <RoomChatBoard
                roomId={roomId}
                items={items}
                reactionCounts={reactionCounts}
                selectedReactions={selectedReactions}
                mutatingReactionItemId={mutatingReactionItemId}
                onReact={handleReact}
                isAuthenticated={isAuthenticated}
              />
            )}

            {activeTab === 'scans' && (
              <ScrollView
                contentContainerStyle={styles.tabContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                <RoomScansGrid
                  items={items}
                  reactionCounts={reactionCounts}
                  selectedReactions={selectedReactions}
                  mutatingReactionItemId={mutatingReactionItemId}
                  onReact={handleReact}
                  isAuthenticated={isAuthenticated}
                  onRemoveItem={handleRemoveItem}
                />

                {/* Room Inspiration */}
                <View style={styles.inspirationSection}>
                  <View style={styles.inspirationHeader}>
                    <SectionHeader title="Room Inspiration" subtitle="Reference images" />
                    {isAuthenticated ? (
                      <TouchableOpacity
                        style={styles.uploadBtn}
                        onPress={handleUploadInspiration}
                        testID="upload-room-inspiration-button"
                        accessibilityRole="button"
                        accessibilityLabel="Upload room inspiration image"
                        accessibilityHint="Choose a clothing-focused image from your library"
                      >
                        <Text style={styles.uploadBtnText}>Upload</Text>
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
              </ScrollView>
            )}

            {activeTab === 'saved' && (
              <RoomSavedPanel
                items={items}
                selectedIds={selectedIds}
                onToggleItem={toggleItem}
                onCreateLook={() => setCreatingLook(true)}
                selectedCount={selectedCount}
                onRemoveItem={handleRemoveItem}
              />
            )}

            {activeTab === 'info' && (
              <View style={styles.flex}>
                {editingNote ? (
                  <ScrollView
                    contentContainerStyle={styles.tabContent}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                  >
                    <View style={styles.noteSection}>
                      <TextInput
                        value={noteDraft}
                        onChangeText={setNoteDraft}
                        placeholder="Add a note..."
                        placeholderTextColor={LUXURY.colors.stone}
                        multiline
                        textAlignVertical="top"
                        style={styles.noteInput}
                        maxLength={ROOM_NOTE_MAX_LENGTH}
                        accessibilityLabel="Room note editor"
                        accessibilityHint="Edit the private note for this room"
                      />
                      <Text style={[styles.noteCount, noteTooLong ? styles.noteCountError : null]}>
                        {noteLength}/{ROOM_NOTE_MAX_LENGTH}
                      </Text>
                      {noteError ? <Text style={styles.noteError}>{noteError}</Text> : null}
                      {noteMessage ? <Text style={styles.noteMessage}>{noteMessage}</Text> : null}
                      <PrimaryButton
                        title={savingNote ? 'Saving Note' : 'Save Note'}
                        onPress={handleSaveNote}
                        disabled={disableNoteSave}
                        loading={savingNote}
                        accessibilityLabel="Save room note"
                      />
                      <SecondaryButton
                        title="Cancel"
                        onPress={handleCancelNoteEdit}
                        disabled={savingNote}
                        accessibilityLabel="Cancel note edit"
                      />
                    </View>
                  </ScrollView>
                ) : (
                  <RoomInfoPanel
                    room={room}
                    onEdit={() => setEditing(true)}
                    onShare={handleShareRoom}
                    onRevokeShare={handleRevokeShare}
                    onDelete={handleDeleteRoom}
                    onStartEditingNote={handleStartEditingNote}
                    canShareRoom={canShareRoom}
                    sharing={sharing}
                    revokingShare={revokingShare}
                    shareError={shareError}
                    shareMessage={shareMessage}
                  />
                )}
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
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
      <PrivacyFooter
        onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/support')}
      />
    </LuxuryScreen>
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
        accessibilityRole="button"
        accessibilityLabel="Remove inspiration from room"
        accessibilityHint="The image will remain in your Style Library"
      >
        <Text style={inspirationCardStyles.removeBtnText}>×</Text>
      </TouchableOpacity>
    </View>
  );
}

const inspirationCardStyles = StyleSheet.create({
  card: {
    width: INSPIRATION_CARD_W,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  thumb: {
    // width/height set inline
  },
  thumbPlaceholder: {
    backgroundColor: LUXURY.colors.champagne,
  },
  noteWrap: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  noteText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    lineHeight: 16,
  },
  removeBtn: {
    position: 'absolute',
    top: SPACING.xs,
    right: SPACING.xs,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: {
    fontSize: 16,
    color: LUXURY.colors.graphite,
    lineHeight: 18,
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
  flex: {
    flex: 1,
  },
  centeredFill: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  tabContent: {
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xxxl,
  },
  noteSection: {
    marginBottom: SPACING.md,
    padding: SPACING.xl,
  },
  noteInput: {
    minHeight: 120,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    color: LUXURY.colors.ink,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    fontSize: 15,
    lineHeight: 22,
  },
  noteCount: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    textAlign: 'right',
    marginTop: SPACING.xs,
  },
  noteCountError: {
    color: LUXURY.colors.error,
  },
  noteError: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
    marginTop: SPACING.sm,
  },
  noteMessage: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.sm,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: COLORS.backdrop,
    padding: SPACING.xl,
  },
  modalCard: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    ...SHADOWS.editorialRaised,
  },
  modalTitle: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
    textAlign: 'center',
  },
  modalNote: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    textAlign: 'center',
    marginTop: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  error: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
    marginTop: SPACING.md,
    textAlign: 'center',
  },
  inspirationSection: {
    marginTop: SPACING.xxl,
    marginBottom: SPACING.md,
  },
  inspirationHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  uploadBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.pearl,
    minHeight: 36,
    justifyContent: 'center',
  },
  uploadBtnText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 1.4,
  },
  inspirationEmpty: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
    paddingVertical: SPACING.lg,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
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
    borderRadius: RADIUS.lg,
    backgroundColor: LUXURY.colors.champagne,
    opacity: 0.55,
  },
});
