// Post-creation editing for a committed Closet item.
//
// DOMAIN BOUNDARY, same as ClosetIntakeModal: this surface edits the Closet
// record's own metadata and NOTHING else. It does not touch media, does not
// re-identify the photo, does not create a Recent Scan, and cannot reach the
// underlying scan a promoted item came from — the Closet record and the scan
// that produced it are separate rows, and editing one must not disturb the
// other.
//
// EDITABLE FIELDS ARE THE CREATION FIELDS. Intake offers Name and Category, so
// those are what can be changed afterwards. AI-derived taxonomy is evidence
// about the photo, not user metadata, and stays out of reach here.
//
// Guard contract (mirrors ClosetIntakeModal):
//   - single in-flight save, monotonic operation id
//   - late results discarded after supersede/unmount
//   - Cancel is lossless: it reverts the draft and writes nothing
//   - a failed save keeps the user's edits on screen so they are not retyped

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { TextField } from '../StyleObjectCards';
import { InlineNotice, PrimaryButton, SecondaryButton } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';

export type ClosetEditableItem = {
  id: string;
  title: string;
  category?: string | null;
  imageUri?: string | null;
  thumbnailUri?: string | null;
};

export type ClosetItemEditResult = { ok: boolean; reason?: string };

function messageFor(reason?: string): string {
  if (reason === 'android_requires_authenticated_actor') {
    return 'Sign in to change items in your Closet.';
  }
  if (reason === 'stale_actor_context' || reason === 'missing_actor_context') {
    return 'Your session changed. Please try again.';
  }
  if (reason === 'not_found') {
    return 'This item is no longer in your Closet.';
  }
  return 'Your changes could not be saved. Please try again.';
}

export function ClosetItemEditModal({
  visible,
  item,
  onClose,
  onSave,
}: {
  visible: boolean;
  /** The item being edited, or null when the modal is closed. */
  item: ClosetEditableItem | null;
  onClose: () => void;
  onSave: (
    id: string,
    patch: { title: string; category: string | null },
  ) => Promise<ClosetItemEditResult>;
}) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const operationIdRef = useRef(0);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationIdRef.current += 1;
    };
  }, []);

  // Prefill from the record every time the sheet opens on an item, so a second
  // edit never starts from the previous item's draft.
  useEffect(() => {
    if (!visible || !item) return;
    setTitle(item.title ?? '');
    setCategory(item.category ?? '');
    setError(null);
    setSaving(false);
    inFlightRef.current = false;
  }, [visible, item]);

  const isCurrent = useCallback(
    (operationId: number) => mountedRef.current && operationIdRef.current === operationId,
    [],
  );

  /** Cancel is lossless: nothing is written and the record keeps its values. */
  const cancel = useCallback(() => {
    if (inFlightRef.current) return;
    setTitle(item?.title ?? '');
    setCategory(item?.category ?? '');
    setError(null);
    onClose();
  }, [item, onClose]);

  const save = useCallback(async () => {
    if (!item) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError('Give this item a name.');
      return;
    }
    if (inFlightRef.current) return; // repeated-tap guard
    inFlightRef.current = true;
    operationIdRef.current += 1;
    const operationId = operationIdRef.current;

    setSaving(true);
    setError(null);
    try {
      const result = await onSave(item.id, {
        title: nextTitle,
        category: category.trim() || null,
      });
      if (!isCurrent(operationId)) return;
      if (result.ok) {
        onClose();
        return;
      }
      // The draft stays on screen: a failed save must not cost the user the
      // text they just typed.
      setError(messageFor(result.reason));
    } catch {
      if (isCurrent(operationId)) setError(messageFor());
    } finally {
      if (isCurrent(operationId)) setSaving(false);
      inFlightRef.current = false;
    }
  }, [category, isCurrent, item, onClose, onSave, title]);

  const previewUri = item?.thumbnailUri ?? item?.imageUri ?? null;

  return (
    <Modal
      visible={visible && !!item}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
      onRequestClose={cancel}
      testID="closet-item-edit-modal"
    >
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.heading}>Edit Item</Text>
          <Text style={styles.sub}>
            Change how this piece is named and filed. Your photo and your scans are not affected.
          </Text>

          {error ? <InlineNotice variant="error" body={error} testID="closet-item-edit-error" /> : null}

          {previewUri ? (
            <Image source={{ uri: previewUri }} style={styles.preview} resizeMode="cover" />
          ) : null}

          <TextField
            label="Name"
            value={title}
            onChangeText={setTitle}
            placeholder="Navy wool coat"
            maxLength={200}
            testID="closet-item-edit-title"
          />
          <TextField
            label="Category (optional)"
            value={category}
            onChangeText={setCategory}
            placeholder="Outerwear"
            maxLength={80}
            testID="closet-item-edit-category"
          />

          {saving ? (
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          ) : (
            <>
              <PrimaryButton title="Save Changes" onPress={save} testID="closet-item-edit-save" />
              <SecondaryButton title="Cancel" onPress={cancel} testID="closet-item-edit-cancel" />
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: LUXURY.colors.ivory },
  content: { padding: SPACING.xl, gap: SPACING.md },
  heading: { fontSize: 24, color: LUXURY.colors.ink, fontWeight: '600' },
  sub: { fontSize: 14, color: LUXURY.colors.graphite, marginBottom: SPACING.sm },
  preview: {
    width: '100%',
    height: 260,
    borderRadius: 12,
    backgroundColor: LUXURY.colors.pearl,
  },
});
