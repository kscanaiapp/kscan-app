// StyleChat photo intake (Phase 2) — guarded scanner-pipeline reuse.
//
// Flow (Part 12): picker → privacy/sanitization → scan-identify → review →
// explicit SAVE TO CLOSET & ATTACH → saved_scan row (existing library save +
// cloud-sync path) → private media backing (idempotent saga) → stable
// owned-item contract handed back to the composer. Nothing auto-saves,
// nothing auto-sends, no base64 or local URI ever enters a chat payload.
//
// Guard invariants (Part 11): this modal consumes the same underlying
// services as the scanner (permission guidance, sanitizeImageBeforeUpload,
// identifyScanImage with abort + timeout, library saveScan) and implements
// the scanner's guard contract — single in-flight analysis, monotonic
// operation id, abort on supersede/unmount, late results discarded, picker
// cancellation is a no-op. The scanner's own hook and flow are untouched.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';

import { TextField } from '../StyleObjectCards';
import { InlineNotice, PrimaryButton, SecondaryButton } from '../luxury';
import { LUXURY, SPACING } from '../../constants/theme';
import {
  getPrivacySanitizerStatus,
  sanitizeImageBeforeUpload,
} from '../../services/privacyImageSanitizer';
import { identifyScanImage } from '../../services/scanIdentification';
import {
  mapScanIdentifyToAnalysis,
  type MappedFashionAnalysis,
} from '../../services/scanIdentificationMapper';
import { saveScan } from '../../services/library';
import { createActorRequest } from '../../services/actorContext';
import { saveScanToCloud } from '../../services/savedScansCloud';
import { supabase } from '../../services/supabaseClient';
import { ensureSavedScanMediaBacking } from '../../services/savedScanMedia';
import { recordAiStylistEvent } from '../../services/styleMemoryEvents';
import {
  STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
  type StyleChatAttachment,
  type StyleChatAttachmentSummary,
} from '../../types/styleChatAttachments';
import type { EliseFashionContextV2 } from '../../types/fashionIdentificationV2';
import { identifyDirectImageForStyle } from '../../services/style-chat/eliseDirectImageIdentification';
import { beginEliseV2Session } from '../../services/style-chat/eliseIdentificationV2';
import {
  describeIdentification,
  groundableItems,
  primaryColorOf,
  summaryOf,
} from '../../services/style-chat/eliseFashionContextV2';

/**
 * Colour and summary for the review screen, read from the context's styling-safe
 * identity via the shared display helpers.
 *
 * Reading the shared helpers rather than re-deriving here means the review field,
 * the chip label and what Elise is told all come from one place and cannot
 * diverge.
 */
function canonicalPrimaryColor(context: EliseFashionContextV2 | null): string {
  return primaryColorOf(groundableItems(context)[0]?.identification);
}

function canonicalSummary(context: EliseFashionContextV2 | null): string {
  const identity = groundableItems(context)[0]?.identification;
  return summaryOf(identity) || describeIdentification(identity);
}

type IntakeStep =
  | 'idle'
  | 'sanitizing'
  | 'identifying'
  | 'review'
  | 'manual_details'
  | 'saving'
  | 'sanitizer_rejected'
  | 'identify_failed';

