import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import {
  cleanupSanitizedImage,
  isPrivateImageUploadAvailable,
  prepareImageForPrivacyUpload,
  PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE,
} from '../services/privacyImageUpload';
import {
  appendVisualContextEntry,
  clearVisualContextCollection,
  createVisualContextScanIntent,
  getVisualContextCollection,
  isVisualContextEntryRevisionCurrent,
  removeVisualContextEntry,
  restartVisualContextEntry,
  setVisualContextFocusedEntry,
  subscribeToVisualContextCollection,
  updateVisualContextEntryIfCurrent,
} from '../services/style-chat/eliseVisualContextStore';
import {
  createEliseVisualContextQueue,
  type EliseVisualPreparationJob,
} from '../services/style-chat/eliseVisualContextQueue';
import { buildEliseVisualContext } from '../services/style-chat/buildEliseVisualContext';
import {
  isVisualContextEvidenceFailure,
  prepareVisualContextEvidence,
} from '../services/style-chat/eliseVisualContextEvidence';
import { setDraftComposerText } from '../services/style-chat/styleChatAttachmentStore';
import {
  ELISE_VISUAL_CONTEXT_MAX_ENTRIES,
  type EliseVisualContextEntry,
} from '../types/eliseVisualContext';
import { beginEliseV2Session } from '../services/style-chat/eliseIdentificationV2';
import { buildEliseFashionContextV2 } from '../services/style-chat/eliseFashionContextV2';

function blockedPrivacyPolicy(): EliseVisualContextEntry['privacyPolicy'] {
  return {
    mode: 'blocked',
    sanitizerVersion: 'blocked',
    faceDetectionAvailable: false,
    faceMaskApplied: false,
    plateDetectionAvailable: false,
    plateMaskApplied: false,
    metadataStripped: false,
  };
}

function uploadBlockedEntry(title: string): Partial<EliseVisualContextEntry> {
  return {
    status: 'blocked',
    title,
    summary: PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE,
    privacyPolicy: blockedPrivacyPolicy(),
  };
}

/**
 * Manage a pending multi-image visual-context collection for an Elise session.
 *
 * Scan navigation uses an opaque, actor/revision-bound return intent.
 * Upload opens the native photo picker; selected images become local evidence
 * entries only. Live analysis is never fabricated: while the privacy boundary
 * is closed, uploads are marked `blocked` and their preview is kept local.
 */
