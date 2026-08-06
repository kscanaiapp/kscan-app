import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { goBackOrHome } from '../../services/navigationExit';
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
  StatusPill,
  TertiaryButton,
} from '../../components/luxury';
import { COLORS, LUXURY, MOTION, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useSharedRoomMemberships } from '../../hooks/useSharedRoomMemberships';
import { useDressingRooms } from '../../hooks/useStyleObjects';
import { createDressingRoom, ROOM_TITLE_MAX_LENGTH } from '../../services/styleObjects';
import {
  SHARED_WITH_ME_REFRESH_ERROR,
  buildSharedRoomNativePath,
  canOpenSharedRoom,
  formatSharedRoomDialogTitle,
  getSharedWithMeSectionPresentation,
  sharedRoomAccessibilityLabel,
  sharedRoomDisplayTitle,
  sharedRoomEnterDelayMs,
  sharedRoomItemCountLabel,
} from '../../services/sharedWithMeListLogic';
import type { SharedRoomMembershipSummary } from '../../services/sharedRoomMemberships';
import type { DressingRoom } from '../../types/styleObjects';

const DRESSING_ROOM_SAVE_ERROR = "We couldn't save that change. Please try again.";
const DRESSING_ROOM_LOAD_ERROR = "We couldn't load your Dressing Rooms. Please refresh and try again.";
const NAV_GUARD_MS = 800;
/** Home / Dressing Rooms geometric glyph — reused as the shared cover mark. */
const SHARED_ROOM_GLYPH = '✦';
const OWNED_ROOM_GLYPH = '◇';

