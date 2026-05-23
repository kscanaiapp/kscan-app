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
import { createDressingRoom } from '../../services/styleObjects';
import type { DressingRoom } from '../../types/styleObjects';

type TeaserCardConfig = {
  title: string;
  subtitle: string;
  body: string;
  capabilities: readonly string[];
  footer?: string;
};

const CIRCULAR_CLOSET_CONFIG: TeaserCardConfig = {
  title: 'CIRCULAR CLOSET',
  subtitle: 'Secondhand-first styling intelligence',
  body: 'Build an outfit and K Scan will surface standout secondhand alternatives alongside new retail options — helping every look move closer to smarter, lower-impact discovery.',
  capabilities: [
    'Secondhand match suggestions',
    'Lower-impact shopping signals',
    'Resale value insights for closet items',
  ],
  footer: 'Designed for the next phase of Dressing Rooms.',
};

const STYLECHAT_CONFIG: TeaserCardConfig = {
  title: 'STYLECHAT',
  subtitle: 'Conversational styling that learns your taste',
  body: 'Talk through outfits, occasions, and preferences with a stylist layer designed to become more personal over time — remembering the signals that shape your wardrobe decisions.',
  capabilities: [
    'Preference-aware outfit guidance',
    'Event-based styling conversations',
    'Personalized wardrobe memory',
  ],
  footer: 'Designed for the next phase of Dressing Rooms.',
};

const WEB_LENS_CONFIG: TeaserCardConfig = {
  title: 'K SCAN WEB LENS',
  subtitle: 'Web-first visual search and instant try-on',
  body: 'Upload a look from anywhere and move from inspiration to discovery in seconds — with a browser-first scan experience designed for desktop, mobile, and future avatar-led try-on.',
  capabilities: [
    'Browser-based image upload',
    'Cross-device visual search',
    'Avatar-ready try-on pathway',
  ],
  footer: 'Designed for the next phase of K Scan discovery.',
};

const OUTFIT_REMIX_CONFIG: TeaserCardConfig = {
  title: 'OUTFIT REMIX',
  subtitle: 'Recreate inspiration from your own closet',
  body: 'Bring a favorite look into your wardrobe world. K Scan will help reinterpret inspiration using pieces you already own — with smart substitutions, layering ideas, and remix guidance when there is no exact match.',
  capabilities: [
    'Closet-first look recreation',
    'Smart substitution and layering ideas',
    'Generative remix pathways',
  ],
  footer: 'Designed for the next phase of Dressing Rooms.',
};

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
      setError(err?.message || 'Unable to create Dressing Room.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>New Dressing Room</Text>
          <TextField label="Title" value={title} onChangeText={setTitle} placeholder="Vacation Capsule" />
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

function TeaserCard({ config }: { config: TeaserCardConfig }) {
  return (
    <View style={ccStyles.card}>
      <View style={ccStyles.statusBadge}>
        <Text style={ccStyles.statusLabel}>COMING SOON</Text>
      </View>
      <Text style={ccStyles.title}>{config.title}</Text>
      <Text style={ccStyles.subtitle}>{config.subtitle}</Text>
      <Text style={ccStyles.body}>{config.body}</Text>
      <View style={ccStyles.capabilities}>
        {config.capabilities.map((item) => (
          <View key={item} style={ccStyles.capabilityRow}>
            <View style={ccStyles.capabilityDot} />
            <Text style={ccStyles.capabilityText}>{item}</Text>
          </View>
        ))}
      </View>
      {config.footer ? <Text style={ccStyles.footer}>{config.footer}</Text> : null}
    </View>
  );
}

function DressingRoomsContent() {
  const { rooms, loading, error, reload } = useDressingRooms();
  const [creating, setCreating] = useState(false);
  const blocking = loading || !!error;

  return (
    <View style={styleObjectStyles.screen}>
      <StatusBar style="dark" />
      <Header title="Dressing Rooms" eyebrow="Persistent Boards" onBack={() => router.back()} />
      {blocking ? (
        <LoadingOrError loading={loading} error={error} onRetry={reload} />
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
          <View style={ccStyles.roadmapSection}>
            <TeaserCard config={CIRCULAR_CLOSET_CONFIG} />
            <TeaserCard config={STYLECHAT_CONFIG} />
            <TeaserCard config={WEB_LENS_CONFIG} />
            <TeaserCard config={OUTFIT_REMIX_CONFIG} />
          </View>
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
    color: COLORS.editorialTextMuted,
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
    color: COLORS.goldPressed,
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

const ccStyles = StyleSheet.create({
  roadmapSection: {
    marginTop: SPACING.xxxl,
    gap: SPACING.xl,
  },
  card: {
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.xl,
    gap: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  statusLabel: {
    fontSize: 9,
    fontWeight: '600' as const,
    letterSpacing: 2.2,
    color: COLORS.editorialTextMuted,
    textTransform: 'uppercase' as const,
  },
  title: {
    fontSize: 18,
    fontWeight: '700' as const,
    letterSpacing: 3.5,
    color: COLORS.editorialTextPrimary,
    textTransform: 'uppercase' as const,
  },
  subtitle: {
    ...TYPOGRAPHY.subtitle,
    color: COLORS.goldPressed,
    fontSize: 11,
  },
  body: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextSecondary,
    fontSize: 14,
    lineHeight: 22,
  },
  capabilities: {
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  capabilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  capabilityDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.gold,
  },
  capabilityText: {
    ...TYPOGRAPHY.bodyStrong,
    fontSize: 13,
    color: COLORS.editorialTextSecondary,
  },
  footer: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
    fontSize: 10,
  },
});
