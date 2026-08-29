// StyleChat photo intake (Phase 2) — guarded scanner-pipeline reuse.
//
// Flow: picker → privacy/sanitization → durable local candidate → identify →
// ATTACH TO ELISE. Saving to Closet is a separate, optional, idempotent
// promotion. Nothing auto-saves and no image bytes enter a chat payload.
//
// Guard invariants (Part 11): this modal consumes the same underlying
// services as the scanner (permission guidance, sanitizeImageBeforeUpload,
// identifyScanImage with abort + timeout) and implements
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
} from '../../services/scanIdentificationMapper';
import { createActorRequest } from '../../services/actorContext';
import type { StyleChatAttachmentSummary } from '../../types/styleChatAttachments';
import {
  createClosetCandidate,
  deleteClosetCandidate,
  getClosetCandidate,
  transitionClosetCandidate,
  updateClosetCandidate,
} from '../../services/closetCandidateLibrary';
import { promoteSelectedClosetCandidates } from '../../services/closetCandidatePromotion';
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
  | 'sanitizer_rejected'
  | 'identify_failed';

type ClosetState = 'not_saved' | 'saving' | 'saved' | 'save_failed';

export type StyleChatDirectImageAttachmentInput = {
  candidateId: string;
  batchId: string;
  imageUri: string;
  thumbnailUri?: string | null;
  summary: StyleChatAttachmentSummary;
  fashionContext: EliseFashionContextV2;
  identificationState: 'ready';
  closetState: ClosetState;
  closetItemId?: string | null;
};