function RoomCard({ room, style }: { room: DressingRoom; style?: any }) {
  const cover = room.coverImageUrl || room.coverFallbackUrl;
  const itemCount = room.itemCount ?? 0;
  return (
    <Pressable
      style={({ pressed }) => [styles.card, style, pressed && styles.cardPressed]}
      onPress={() => router.push(`/dressing-rooms/${room.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${room.title}, ${itemCount} item${itemCount === 1 ? '' : 's'}. ${room.description || ''}`}
      accessibilityHint="Open this Dressing Room"
    >
      {cover ? (
        <Image source={{ uri: cover }} style={styles.cover} resizeMode="cover" />
      ) : (
        <View style={[styles.cover, styles.coverFallback]}>
          <Text style={styles.coverGlyph}>{OWNED_ROOM_GLYPH}</Text>
          <Text style={styles.coverFallbackText}>ROOM</Text>
        </View>
      )}
      <View style={styles.cardBody}>
        {/* Two lines before truncating — a short title like "QA Test Room"
            must never clip at default settings, and this matches the
            SharedRoomCard title's wrap policy just below (see BUG-07). */}
        <Text style={styles.cardTitle} numberOfLines={2}>{room.title}</Text>
        {room.description ? (
          <Text style={styles.cardDescription} numberOfLines={2}>{room.description}</Text>
        ) : null}
        <Text style={styles.cardMeta}>{itemCount} ITEM{itemCount === 1 ? '' : 'S'}</Text>
      </View>
    </Pressable>
  );
}

function SharedRoomCard({
  room,
  removing,
  onOpen,
  onRemove,
  style,
  index = 0,
}: {
  room: SharedRoomMembershipSummary;
  removing: boolean;
  onOpen: (room: SharedRoomMembershipSummary) => void;
  onRemove: (room: SharedRoomMembershipSummary) => void;
  style?: any;
  index?: number;
}) {
  const title = sharedRoomDisplayTitle(room);
  const unavailable = room.availability === 'unavailable';
  const openable = canOpenSharedRoom(room);
  const reducedMotion = useReducedMotion();
  const enter = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reducedMotion) {
      enter.setValue(1);
      return undefined;
    }
    enter.setValue(0);
    const animation = Animated.timing(enter, {
      toValue: 1,
      duration: MOTION.microDuration,
      delay: sharedRoomEnterDelayMs(index, MOTION.chipStagger),
      easing: Easing.bezier(
        MOTION.easing.x1,
        MOTION.easing.y1,
        MOTION.easing.x2,
        MOTION.easing.y2,
      ),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
    // Re-run only when the card's own identity or the motion preference
    // changes; `index`/`enter` are stable per mounted card instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.shareToken, reducedMotion]);

  const enterStyle = {
    opacity: enter,
    transform: [
      {
        translateY: enter.interpolate({
          inputRange: [0, 1],
          outputRange: [8, 0],
        }),
      },
    ],
  };

  return (
    <Animated.View
      style={[
        styles.card,
        styles.sharedCard,
        unavailable && styles.sharedCardUnavailable,
        style,
        removing && styles.sharedCardRemoving,
        enterStyle,
      ]}
    >
      <Pressable
        style={({ pressed }) => [
          styles.sharedCardPressable,
          pressed && openable && styles.cardPressed,
        ]}
        onPress={() => {
          if (openable) onOpen(room);
        }}
        disabled={!openable || removing}
        accessibilityRole="button"
        accessibilityLabel={sharedRoomAccessibilityLabel(room)}
        accessibilityHint={
          openable
            ? 'Open this shared Dressing Room'
            : 'This shared room is no longer available'
        }
        accessibilityState={{ disabled: !openable || removing, busy: removing }}
      >
        <View style={[styles.cover, styles.coverFallback, unavailable && styles.sharedCoverUnavailable]}>
          <Text style={styles.coverGlyph}>{SHARED_ROOM_GLYPH}</Text>
          <Text style={styles.coverFallbackText}>{unavailable ? 'GONE' : 'SHARED'}</Text>
        </View>
        <View style={styles.cardBody}>
          <View style={styles.sharedPillRow}>
            <StatusPill
              label={unavailable ? 'Shared · Unavailable' : 'Shared · View only'}
              variant={unavailable ? 'neutral' : 'gold'}
            />
          </View>
          <Text style={[styles.cardTitle, unavailable && styles.sharedTitleUnavailable]} numberOfLines={2}>
            {title}
          </Text>
          <Text style={[styles.cardMeta, unavailable && styles.sharedMetaUnavailable]}>
            {sharedRoomItemCountLabel(room)}
          </Text>
        </View>
      </Pressable>
      <View style={styles.sharedRemoveWrap}>
        <TertiaryButton
          title={removing ? 'Removing' : 'Remove from list'}
          onPress={() => onRemove(room)}
          disabled={removing}
          loading={removing}
          accessibilityLabel={`Remove ${title} from Shared with Me list`}
        />
      </View>
    </Animated.View>
  );
}

/**
 * Static placeholder shown only while the very first load is in flight.
 * Matches the app's existing skeleton convention (solid tinted block, no
 * shimmer/animation) used by CatalogProductImage in ProductShelf.tsx, and is
 * hidden from assistive technology since it carries no real content.
 */
function SharedRoomSkeletonCard({ style }: { style?: any }) {
  return (
    <View
      style={[styles.card, styles.sharedCard, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.cover, styles.skeletonBlock]} />
      <View style={styles.cardBody}>
        <View style={[styles.skeletonLine, styles.skeletonLineWide]} />
        <View style={[styles.skeletonLine, styles.skeletonLineNarrow]} />
      </View>
    </View>
  );
}

function SharedWithMeSection({
  rooms,
  loading,
  phase,
  unauthenticated,
  removingToken,
  removeError,
  onRetry,
  onOpen,
  onRemove,
  onClearRemoveError,
}: {
  rooms: SharedRoomMembershipSummary[];
  loading: boolean;
  phase: 'idle' | 'loading' | 'ready' | 'empty' | 'temporary_failure' | 'unauthenticated';
  unauthenticated: boolean;
  removingToken: string | null;
  removeError: string | null;
  onRetry: () => void;
  onOpen: (room: SharedRoomMembershipSummary) => void;
  onRemove: (room: SharedRoomMembershipSummary) => void;
  onClearRemoveError: () => void;
}) {
  if (unauthenticated) {
    return null;
  }

  const presentation = getSharedWithMeSectionPresentation({
    phase,
    rooms,
    loading,
  });

  return (
    <View style={styles.sharedSection} accessibilityLabel="Shared with Me">
      <SectionHeader
        title="Shared with Me"
        subtitle={presentation.sectionSubtitle}
      />

      {removeError ? (
        <InlineNotice
          variant="warning"
          title="Unable to update list"
          body={removeError}
          action={{
            label: 'Dismiss',
            onPress: onClearRemoveError,
            accessibilityLabel: 'Dismiss shared room removal error',
          }}
          style={styles.sharedNotice}
        />
      ) : null}

      {presentation.showTemporaryFailure ? (
        <InlineNotice
          variant="warning"
          title="Shared rooms unavailable"
          body={presentation.failureBody || SHARED_WITH_ME_REFRESH_ERROR}
          action={{
            label: 'Retry',
            onPress: onRetry,
            accessibilityLabel: 'Retry loading shared rooms',
          }}
          style={styles.sharedNotice}
        />
      ) : null}

      {presentation.showLoading ? (
        <>
          <View style={styles.sharedLoading}>
            <ActivityIndicator size="small" color={LUXURY.colors.plum} />
            <Text style={styles.sharedLoadingLabel}>Loading shared rooms…</Text>
          </View>
          <View style={styles.roomGrid}>
            <SharedRoomSkeletonCard style={styles.gridItem} />
            <SharedRoomSkeletonCard style={styles.gridItem} />
          </View>
        </>
      ) : null}

      {presentation.showEmpty ? (
        <EmptyStateCard
          title={presentation.emptyTitle || 'No shared rooms yet'}
          subtitle={
            presentation.emptySubtitle ||
            'Shared rooms will appear here after you open a Dressing Room link.'
          }
        />
      ) : null}

      {presentation.showRooms ? (
        <View style={styles.roomGrid}>
          {rooms.map((room, index) => (
            <SharedRoomCard
              key={room.shareToken}
              room={room}
              removing={removingToken === room.shareToken}
              onOpen={onOpen}
              onRemove={onRemove}
              style={styles.gridItem}
              index={index}
            />
          ))}
        </View>
      ) : null}
    </View>
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
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  // Reset the draft on every open, not on every individual dismissal path.
  // This one effect covers Cancel, Android Back, and successful creation —
  // whatever path set `visible` back to false — so no dismissal route can
  // leave stale title/description/error behind for the next open (BUG-04).
  // A recoverable failure keeps the modal visible, so this effect does not
  // re-fire and the current draft remains available for correction.
  useEffect(() => {
    if (visible) {
      setTitle('');
      setDescription('');
      setError(null);
      setSaving(false);
      savingRef.current = false;
    }
  }, [visible]);

  const canSave = useMemo(() => title.trim().length > 0 && !saving, [title, saving]);

  const handleSave = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await createDressingRoom({ userId: user?.id, title, description });
      onCreated();
      onClose();
    } catch (err: any) {
      console.error('Create dressing room failed', err);
      setError(DRESSING_ROOM_SAVE_ERROR);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* KeyboardAvoidingView + a scrollable content container: on both
          platforms a Modal is a separate native window, so the app's own
          softwareKeyboardLayoutMode/insets handling does not reach it. Without
          this, the keyboard covers the Title/Description fields and the
          Create Room / Cancel buttons (BUG-03). */}
      <KeyboardAvoidingView
        style={styles.modalKeyboardAvoider}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.modalBackdrop}>
          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={[
              styles.modalScrollContent,
              { paddingBottom: Math.max(SPACING.xl, insets.bottom + SPACING.md) },
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
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
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function DressingRoomsContent() {
  const { rooms, loading, error, reload } = useDressingRooms();
  const shared = useSharedRoomMemberships();
  const [creating, setCreating] = useState(false);
  const navGuardRef = useRef<{ token: string; at: number } | null>(null);
  const removePromptTokenRef = useRef<string | null>(null);
  const friendlyError = error ? DRESSING_ROOM_LOAD_ERROR : null;

  const handleOpenSharedRoom = useCallback((room: SharedRoomMembershipSummary) => {
    if (!canOpenSharedRoom(room)) return;
    const path = buildSharedRoomNativePath(room.shareToken);
    if (!path) return;
    const now = Date.now();
    const prior = navGuardRef.current;
    if (prior && prior.token === room.shareToken && now - prior.at < NAV_GUARD_MS) {
      return;
    }
    navGuardRef.current = { token: room.shareToken, at: now };
    router.push(path as any);
  }, []);

  const handleRemoveSharedRoom = useCallback((room: SharedRoomMembershipSummary) => {
    if (shared.removingToken || removePromptTokenRef.current) return;
    removePromptTokenRef.current = room.shareToken;
    const clearPromptGuard = () => {
      if (removePromptTokenRef.current === room.shareToken) {
        removePromptTokenRef.current = null;
      }
    };
    const dialogTitle = formatSharedRoomDialogTitle(sharedRoomDisplayTitle(room));
    Alert.alert(
      'Remove shared room?',
      `This removes “${dialogTitle}” from your Shared with Me list. It does not delete the owner’s Dressing Room or disable the share link.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: clearPromptGuard },
        {
          text: 'Remove from list',
          style: 'destructive',
          onPress: () => {
            clearPromptGuard();
            void shared.removeFromList(room);
          },
        },
      ],
      { cancelable: true, onDismiss: clearPromptGuard },
    );
  }, [shared.removeFromList, shared.removingToken]);

  return (
    <LuxuryScreen
      scrollable={false}
      safeArea
      backgroundColor={LUXURY.colors.ivory}
      accessibilityLabel="Dressing Rooms list"
    >
      <StatusBar style="dark" />
      <KScanHeader
        title="Dressing Rooms"
        subtitle="PRIVATE STYLING BOARDS"
        onBack={() => goBackOrHome(router)}
        backLabel="Back"
        rightAction={
          <Pressable
            onPress={() => router.replace('/')}
            style={styles.homeButton}
            accessibilityRole="button"
            accessibilityLabel="Go Home"
            accessibilityHint="Returns to the K Scan home screen"
          >
            <Text style={styles.homeButtonText}>HOME</Text>
          </Pressable>
        }
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styleObjectStyles.content, styles.content]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <SectionHeader
          title="My Dressing Rooms"
          subtitle={
            loading
              ? 'Loading your rooms'
              : error
                ? 'Unable to refresh'
                : `${rooms.length} private styling space${rooms.length === 1 ? '' : 's'}`
          }
          actionLabel="New"
          onAction={() => setCreating(true)}
          actionAccessibilityLabel="Create new dressing room"
          actionVariant="pill"
        />

        {loading ? (
          <View style={styles.sectionLoading}>
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          </View>
        ) : null}

        {!loading && error ? (
          <InlineNotice
            variant="error"
            title="Unable to load Dressing Rooms"
            body={friendlyError || 'Something went wrong. Please try again.'}
            action={{ label: 'Retry', onPress: reload, accessibilityLabel: 'Retry loading dressing rooms' }}
            style={styles.sharedNotice}
          />
        ) : null}

        {!loading && !error && rooms.length === 0 ? (
          <EmptyStateCard
            title="Start Your First Styling Room"
            subtitle="Create a private board to compare scans, notes, and looks."
            action={{
              label: 'Create Room',
              onPress: () => setCreating(true),
              accessibilityLabel: 'Create new dressing room',
            }}
          />
        ) : null}

        {!loading && !error && rooms.length > 0 ? (
          <View style={styles.roomGrid}>
            {rooms.map((room) => (
              <RoomCard key={room.id} room={room} style={styles.gridItem} />
            ))}
          </View>
        ) : null}

        <SharedWithMeSection
          rooms={shared.rooms}
          loading={shared.loading}
          phase={shared.snapshot.phase}
          unauthenticated={shared.unauthenticated}
          removingToken={shared.removingToken}
          removeError={shared.removeError}
          onRetry={() => {
            void shared.reload();
          }}
          onOpen={handleOpenSharedRoom}
          onRemove={handleRemoveSharedRoom}
          onClearRemoveError={shared.clearRemoveError}
        />
      </ScrollView>

      <CreateRoomModal visible={creating} onClose={() => setCreating(false)} onCreated={reload} />
      <PrivacyFooter
        onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/legal/delete-account')}
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
  scrollView: {
    flex: 1,
  },
  content: {
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xxxl,
    flexGrow: 1,
  },
  sectionLoading: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xl,
  },
  roomGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -SPACING.sm,
  },
  gridItem: {
    width: '50%',
    padding: SPACING.sm,
  },
  homeButton: {
    borderRadius: RADIUS.pill,
    borderWidth: 1.5,
    borderColor: COLORS.gold,
    backgroundColor: COLORS.surfaceCard,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    minHeight: 36,
    justifyContent: 'center',
    alignItems: 'center',
    ...SHADOWS.editorialSmall,
  },
  homeButtonText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 1.2,
    color: LUXURY.colors.goldBrushed,
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
    aspectRatio: 3 / 4,
    backgroundColor: LUXURY.colors.champagne,
  },
  coverFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  coverGlyph: {
    fontSize: 28,
    color: LUXURY.colors.goldBrushed,
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
  sharedSection: {
    marginTop: SPACING.xl,
    gap: SPACING.md,
    paddingBottom: SPACING.xl,
  },
  sharedNotice: {
    marginBottom: 0,
  },
  sharedLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.md,
  },
  sharedLoadingLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  sharedCard: {
    width: '100%',
  },
  sharedCardUnavailable: {
    opacity: 0.72,
  },
  sharedCardRemoving: {
    opacity: 0.55,
  },
  sharedCardPressable: {
    width: '100%',
  },
  sharedCoverUnavailable: {
    backgroundColor: LUXURY.colors.champagne,
  },
  sharedPillRow: {
    flexDirection: 'row',
    marginBottom: SPACING.xs,
  },
  sharedTitleUnavailable: {
    color: LUXURY.colors.graphite,
  },
  sharedMetaUnavailable: {
    color: LUXURY.colors.stone,
  },
  sharedRemoveWrap: {
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
    alignItems: 'center',
  },
  skeletonBlock: {
    backgroundColor: LUXURY.colors.champagne,
  },
  skeletonLine: {
    height: 10,
    borderRadius: RADIUS.sm,
    backgroundColor: LUXURY.colors.champagne,
  },
  skeletonLineWide: {
    width: '70%',
    marginBottom: SPACING.sm,
  },
  skeletonLineNarrow: {
    width: '40%',
  },
  modalKeyboardAvoider: {
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: COLORS.backdrop,
  },
  modalScroll: {
    flex: 1,
  },
  modalScrollContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
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
