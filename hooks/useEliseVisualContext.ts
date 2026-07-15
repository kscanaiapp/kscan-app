import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import {
  cleanupSanitizedImage,
  compressSanitizedImageForAnalysis,
  prepareImageForPrivacyUpload,
  PrivacyPrepareError,
} from '../services/privacyImageUpload';
import { identifyScanImage } from '../services/scanIdentification';
import { buildEliseVisualContextFromScanIdentify } from '../services/style-chat/buildEliseVisualContext';
import {
  getVisualContext,
  isVisualContextRevisionCurrent,
  removeVisualContext,
  setVisualContext,
  subscribeToVisualContext,
  updateVisualContextIfCurrent,
} from '../services/style-chat/eliseVisualContextStore';
import { setDraftComposerText } from '../services/style-chat/styleChatAttachmentStore';
import type { EliseVisualContext } from '../types/eliseVisualContext';

export type EliseVisualContextState = {
  context: EliseVisualContext | null;
  isProcessing: boolean;
  error: string | null;
};

const ANALYSIS_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

/**
 * Manage one pending visual context for an Elise session.
 *
 * - startScan opens the canonical scanner with a return-to-session token.
 * - startUpload launches the photo library, prepares privacy, and runs fashion analysis.
 * - remove clears the pending context.
 *
 * Actor/session isolation is enforced by the backing store; stale async results
 * are rejected by revision tokens.
 */
export function useEliseVisualContext(sessionId: string, actorKey: string | null) {
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const inFlightRef = useRef(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    return subscribeToVisualContext(refresh);
  }, [refresh]);

  const context = actorKey ? getVisualContext(actorKey, sessionId) : null;
  const isProcessing = context?.status === 'preparing' || context?.status === 'analyzing';
  const error = context?.status === 'failed' ? context.title : null;

  const startScan = useCallback(
    (currentDraftText: string) => {
      if (inFlightRef.current) return;
      if (!actorKey) {
        Alert.alert('Sign in required', 'Please sign in to use visual context.');
        return;
      }
      inFlightRef.current = true;
      // Preserve the unsent composer draft before leaving the screen.
      setDraftComposerText(sessionId, currentDraftText, actorKey);
      router.push(`/scan?returnToSessionId=${encodeURIComponent(sessionId)}`);
      setTimeout(() => {
        inFlightRef.current = false;
      }, 500);
    },
    [actorKey, router, sessionId],
  );

  const startUpload = useCallback(async () => {
    if (inFlightRef.current) return;
    if (!actorKey) {
      Alert.alert('Sign in required', 'Please sign in to use visual context.');
      return;
    }

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Photo Access Required',
        'Allow K Scan to access your photo library in Settings to upload a photo.',
        [{ text: 'OK' }],
      );
      return;
    }

    let picked;
    try {
      picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        allowsEditing: false,
        allowsMultipleSelection: false,
      });
    } catch {
      // System picker cancellation is not an error.
      return;
    }

    if (picked.canceled || !picked.assets?.[0]?.uri) return;

    const asset = picked.assets[0];
    if (asset.type && asset.type !== 'image') {
      Alert.alert('Unsupported file', 'Please choose a photo.');
      return;
    }

    inFlightRef.current = true;
    const revision = setVisualContext(
      actorKey,
      sessionId,
      {
        id: `elise-vc-upload-${Date.now()}`,
        actorKey,
        sessionId,
        source: 'upload',
        status: 'preparing',
        title: 'Preparing image…',
        createdAt: Date.now(),
        revision: 0,
      },
    );

    let sanitizedUri: string | undefined;

    try {
      updateVisualContextIfCurrent(actorKey, sessionId, revision, (ctx) => ({
        ...ctx,
        status: 'preparing',
        title: 'Preparing image…',
      }));

      const prepared = await prepareImageForPrivacyUpload(asset.uri);
      sanitizedUri = prepared.sanitizedUri;

      if (!isVisualContextRevisionCurrent(actorKey, sessionId, revision)) return;

      updateVisualContextIfCurrent(actorKey, sessionId, revision, (ctx) => ({
        ...ctx,
        status: 'analyzing',
        title: 'Analyzing item…',
        sanitizedPreviewUri: sanitizedUri,
        privacyPolicy: prepared.policy,
      }));

      const compressed = await compressSanitizedImageForAnalysis(sanitizedUri);

      if (!isVisualContextRevisionCurrent(actorKey, sessionId, revision)) return;

      const identification = await withTimeout(
        identifyScanImage(compressed.base64, {
          source: 'upload',
          localPrivacyFiltered: true,
        }),
        ANALYSIS_TIMEOUT_MS,
        'Analysis timed out. Please try again.',
      );

      if (!isVisualContextRevisionCurrent(actorKey, sessionId, revision)) return;

      if (identification.status !== 'completed') {
        throw new Error(identification.userMessage || "Couldn't identify this fashion item.");
      }

      const visualContext = buildEliseVisualContextFromScanIdentify(identification, {
        actorKey,
        sessionId,
        source: 'upload',
        sanitizedPreviewUri: sanitizedUri,
        privacyPolicy: prepared.policy,
        revision,
      });

      setVisualContext(actorKey, sessionId, visualContext);
    } catch (err) {
      if (!isVisualContextRevisionCurrent(actorKey, sessionId, revision)) return;
      const message = err instanceof Error ? err.message : "Couldn't process this image.";
      updateVisualContextIfCurrent(actorKey, sessionId, revision, (ctx) => ({
        ...ctx,
        status: 'failed',
        title: message,
        sanitizedPreviewUri: sanitizedUri,
      }));
    } finally {
      inFlightRef.current = false;
    }
  }, [actorKey, sessionId]);

  const remove = useCallback(() => {
    if (!actorKey) return;
    const ctx = getVisualContext(actorKey, sessionId);
    if (ctx?.sanitizedPreviewUri) {
      void cleanupSanitizedImage(ctx.sanitizedPreviewUri);
    }
    removeVisualContext(actorKey, sessionId);
  }, [actorKey, sessionId]);

  const retry = useCallback(() => {
    remove();
    void startUpload();
  }, [remove, startUpload]);

  return {
    context,
    isProcessing,
    error,
    startScan,
    startUpload,
    remove,
    retry,
  };
}
