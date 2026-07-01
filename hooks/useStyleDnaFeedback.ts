import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getFeedbackForMessage,
  setFeedbackForMessage,
  type LocalStyleDnaFeedbackValue,
} from '../services/style-dna/localStyleDnaFeedbackStore';

// Style DNA Phase 0 — per-message local feedback hook.
// Loads any persisted selection on mount, then exposes an optimistic save that
// reverts on write failure. State lives per assistant message; the underlying
// store serializes writes for the same session map.

export interface UseStyleDnaFeedbackParams {
  userKey: string | null | undefined;
  sessionId: string;
  messageId: string;
  enabled?: boolean;
}

export interface UseStyleDnaFeedbackReturn {
  selectedFeedback: LocalStyleDnaFeedbackValue | null;
  isSavingFeedback: boolean;
  feedbackError: string | null;
  saveFeedback: (value: LocalStyleDnaFeedbackValue) => void;
}

export function useStyleDnaFeedback({
  userKey,
  sessionId,
  messageId,
  enabled = true,
}: UseStyleDnaFeedbackParams): UseStyleDnaFeedbackReturn {
  const [selectedFeedback, setSelectedFeedback] = useState<LocalStyleDnaFeedbackValue | null>(null);
  const [isSavingFeedback, setIsSavingFeedback] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const active = Boolean(enabled && userKey && sessionId && messageId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Hydrate persisted selection. Row renders unselected first, then updates —
  // avoids blocking the bubble on AsyncStorage.
  useEffect(() => {
    let cancelled = false;
    if (!active) {
      setSelectedFeedback(null);
      return;
    }
    void (async () => {
      try {
        const record = await getFeedbackForMessage({
          userKey: userKey as string,
          sessionId,
          messageId,
        });
        if (!cancelled) setSelectedFeedback(record?.feedback ?? null);
      } catch {
        if (!cancelled) setSelectedFeedback(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, userKey, sessionId, messageId]);

  const saveFeedback = useCallback(
    (value: LocalStyleDnaFeedbackValue) => {
      if (!active) return;
      // Re-tapping the current selection is a no-op (no write, no confirmation spam).
      if (value === selectedFeedback) return;

      const previous = selectedFeedback;
      setSelectedFeedback(value); // optimistic
      setIsSavingFeedback(true);
      setFeedbackError(null);

      void (async () => {
        try {
          await setFeedbackForMessage({
            userKey: userKey as string,
            sessionId,
            messageId,
            feedback: value,
          });
          if (mountedRef.current) setIsSavingFeedback(false);
        } catch {
          // Revert optimistic state on write failure.
          if (mountedRef.current) {
            setSelectedFeedback(previous);
            setIsSavingFeedback(false);
            setFeedbackError("Couldn't save feedback");
          }
        }
      })();
    },
    [active, selectedFeedback, userKey, sessionId, messageId],
  );

  return { selectedFeedback, isSavingFeedback, feedbackError, saveFeedback };
}
