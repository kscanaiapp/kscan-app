import React, { useMemo, useState } from 'react';
import {
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { FeatureFreezeFallback } from '../../components/FeatureFreezeFallback';
import {
  EmptyState,
  Header,
  LoadingOrError,
  PrimaryButton,
  TextField,
  styleObjectStyles,
} from '../../components/StyleObjectCards';
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useDressingRooms } from '../../hooks/useStyleObjects';
import { createDressingRoom, ROOM_TITLE_MAX_LENGTH } from '../../services/styleObjects';
import type { DressingRoom } from '../../types/styleObjects';

const DRESSING_ROOM_SAVE_ERROR = "We couldn't save that change. Please try again.";
const DRESSING_ROOM_LOAD_ERROR = "We couldn't load your Dressing Rooms. Please refresh and try again.";
const ACCESSIBLE_GOLD_TEXT = '#72521E';

function RoomCard({ room }: { room: DressingRoom }) {
  const cover = room.coverImageUrl || room.coverFallbackUrl;
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push(`/dressing-rooms/${room.id}`)}
      activeOpacity={0.84}
    >
      {cover ? (
        <Image source={{ uri: cover }} style={styles.cover} resizeMode="cover" />
      ) : (
        <View style={[styles.cover, styles.coverFallback]}>
          <Text style={styles.coverFallbackText}>ROOM</Text>
        </View>
      )}
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={1}>{room.title}</Text>
        {room.description ? (
          <Text style={styles.cardDescription} numberOfLines={2}>{room.description}</Text>
        ) : null}
        <Text style={styles.cardMeta}>{room.itemCount ?? 0} ITEMS</Text>
      </View>
    </TouchableOpacity>
  );
}

function CreateRoomModal({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { user } = useAuthSession();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = useMemo(() => title.trim().length > 0 && !saving, [title, saving]);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await createDressingRoom({ userId: user?.id, title, description });
      setTitle('');
      setDescription('');
      onCreated();
      onClose();
    } catch (err: any) {
      console.error('Create dressing room failed', err);
      setError(DRESSING_ROOM_SAVE_ERROR);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>New Dressing Room</Text>
          <TextField label="Title" value={title} onChangeText={setTitle} placeholder="Vacation Capsule" maxLength={ROOM_TITLE_MAX_LENGTH} />
          <TextField
            label="Description"
            value={description}
            onChangeText={setDescription}
            placeholder="Optional notes, mood, trip, or event"
            multiline
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton label={saving ? 'Creating' : 'Create Room'} onPress={handleSave} disabled={!canSave} />
          <PrimaryButton label="Cancel" onPress={onClose} variant="secondary" disabled={saving} />
        </View>
      </View>
    </Modal>
  );
}


function DressingRoomsContent() {
  const { rooms, loading, error, reload } = useDressingRooms();
  const [creating, setCreating] = useState(false);
  const blocking = loading || !!error;
  const friendlyError = error ? DRESSING_ROOM_LOAD_ERROR : null;

  return (
    <View style={styleObjectStyles.screen}>
      <StatusBar style="dark" />
      <Header title="Dressing Rooms" eyebrow="Persistent Boards" onBack={() => router.back()} />
      {blocking ? (
        <LoadingOrError loading={loading} error={friendlyError} onRetry={reload} />
      ) : (
        <ScrollView contentContainerStyle={styleObjectStyles.content}>
          <PrimaryButton label="New Dressing Room" onPress={() => setCreating(true)} />
          {rooms.length === 0 ? (
            <EmptyState
              title="No Dressing Rooms yet."
              body="Create a board for a trip, event, sale watchlist, or styling project."
            />
          ) : (
            <View style={styles.grid}>
              {rooms.map((room) => <RoomCard key={room.id} room={room} />)}
            </View>
          )}

        </ScrollView>
      )}
      <CreateRoomModal visible={creating} onClose={() => setCreating(false)} onCreated={reload} />
    </View>
  );
}

export default function DressingRoomsScreen() {
  const { isFeatureEnabled, isLoading } = useFeatureFreeze();
  if (isLoading) {
    return <FeatureFreezeFallback cta="closet" loading />;
  }
  if (!isFeatureEnabled('dressingRooms')) {
    return <FeatureFreezeFallback cta="closet" />;
  }

  return <DressingRoomsContent />;
}

const styles = StyleSheet.create({
  grid: {
    gap: SPACING.md,
    marginTop: SPACING.lg,
  },
  card: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  cover: {
    width: '100%',
    aspectRatio: 1.8,
    backgroundColor: COLORS.surfaceMuted,
  },
  coverFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverFallbackText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextSecondary,
  },
  cardBody: {
    padding: SPACING.lg,
    gap: SPACING.xs,
  },
  cardTitle: {
    ...TYPOGRAPHY.title,
    color: COLORS.editorialTextPrimary,
  },
  cardDescription: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextSecondary,
    fontSize: 13,
  },
  cardMeta: {
    ...TYPOGRAPHY.caption,
    color: ACCESSIBLE_GOLD_TEXT,
    marginTop: SPACING.xs,
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
    marginBottom: SPACING.sm,
  },
  error: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.error,
    marginTop: SPACING.md,
    textAlign: 'center',
  },
});
