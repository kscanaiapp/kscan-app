import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  SecondaryButton,
  TertiaryButton,
} from '../../components/luxury';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import type { DressingRoom } from '../../types/styleObjects';

type Props = {
  room: DressingRoom | null;
  onEdit: () => void;
  onShare: () => void;
  onRevokeShare: () => void;
  onDelete: () => void;
  onStartEditingNote: () => void;
  canShareRoom: boolean;
  sharing: boolean;
  revokingShare: boolean;
  shareError: string | null;
  shareMessage: string | null;
};

export function RoomInfoPanel({
  room,
  onEdit,
  onShare,
  onRevokeShare,
  onDelete,
  onStartEditingNote,
  canShareRoom,
  sharing,
  revokingShare,
  shareError,
  shareMessage,
}: Props) {
  return (
    <ScrollView
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
    >
      {/* Room Details */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Room Details</Text>
        <Text style={styles.cardTitle}>
          {room?.title || 'Untitled Room'}
        </Text>
        {room?.description ? (
          <Text style={styles.cardBody}>{room.description}</Text>
        ) : null}
        {room?.roomNote ? (
          <Text style={styles.cardBody}>{room.roomNote}</Text>
        ) : null}
        <SecondaryButton
          title="Edit Room"
          onPress={onEdit}
          accessibilityLabel="Edit dressing room"
        />
        <SecondaryButton
          title={room?.roomNote ? 'Edit Note' : 'Add Note'}
          onPress={onStartEditingNote}
          accessibilityLabel={
            room?.roomNote ? 'Edit room note' : 'Add room note'
          }
        />
      </View>

      {/* Sharing */}
      {canShareRoom ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Sharing</Text>
          <SecondaryButton
            title={sharing ? 'Preparing Link' : 'Share Room'}
            onPress={onShare}
            disabled={sharing}
            loading={sharing}
            accessibilityLabel="Share room link"
          />
          <SecondaryButton
            title={
              revokingShare ? 'Disabling Link' : 'Disable Shared Link'
            }
            onPress={onRevokeShare}
            disabled={revokingShare}
            loading={revokingShare}
            accessibilityLabel="Disable shared room link"
          />
          {shareError ? (
            <Text style={styles.error}>{shareError}</Text>
          ) : null}
          {shareMessage ? (
            <Text style={styles.message}>{shareMessage}</Text>
          ) : null}
        </View>
      ) : null}

      {/* Privacy */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Privacy</Text>
        <Text style={styles.cardBody}>
          Private by design. Only invited people can see shared room previews.
        </Text>
      </View>

      {/* Danger Zone */}
      <View style={[styles.card, styles.dangerCard]}>
        <TertiaryButton
          title="Delete Room"
          onPress={onDelete}
          textStyle={{ color: LUXURY.colors.error }}
          accessibilityLabel="Delete dressing room"
          accessibilityHint="Permanently remove this room and its items"
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: SPACING.xl,
    paddingBottom: SPACING.xxxl,
    gap: SPACING.lg,
  },
  card: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.lg,
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  dangerCard: {
    borderColor: 'rgba(130, 48, 56, 0.20)',
    backgroundColor: 'rgba(130, 48, 56, 0.04)',
    alignItems: 'center',
  },
  cardLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    marginBottom: SPACING.xs,
  },
  cardTitle: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
    fontSize: 18,
    marginBottom: SPACING.xs,
  },
  cardBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.sm,
  },
  error: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
    textAlign: 'center',
  },
  message: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
  },
});
