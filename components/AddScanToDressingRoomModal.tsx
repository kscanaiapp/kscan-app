import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../constants/theme';
import { MODAL_MAX_WIDTH } from '../services/responsiveLayout';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  addScanImageToDressingRoom,
  createDressingRoom,
  listDressingRooms,
} from '../services/styleObjects';
import { hasUsableDressingRoomImageSource } from '../services/dressingRoomItemContract';
import { captureActorScope, isActorScopeCurrent, type ActorScope } from '../services/actorScope';
import type { DressingRoom, ScanImageSnapshotSource } from '../types/styleObjects';

type Props = {
  visible: boolean;
  localImageUri?: string | null;
  // Durable storage reference / remote URL for this scan's image, when the
  // local device URI is absent or was never the source of truth (e.g. a
  // cloud-synced saved scan). See services/dressingRoomItemContract.ts.
  storageBucket?: string | null;
  storagePath?: string | null;
  imageUrl?: string | null;
  scan?: Partial<ScanImageSnapshotSource> | null;
  /** Additional analyzed Scanner items for the same explicit room action. */
  additionalScans?: ReadonlyArray<{
    localImageUri?: string | null;
    storageBucket?: string | null;
    storagePath?: string | null;
    imageUrl?: string | null;
    scan?: Partial<ScanImageSnapshotSource> | null;
  }>;
  onClose: () => void;
  variant?: 'scan' | 'vto_try_on';
  /** Fired only after the durable Dressing Room write is confirmed. */
  onSaved?: (roomTitle: string) => void;
  onBeforeNavigate?: () => void;
};

const COPY = {
  scan: {
    title: 'Add Scan to Dressing Room',
    subtitle: 'Save this clothing-focused image to a Dressing Room. Avoid faces, bystanders, or sensitive information.',
    missingImage: "This scan doesn't have a usable image yet, so it can't be added to a Dressing Room.",
    continueLabel: 'Continue scanning',
    createAndSave: 'CREATE + SAVE SCAN',
    createAndSaveA11y: 'Create new room and save scan',
    newRoomHint: 'Create a new room and save the scan to it',
    saveToRoomA11y: (room: string) => `Save scan to ${room}`,
    saveToRoomHint: (room: string) => `Adds this scan to ${room}`,
    saveFailed: 'Could not save scan. Please try again.',
  },
  vto_try_on: {
    title: 'Save this try-on',
    subtitle: "This try-on contains the photo you chose. It's added to the Dressing Room you pick, and anyone that room is shared with can see it.",
    missingImage: "This try-on isn't ready to save yet.",
    continueLabel: 'Back to try-on',
    createAndSave: 'CREATE + SAVE TRY-ON',
    createAndSaveA11y: 'Create new room and save this try-on',
    newRoomHint: 'Create a new room and save this try-on to it',
    saveToRoomA11y: (room: string) => `Save try-on to ${room}`,
    saveToRoomHint: (room: string) => `Adds this try-on to ${room}`,
    saveFailed: 'Could not save this try-on. Please try again.',
  },
} as const;

