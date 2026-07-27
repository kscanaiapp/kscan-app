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
import { prepareVisualContextEvidence } from '../services/style-chat/eliseVisualContextEvidence';
import { setDraftComposerText } from '../services/style-chat/styleChatAttachmentStore';
import {
  ELISE_VISUAL_CONTEXT_MAX_ENTRIES,
  type EliseVisualContextEntry,
} from '../types/eliseVisualContext';

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
        });

        if (!evidence.ok) {
          if (evidence.reason === 'cancelled') return;
          // Honest terminal state. No structured fields are written, so a
          // failed entry can never be sent as grounded visual context.
          updateVisualContextEntryIfCurrent(
            jobActorKey,
            jobSessionId,
            entryId,
            revision,
            (entry) => ({
              ...entry,
              status: evidence.reason === 'non_fashion' ? 'blocked' : 'failed',
              title: evidence.message,
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
            savedScanId: evidence.savedScanId,
            sanitizedPreviewUri: prepared.sanitizedUri,
            privacyPolicy: prepared.policy,
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
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: slots,
        quality: 1,
      });
    } catch {
      Alert.alert('Photos unavailable', 'K Scan could not open your photo library. Try again.');
      return;
    } finally {
      pickerInFlightRef.current = false;
    }

    if (result.canceled || !result.assets?.length) return;

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
        (e) => ({ ...e, status: 'preparing', title: 'Preparing upload…' }) as EliseVisualContextEntry,
      );
      if (revision !== null) {
        enqueuePreparation({ actorKey, sessionId, entryId, rawUri, revision });
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

  return {
    collection,
    entries,
    isProcessing,
    hasReadyEntry,
    hasBlockedEntry,
    hasUnsendableEntry,
    remainingSlots,
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
