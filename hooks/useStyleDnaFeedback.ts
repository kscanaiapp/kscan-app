import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getFeedbackForMessage,
  setFeedbackForMessage,
  type LocalStyleDnaFeedbackValue,
} from '../services/style-dna/localStyleDnaFeedbackStore';
import {
  getReasonForMessage,
  setReasonForMessage,
  clearReasonForMessage,
  isReasonValidForFeedback,
  STYLE_DNA_REASON_FEEDBACK_ENABLED,
  type StyleDnaReasonCode,
} from '../services/style-dna/localStyleDnaReasons';

// Style DNA Phase 0/3 — per-message local feedback hook.
// Phase 0: loads any persisted Helpful/Not-my-style selection on mount, then exposes an
// optimistic save that reverts on write failure.
// Phase 3 (flag-gated): optional reason code per message. Reason capture never blocks the
// feedback tap; changing feedback polarity clears any now-incompatible reason.

export interface UseStyleDnaFeedbackParams {
  userKey: string | null | undefined;
  sessionId: string;
  messageId: string;
  enabled?: boolean;
  onSaved?: (value: LocalStyleDnaFeedbackValue) => void;
}

export interface UseStyleDnaFeedbackReturn {
  selectedFeedback: LocalStyleDnaFeedbackValue | null;
  isSavingFeedback: boolean;
  feedbackError: string | null;
  saveFeedback: (value: LocalStyleDnaFeedbackValue) => void;
  // Phase 3 (optional reason enrichment)
  reasonEnabled: boolean;
  selectedReason: StyleDnaReasonCode | null;
  isSavingReason: boolean;
  saveReason: (code: StyleDnaReasonCode) => void;
}

export function useStyleDnaFeedback({
  userKey,
  sessionId,
  messageId,
  enabled = true,
  onSaved,
}: UseStyleDnaFeedbackParams): UseStyleDnaFeedbackReturn {
  const [selectedFeedback, setSelectedFeedback] = useState<LocalStyleDnaFeedbackValue | null>(null);
  const [isSavingFeedback, setIsSavingFeedback] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [selectedReason, setSelectedReason] = useState<StyleDnaReasonCode | null>(null);
  const [isSavingReason, setIsSavingReason] = useState(false);
  const mountedRef = useRef(true);

  const active = Boolean(enabled && userKey && sessionId && messageId);
  const reasonEnabled = STYLE_DNA_REASON_FEEDBACK_ENABLED;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Hydrate persisted feedback (and reason, when enabled). Row renders unselected first,
  // then updates — avoids blocking the bubble on AsyncStorage.
  useEffect(() => {
    let cancelled = false;
    if (!active) {
      setSelectedFeedback(null);
      setSelectedReason(null);
      return;
    }
    void (async () => {
      try {
        const record = await getFeedbackForMessage({
          userKey: userKey as string,
          sessionId,
          messageId,
        });
        if (cancelled) return;
        const feedback = record?.feedback ?? null;
        setSelectedFeedback(feedback);

        if (!reasonEnabled || !feedback) {
          setSelectedReason(null);
          return;
        }
        const reasonRecord = await getReasonForMessage({
          userKey: userKey as string,
          sessionId,
          messageId,
        });
        if (cancelled) return;
        // Defensive: only surface a stored reason that still matches the stored polarity.
        const code = reasonRecord?.reasonCode ?? null;
        setSelectedReason(code && isReasonValidForFeedback(code, feedback) ? code : null);
      } catch {
        if (!cancelled) {
          setSelectedFeedback(null);
          setSelectedReason(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, reasonEnabled, userKey, sessionId, messageId]);

  const saveFeedback = useCallback(
    (value: LocalStyleDnaFeedbackValue) => {
      if (!active) return;
      // Re-tapping the current selection is a no-op (no write, no confirmation spam).
      if (value === selectedFeedback) return;

      const previous = selectedFeedback;
      setSelectedFeedback(value); // optimistic
      setIsSavingFeedback(true);
      setFeedbackError(null);

      // Polarity changed: any prior reason is now incompatible. Clear it locally and in
      // storage so the profile/aggregation never keeps a mismatched reason.
      if (selectedReason !== null) {
        setSelectedReason(null);
        void clearReasonForMessage({
          userKey: userKey as string,
          sessionId,
          messageId,
        }).catch(() => {});
      }

      void (async () => {
        try {
          await setFeedbackForMessage({
            userKey: userKey as string,
            sessionId,
            messageId,
            feedback: value,
          });
          if (mountedRef.current) {
            setIsSavingFeedback(false);
            onSaved?.(value);
          }
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
    [active, selectedFeedback, selectedReason, userKey, sessionId, messageId, onSaved],
  );

  const saveReason = useCallback(
    (code: StyleDnaReasonCode) => {
      if (!active || !reasonEnabled) return;
      const feedback = selectedFeedback;
      // Reason requires a current feedback selection and must match its polarity.
      if (!feedback || !isReasonValidForFeedback(code, feedback)) return;

      // Tapping the current reason again clears it (fully optional, easy to undo).
      if (code === selectedReason) {
        setSelectedReason(null);
        setIsSavingReason(true);
        void (async () => {
          try {
            await clearReasonForMessage({ userKey: userKey as string, sessionId, messageId });
          } catch {
            // best-effort; leave UI cleared
          } finally {
            if (mountedRef.current) setIsSavingReason(false);
          }
        })();
        return;
      }

      const previous = selectedReason;
      setSelectedReason(code); // optimistic
      setIsSavingReason(true);
      void (async () => {
        try {
          await setReasonForMessage({
            userKey: userKey as string,
            sessionId,
            messageId,
            feedback,
            reasonCode: code,
          });
          if (mountedRef.current) setIsSavingReason(false);
        } catch {
          if (mountedRef.current) {
            setSelectedReason(previous);
            setIsSavingReason(false);
          }
        }
      })();
    },
    [active, reasonEnabled, selectedFeedback, selectedReason, userKey, sessionId, messageId],
  );

  return {
    selectedFeedback,
    isSavingFeedback,
    feedbackError,
    saveFeedback,
    reasonEnabled,
    selectedReason,
    isSavingReason,
    saveReason,
  };
}
