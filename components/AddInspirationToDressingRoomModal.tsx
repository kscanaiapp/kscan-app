import React, { useCallback, useEffect, useState } from 'react';
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
  addInspirationToDressingRoom,
  createDressingRoom,
  listDressingRooms,
} from '../services/styleObjects';
import type { DressingRoom } from '../types/styleObjects';

// Adds an EXISTING Closet/Inspiration item to a Dressing Room. Unlike
// AddScanToDressingRoomModal, this never uploads an image — the Closet item is
// already stored in Supabase, so we only create the room link. Raw Supabase/RLS
// errors are never surfaced to the user; see SAVE_ERROR.
const SAVE_ERROR = 'Could not add this item to your Dressing Room. Please try again.';
const LOAD_ERROR = 'Could not load your Dressing Rooms. Please try again.';

type Props = {
  visible: boolean;
  inspirationId?: string | null;
  inspirationLabel?: string | null;
  onClose: () => void;
};

export function AddInspirationToDressingRoomModal({
  visible,
  inspirationId,
  inspirationLabel,
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

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRooms(await listDressingRooms());
    } catch (err) {
      console.warn('Load dressing rooms for inspiration add failed', err);
      setError(LOAD_ERROR);
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

  const missingItem = !inspirationId;

  const handleSave = async (roomId: string, roomTitle: string) => {
    if (saving || !inspirationId) return;
    setSaving(true);
    setMessage(null);
    try {
      await addInspirationToDressingRoom({
        roomId,
        inspirationId,
        userId: user?.id,
      });
      setSavedRoomId(roomId);
      setMessage(`Added to ${roomTitle}.`);
    } catch (err) {
      console.warn('Add inspiration to dressing room failed', err);
      setMessage(SAVE_ERROR);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAndSave = async () => {
    if (!newRoomTitle.trim() || saving || !inspirationId) return;
    setSaving(true);
    setMessage(null);
    try {
      const room = await createDressingRoom({
        userId: user?.id,
        title: newRoomTitle,
        description: null,
      });
      await addInspirationToDressingRoom({
        roomId: room.id,
        inspirationId,
        userId: user?.id,
      });
      await reload();
      setSavedRoomId(room.id);
      setMessage(`Added to ${room.title}.`);
    } catch (err) {
      console.warn('Create room and add inspiration failed', err);
      setMessage(SAVE_ERROR);
    } finally {
      setSaving(false);
    }
  };

  const handleViewDressingRoom = () => {
    onClose();
    router.push('/dressing-rooms');
  };

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
              <Text style={styles.title}>Add to Dressing Room</Text>
              <Text style={styles.subtitle}>
                {inspirationLabel
                  ? `Add "${inspirationLabel}" from your Closet to a Dressing Room.`
                  : 'Add this Closet item to a Dressing Room. Your image stays in your Closet too.'}
              </Text>

              {missingItem ? (
                <Text style={styles.message}>This Closet item is unavailable.</Text>
              ) : successState ? (
                <>
                  <Text style={styles.successTitle}>Added to Dressing Room</Text>
                  {message ? <Text style={styles.message}>{message}</Text> : null}
                  <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={handleViewDressingRoom}
                    accessibilityRole="button"
                    accessibilityLabel="View Dressing Rooms"
                  >
                    <Text style={styles.primaryText}>View Dressing Rooms</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel="Done"
                  >
                    <Text style={styles.secondaryText}>Done</Text>
                  </TouchableOpacity>
                </>
              ) : loading ? (
                <ActivityIndicator color={LUXURY.colors.plum} />
              ) : error ? (
                <>
                  <Text style={styles.message}>{error}</Text>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={reload}
                    accessibilityRole="button"
                    accessibilityLabel="Retry loading Dressing Rooms"
                  >
                    <Text style={styles.secondaryText}>Retry</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <View style={styles.roomList}>
                    {rooms.length === 0 ? (
                      <Text style={styles.message}>Create your first Dressing Room below.</Text>
                    ) : (
                      rooms.map((room) => (
                        <TouchableOpacity
                          key={room.id}
                          style={styles.roomChoice}
                          onPress={() => handleSave(room.id, room.title)}
                          disabled={saving}
                          accessibilityRole="button"
                          accessibilityLabel={`Add Closet item to ${room.title}`}
                          accessibilityHint={`Adds this Closet item to ${room.title}`}
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
                      accessibilityHint="Create a new room and add this Closet item to it"
                    />
                  </View>

                  <TouchableOpacity
                    style={[styles.primaryButton, (!newRoomTitle.trim() || saving) && styles.disabled]}
                    onPress={handleCreateAndSave}
                    disabled={!newRoomTitle.trim() || saving}
                    accessibilityRole="button"
                    accessibilityLabel="Create new room and add Closet item"
                  >
                    {saving ? (
                      <ActivityIndicator color={LUXURY.colors.inverse} />
                    ) : (
                      <Text style={styles.primaryText}>CREATE + ADD</Text>
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
                    accessibilityLabel="Close add to Dressing Room"
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
