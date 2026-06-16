import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { FeatureFreezeFallback } from '../../components/FeatureFreezeFallback';
import {
  TextField,
  styleObjectStyles,
} from '../../components/StyleObjectCards';
import {
  KScanHeader,
  LuxuryScreen,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  InlineNotice,
  EmptyStateCard,
  PrivacyFooter,
} from '../../components/luxury';
import { COLORS, LUXURY, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useDressingRooms } from '../../hooks/useStyleObjects';
import { createDressingRoom, ROOM_TITLE_MAX_LENGTH } from '../../services/styleObjects';
import type { DressingRoom } from '../../types/styleObjects';

const DRESSING_ROOM_SAVE_ERROR = "We couldn't save that change. Please try again.";
const DRESSING_ROOM_LOAD_ERROR = "We couldn't load your Dressing Rooms. Please refresh and try again.";

function RoomCard({ room }: { room: DressingRoom }) {
  const cover = room.coverImageUrl || room.coverFallbackUrl;
  const itemCount = room.itemCount ?? 0;
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => router.push(`/dressing-rooms/${room.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${room.title}, ${itemCount} item${itemCount === 1 ? '' : 's'}. ${room.description || ''}`}
      accessibilityHint="Open this Dressing Room"
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
        <Text style={styles.cardMeta}>{itemCount} ITEM{itemCount === 1 ? '' : 'S'}</Text>
      </View>
    </Pressable>
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
          <Text style={styles.modalSubtitle}>
            Create a private board for a trip, event, sale watchlist, or styling project.
          </Text>
          <TextField label="Title" value={title} onChangeText={setTitle} placeholder="Vacation Capsule" maxLength={ROOM_TITLE_MAX_LENGTH} />
          <TextField
            label="Description"
            value={description}
            onChangeText={setDescription}
            placeholder="Optional notes, mood, trip, or event"
            multiline
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton
            title={saving ? 'Creating' : 'Create Room'}
            onPress={handleSave}
            disabled={!canSave}
            loading={saving}
            accessibilityLabel="Create new dressing room"
          />
          <SecondaryButton
            title="Cancel"
            onPress={onClose}
            disabled={saving}
            accessibilityLabel="Cancel create room"
          />
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
    <LuxuryScreen
      scrollable
      safeArea
      backgroundColor={LUXURY.colors.ivory}
      accessibilityLabel="Dressing Rooms list"
    >
      <StatusBar style="dark" />
      <KScanHeader
        title="Dressing Rooms"
        subtitle="PRIVATE STYLING BOARDS"
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
              title="Unable to load Dressing Rooms"
              body={friendlyError || 'Something went wrong. Please try again.'}
              action={{ label: 'Retry', onPress: reload, accessibilityLabel: 'Retry loading dressing rooms' }}
            />
          )}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styleObjectStyles.content, styles.content]}
          showsVerticalScrollIndicator={false}
        >
          <SectionHeader
            title="Your Boards"
            subtitle={`${rooms.length} private styling space${rooms.length === 1 ? '' : 's'}`}
            actionLabel="New"
            onAction={() => setCreating(true)}
            actionAccessibilityLabel="Create new dressing room"
          />

          {rooms.length === 0 ? (
            <EmptyStateCard
              title="No Dressing Rooms yet"
              subtitle="Create a board for a trip, event, sale watchlist, or styling project. Shared only with people you invite."
              action={{
                label: 'Create Room',
                onPress: () => setCreating(true),
                accessibilityLabel: 'Create new dressing room',
              }}
            />
          ) : (
            <View style={styles.grid}>
              {rooms.map((room) => <RoomCard key={room.id} room={room} />)}
            </View>
          )}
        </ScrollView>
      )}
      <CreateRoomModal visible={creating} onClose={() => setCreating(false)} onCreated={reload} />
      <PrivacyFooter
        onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/support')}
      />
    </LuxuryScreen>
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
  centeredFill: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  content: {
    paddingTop: SPACING.sm,
  },
  grid: {
    gap: SPACING.lg,
    marginTop: SPACING.sm,
  },
  card: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  cardPressed: {
    backgroundColor: LUXURY.colors.cream,
    borderColor: LUXURY.colors.goldLight,
  },
  cover: {
    width: '100%',
    aspectRatio: 1.8,
    backgroundColor: LUXURY.colors.champagne,
  },
  coverFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverFallbackText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    letterSpacing: 3,
  },
  cardBody: {
    padding: SPACING.lg,
    gap: SPACING.xs,
  },
  cardTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    fontSize: 16,
  },
  cardDescription: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    fontSize: 13,
    lineHeight: 20,
  },
  cardMeta: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    marginTop: SPACING.xs,
    letterSpacing: 1.6,
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
  modalSubtitle: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
    marginTop: SPACING.xs,
    marginBottom: SPACING.md,
  },
  error: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
    marginTop: SPACING.md,
    textAlign: 'center',
  },
});
