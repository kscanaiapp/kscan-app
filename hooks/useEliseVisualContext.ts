import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import {
  cleanupSanitizedImage,
  isPrivateImageUploadAvailable,
  PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE,
} from '../services/privacyImageUpload';
import {
  createVisualContextScanIntent,
  getVisualContext,
  removeVisualContext,
  subscribeToVisualContext,
} from '../services/style-chat/eliseVisualContextStore';
import { setDraftComposerText } from '../services/style-chat/styleChatAttachmentStore';

/**
 * Manage one pending visual context for an Elise session.
 *
 * Upload stays visibly disabled and this callback also fails closed until a
 * cross-platform face + license-plate masker is integrated and runtime-proven.
 * Scan navigation uses an opaque, actor/revision-bound return intent.
 */
export function useEliseVisualContext(sessionId: string, actorKey: string | null) {
  const router = useRouter();
  const [, setTick] = useState(0);
  const inFlightRef = useRef(false);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => subscribeToVisualContext(refresh), [refresh]);

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

  const startUpload = useCallback(async () => {
    if (!actorKey) {
      Alert.alert('Sign in required', 'Please sign in to use visual context.');
      return;
    }
    Alert.alert('Upload unavailable', PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE);
  }, [actorKey]);

  const remove = useCallback(() => {
    if (!actorKey) return;
    const current = getVisualContext(actorKey, sessionId);
    if (current?.sanitizedPreviewUri) {
      void cleanupSanitizedImage(current.sanitizedPreviewUri);
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
    uploadAvailable: isPrivateImageUploadAvailable(),
    uploadUnavailableReason: PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE,
  };
}