export function useEliseVisualContext(sessionId: string, actorKey: string | null) {
  const router = useRouter();
  const [, setTick] = useState(0);
  const inFlightRef = useRef(false);
  const pickerInFlightRef = useRef(false);
  const processEntryRef = useRef<(job: EliseVisualPreparationJob) => Promise<void>>(async () => {});
  const preparationQueueRef = useRef<ReturnType<typeof createEliseVisualContextQueue> | null>(null);
  if (!preparationQueueRef.current) {
    preparationQueueRef.current = createEliseVisualContextQueue({
      maxConcurrency: 2,
      run: (job) => processEntryRef.current(job),
      isCurrent: (job) => isVisualContextEntryRevisionCurrent(
        job.actorKey,
        job.sessionId,
        job.entryId,
        job.revision,
      ),
    });
  }

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => subscribeToVisualContextCollection(refresh), [refresh]);

  const collection = actorKey ? getVisualContextCollection(actorKey, sessionId) : null;
  const entries = collection?.entries ?? [];
  const isProcessing = entries.some(
    (entry) => entry.status === 'preparing' || entry.status === 'analyzing',
  );
  const hasReadyEntry = entries.some((entry) => entry.status === 'ready');
  const hasBlockedEntry = entries.some((entry) => entry.status === 'blocked');
  const hasUnsendableEntry = entries.some((entry) => entry.status !== 'ready');
  const remainingSlots = Math.max(0, ELISE_VISUAL_CONTEXT_MAX_ENTRIES - entries.length);

  const getRemainingCapacity = useCallback(() => {
    if (!actorKey) return 0;
    const latest = getVisualContextCollection(actorKey, sessionId);
    return Math.max(
      0,
      ELISE_VISUAL_CONTEXT_MAX_ENTRIES - (latest?.entries.length ?? 0),
    );
  }, [actorKey, sessionId]);

  const startScan = useCallback(
    (currentDraftText: string) => {
      if (inFlightRef.current) return;
      if (!actorKey) {
        Alert.alert('Sign in required', 'Please sign in to use visual context.');
        return;
      }
      if (getRemainingCapacity() === 0) {
        Alert.alert('Collection full', 'Remove an image before adding another.');
        return;
      }

      inFlightRef.current = true;
      setDraftComposerText(sessionId, currentDraftText, actorKey);
      const intentId = createVisualContextScanIntent(actorKey, sessionId);
      router.push(
        `/scan?returnToSessionId=${encodeURIComponent(sessionId)}&visualContextIntentId=${encodeURIComponent(intentId)}`,
      );
      setTimeout(() => {
        inFlightRef.current = false;
      }, 500);
    },
    [actorKey, getRemainingCapacity, router, sessionId],
  );

  const processEntry = useCallback(
    async (job: EliseVisualPreparationJob) => {
      const { actorKey: jobActorKey, sessionId: jobSessionId, entryId, rawUri, revision } = job;

      if (!isPrivateImageUploadAvailable()) {
        updateVisualContextEntryIfCurrent(
          jobActorKey,
          jobSessionId,
          entryId,
          revision,
          (entry) => ({
            ...entry,
            ...uploadBlockedEntry('Uploaded photo'),
          }) as EliseVisualContextEntry,
        );
        return;
      }

      let sanitizedUri: string | undefined;
      try {
        const prepared = await prepareImageForPrivacyUpload(rawUri);
        sanitizedUri = prepared.sanitizedUri;

        // Show the local preview immediately, but keep the entry in `analyzing`
        // until the backend has actually seen the image. Marking it `ready`
        // here — as this path used to — is what let the composer present Elise
        // as image-aware while `stylechat-generate` received nothing (IMG-007).
        const previewApplied = updateVisualContextEntryIfCurrent(
          jobActorKey,
          jobSessionId,
          entryId,
          revision,
          (entry) => ({
            ...entry,
            status: 'analyzing',
            title: 'Identifying photo…',
            sanitizedPreviewUri: prepared.sanitizedUri,
            privacyPolicy: prepared.policy,
          }) as EliseVisualContextEntry,
        );
        if (!previewApplied) {
          // Removed, restarted, or actor-switched during preparation.
          void cleanupSanitizedImage(prepared.sanitizedUri);
          return;
        }

        const evidence = await prepareVisualContextEvidence({
          sanitizedUri: prepared.sanitizedUri,
          // Latched once for the whole selection by `startUpload`, so image 1 and
          // image 4 of one attachment operation cannot speak different contracts.
          ...(job.sessionFlag ? { sessionFlag: job.sessionFlag } : {}),
          isCurrent: () => isVisualContextEntryRevisionCurrent(
            jobActorKey,
            jobSessionId,
            entryId,
            revision,
          ),
        });

        if (isVisualContextEvidenceFailure(evidence)) {
          if (evidence.reason === 'cancelled') return;
          const failureStatus = evidence.reason === 'non_fashion' ? 'blocked' : 'failed';
          const failureTitle = evidence.message;
          // Honest terminal state. No structured fields are written, so a
          // failed entry can never be sent as grounded visual context.
          updateVisualContextEntryIfCurrent(
            jobActorKey,
            jobSessionId,
            entryId,
            revision,
            (entry) => ({
              ...entry,
              status: failureStatus,
              title: failureTitle,
              summary: null,
            }) as EliseVisualContextEntry,
          );
          return;
        }

        const applied = updateVisualContextEntryIfCurrent(
          jobActorKey,
          jobSessionId,
          entryId,
          revision,
          (entry) => ({
            ...entry,
            ...evidence.fields,
            status: 'ready',
            closetCandidateId: evidence.candidateId,
            sanitizedPreviewUri: prepared.sanitizedUri,
            privacyPolicy: prepared.policy,
            // Present only on the V2 path. Absent leaves the legacy behaviour
            // exactly as it is, including the descriptive-only server payload.
            ...(evidence.identificationV2
              ? {
                identificationV2: evidence.identificationV2,
                identificationState: evidence.identificationState ?? 'ready',
              }
              : {}),
          }) as EliseVisualContextEntry,
        );
        if (!applied) {
          // The staged saved scan is a durable, actor-owned record; it is left
          // in the user's library rather than deleted behind their back.
          void cleanupSanitizedImage(prepared.sanitizedUri);
        }
      } catch (error) {
        if (sanitizedUri) void cleanupSanitizedImage(sanitizedUri);
        const message = error instanceof Error ? error.message : 'Upload failed';
        updateVisualContextEntryIfCurrent(
          jobActorKey,
          jobSessionId,
          entryId,
          revision,
          (entry) => ({
            ...entry,
            status: 'failed',
            title: message,
          }) as EliseVisualContextEntry,
        );
      }
    },
    [],
  );
  processEntryRef.current = processEntry;

  const enqueuePreparation = useCallback(
    (job: EliseVisualPreparationJob) => {
      preparationQueueRef.current?.enqueue(job);
    },
    [],
  );

  useEffect(() => () => {
    if (actorKey) preparationQueueRef.current?.cancelScope(actorKey, sessionId);
  }, [actorKey, sessionId]);

  const startUpload = useCallback(async () => {
    if (pickerInFlightRef.current) return;
    if (!actorKey) {
      Alert.alert('Sign in required', 'Please sign in to use visual context.');
      return;
    }

    const latest = getVisualContextCollection(actorKey, sessionId);
    const slots = Math.max(
      0,
      ELISE_VISUAL_CONTEXT_MAX_ENTRIES - (latest?.entries.length ?? 0),
    );
    if (slots === 0) {
      Alert.alert('Collection full', 'You can add up to 6 visual references.');
      return;
    }

    pickerInFlightRef.current = true;
    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: slots,
        quality: 1,
      });
    } catch {
      Alert.alert('Photos unavailable', 'K Scan AI could not open your photo library. Try again.');
      return;
    } finally {
      pickerInFlightRef.current = false;
    }

    if (result.canceled || !result.assets?.length) return;

    // Latched ONCE for this whole selection, before any image is queued. Every
    // image of one attachment operation therefore speaks the same contract.
    const sessionFlag = beginEliseV2Session();

    let skipped = 0;
    for (const asset of result.assets) {
      const entry = buildEliseVisualContext({
        actorKey,
        sessionId,
        source: 'upload',
        status: 'preparing',
        title: 'Preparing upload…',
        rawImageUri: asset.uri,
        privacyPolicy: blockedPrivacyPolicy(),
      });
      const appended = appendVisualContextEntry(actorKey, sessionId, entry);
      if (appended) {
        enqueuePreparation({
          actorKey,
          sessionId,
          entryId: appended.entry.id,
          rawUri: asset.uri,
          revision: appended.revision,
          sessionFlag,
        });
      } else {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      Alert.alert(
        'Collection updated',
        `${skipped} selected ${skipped === 1 ? 'image was' : 'images were'} not added because the 6-reference limit was reached.`,
      );
    }
  }, [actorKey, sessionId, enqueuePreparation]);

  const remove = useCallback(
    (entryId: string) => {
      if (!actorKey) return;
      const current = getVisualContextCollection(actorKey, sessionId);
      const entry = current?.entries.find((e) => e.id === entryId);
      preparationQueueRef.current?.cancelEntry(actorKey, sessionId, entryId);
      if (entry?.sanitizedPreviewUri) {
        void cleanupSanitizedImage(entry.sanitizedPreviewUri);
      }
      removeVisualContextEntry(actorKey, sessionId, entryId);
    },
    [actorKey, sessionId],
  );

  const retry = useCallback(
    (entryId: string) => {
      if (!actorKey) return;
      const current = getVisualContextCollection(actorKey, sessionId);
      const entry = current?.entries.find((e) => e.id === entryId);
      if (!entry) return;
      const rawUri = entry.rawImageUri ?? entry.sanitizedPreviewUri;
      if (!rawUri) return;

      const revision = restartVisualContextEntry(
        actorKey,
        sessionId,
        entryId,
        (e) => ({
          ...e,
          status: 'preparing',
          title: 'Preparing upload…',
          // A retry is a NEW identification operation. Clearing the previous
          // identity means a failed retry cannot leave the stale one attached and
          // looking current.
          identificationV2: undefined,
          identificationState: null,
        }) as EliseVisualContextEntry,
      );
      if (revision !== null) {
        // A retry is a new operation and resolves the flag again — which is the
        // one place a flag change is allowed to take effect.
        enqueuePreparation({
          actorKey,
          sessionId,
          entryId,
          rawUri,
          revision,
          sessionFlag: beginEliseV2Session(),
        });
      }
    },
    [actorKey, sessionId, enqueuePreparation],
  );

  const setFocusedEntry = useCallback(
    (entryId: string) => {
      if (!actorKey) return;
      const current = getVisualContextCollection(actorKey, sessionId);
      setVisualContextFocusedEntry(
        actorKey,
        sessionId,
        current?.focusedEntryId === entryId ? null : entryId,
      );
    },
    [actorKey, sessionId],
  );

  const clear = useCallback(() => {
    if (!actorKey) return;
    preparationQueueRef.current?.cancelScope(actorKey, sessionId);
    const current = getVisualContextCollection(actorKey, sessionId);
    for (const entry of current?.entries ?? []) {
      if (entry.sanitizedPreviewUri) {
        void cleanupSanitizedImage(entry.sanitizedPreviewUri);
      }
    }
    clearVisualContextCollection(actorKey, sessionId);
  }, [actorKey, sessionId]);

  /**
   * The header gallery's canonical context, aggregated in SOURCE order.
   *
   * `order` is the user's selection order and is 1-based, so it becomes a 0-based
   * `sourceIndex`. Completion order is deliberately not used: at concurrency 2 a
   * six-image selection settles out of order, and letting that decide item
   * numbering is how "the fourth photo" silently becomes "the first item".
   *
   * null whenever no ready entry carries a canonical identity — including the
   * whole legacy path — so a flag-off build sends nothing new.
   */
  const fashionContextV2 = (() => {
    const identified = entries
      .filter((entry) => entry.status === 'ready' && entry.identificationV2)
      .sort((left, right) => left.order - right.order);
    if (identified.length === 0) return null;
    // Provenance must stay truthful. When every identified reference came back
    // from the Scanner handoff the source is `scanner_handoff` — those garments
    // were scanned, not uploaded, and the prompt's provenance line differs.
    // A mixed selection reports `header_gallery`, the broader and weaker claim.
    const allFromScanner = identified.every((entry) => entry.source === 'scan');
    return buildEliseFashionContextV2({
      source: allFromScanner ? 'scanner_handoff' : 'header_gallery',
      items: identified.map((entry, index) => ({
        // Re-indexed densely: a removed entry leaves a gap in `order`, and a gap
        // would make the indices non-contiguous for no benefit.
        sourceIndex: index,
        state: entry.identificationState === 'partial' ? 'partial' : 'ready',
        identification: entry.identificationV2 as never,
      })),
    });
  })();

  return {
    collection,
    entries,
    isProcessing,
    hasReadyEntry,
    hasBlockedEntry,
    hasUnsendableEntry,
    remainingSlots,
    fashionContextV2,
    getRemainingCapacity,
    startScan,
    startUpload,
    remove,
    retry,
    setFocusedEntry,
    clear,
    uploadAvailable: true,
    uploadUnavailableReason: PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE,
  };
}
