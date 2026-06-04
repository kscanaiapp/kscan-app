import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { FeatureFreezeFallback } from '../../components/FeatureFreezeFallback';
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
  getDressingRoomDetail,
  removeDressingRoomItem,
  revokeRoomShare,
  updateDressingRoom,
} from '../../services/styleObjects';
import type { DressingRoom, DressingRoomItem } from '../../types/styleObjects';

const KSCAN_PUBLIC_BASE_URL = 'https://kscan.app';

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
          <TextField label="Title" value={title} onChangeText={setTitle} />
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

  const reload = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await getDressingRoomDetail(roomId);
      setRoom(detail.room);
      setItems(detail.items);
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
  }, [reload]);

  const selectedCount = selectedIds.length;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
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

  const blocking = loading || !!error;

  return (
    <View style={styleObjectStyles.screen}>
      <StatusBar style="dark" />
      <Header title={room?.title || 'Dressing Room'} eyebrow="Room Detail" onBack={() => router.back()} />
      {blocking ? (
        <LoadingOrError loading={loading} error={error} onRetry={reload} />
      ) : (
        <ScrollView contentContainerStyle={styleObjectStyles.content}>
          {room?.description ? <Text style={styles.description}>{room.description}</Text> : null}
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
              {items.map((item) => (
                <ItemTile
                  key={item.id}
                  item={item}
                  selected={selectedSet.has(item.id)}
                  onPress={() => toggleItem(item.id)}
                  onRemove={() => handleRemoveItem(item.id)}
                />
              ))}
            </View>
          )}
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
    </View>
  );
}

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
  items: {
    marginTop: SPACING.lg,
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
