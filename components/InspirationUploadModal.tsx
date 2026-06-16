import React, { useEffect, useState } from 'react';
import {
  Image,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../constants/theme';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  INSPIRATION_NOTE_MAX_LENGTH,
  normalizeInspirationNote,
  uploadAndSaveInspiration,
  uploadAndSaveInspirationToDressingRoom,
} from '../services/styleObjects';
import type { InspirationItem } from '../types/styleObjects';

type Props = {
  visible: boolean;
  selectedUri: string | null;
  roomId?: string | null;
  onClose: () => void;
  onSuccess: (item: InspirationItem) => void;
};

export function InspirationUploadModal({
  visible,
  selectedUri,
  roomId,
  onClose,
  onSuccess,
}: Props) {
  const { user } = useAuthSession();
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (visible) {
      setNote('');
      setError(null);
      setDone(false);
    }
  }, [visible]);

  const noteLength = note.trim().length;
  const noteTooLong = noteLength > INSPIRATION_NOTE_MAX_LENGTH;

  const handleUpload = async () => {
    if (!selectedUri || uploading) return;
    setUploading(true);
    setError(null);
    try {
      let item: InspirationItem;
      if (roomId) {
        item = await uploadAndSaveInspirationToDressingRoom({
          userId: user?.id,
          roomId,
          localUri: selectedUri,
          note,
        });
      } else {
        item = await uploadAndSaveInspiration({
          userId: user?.id,
          localUri: selectedUri,
          note,
        });
      }
      setDone(true);
      onSuccess(item);
    } catch (err: any) {
      setError(err?.message || 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  if (!selectedUri) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => {
        if (!uploading) onClose();
      }}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>
            {roomId ? 'Add to Room Inspiration' : 'Add to Style Library'}
          </Text>
          <Text style={styles.subtitle}>
            Upload clothing-focused images only. Avoid faces, bystanders, or sensitive information.
          </Text>

          {done ? (
            <>
              <Text style={styles.successText}>Inspiration saved.</Text>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Done uploading inspiration"
              >
                <Text style={styles.primaryText}>Done</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Image
                source={{ uri: selectedUri }}
                style={styles.preview}
                resizeMode="cover"
              />

              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Add a note (optional)"
                placeholderTextColor={LUXURY.colors.stone}
                maxLength={INSPIRATION_NOTE_MAX_LENGTH + 20}
                multiline
                textAlignVertical="top"
                style={styles.noteInput}
                accessibilityLabel="Inspiration note"
                accessibilityHint="Optional note about this inspiration image"
              />
              <Text style={[styles.noteCount, noteTooLong ? styles.noteCountError : null]}>
                {noteLength}/{INSPIRATION_NOTE_MAX_LENGTH}
                {noteTooLong ? ` · max ${INSPIRATION_NOTE_MAX_LENGTH}` : ''}
              </Text>

              {error ? <Text style={styles.errorText}>{error}</Text> : null}

              <TouchableOpacity
                style={[styles.primaryButton, (uploading || noteTooLong) && styles.disabled]}
                onPress={handleUpload}
                disabled={uploading || noteTooLong}
                accessibilityRole="button"
                accessibilityLabel={roomId ? 'Save to room inspiration' : 'Save to style library'}
              >
                {uploading ? (
                  <Text style={styles.primaryText}>
                    {roomId ? 'Saving Room' : 'Saving Library'}
                  </Text>
                ) : (
                  <Text style={styles.primaryText}>Upload</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.secondaryButton, uploading && styles.disabled]}
                onPress={onClose}
                disabled={uploading}
                accessibilityRole="button"
                accessibilityLabel="Cancel upload"
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
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
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    maxHeight: '90%',
    ...SHADOWS.editorialRaised,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
  },
  subtitle: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    marginTop: SPACING.xs,
    marginBottom: SPACING.md,
  },
  preview: {
    width: '100%',
    height: 220,
    borderRadius: RADIUS.lg,
    backgroundColor: LUXURY.colors.champagne,
    marginBottom: SPACING.md,
  },
  noteInput: {
    minHeight: 72,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    color: LUXURY.colors.ink,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: 14,
    lineHeight: 20,
  },
  noteCount: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    textAlign: 'right',
    marginTop: SPACING.xs,
  },
  noteCountError: {
    color: LUXURY.colors.error,
  },
  errorText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
  successText: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
    textAlign: 'center',
    marginTop: SPACING.sm,
    marginBottom: SPACING.md,
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
});