export function StyleChatPhotoIntake({
  visible,
  onClose,
  onAttached,
  onClosetOutcome,
}: {
  visible: boolean;
  onClose: () => void;
  onAttached: (input: StyleChatDirectImageAttachmentInput) => void;
  onClosetOutcome?: (
    candidateId: string,
    state: ClosetState,
    closetItemId?: string | null,
  ) => void;
}) {
  const [step, setStep] = useState<IntakeStep>('idle');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [color, setColor] = useState('');
  const [resultText, setResultText] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [closetState, setClosetState] = useState<ClosetState>('not_saved');
  const [closetItemId, setClosetItemId] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  /** Canonical V2 identity for this intake, when the flag produced one. */
  const [fashionContext, setFashionContext] = useState<EliseFashionContextV2 | null>(null);
  /** Bounded, honest copy for the identify-failed step. */
  const [identifyFailureMessage, setIdentifyFailureMessage] = useState<string | null>(null);

  // Guard contract: monotonic op id + abort; late results are discarded.
  const operationIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const savingRef = useRef(false);
  const attachingRef = useRef(false);
  const closetStateRef = useRef<ClosetState>('not_saved');
  const closetItemIdRef = useRef<string | null>(null);
  const candidateRef = useRef<{
    actorRequest: ReturnType<typeof createActorRequest>;
    candidateId: string;
    batchId: string;
    imageUri: string;
    thumbnailUri: string | null;
  } | null>(null);
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
    setSaveError(null);
    setClosetState('not_saved');
    setClosetItemId(null);
    closetStateRef.current = 'not_saved';
    closetItemIdRef.current = null;
    setAttaching(false);
    setFashionContext(null);
    setIdentifyFailureMessage(null);
    candidateRef.current = null;
  }, []);

  const discardCurrentCandidate = useCallback(async () => {
    const staged = candidateRef.current;
    candidateRef.current = null;
    if (!staged) return;
    await deleteClosetCandidate(staged.actorRequest, staged.candidateId).catch(() => null);
  }, []);

  useEffect(() => {
    return () => {
      operationIdRef.current += 1;
      abortRef.current?.abort();
      void discardCurrentCandidate();
    };
  }, [discardCurrentCandidate]);

  const persistCandidateReview = useCallback(async (input: {
    title: string;
    category: string;
    color?: string | null;
    result?: string | null;
    context?: EliseFashionContextV2 | null;
  }): Promise<boolean> => {
    const staged = candidateRef.current;
    if (!staged) return false;
    const identity = groundableItems(input.context ?? null)[0]?.identification ?? null;
    const patch = {
      title: input.title.trim(),
      category: input.category.trim(),
      clothingType: identity?.subtype ?? input.category.trim(),
      primaryColor: input.color?.trim() || identity?.colors.primary || null,
      secondaryColors: identity?.colors.secondary ?? [],
      material: identity?.material ?? [],
      notes: input.result?.trim() || null,
      classificationVersion: input.context?.contractVersion ?? null,
    };
    const loaded = await getClosetCandidate(staged.actorRequest, staged.candidateId);
    if (!loaded.ok) return false;
    let status = loaded.candidate.status;
    if (status === 'failed') {
      const queued = await transitionClosetCandidate(staged.actorRequest, staged.candidateId, {
        to: 'queued',
      });
      if (!queued || queued.ok !== true) return false;
      status = 'queued';
    }
    if (status === 'queued' || status === 'waiting_for_network') {
      const classifying = await transitionClosetCandidate(staged.actorRequest, staged.candidateId, {
        to: 'classifying',
        attempt: 'manual',
      });
      if (!classifying || classifying.ok !== true) return false;
      status = 'classifying';
    }
    if (status === 'classifying' || status === 'needs_manual_classification') {
      const ready = await transitionClosetCandidate(staged.actorRequest, staged.candidateId, {
        to: 'ready_for_review',
        patch,
      });
      return Boolean(ready && ready.ok === true);
    }
    if (status === 'ready_for_review' || status === 'duplicate' || status === 'saved') {
      const updated = await updateClosetCandidate(
        staged.actorRequest,
        staged.candidateId,
        patch,
      );
      return Boolean(updated && updated.ok === true);
    }
    return false;
  }, []);

  const markCandidateNeedsManual = useCallback(async () => {
    const staged = candidateRef.current;
    if (!staged) return;
    const loaded = await getClosetCandidate(staged.actorRequest, staged.candidateId);
    if (loaded.ok && loaded.candidate.status === 'classifying') {
      await transitionClosetCandidate(staged.actorRequest, staged.candidateId, {
        to: 'needs_manual_classification',
      });
    }
  }, []);

  const startPicker = useCallback(async () => {
    if (inFlightRef.current) return; // single in-flight analysis
    // Claimed BEFORE the first await. The composer passes a fresh inline
    // `onClose` on every render, so this callback — and the auto-open effect
    // that depends on it — is rebuilt while the user is still standing in the
    // gallery. A claim taken after the picker returns leaves that whole window
    // unguarded and lets the effect launch a second native picker.
    inFlightRef.current = true;
    let localUri: string;
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Photo Access Required',
          'Allow K Scan AI to access your photo library in Settings to upload a photo.',
          [{ text: 'OK' }],
        );
        onClose();
        return;
      }

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsEditing: false,
        allowsMultipleSelection: false,
      });
      // Picker cancellation: no row, no upload, no state change.
      if (picked.canceled || !picked.assets?.[0]?.uri) {
        onClose();
        return;
      }
      localUri = picked.assets[0].uri;
    } catch {
      // Safe to release inline: `identify_failed` is not `idle`, so the
      // auto-open effect cannot re-enter on this path.
      inFlightRef.current = false;
      setIdentifyFailureMessage('The photo picker could not finish. Try again.');
      setStep('identify_failed');
      return;
    }

    const operationId = ++operationIdRef.current;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setImageUri(localUri);
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

      // Stage only the sanitizer output in the existing actor-scoped candidate
      // store. This gives the attachment a durable app-owned image without
      // creating a Recent Scan or a committed Closet item.
      const actorRequest = createActorRequest();
      const staged = await createClosetCandidate(actorRequest, {
        sourceUri: sanitizedUri,
        sourceType: 'gallery',
        sourceLineageId: `elise:intake_${operationId}`,
        draft: { title: 'Photo' },
      });
      const candidate = 'candidate' in staged ? staged.candidate : null;
      if (operationId !== operationIdRef.current) {
        if (candidate?.candidateId) {
          await deleteClosetCandidate(actorRequest, candidate.candidateId).catch(() => null);
        }
        return;
      }
      if (!candidate?.candidateId || !candidate.candidateImageUri) {
        if (candidate?.candidateId) {
          await deleteClosetCandidate(actorRequest, candidate.candidateId).catch(() => null);
        }
        setStep('sanitizer_rejected');
        return;
      }
      candidateRef.current = {
        actorRequest,
        candidateId: candidate.candidateId,
        batchId: candidate.batchId,
        imageUri: candidate.candidateImageUri,
        thumbnailUri: candidate.candidateThumbnailUri ?? null,
      };
      setImageUri(candidate.candidateImageUri);
      const duplicateClosetItemId = candidate.duplicateMatch?.closetItemId ?? null;
      if (candidate.status === 'duplicate' && duplicateClosetItemId) {
        closetStateRef.current = 'saved';
        closetItemIdRef.current = duplicateClosetItemId;
        setClosetState('saved');
        setClosetItemId(duplicateClosetItemId);
      } else {
        closetStateRef.current = 'not_saved';
        closetItemIdRef.current = null;
        setClosetState('not_saved');
        setClosetItemId(null);
      }
      if (candidate.status === 'failed') {
        await transitionClosetCandidate(actorRequest, candidate.candidateId, { to: 'queued' });
      }
      if (candidate.status === 'queued' || candidate.status === 'failed') {
        await transitionClosetCandidate(actorRequest, candidate.candidateId, {
          to: 'classifying',
          attempt: 'manual',
        });
      } else if (candidate.status === 'waiting_for_network') {
        await transitionClosetCandidate(actorRequest, candidate.candidateId, {
          to: 'classifying',
          attempt: 'manual',
        });
      }
      if (operationId !== operationIdRef.current) return;

      const analysisUri = candidate.candidateImageUri;

      // Identify through the existing guarded service (its own timeout+abort).
      setStep('identifying');
      const prepared = await ImageManipulator.manipulateAsync(
        analysisUri,
        [{ resize: { width: 1024 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (operationId !== operationIdRef.current) return;

      // ── Phase 2B.3: canonical identify_for_style when latched on ───────────
      // The V2 adapter prepares its OWN derivative from `sanitizedUri` (the
      // shared 896px/0.75 analysis settings inside
      // `compressSanitizedImageForAnalysis`), so the 1024/0.8 derivative above
      // is used only by the legacy path below. Two preparations exist while
      // both contracts coexist; collapsing them is a post-rollout cleanup, not
      // something this phase may do by silently changing legacy bytes.
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
      // Populated only when the V2 orchestrator already performed its one
      // permitted legacy retry (UNSUPPORTED_CONTRACT_VERSION). Reused below —
      // discarding a paid response and purchasing a third identification of
      // the same bytes was the composition defect the hostile audit found.
      let paidLegacyResponse: Awaited<ReturnType<typeof identifyScanImage>> | null = null;
      if (v2Flag.enabled && prepared.base64) {
        const outcome = await identifyDirectImageForStyle({
          preparedUri: analysisUri,
          source: 'photo_library',
          requestId: `intake_${operationId}`,
          sessionFlag: v2Flag,
          policy: 'item',
          ...(abortRef.current?.signal ? { signal: abortRef.current.signal } : {}),
          isCurrent: () => operationId === operationIdRef.current,
        });
        if (operationId !== operationIdRef.current) return; // late result discard

        if (outcome.kind === 'identified') {
          const candidateReady = await persistCandidateReview({
            title: outcome.title,
            category: outcome.category,
            color: canonicalPrimaryColor(outcome.context),
            result: canonicalSummary(outcome.context),
            context: outcome.context,
          });
          if (operationId !== operationIdRef.current) return;
          if (!candidateReady) {
            setIdentifyFailureMessage('This photo could not be prepared for Elise. Try again.');
            setStep('identify_failed');
            return;
          }
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
          setStep('review');
          return;
        }
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind === 'no_evidence' || outcome.kind === 'needs_selection') {
          await markCandidateNeedsManual();
          if (operationId !== operationIdRef.current) return;
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
        // through to the unchanged legacy handling below, reusing the response
        // the orchestrator's single permitted retry already paid for.
        if (outcome.kind === 'legacy_fallback' && outcome.legacyResponse !== undefined) {
          paidLegacyResponse = outcome.legacyResponse;
        }
      }

      const identification = paidLegacyResponse ?? (prepared.base64
        ? await identifyScanImage(prepared.base64, {
            source: 'upload',
            localPrivacyFiltered,
            signal: abortRef.current?.signal,
          })
        : null);
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
        await markCandidateNeedsManual();
        if (operationId !== operationIdRef.current) return;
        setStep('identify_failed');
        return;
      }

      const candidateReady = await persistCandidateReview({
        title: identifiedCategory,
        category: identifiedCategory,
        color: mapped.metadata.color,
        result: mapped.result,
      });
      if (operationId !== operationIdRef.current) return;
      if (!candidateReady) {
        setIdentifyFailureMessage('This photo could not be prepared for Elise. Try again.');
        setStep('identify_failed');
        return;
      }

      setTitle(identifiedCategory);
      setCategory(identifiedCategory);
      setColor(mapped.metadata.color);
      setResultText(mapped.result);
      setStep('review');
    } catch {
      if (operationId !== operationIdRef.current) return;
      await markCandidateNeedsManual();
      if (operationId !== operationIdRef.current) return;
      setIdentifyFailureMessage('Identification stopped before this photo was ready. Try again.');
      setStep('identify_failed');
    } finally {
      inFlightRef.current = false;
    }
  }, [markCandidateNeedsManual, onClose, persistCandidateReview]);

  // Open picker automatically when the modal becomes visible from idle.
  useEffect(() => {
    if (visible && step === 'idle' && !inFlightRef.current) {
      void startPicker();
    }
  }, [visible, step, startPicker]);

  // Dismissal is what releases the picker claim on the cancel and
  // permission-denied paths. Releasing it inline there would race the parent's
  // `onClose`: in the render between clearing the flag and `visible` turning
  // false, the effect above would reopen the gallery the user just dismissed.
  useEffect(() => {
    if (!visible) inFlightRef.current = false;
  }, [visible]);

  const handleAttach = useCallback(async () => {
    if (attachingRef.current) return;
    const staged = candidateRef.current;
    const finalTitle = title.trim();
    const finalCategory = category.trim();
    if (!staged || !imageUri || !finalTitle || !finalCategory) {
      setSaveError('Add a title and category first.');
      return;
    }
    if (!fashionContext) {
      setSaveError('Try another photo so Elise can identify the item before attaching it.');
      return;
    }

    attachingRef.current = true;
    setAttaching(true);
    setSaveError(null);
    try {
      const ready = await persistCandidateReview({
        title: finalTitle,
        category: finalCategory,
        color,
        result: resultText,
        context: fashionContext,
      });
      if (!ready || candidateRef.current?.candidateId !== staged.candidateId) {
        setSaveError("Couldn't prepare this photo for Elise. Try again.");
        return;
      }

      onAttached({
        candidateId: staged.candidateId,
        batchId: staged.batchId,
        imageUri: staged.imageUri,
        thumbnailUri: staged.thumbnailUri,
        summary: {
          title: finalTitle,
          subtitle: finalCategory,
          imageUri: staged.thumbnailUri ?? staged.imageUri,
          itemCount: 1,
        },
        fashionContext,
        identificationState: 'ready',
        closetState: closetStateRef.current,
        closetItemId: closetItemIdRef.current,
      });
      candidateRef.current = null;
      resetState();
      onClose();
    } finally {
      attachingRef.current = false;
      setAttaching(false);
    }
  }, [
    title, category, color, resultText, imageUri, fashionContext, closetState, closetItemId,
    persistCandidateReview, onAttached, onClose, resetState,
  ]);

  const handleSaveToCloset = useCallback(async () => {
    if (savingRef.current || closetState === 'saved') return;
    const staged = candidateRef.current;
    const finalTitle = title.trim();
    const finalCategory = category.trim();
    if (!staged || !finalTitle || !finalCategory) {
      setSaveError('Add a title and category first.');
      return;
    }

    savingRef.current = true;
    setSaveError(null);
    closetStateRef.current = 'saving';
    setClosetState('saving');
    onClosetOutcome?.(staged.candidateId, 'saving');
    try {
      const ready = await persistCandidateReview({
        title: finalTitle,
        category: finalCategory,
        color,
        result: resultText,
        context: fashionContext,
      });
      if (!ready) throw new Error('candidate_not_ready');
      const result = await promoteSelectedClosetCandidates({
        actorId: staged.actorRequest.actorId,
        actorEpoch: staged.actorRequest.epoch,
        batchId: staged.batchId,
        candidateIds: [staged.candidateId],
      });
      const item = result?.results?.[0];
      const committedClosetItemId = item?.committedClosetItemId ?? null;
      if (
        (item?.status === 'promoted' || item?.status === 'already_promoted') &&
        typeof committedClosetItemId === 'string' &&
        committedClosetItemId
      ) {
        closetStateRef.current = 'saved';
        closetItemIdRef.current = committedClosetItemId;
        setClosetState('saved');
        setClosetItemId(committedClosetItemId);
        onClosetOutcome?.(staged.candidateId, 'saved', committedClosetItemId);
        return;
      }
      throw new Error('promotion_failed');
    } catch {
      closetStateRef.current = 'save_failed';
      closetItemIdRef.current = null;
      setClosetState('save_failed');
      setSaveError("Couldn't save to Closet. You can still attach and retry later.");
      onClosetOutcome?.(staged.candidateId, 'save_failed');
    } finally {
      savingRef.current = false;
    }
  }, [
    closetState, title, category, color, resultText, fashionContext,
    persistCandidateReview, onClosetOutcome,
  ]);

  const handleTryAnother = useCallback(async () => {
    operationIdRef.current += 1;
    abortRef.current?.abort();
    await discardCurrentCandidate();
    // `idle` has one picker owner: the visibility effect below. Calling
    // `startPicker` here as well would request two native pickers for one tap.
    resetState();
  }, [discardCurrentCandidate, resetState]);

  const handleCancel = () => {
    operationIdRef.current += 1;
    abortRef.current?.abort();
    void (async () => {
      if (savingRef.current) candidateRef.current = null;
      else await discardCurrentCandidate();
      resetState();
      onClose();
    })();
  };

  const busy = step === 'sanitizing' || step === 'identifying';

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
                  : 'Identifying this item…'}
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
              <PrimaryButton title="Try Again" onPress={() => { void handleTryAnother(); }} accessibilityLabel="Try again" />
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
              <SecondaryButton title="Try Another Photo" onPress={() => { void handleTryAnother(); }} />
              <SecondaryButton title="Cancel" onPress={handleCancel} />
            </>
          ) : null}

          {step === 'review' || step === 'manual_details' ? (
            <ScrollView style={styles.reviewScroll} showsVerticalScrollIndicator={false}>
              {imageUri ? <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="cover" /> : null}
              <TextField label="Title" value={title} onChangeText={setTitle} />
              <TextField label="Category" value={category} onChangeText={setCategory} />
              {step === 'review' ? <TextField label="Color" value={color} onChangeText={setColor} /> : null}
              {saveError ? <InlineNotice variant="error" title="Photo" body={saveError} /> : null}
              {/*
                Attaching requires a real identified context, and only the V2
                `identified` outcome produces one. Every other route here — the
                legacy identification path, and `manual_details` after a failed
                or ambiguous identification — arrives with `fashionContext`
                null, which disables the primary action below.
                Without this notice that disabled control is unexplained: the
                sheet shows a filled-in garment and a working "Save to Closet"
                beside a button that can never activate, and the user is left
                with no way to tell that the recovery is another photo. State
                the reason and keep the retry visible rather than fabricating a
                context the identification never produced.
              */}
              {!fashionContext ? (
                <InlineNotice
                  variant="info"
                  title="Attach to Elise"
                  body="Elise needs to identify this item before it can be attached. Saving to your Closet still works — to attach it, try another photo of a single piece."
                />
              ) : null}
              <PrimaryButton
                title="Attach to Elise"
                onPress={() => { void handleAttach(); }}
                loading={attaching}
                disabled={!title.trim() || !category.trim() || !fashionContext}
                accessibilityLabel="Attach photo to Elise"
                testID="attach-to-elise-button"
              />
              <SecondaryButton
                title={closetState === 'saved'
                  ? 'Saved to Closet'
                  : closetState === 'save_failed'
                    ? 'Retry Save to Closet'
                    : 'Save to Closet'}
                onPress={() => { void handleSaveToCloset(); }}
                loading={closetState === 'saving'}
                disabled={!title.trim() || !category.trim() || closetState === 'saved'}
                accessibilityLabel="Save photo to Closet"
                testID="save-to-closet-button"
              />
              <SecondaryButton
                title="Try Another Photo"
                onPress={() => { void handleTryAnother(); }}
                disabled={closetState === 'saving' || attaching}
              />
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
