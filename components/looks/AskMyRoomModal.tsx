// ASK MY ROOM — shares 1–3 Looks to a Dressing Room as an outfit decision.
//
// Shared by Look Detail (single Look) and the AI Stylist results screen
// (multiple options). The owner picks an existing room or creates a new one,
// chooses a question preset (or writes a custom question), and shares. The
// share is atomic server-side (share_looks_to_outfit_decision) and produces
// immutable snapshots; an in-flight guard prevents duplicate decision groups.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { TextField } from '../StyleObjectCards';
import { InlineNotice, PrimaryButton, SecondaryButton } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import {
  createDressingRoom,
  listDressingRooms,
} from '../../services/styleObjects';
import {
  DECISION_QUESTION_PRESETS,
  shareLooksToRoom,
} from '../../services/outfitDecisions';
import { recordAiStylistEvent } from '../../services/styleMemoryEvents';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import type { DressingRoom } from '../../types/styleObjects';
import { createAskMyRoomShareGuard } from './askMyRoomShareGuard';

const CUSTOM_QUESTION = 'Custom';

export function AskMyRoomModal({
  visible,
  lookIds,
  onClose,
  onShared,
}: {
  visible: boolean;
  /** 1–3 Looks; order is preserved as option order. */
  lookIds: string[];
  onClose: () => void;
  onShared?: (input: { roomId: string; groupId: string }) => void;
}) {
  const { user } = useAuthSession();
  const [rooms, setRooms] = useState<DressingRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [creatingNewRoom, setCreatingNewRoom] = useState(false);
  const [newRoomTitle, setNewRoomTitle] = useState('');
  const [questionChoice, setQuestionChoice] = useState<string>(DECISION_QUESTION_PRESETS[0]);
  const [customQuestion, setCustomQuestion] = useState('');
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shareGuardRef = useRef<ReturnType<typeof createAskMyRoomShareGuard> | null>(null);
  if (!shareGuardRef.current) {
    shareGuardRef.current = createAskMyRoomShareGuard();
  }

  const loadRooms = useCallback(async () => {
    setLoadingRooms(true);
    setError(null);
    try {
      setRooms(await listDressingRooms());
    } catch (err: any) {
      setError(err?.message || 'Unable to load your Dressing Rooms.');
    } finally {
      setLoadingRooms(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      shareGuardRef.current?.reset();
      setSharing(false);
      setError(null);
      setCreatingNewRoom(false);
      setNewRoomTitle('');
      void loadRooms();
    }
  }, [visible, loadRooms]);

  const question = questionChoice === CUSTOM_QUESTION ? customQuestion.trim() : questionChoice;
  const canShare =
    !sharing &&
    lookIds.length >= 1 &&
    lookIds.length <= 3 &&
    question.length > 0 &&
    (creatingNewRoom ? newRoomTitle.trim().length > 0 : !!selectedRoomId);

  const handleShare = async () => {
    const guard = shareGuardRef.current;
    if (!canShare || !guard?.tryBegin()) return;
    setSharing(true);
    setError(null);
    try {
      let roomId = selectedRoomId;
      if (creatingNewRoom) {
        const normalizedTitle = newRoomTitle.trim();
        roomId = guard.getCreatedRoomId(normalizedTitle);
        if (!roomId) {
          const room = await createDressingRoom({ userId: user?.id, title: normalizedTitle });
          roomId = room.id;
          guard.rememberCreatedRoom(normalizedTitle, room.id);
        }
      }
      if (!roomId) throw new Error('Choose a Dressing Room first.');

      const groupId = await shareLooksToRoom({ roomId, lookIds, question });
      void recordAiStylistEvent({
        eventType: 'ai_suggestion_shared',
        signalKey: groupId,
        payload: { optionCount: lookIds.length },
      });
      try {
        onShared?.({ roomId, groupId });
      } catch {
        // The server share succeeded. A parent callback must not turn success
        // into a retry that creates another decision group.
      }
      onClose();
    } catch (err: any) {
      // Draft state (room choice, question) is preserved for retry.
      guard.releaseForRetry();
      setSharing(false);
      setError(err?.message || 'Unable to share to this Dressing Room. Please try again.');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={sharing ? () => {} : onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Ask My Room</Text>
          <Text style={styles.subtitle}>
            {lookIds.length > 1
              ? `Share ${lookIds.length} options for your room to vote on.`
              : 'Share this Look for your room to weigh in.'}
          </Text>

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionLabel}>DRESSING ROOM</Text>
            {loadingRooms ? (
              <ActivityIndicator color={LUXURY.colors.plum} />
            ) : (
              <View style={styles.chipWrap}>
                {rooms.map((room) => {
                  const selected = !creatingNewRoom && selectedRoomId === room.id;
                  return (
                    <TouchableOpacity
                      key={room.id}
                      style={[styles.chip, selected && styles.chipSelected]}
                      onPress={() => {
                        setCreatingNewRoom(false);
                        setSelectedRoomId(room.id);
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Share to ${room.title}`}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
                        {room.title}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity
                  style={[styles.chip, creatingNewRoom && styles.chipSelected]}
                  onPress={() => setCreatingNewRoom(true)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: creatingNewRoom }}
                  accessibilityLabel="Create a new Dressing Room"
                >
                  <Text style={[styles.chipText, creatingNewRoom && styles.chipTextSelected]}>
                    + New Room
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {creatingNewRoom ? (
              <TextField label="New room name" value={newRoomTitle} onChangeText={setNewRoomTitle} />
            ) : null}

            <Text style={styles.sectionLabel}>QUESTION</Text>
            <View style={styles.chipWrap}>
              {[...DECISION_QUESTION_PRESETS, CUSTOM_QUESTION].map((preset) => {
                const selected = questionChoice === preset;
                return (
                  <TouchableOpacity
                    key={preset}
                    style={[styles.chip, selected && styles.chipSelected]}
                    onPress={() => setQuestionChoice(preset)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Question: ${preset}`}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{preset}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {questionChoice === CUSTOM_QUESTION ? (
              <TextField label="Your question" value={customQuestion} onChangeText={setCustomQuestion} />
            ) : null}

            {error ? <InlineNotice variant="error" title="Could not share" body={error} /> : null}
          </ScrollView>

          <PrimaryButton
            title={sharing ? 'Sharing' : 'Share to Room'}
            onPress={handleShare}
            disabled={!canShare}
            accessibilityLabel="Share to room"
          />
          <SecondaryButton title="Cancel" onPress={onClose} disabled={sharing} />
        </View>
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
  card: {
    borderRadius: LUXURY.cards.screen.borderRadius,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.md,
    maxHeight: '86%',
    ...LUXURY.cards.screen.shadow,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
  },
  subtitle: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
  },
  scroll: {
    flexGrow: 0,
  },
  sectionLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  chip: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.ivory,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    maxWidth: 220,
  },
  chipSelected: {
    borderColor: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.plum,
  },
  chipText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.graphite,
  },
  chipTextSelected: {
    color: LUXURY.colors.pearl,
  },
});
