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
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  addScanImageToDressingRoom,
  createDressingRoom,
  listDressingRooms,
} from '../services/styleObjects';
import { hasUsableDressingRoomImageSource } from '../services/dressingRoomItemContract';
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
  /** Additional explicitly selected scanner items for the same room action. */
  additionalScans?: ReadonlyArray<{
    localImageUri?: string | null;
    storageBucket?: string | null;
    storagePath?: string | null;
    imageUrl?: string | null;
    scan?: Partial<ScanImageSnapshotSource> | null;
  }>;
  onClose: () => void;
};

export function AddScanToDressingRoomModal({
  visible,
  localImageUri,
  storageBucket,
  storagePath,
  imageUrl,
  scan,
  additionalScans = [],
  onClose,
}: Props) {
  const { user } = useAuthSession();
  const [rooms, setRooms] = useState<DressingRoom[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newRoomTitle, setNewRoomTitle] = useState('');
  const [savedRoomId, setSavedRoomId] = useState<string | null>(null);
  const savingRef = useRef(false);

  // Only fetch rooms when the modal opens — never on background screen focus.
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRooms(await listDressingRooms());
    } catch (err: any) {
      setError(err?.message || 'Unable to load Dressing Rooms.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      setMessage(null);
      setNewRoomTitle('');
      setSavedRoomId(null);
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

  const saveAllToRoom = async (roomId: string): Promise<{ saved: number; total: number }> => {
    const scans = buildScans();
    const results = await Promise.allSettled(scans.map((item) => addScanImageToDressingRoom({
      dressingRoomId: roomId,
      userId: user?.id,
      scan: item,
    })));
    return { saved: results.filter((result) => result.status === 'fulfilled').length, total: scans.length };
  };

  const handleSave = async (roomId: string, roomTitle: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const result = await saveAllToRoom(roomId);
      if (result.saved === 0) throw new Error('No items could be added.');
      setSavedRoomId(roomId);
      setMessage(result.saved === result.total
        ? `Added ${result.saved === 1 ? 'item' : `${result.saved} items`} to ${roomTitle}.`
        : `Added ${result.saved} of ${result.total} items to ${roomTitle}.`);
    } catch (err: any) {
      setMessage(err?.message || 'Could not save scan. Please try again.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleCreateAndSave = async () => {
    if (!newRoomTitle.trim() || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const room = await createDressingRoom({
        userId: user?.id,
        title: newRoomTitle,
        description: null,
      });
      const result = await saveAllToRoom(room.id);
      if (result.saved === 0) throw new Error('No items could be added.');
      await reload();
      setSavedRoomId(room.id);
      setMessage(result.saved === result.total
        ? `Added ${result.saved === 1 ? 'item' : `${result.saved} items`} to ${room.title}.`
        : `Added ${result.saved} of ${result.total} items to ${room.title}.`);
    } catch (err: any) {
      setMessage(err?.message || 'Could not save scan. Please try again.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleViewDressingRoom = () => {
    onClose();
    router.push('/dressing-rooms');
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
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
              <Text style={styles.title}>Add Scan to Dressing Room</Text>
              <Text style={styles.subtitle}>
                Save this clothing-focused image to a Dressing Room. Avoid faces, bystanders, or sensitive information.
              </Text>

              {missingImage ? (
                <Text style={styles.message}>This scan doesn't have a usable image yet, so it can't be added to a Dressing Room.</Text>
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
                    accessibilityLabel="Continue scanning"
                  >
                    <Text style={styles.secondaryText}>Continue Scanning</Text>
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
                          accessibilityLabel={`Save scan to ${room.title}`}
                          accessibilityHint={`Adds this scan to ${room.title}`}
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
                      accessibilityHint="Create a new room and save the scan to it"
                    />
                  </View>

                  <TouchableOpacity
                    style={[styles.primaryButton, (!newRoomTitle.trim() || saving) && styles.disabled]}
                    onPress={handleCreateAndSave}
                    disabled={!newRoomTitle.trim() || saving}
                    accessibilityRole="button"
                    accessibilityLabel="Create new room and save scan"
                  >
                    {saving ? (
                      <ActivityIndicator color={LUXURY.colors.inverse} />
                    ) : (
                      <Text style={styles.primaryText}>CREATE + SAVE SCAN</Text>
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
    width: '100%',
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