export function StyleChatPhotoIntake({
  visible,
  onClose,
  onAttached,
}: {
  visible: boolean;
  onClose: () => void;
  onAttached: (
    resolved: StyleChatAttachment,
    summary: StyleChatAttachmentSummary,
    /** Canonical identity; present only on the V2 path (Phase 2B.3). */
    fashionContext?: EliseFashionContextV2,
  ) => void;
}) {
  const [step, setStep] = useState<IntakeStep>('idle');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [color, setColor] = useState('');
  const [resultText, setResultText] = useState('');
  const [identifiedAnalysis, setIdentifiedAnalysis] = useState<MappedFashionAnalysis | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Canonical V2 identity for this intake, when the flag produced one. */
  const [fashionContext, setFashionContext] = useState<EliseFashionContextV2 | null>(null);
  /** Bounded, honest copy for the identify-failed step. */
  const [identifyFailureMessage, setIdentifyFailureMessage] = useState<string | null>(null);

  // Guard contract: monotonic op id + abort; late results are discarded.
  const operationIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const savingRef = useRef(false);
  /**
   * Elise V2 flag, latched once per intake operation.
   *
   * Resolved in `startPicker` and read in the save handler, so identification and
   * the save that follows it cannot disagree about which contract this intake ran
   * under. A new pick resolves it again.
   */
  const v2FlagRef = useRef<{ readonly enabled: boolean }>({ enabled: false });

  const resetState = useCallback(() => {
    setStep('idle');
    setImageUri(null);
    setTitle('');
    setCategory('');
    setColor('');
    setResultText('');
    setIdentifiedAnalysis(null);
    setSaveError(null);
    setFashionContext(null);
    setIdentifyFailureMessage(null);
  }, []);

  useEffect(() => {
    return () => {
      operationIdRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  const startPicker = useCallback(async () => {
    if (inFlightRef.current) return; // single in-flight analysis
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Photo Access Required',
        'Allow K Scan to access your photo library in Settings to upload a photo.',
        [{ text: 'OK' }],
      );
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
      allowsEditing: false,
      allowsMultipleSelection: false,
    });
    // Picker cancellation: no row, no upload, no state change.
    if (picked.canceled || !picked.assets?.[0]?.uri) return;

    const operationId = ++operationIdRef.current;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    inFlightRef.current = true;
    const localUri = picked.assets[0].uri;
    setImageUri(localUri);
    setIdentifiedAnalysis(null);
    setSaveError(null);
    setFashionContext(null);
    setIdentifyFailureMessage(null);
    // Latched here, once, for this whole intake operation.
    const v2Flag = beginEliseV2Session();
    v2FlagRef.current = v2Flag;

    try {
      // Privacy boundary FIRST — a rejected image is never saved or uploaded.
      setStep('sanitizing');
      let sanitizedUri: string;
      try {
        sanitizedUri = await sanitizeImageBeforeUpload(localUri);
      } catch {
        if (operationId !== operationIdRef.current) return; // late result discard
        setStep('sanitizer_rejected');
        return;
      }
      if (operationId !== operationIdRef.current) return;
      setImageUri(sanitizedUri);
      const sanitizerStatus = getPrivacySanitizerStatus();
      const localPrivacyFiltered = Boolean(
        sanitizerStatus.faceBlurApplied && sanitizerStatus.plateMaskApplied
      );

      // Identify through the existing guarded service (its own timeout+abort).
      setStep('identifying');
      const prepared = await ImageManipulator.manipulateAsync(
        sanitizedUri,
        [{ resize: { width: 1024 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (operationId !== operationIdRef.current) return;

      // ── Phase 2B.3: canonical identify_for_style when latched on ───────────
      // The SAME 1024/0.8 derivative computed above is reused — this path's
      // existing preparation settings are preserved exactly, and no second
      // recompression pass runs.
      //
      // This path is ITEM-oriented: the review screen edits one garment's title,
      // category and colour, so several detected candidates require an explicit
      // choice rather than a silent pick of the first.
      //
      // WHY THIS MATTERS HERE SPECIFICALLY: the legacy call below sends no intent,
      // and the backend defaults an intentless request to `identify_and_shop`. An
      // Elise styling attachment has therefore been paying for commerce providers
      // and catalog retrieval it never used. `identify_for_style` short-circuits
      // all of it before a single provider initializes.
      if (v2Flag.enabled && prepared.base64) {
        const outcome = await identifyDirectImageForStyle({
          preparedUri: sanitizedUri,
          source: 'photo_library',
          requestId: `intake_${operationId}`,
          sessionFlag: v2Flag,
          policy: 'item',
          ...(abortRef.current?.signal ? { signal: abortRef.current.signal } : {}),
          isCurrent: () => operationId === operationIdRef.current,
        });
        if (operationId !== operationIdRef.current) return; // late result discard

        if (outcome.kind === 'identified') {
          setFashionContext(outcome.context);
          setTitle(outcome.title);
          setCategory(outcome.category);
          // Colour comes from the canonical identity, filtered — never a
          // template-interpolated nullable that could render "null".
          setColor(canonicalPrimaryColor(outcome.context));
          setResultText(canonicalSummary(outcome.context));
          // The legacy mapped analysis is intentionally left null: the saved
          // record is built from the canonical identity instead, so the durable
          // row and Elise's grounding describe the same garment.
          setIdentifiedAnalysis(null);
          setStep('review');
          return;
        }
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind === 'no_evidence' || outcome.kind === 'needs_selection') {
          // Honest terminal state with the existing manual/retry affordances.
          setIdentifyFailureMessage(
            outcome.kind === 'needs_selection'
              ? 'I found more than one item in this photo. Try a photo of one piece.'
              : outcome.message,
          );
          setStep('identify_failed');
          return;
        }
        // `legacy_fallback` — the backend does not implement the contract. Fall
        // through to the unchanged legacy call below.
      }

      const identification = prepared.base64
        ? await identifyScanImage(prepared.base64, {
            source: 'upload',
            localPrivacyFiltered,
            signal: abortRef.current?.signal,
          })
        : null;
      if (operationId !== operationIdRef.current) return; // late result discard

      let mapped: ReturnType<typeof mapScanIdentifyToAnalysis> | null = null;
      try {
        mapped = identification ? mapScanIdentifyToAnalysis(identification) : null;
      } catch {
        mapped = null;
      }
      const identifiedCategory =
        mapped?.type === 'fashion' && mapped.metadata.category.trim()
          ? mapped.metadata.category.trim()
          : '';
      // Only a completed identification with a category proceeds to review;
      // failed / non_fashion / missing-category all offer the manual path.
      if (!mapped || mapped.type !== 'fashion' || !identifiedCategory) {
        setStep('identify_failed');
        return;
      }

      setIdentifiedAnalysis(mapped);
      setTitle(identifiedCategory);
      setCategory(identifiedCategory);
      setColor(mapped.metadata.color);
      setResultText(mapped.result);
      setStep('review');
    } finally {
      if (operationId === operationIdRef.current) inFlightRef.current = false;
      else inFlightRef.current = false;
    }
  }, []);

  // Open picker automatically when the modal becomes visible from idle.
  useEffect(() => {
    if (visible && step === 'idle' && !inFlightRef.current) {
      void startPicker();
    }
  }, [visible, step, startPicker]);

  const handleSaveAndAttach = useCallback(async () => {
    if (savingRef.current) return; // duplicate-tap guard
    const finalTitle = title.trim();
    const finalCategory = category.trim();
    // Explicit save only; never an empty or category-less saved_scan.
    if (!finalTitle || !finalCategory || !imageUri) {
      setSaveError('Add a title and category first.');
      return;
    }
    savingRef.current = true;
    setStep('saving');
    setSaveError(null);

    // Captured at operation start and preserved through the whole async
    // transaction. Ownership is derived from this, never chosen by this caller,
    // and a stale context is rejected rather than written under the wrong owner.
    const actorRequest = createActorRequest();

    try {
      // 1. Local Closet save through the existing library path.
      const analysis = identifiedAnalysis
        ? {
            ...identifiedAnalysis,
            result: resultText || identifiedAnalysis.result,
            metadata: {
              ...identifiedAnalysis.metadata,
              category: finalCategory,
              color: color.trim() || identifiedAnalysis.metadata.color,
            },
          }
        : {
            result: resultText || `${finalTitle} — added from StyleChat`,
            metadata: { category: finalCategory, color: color.trim() || undefined },
          };
      const scan = await saveScan({
        photoUri: imageUri,
        analysis,
        source: 'upload',
        actorRequest,
      });
      if (!scan) throw new Error('save');

      // 2. Stable remote row via the existing cloud-sync path (idempotent by
      //    user_id + local_id). Never invents a UUID.
      const cloudResult = await saveScanToCloud(scan);
      if (!cloudResult.ok) throw new Error('sync');
      const { data: row } = await supabase
        .from('saved_scans')
        .select('id')
        .eq('local_id', scan.id)
        .is('deleted_at', null)
        .maybeSingle();
      const savedScanId = row?.id as string | undefined;
      if (!savedScanId) throw new Error('sync');

      // 3. Private media backing (idempotent saga; retry-safe).
      const media = await ensureSavedScanMediaBacking({
        savedScanId,
        localImageUri: scan.imageUri ?? imageUri,
      });
      if (!media.ok) throw new Error('media');

      // 4. Hand the stable contract back to the composer draft.
      //
      // The canonical identity rides alongside it when this intake ran under V2.
      // The user may have edited the title, category or colour on the review
      // screen; those edits govern the SAVED RECORD and the chip, and the
      // canonical identity still governs what Elise is told the garment is. They
      // are different claims — a user renaming a jacket "work coat" has not
      // reclassified it — so neither overwrites the other.
      onAttached(
        {
          attachmentType: 'owned_item',
          sourceType: 'saved_scan',
          sourceId: savedScanId,
          contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
        },
        {
          title: finalTitle,
          subtitle: finalCategory,
          imageUri: scan.thumbnailUri ?? scan.imageUri ?? imageUri,
          itemCount: 1,
        },
        fashionContext ?? undefined,
      );
      void recordAiStylistEvent({
        eventType: 'stylechat_image_saved_and_attached',
        signalKey: savedScanId,
        payload: { category: finalCategory },
      });
      resetState();
      onClose();
    } catch {
      // Row/media failures stay retryable; the local record and image are
      // preserved and the chip flow never claims readiness.
      setStep((current) => (current === 'saving' ? 'review' : current));
      setSaveError("Couldn't finish saving. Tap Save to retry, or cancel.");
    } finally {
      savingRef.current = false;
    }
  }, [title, category, color, resultText, imageUri, identifiedAnalysis, onAttached, onClose, resetState]);

  const handleCancel = () => {
    operationIdRef.current += 1;
    abortRef.current?.abort();
    resetState();
    onClose();
  };

  const busy = step === 'sanitizing' || step === 'identifying' || step === 'saving';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? () => {} : handleCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Upload a Photo</Text>

          {busy ? (
            <View style={styles.busyWrap}>
              <ActivityIndicator size="large" color={LUXURY.colors.plum} />
              <Text style={styles.busyText}>
                {step === 'sanitizing'
                  ? 'Checking image…'
                  : step === 'identifying'
                    ? 'Identifying this item…'
                    : 'Saving to your Closet…'}
              </Text>
            </View>
          ) : null}

          {step === 'sanitizer_rejected' ? (
            <>
              <InlineNotice
                variant="error"
                title="Image"
                body="This image couldn’t be processed. Please try a clearer photo of the item."
              />
              <PrimaryButton title="Try Again" onPress={() => { resetState(); void startPicker(); }} accessibilityLabel="Try again" />
              <SecondaryButton title="Cancel" onPress={handleCancel} />
            </>
          ) : null}

          {step === 'identify_failed' ? (
            <>
              <InlineNotice
                variant="info"
                title="Identification"
                body={
                  identifyFailureMessage ??
                  'I couldn’t identify this item. You can add basic details or try another photo.'
                }
              />
              <PrimaryButton
                title="Add Details Manually"
                onPress={() => setStep('manual_details')}
                accessibilityLabel="Add details manually"
              />
              <SecondaryButton title="Try Another Photo" onPress={() => { resetState(); void startPicker(); }} />
              <SecondaryButton title="Cancel" onPress={handleCancel} />
            </>
          ) : null}

          {step === 'review' || step === 'manual_details' ? (
            <ScrollView style={styles.reviewScroll} showsVerticalScrollIndicator={false}>
              {imageUri ? <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="cover" /> : null}
              <TextField label="Title" value={title} onChangeText={setTitle} />
              <TextField label="Category" value={category} onChangeText={setCategory} />
              {step === 'review' ? <TextField label="Color" value={color} onChangeText={setColor} /> : null}
              {saveError ? <InlineNotice variant="error" title="Save" body={saveError} /> : null}
              <PrimaryButton
                title="Save to Closet & Attach"
                onPress={handleSaveAndAttach}
                disabled={!title.trim() || !category.trim()}
                accessibilityLabel="Save to closet and attach"
                testID="save-and-attach-button"
              />
              <SecondaryButton title="Try Another Photo" onPress={() => { resetState(); void startPicker(); }} />
              <SecondaryButton title="Cancel" onPress={handleCancel} />
            </ScrollView>
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
    backgroundColor: LUXURY.colors.plumDeep + 'C2',
    padding: SPACING.xl,
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.md,
    maxHeight: '88%',
  },
  title: { ...LUXURY.typography.displayTitle, color: LUXURY.colors.ink },
  busyWrap: { alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.lg },
  busyText: { ...LUXURY.typography.body, color: LUXURY.colors.graphite },
  reviewScroll: { flexGrow: 0 },
  preview: {
    width: '100%',
    height: 220,
    borderRadius: 14,
    backgroundColor: LUXURY.colors.ivory,
    marginBottom: SPACING.md,
  },
});