export function AddScanToDressingRoomModal({
  visible,
  localImageUri,
  storageBucket,
  storagePath,
  imageUrl,
  scan,
  additionalScans = [],
  onClose,
  variant = 'scan',
  onSaved,
  onBeforeNavigate,
}: Props) {
  const copy = COPY[variant];
  const { user } = useAuthSession();
  const [rooms, setRooms] = useState<DressingRoom[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newRoomTitle, setNewRoomTitle] = useState('');
  const [savedRoomId, setSavedRoomId] = useState<string | null>(null);
  const savingRef = useRef(false);
  // "View Dressing Room" closes the sheet and pushes a route. The sheet stays mounted
  // and tappable for the whole close transition and React has not repainted between two
  // rapid taps, so the once-only guard has to be a synchronous ref, not state.
  const navigatingRef = useRef(false);
  // A create that succeeded but whose add then failed leaves a real, empty room.
  // It is kept, with the title it was created under and the actor that created it,
  // so a retry adds the scan to THAT room instead of creating a second one.
  const createdRoomRef = useRef<{ title: string; room: DressingRoom; scope: ActorScope } | null>(null);

  // Only fetch rooms when the modal opens — never on background screen focus.
  // Actor-bound like useDressingRooms: a list requested as one actor that resolves
  // after another has signed in is dropped, never shown (services/actorScope).
  const reload = useCallback(async () => {
    const scope = captureActorScope();
    setLoading(true);
    setError(null);
    try {
      const nextRooms = await listDressingRooms();
      if (!isActorScopeCurrent(scope)) return;
      setRooms(nextRooms);
    } catch (err: any) {
      if (!isActorScopeCurrent(scope)) return;
      setError(err?.message || 'Unable to load Dressing Rooms.');
    } finally {
      if (isActorScopeCurrent(scope)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      setMessage(null);
      setNewRoomTitle('');
      setSavedRoomId(null);
      createdRoomRef.current = null;
      // A new opening may navigate once again. Reset here, on OPEN, not on close: the
      // sheet is still tappable while it fades out, which is the window being guarded.
      navigatingRef.current = false;
      void reload();
    }
  }, [visible, reload]);

  const buildScans = (): ScanImageSnapshotSource[] => [
    { localImageUri, storageBucket, storagePath, imageUrl, scan },
    ...additionalScans,
  ].map((item) => ({
    userId: user?.id,
    localImageUri: item.localImageUri,
    storageBucket: item.storageBucket,
    storagePath: item.storagePath,
    imageUrl: item.imageUrl,
    sourceType: item.scan?.sourceType ?? 'live_scan',
    sourceId: item.scan?.sourceId ?? null,
    createdAt: item.scan?.createdAt ?? new Date().toISOString(),
    result: item.scan?.result ?? null,
    metadata: item.scan?.metadata ?? null,
  }));

  const saveAllToRoom = async (
    roomId: string,
    scope: ActorScope,
  ): Promise<{ saved: number; total: number; actorChanged: boolean }> => {
    const scans = buildScans();
    let saved = 0;
    for (const item of scans) {
      if (!isActorScopeCurrent(scope)) {
        return { saved, total: scans.length, actorChanged: true };
      }
      try {
        await addScanImageToDressingRoom({
          dressingRoomId: roomId,
          userId: user?.id,
          scan: item,
        });
        saved += 1;
      } catch {
        // Preserve successful siblings; the caller reports the truthful count.
      }
    }
    return { saved, total: scans.length, actorChanged: !isActorScopeCurrent(scope) };
  };

  const handleSave = async (roomId: string, roomTitle: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const scope = captureActorScope();
    setSaving(true);
    setMessage(null);
    try {
      const result = await saveAllToRoom(roomId, scope);
      // A write that finished for a previous actor is theirs, not this session's.
      if (result.actorChanged || !isActorScopeCurrent(scope)) return;
      if (result.saved === 0) throw new Error('No items could be added.');
      setSavedRoomId(roomId);
      setMessage(result.saved === result.total
        ? `Added ${result.saved === 1 ? 'item' : `${result.saved} items`} to ${roomTitle}.`
        : `Added ${result.saved} of ${result.total} items to ${roomTitle}.`);
      onSaved?.(roomTitle);
    } catch (err: any) {
      if (!isActorScopeCurrent(scope)) return;
      setMessage(err?.message || copy.saveFailed);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleCreateAndSave = async () => {
    const title = newRoomTitle.trim();
    if (!title || savingRef.current) return;
    savingRef.current = true;
    const scope = captureActorScope();
    setSaving(true);
    setMessage(null);
    try {
      const created = createdRoomRef.current;
      const reusable =
        created && created.title === title && isActorScopeCurrent(created.scope) ? created.room : null;
      const room =
        reusable ??
        (await createDressingRoom({
          userId: user?.id,
          title: newRoomTitle,
          description: null,
        }));
      createdRoomRef.current = { title, room, scope };
      const result = await saveAllToRoom(room.id, scope);
      if (result.actorChanged || !isActorScopeCurrent(scope)) return;
      if (result.saved === 0) throw new Error('No items could be added.');
      await reload();
      if (!isActorScopeCurrent(scope)) return;
      setSavedRoomId(room.id);
      setMessage(result.saved === result.total
        ? `Added ${result.saved === 1 ? 'item' : `${result.saved} items`} to ${room.title}.`
        : `Added ${result.saved} of ${result.total} items to ${room.title}.`);
      onSaved?.(room.title);
    } catch (err: any) {
      if (!isActorScopeCurrent(scope)) return;
      setMessage(err?.message || copy.saveFailed);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleViewDressingRoom = () => {
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    onBeforeNavigate?.();
    onClose();
    router.push('/dressing-rooms');
  };

  // The Modal's own request-close path (Android hardware Back). The visible Close
  // button is disabled while a save is in flight; this path must be too, or Back
  // dismisses the sheet and the customer never sees the outcome of a write that still
  // completes. The in-flight write itself is left alone. Read from the ref, the
  // synchronous source of truth for "saving", not from state that may lag a repaint.
  const handleRequestClose = () => {
    if (savingRef.current) return;
    onClose();
  };

  // Uses the same canonical contract as the rest of the Dressing Room add
  // pipeline (storage > remote URL > local URI), not bare localImageUri
  // truthiness — a cloud-synced scan with no local file left on this device
  // can still be added when it has a durable storage reference or URL.
  const missingImage =
    !hasUsableDressingRoomImageSource({ localUri: localImageUri, storageBucket, storagePath, imageUrl }) ||
    additionalScans.some((item) => !hasUsableDressingRoomImageSource({
      localUri: item.localImageUri,
      storageBucket: item.storageBucket,
      storagePath: item.storagePath,
      imageUrl: item.imageUrl,
    }));
  const successState = !!savedRoomId;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleRequestClose}>
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          style={styles.keyboardContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <View style={styles.card}>
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.title} accessibilityRole="header">{copy.title}</Text>
              <Text style={styles.subtitle}>{copy.subtitle}</Text>

              {missingImage ? (
                <Text style={styles.message}>{copy.missingImage}</Text>
              ) : successState ? (
                <>
                  <Text style={styles.successTitle}>Added to Dressing Room</Text>
                  {message ? <Text style={styles.message}>{message}</Text> : null}
                  <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={handleViewDressingRoom}
                    accessibilityRole="button"
                    accessibilityLabel="View Dressing Room"
                  >
                    <Text style={styles.primaryText}>View Dressing Room</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel={copy.continueLabel}
                  >
                    <Text style={styles.secondaryText}>{copy.continueLabel}</Text>
                  </TouchableOpacity>
                </>
              ) : loading ? (
                <ActivityIndicator color={LUXURY.colors.plum} />
              ) : error ? (
                <Text style={styles.message}>{error}</Text>
              ) : (
                <>
                  <View style={styles.roomList}>
                    {rooms.length === 0 ? (
                      <Text style={styles.message}>Create your first Dressing Room.</Text>
                    ) : (
                      rooms.map((room) => (
                        <TouchableOpacity
                          key={room.id}
                          style={styles.roomChoice}
                          onPress={() => handleSave(room.id, room.title)}
                          disabled={saving}
                          accessibilityRole="button"
                          accessibilityLabel={copy.saveToRoomA11y(room.title)}
                          accessibilityHint={copy.saveToRoomHint(room.title)}
                        >
                          <Text style={styles.roomChoiceTitle}>{room.title}</Text>
                          <Text style={styles.roomChoiceMeta}>{room.itemCount ?? 0} ITEMS</Text>
                          {saving ? <ActivityIndicator color={LUXURY.colors.plum} /> : null}
                        </TouchableOpacity>
                      ))
                    )}
                  </View>

                  <View style={styles.quickCreate}>
                    <Text style={styles.quickCreateLabel}>New Room</Text>
                    <TextInput
                      value={newRoomTitle}
                      onChangeText={setNewRoomTitle}
                      placeholder="Inspiration Board"
                      placeholderTextColor={LUXURY.colors.stone}
                      style={styles.input}
                      returnKeyType="done"
                      blurOnSubmit
                      onSubmitEditing={Keyboard.dismiss}
                      accessibilityLabel="New dressing room title"
                      accessibilityHint={copy.newRoomHint}
                    />
                  </View>

                  <TouchableOpacity
                    style={[styles.primaryButton, (!newRoomTitle.trim() || saving) && styles.disabled]}
                    onPress={handleCreateAndSave}
                    disabled={!newRoomTitle.trim() || saving}
                    accessibilityRole="button"
                    accessibilityLabel={copy.createAndSaveA11y}
                  >
                    {saving ? (
                      <ActivityIndicator color={LUXURY.colors.inverse} />
                    ) : (
                      <Text style={styles.primaryText}>{copy.createAndSave}</Text>
                    )}
                  </TouchableOpacity>
                </>
              )}

              {!successState ? (
                <>
                  {message ? <Text style={styles.message}>{message}</Text> : null}
                  <TouchableOpacity
                    style={[styles.secondaryButton, saving && styles.disabled]}
                    onPress={onClose}
                    disabled={saving}
                    accessibilityRole="button"
                    accessibilityLabel="Close add to room"
                  >
                    <Text style={styles.secondaryText}>Close</Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: LUXURY.colors.plumDeep + 'C2',
    padding: SPACING.xl,
  },
  keyboardContainer: {
    // Inert on phones; caps the sheet on regular-width iPad windows.
    width: '100%',
    maxWidth: MODAL_MAX_WIDTH,
    alignSelf: 'center',
  },
  card: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    maxHeight: '84%',
    overflow: 'hidden',
    ...SHADOWS.editorialRaised,
  },
  scrollContent: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xl + 120,
    gap: 0,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
  },
  successTitle: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
  subtitle: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
    marginBottom: SPACING.md,
  },
  roomList: {
    gap: SPACING.sm,
  },
  roomChoice: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  roomChoiceTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  roomChoiceMeta: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
  },
  quickCreate: {
    marginTop: SPACING.lg,
    gap: SPACING.sm,
  },
  quickCreateLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  input: {
    minHeight: 48,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    color: LUXURY.colors.ink,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: 14,
  },
  primaryButton: {
    minHeight: 52,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    marginTop: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  primaryText: {
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
    marginTop: SPACING.md,
  },
  secondaryText: {
    ...LUXURY.typography.ctaSecondary,
    color: LUXURY.colors.plum,
  },
  disabled: {
    opacity: 0.5,
  },
  message: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
    marginTop: SPACING.md,
  },
});
