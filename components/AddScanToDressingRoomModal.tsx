import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../constants/theme';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  addScanImageToDressingRoom,
  createDressingRoom,
  listDressingRooms,
} from '../services/styleObjects';
import type { DressingRoom, ScanImageSnapshotSource } from '../types/styleObjects';

type Props = {
  visible: boolean;
  localImageUri?: string | null;
  scan?: Partial<ScanImageSnapshotSource> | null;
  onClose: () => void;
};

export function AddScanToDressingRoomModal({
  visible,
  localImageUri,
  scan,
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

  const buildScan = (): ScanImageSnapshotSource => ({
    userId: user?.id,
    localImageUri,
    sourceType: scan?.sourceType ?? 'live_scan',
    sourceId: scan?.sourceId ?? null,
    createdAt: scan?.createdAt ?? new Date().toISOString(),
    result: scan?.result ?? null,
    metadata: scan?.metadata ?? null,
  });

  const handleSave = async (roomId: string, roomTitle: string) => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await addScanImageToDressingRoom({
        dressingRoomId: roomId,
        userId: user?.id,
        scan: buildScan(),
      });
      setSavedRoomId(roomId);
      setMessage(`Added to ${roomTitle}.`);
    } catch (err: any) {
      setMessage(err?.message || 'Could not save scan. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAndSave = async () => {
    if (!newRoomTitle.trim() || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const room = await createDressingRoom({
        userId: user?.id,
        title: newRoomTitle,
        description: null,
      });
      await addScanImageToDressingRoom({
        dressingRoomId: room.id,
        userId: user?.id,
        scan: buildScan(),
      });
      await reload();
      setSavedRoomId(room.id);
      setMessage(`Added to ${room.title}.`);
    } catch (err: any) {
      setMessage(err?.message || 'Could not save scan. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleViewDressingRoom = () => {
    onClose();
    router.push('/dressing-rooms');
  };

  const missingImage = !localImageUri;
  const successState = !!savedRoomId;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Add Scan to Dressing Room</Text>
          <Text style={styles.subtitle}>Save this captured inspiration image privately.</Text>

          {missingImage ? (
            <Text style={styles.message}>No local scan image is available.</Text>
          ) : successState ? (
            <>
              <Text style={styles.successTitle}>Added to Dressing Room</Text>
              {message ? <Text style={styles.message}>{message}</Text> : null}
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleViewDressingRoom}
                accessibilityLabel="View Dressing Room"
              >
                <Text style={styles.primaryText}>VIEW DRESSING ROOM</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondaryButton} onPress={onClose}>
                <Text style={styles.secondaryText}>CONTINUE SCANNING</Text>
              </TouchableOpacity>
            </>
          ) : loading ? (
            <ActivityIndicator color={COLORS.goldPressed} />
          ) : error ? (
            <Text style={styles.message}>{error}</Text>
          ) : (
            <>
              <ScrollView style={styles.roomList} contentContainerStyle={styles.roomListContent}>
                {rooms.length === 0 ? (
                  <Text style={styles.message}>Create your first Dressing Room.</Text>
                ) : (
                  rooms.map((room) => (
                    <TouchableOpacity
                      key={room.id}
                      style={styles.roomChoice}
                      onPress={() => handleSave(room.id, room.title)}
                      disabled={saving}
                    >
                      <Text style={styles.roomChoiceTitle}>{room.title}</Text>
                      <Text style={styles.roomChoiceMeta}>{room.itemCount ?? 0} ITEMS</Text>
                      {saving ? <ActivityIndicator color={COLORS.goldPressed} /> : null}
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>

              <View style={styles.quickCreate}>
                <Text style={styles.quickCreateLabel}>NEW ROOM</Text>
                <TextInput
                  value={newRoomTitle}
                  onChangeText={setNewRoomTitle}
                  placeholder="Inspiration Board"
                  placeholderTextColor={COLORS.editorialTextMuted}
                  style={styles.input}
                />
              </View>

              <TouchableOpacity
                style={[styles.primaryButton, (!newRoomTitle.trim() || saving) && styles.disabled]}
                onPress={handleCreateAndSave}
                disabled={!newRoomTitle.trim() || saving}
              >
                {saving ? (
                  <ActivityIndicator color={COLORS.textInverse} />
                ) : (
                  <Text style={styles.primaryText}>CREATE + SAVE SCAN</Text>
                )}
              </TouchableOpacity>
            </>
          )}

          {!successState ? (
            <>
              {message ? <Text style={styles.message}>{message}</Text> : null}
              <TouchableOpacity style={styles.secondaryButton} onPress={onClose} disabled={saving}>
                <Text style={styles.secondaryText}>CLOSE</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: COLORS.backdrop,
    padding: SPACING.xl,
  },
  card: {
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.xl,
    maxHeight: '84%',
    ...SHADOWS.editorialRaised,
  },
  title: {
    ...TYPOGRAPHY.title,
    color: COLORS.editorialTextPrimary,
  },
  successTitle: {
    ...TYPOGRAPHY.title,
    color: COLORS.editorialTextPrimary,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
  subtitle: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextSecondary,
    marginTop: SPACING.xs,
    marginBottom: SPACING.md,
  },
  roomList: {
    maxHeight: 260,
  },
  roomListContent: {
    gap: SPACING.sm,
  },
  roomChoice: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  roomChoiceTitle: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.editorialTextPrimary,
  },
  roomChoiceMeta: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
  },
  quickCreate: {
    marginTop: SPACING.lg,
    gap: SPACING.sm,
  },
  quickCreateLabel: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
  },
  input: {
    minHeight: 48,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    color: COLORS.editorialTextPrimary,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: 14,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.gold,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    marginTop: SPACING.md,
  },
  primaryText: {
    ...TYPOGRAPHY.cta,
    color: COLORS.textInverse,
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.md,
  },
  secondaryText: {
    ...TYPOGRAPHY.cta,
    color: COLORS.editorialTextSecondary,
  },
  disabled: {
    opacity: 0.48,
  },
  message: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.editorialTextSecondary,
    textAlign: 'center',
    marginTop: SPACING.md,
  },
});
