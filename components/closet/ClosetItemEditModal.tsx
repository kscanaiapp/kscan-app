// Post-creation editing for a committed Closet item.
//
// DOMAIN BOUNDARY, same as ClosetIntakeModal: this surface edits the Closet
// record's own metadata and NOTHING else. It does not touch media, does not
// re-identify the photo, does not create a Recent Scan, and cannot reach the
// underlying scan a promoted item came from — the Closet record and the scan
// that produced it are separate rows, and editing one must not disturb the
// other.
//
// EDITABLE FIELDS ARE THE COMMITTED FIELDS (Closet Ownership V1, PR A2).
//
// This used to offer Name and Category only, on the reasoning that "AI-derived
// taxonomy is evidence about the photo, not user metadata". That reasoning does
// not survive contact with the product: the person who owns the garment is the
// authority on what it is, and a classifier that returned the wrong brand or the
// wrong colour had written a fact its owner could not correct. The Closet's job
// is to be the trusted wardrobe truth layer; a truth layer that cannot be
// corrected by the person who owns the truth is not one.
//
// What is offered here is exactly the set services/closetLibrary.js commits —
// no speculative field, and nothing the record cannot store. Identity,
// ownership, media, provenance, lineage, origin and timestamps remain
// unreachable: `updateClosetItem` allowlists what a patch may address, so this
// surface could not reach them even if it tried to.
//
// Guard contract (mirrors ClosetIntakeModal), unchanged by the widening:
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
  clothingType?: string | null;
  subtype?: string | null;
  brand?: string | null;
  primaryColor?: string | null;
  secondaryColors?: readonly string[] | null;
  material?: readonly string[] | null;
  size?: string | null;
  notes?: string | null;
  imageUri?: string | null;
  thumbnailUri?: string | null;
};

/**
 * The patch this surface can produce.
 *
 * A CLEAR IS A CORRECTION, NOT A NO-OP. An emptied field is sent as `null`
 * (or `[]`) rather than omitted, because "this item has no brand" is a fact the
 * owner is entitled to record — and if clearing were dropped, a wrong value
 * would be permanent.
 */
export type ClosetItemEditPatch = {
  title: string;
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  secondaryColors: string[];
  material: string[];
  size: string | null;
  notes: string | null;
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

/** Render a stored list as the comma-separated text a user edits. */
function listToText(value: readonly string[] | null | undefined): string {
  return Array.isArray(value) ? value.join(', ') : '';
}

/**
 * Parse the comma-separated text back to a list.
 *
 * Deliberately permissive about spacing and trailing commas, and deliberately
 * NOT de-duplicating or bounding here: `normalizeClosetTaxonomyValue` in the
 * store is the one authority on both, and doing it twice is how the two drift.
 */
function textToList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
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
  onSave: (id: string, patch: ClosetItemEditPatch) => Promise<ClosetItemEditResult>;
}) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [clothingType, setClothingType] = useState('');
  const [subtype, setSubtype] = useState('');
  const [brand, setBrand] = useState('');
  const [primaryColor, setPrimaryColor] = useState('');
  const [secondaryColors, setSecondaryColors] = useState('');
  const [material, setMaterial] = useState('');
  const [size, setSize] = useState('');
  const [notes, setNotes] = useState('');
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

  /** Every field, back to what the record says. One place, so a new field
   *  cannot be prefilled on open and forgotten on cancel. */
  const resetFrom = useCallback((source: ClosetEditableItem | null) => {
    setTitle(source?.title ?? '');
    setCategory(source?.category ?? '');
    setClothingType(source?.clothingType ?? '');
    setSubtype(source?.subtype ?? '');
    setBrand(source?.brand ?? '');
    setPrimaryColor(source?.primaryColor ?? '');
    setSecondaryColors(listToText(source?.secondaryColors));
    setMaterial(listToText(source?.material));
    setSize(source?.size ?? '');
    setNotes(source?.notes ?? '');
  }, []);

  // Prefill from the record every time the sheet opens on an item, so a second
  // edit never starts from the previous item's draft.
  useEffect(() => {
    if (!visible || !item) return;
    resetFrom(item);
    setError(null);
    setSaving(false);
    inFlightRef.current = false;
  }, [visible, item, resetFrom]);

  const isCurrent = useCallback(
    (operationId: number) => mountedRef.current && operationIdRef.current === operationId,
    [],
  );

  /** Cancel is lossless: nothing is written and the record keeps its values. */
  const cancel = useCallback(() => {
    if (inFlightRef.current) return;
    resetFrom(item);
    setError(null);
    onClose();
  }, [item, onClose, resetFrom]);

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
        clothingType: clothingType.trim() || null,
        subtype: subtype.trim() || null,
        brand: brand.trim() || null,
        primaryColor: primaryColor.trim() || null,
        secondaryColors: textToList(secondaryColors),
        material: textToList(material),
        size: size.trim() || null,
        notes: notes.trim() || null,
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
  }, [
    brand,
    category,
    clothingType,
    isCurrent,
    item,
    material,
    notes,
    onClose,
    onSave,
    primaryColor,
    secondaryColors,
    size,
    subtype,
    title,
  ]);

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
            Correct anything we got wrong. What you enter here is what K Scan AI treats as true
            about this piece. Your photo and your scans are not affected.
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
          <TextField
            label="Type (optional)"
            value={clothingType}
            onChangeText={setClothingType}
            placeholder="Coat"
            maxLength={80}
            testID="closet-item-edit-clothing-type"
          />
          <TextField
            label="Style (optional)"
            value={subtype}
            onChangeText={setSubtype}
            placeholder="Trench"
            maxLength={80}
            testID="closet-item-edit-subtype"
          />
          <TextField
            label="Brand (optional)"
            value={brand}
            onChangeText={setBrand}
            placeholder="Add a brand"
            maxLength={120}
            testID="closet-item-edit-brand"
          />
          <TextField
            label="Main colour (optional)"
            value={primaryColor}
            onChangeText={setPrimaryColor}
            placeholder="Navy"
            maxLength={60}
            testID="closet-item-edit-primary-color"
          />
          <TextField
            label="Other colours (optional, separated by commas)"
            value={secondaryColors}
            onChangeText={setSecondaryColors}
            placeholder="Cream, gold"
            maxLength={200}
            testID="closet-item-edit-secondary-colors"
          />
          <TextField
            label="Material (optional, separated by commas)"
            value={material}
            onChangeText={setMaterial}
            placeholder="Wool, cashmere"
            maxLength={200}
            testID="closet-item-edit-material"
          />
          <TextField
            label="Size (optional)"
            value={size}
            onChangeText={setSize}
            placeholder="M"
            maxLength={40}
            testID="closet-item-edit-size"
          />
          <TextField
            label="Notes (optional)"
            value={notes}
            onChangeText={setNotes}
            placeholder="Anything you want to remember about this piece"
            maxLength={500}
            testID="closet-item-edit-notes"
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
