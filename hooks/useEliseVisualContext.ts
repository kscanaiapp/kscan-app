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
  removeVisualContextEntry,
  restartVisualContextEntry,
  setVisualContextFocusedEntry,
  subscribeToVisualContextCollection,
  updateVisualContextEntryIfCurrent,
} from '../services/style-chat/eliseVisualContextStore';
import { buildEliseVisualContext } from '../services/style-chat/buildEliseVisualContext';
import { setDraftComposerText } from '../services/style-chat/styleChatAttachmentStore';
import {
  ELISE_VISUAL_CONTEXT_MAX_ENTRIES,
  type EliseVisualContextEntry,
} from '../types/eliseVisualContext';

const MAX_CONCURRENT_PREP = 2;

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
  const runningRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<Array<{ entryId: string; rawUri: string; revision: number }>>([]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => subscribeToVisualContextCollection(refresh), [refresh]);

  const collection = actorKey ? getVisualContextCollection(actorKey, sessionId) : null;
  const entries = collection?.entries ?? [];
  const isProcessing = entries.some(
    (entry) => entry.status === 'preparing' || entry.status === 'analyzing',
  );
  const hasReadyEntry = entries.some((entry) => entry.status === 'ready');
  const hasBlockedEntry = entries.some((entry) => entry.status === 'blocked');
  const remainingSlots = Math.max(0, ELISE_VISUAL_CONTEXT_MAX_ENTRIES - entries.length);

  const startScan = useCallback(
    (currentDraftText: string) => {
      if (inFlightRef.current) return;
      if (!actorKey) {
        Alert.alert('Sign in required', 'Please sign in to use visual context.');
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
    [actorKey, router, sessionId],
  );

  const processEntry = useCallback(
    async (entryId: string, rawUri: string, revision: number) => {
      if (!actorKey) return;

      if (!isPrivateImageUploadAvailable()) {
        updateVisualContextEntryIfCurrent(
          actorKey,
          sessionId,
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
        const applied = updateVisualContextEntryIfCurrent(
          actorKey,
          sessionId,
          entryId,
          revision,
          (entry) => ({
            ...entry,
            status: 'ready',
            title: entry.title || 'Uploaded photo',
            sanitizedPreviewUri: prepared.sanitizedUri,
            privacyPolicy: prepared.policy,
          }) as EliseVisualContextEntry,
        );
        if (!applied && sanitizedUri) {
          void cleanupSanitizedImage(sanitizedUri);
        }
      } catch (error) {
        if (sanitizedUri) void cleanupSanitizedImage(sanitizedUri);
        const message = error instanceof Error ? error.message : 'Upload failed';
        updateVisualContextEntryIfCurrent(
          actorKey,
          sessionId,
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
    [actorKey, sessionId],
  );

  const startNextJobs = useCallback(() => {
    while (runningRef.current.size < MAX_CONCURRENT_PREP && queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (!next) break;
      if (runningRef.current.has(next.entryId)) continue;
      runningRef.current.add(next.entryId);
      void processEntry(next.entryId, next.rawUri, next.revision).finally(() => {
        runningRef.current.delete(next.entryId);
        startNextJobs();
      });
    }
  }, [processEntry]);

  const enqueuePreparation = useCallback(
    (entryId: string, rawUri: string, revision: number) => {
      queueRef.current.push({ entryId, rawUri, revision });
      startNextJobs();
    },
    [startNextJobs],
  );

  const startUpload = useCallback(async () => {
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

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: slots,
      quality: 1,
    });

    if (result.canceled || !result.assets?.length) return;

    const assets = result.assets.slice(0, slots);
    for (const asset of assets) {
      const entry = buildEliseVisualContext({
        actorKey,
        sessionId,
        source: 'upload',
        status: 'preparing',
        title: 'Preparing upload…',
        sanitizedPreviewUri: asset.uri,
        rawImageUri: asset.uri,
        privacyPolicy: blockedPrivacyPolicy(),
      });
      const appended = appendVisualContextEntry(actorKey, sessionId, entry);
      if (appended) {
        enqueuePreparation(appended.entry.id, asset.uri, appended.revision);
      }
    }
  }, [actorKey, sessionId, enqueuePreparation]);

  const remove = useCallback(
    (entryId: string) => {
      if (!actorKey) return;
      const current = getVisualContextCollection(actorKey, sessionId);
      const entry = current?.entries.find((e) => e.id === entryId);
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
        enqueuePreparation(entryId, rawUri, revision);
      }
    },
    [actorKey, sessionId, enqueuePreparation],
  );

  const setFocusedEntry = useCallback(
    (entryId: string) => {
      if (!actorKey) return;
      setVisualContextFocusedEntry(actorKey, sessionId, entryId);
    },
    [actorKey, sessionId],
  );

  const clear = useCallback(() => {
    if (!actorKey) return;
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
    remainingSlots,
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
