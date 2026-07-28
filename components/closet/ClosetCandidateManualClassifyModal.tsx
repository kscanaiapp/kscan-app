// Manual classification for a Closet CANDIDATE (Build 1).
//
// THE ONE JOB: a candidate the backend could not categorize needs a human
// category before it may reach review. This modal collects that category — plus
// three optional descriptors — and hands them to the hook's `classifyManually`,
// which validates, patches through the store's protected-field gate, and drives
// `needs_manual_classification → ready_for_review` through the authoritative
// transition service. THIS COMPONENT NEVER TOUCHES `status` and never imports a
// store module: everything goes through the injected submit function.
//
// DELIBERATELY NOT COLLECTED: brand, material, size, product name, retailer,
// SKU, price. This is a wardrobe intake, not a commerce record. The fields here
// are the ones `hasUsableTaxonomy` and the review card actually use.
//
// The item is still NOT in the committed Closet after this succeeds — the copy
// says "review", never "saved".

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { TextField } from '../StyleObjectCards';
import { InlineNotice, PrimaryButton, SecondaryButton } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';

export type ManualClassifyTarget = {
  candidateId: string;
  category?: string | null;
  clothingType?: string | null;
  subtype?: string | null;
  primaryColor?: string | null;
};

export function ClosetCandidateManualClassifyModal({
  target,
  onClose,
  onSubmit,
}: {
  /** The candidate being classified, or null when the modal is closed. */
  target: ManualClassifyTarget | null;
  onClose: () => void;
  /**
   * `useClosetCandidates().classifyManually` — the only write path. The result
   * type mirrors what the JS hook actually infers to, void included; the submit
   * handler treats anything that is not `{ ok: true }` as a failure.
   */
  onSubmit: (
    candidateId: string,
    fields: {
      category: string;
      clothingType?: string | null;
      subtype?: string | null;
      primaryColor?: string | null;
    }
  ) => Promise<{ ok: boolean; errorCode?: string | null } | void>;
}) {
  const [category, setCategory] = useState('');
  const [clothingType, setClothingType] = useState('');
  const [subtype, setSubtype] = useState('');
  const [primaryColor, setPrimaryColor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed from the record each time a candidate is opened, so a partially
  // classified result ("we saw a colour but no category") is not retyped.
  useEffect(() => {
    setCategory(target?.category ?? '');
    setClothingType(target?.clothingType ?? '');
    setSubtype(target?.subtype ?? '');
    setPrimaryColor(target?.primaryColor ?? '');
    setError(null);
    setSaving(false);
  }, [target?.candidateId]);

  const handleSubmit = async () => {
    if (!target || saving) return;
    // The service validates authoritatively; this early check only exists so an
    // empty category never costs a round-trip to show its error.
    if (!category.trim()) {
      setError('A category is required — for example Outerwear or Shoes.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const raw = await onSubmit(target.candidateId, {
        category: category.trim(),
        clothingType: clothingType.trim() || null,
        subtype: subtype.trim() || null,
        primaryColor: primaryColor.trim() || null,
      });
      // A void resolution is a failure with no code — same rendering path.
      const outcome = (raw ?? { ok: false }) as { ok: boolean; errorCode?: string | null };
      if (outcome.ok) {
        onClose();
        return;
      }
      setError(
        outcome.errorCode === 'candidate_expired'
          ? 'This photo has expired and can no longer be updated.'
          : outcome.errorCode === 'candidate_actor_stale'
            ? 'Your session changed. Please try again.'
            : 'Those details could not be saved. Please try again.'
      );
    } catch {
      setError('Those details could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={target !== null}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
      onRequestClose={onClose}
      testID="closet-candidate-manual-modal"
    >
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.heading}>Add details</Text>
          <Text style={styles.sub}>
            Tell us what this is. It stays in your review queue — nothing is added to
            your Closet yet.
          </Text>

          {error ? (
            <InlineNotice variant="error" body={error} testID="closet-candidate-manual-error" />
          ) : null}

          <TextField
            label="Category"
            value={category}
            onChangeText={setCategory}
            placeholder="Outerwear"
            maxLength={80}
          />
          <TextField
            label="Clothing type (optional)"
            value={clothingType}
            onChangeText={setClothingType}
            placeholder="Coat"
            maxLength={80}
          />
          <TextField
            label="Subtype (optional)"
            value={subtype}
            onChangeText={setSubtype}
            placeholder="Trench coat"
            maxLength={80}
          />
          <TextField
            label="Main color (optional)"
            value={primaryColor}
            onChangeText={setPrimaryColor}
            placeholder="Navy"
            maxLength={60}
          />

          {saving ? (
            <ActivityIndicator size="large" color={LUXURY.colors.plum} />
          ) : (
            <View style={styles.actions}>
              <PrimaryButton
                title="Save details"
                onPress={handleSubmit}
                testID="closet-candidate-manual-save"
              />
              <SecondaryButton
                title="Cancel"
                onPress={onClose}
                testID="closet-candidate-manual-cancel"
              />
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: LUXURY.colors.ivory },
  content: { padding: SPACING.xl, gap: SPACING.md },
  heading: {
    fontSize: 24,
    color: LUXURY.colors.ink,
    fontWeight: '600',
  },
  sub: {
    fontSize: 14,
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.sm,
  },
  actions: { gap: SPACING.md },
});
