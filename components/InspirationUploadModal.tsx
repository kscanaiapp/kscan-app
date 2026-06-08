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
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../constants/theme';
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
            Your uploads are private and only visible to you.
          </Text>

          {done ? (
            <>
              <Text style={styles.successText}>Inspiration saved.</Text>
              <TouchableOpacity style={styles.primaryButton} onPress={onClose}>
                <Text style={styles.primaryText}>DONE</Text>
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
                placeholderTextColor={COLORS.editorialTextMuted}
                maxLength={INSPIRATION_NOTE_MAX_LENGTH + 20}
                multiline
                textAlignVertical="top"
                style={styles.noteInput}
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
              >
                {uploading ? (
                  <Text style={styles.primaryText}>
                    {roomId ? 'SAVING ROOM' : 'SAVING LIBRARY'}
                  </Text>
                ) : (
                  <Text style={styles.primaryText}>UPLOAD</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.secondaryButton, uploading && styles.disabled]}
                onPress={onClose}
                disabled={uploading}
              >
                <Text style={styles.secondaryText}>CANCEL</Text>
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
    backgroundColor: COLORS.backdrop,
    padding: SPACING.xl,
  },
  card: {
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.xl,
    maxHeight: '90%',
    ...SHADOWS.editorialRaised,
  },
  title: {
    ...TYPOGRAPHY.title,
    color: COLORS.editorialTextPrimary,
  },
  subtitle: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextSecondary,
    marginTop: SPACING.xs,
    marginBottom: SPACING.md,
  },
  preview: {
    width: '100%',
    height: 220,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surfaceMuted,
    marginBottom: SPACING.md,
  },
  noteInput: {
    minHeight: 72,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    color: COLORS.editorialTextPrimary,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: 14,
    lineHeight: 20,
  },
  noteCount: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
    textAlign: 'right',
    marginTop: SPACING.xs,
  },
  noteCountError: {
    color: COLORS.error,
  },
  errorText: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.error,
    marginTop: SPACING.sm,
    textAlign: 'center',
  },
  successText: {
    ...TYPOGRAPHY.title,
    color: COLORS.editorialTextPrimary,
    textAlign: 'center',
    marginTop: SPACING.sm,
    marginBottom: SPACING.md,
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
});
