import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getFeedbackForMessage,
  setFeedbackForMessage,
  type LocalSignatureStyleFeedbackValue,
} from '../services/signature-style/localSignatureStyleFeedbackStore';
import {
  getReasonForMessage,
  setReasonForMessage,
  clearReasonForMessage,
  isReasonValidForFeedback,
  SIGNATURE_STYLE_REASON_FEEDBACK_ENABLED,
  type SignatureStyleReasonCode,
} from '../services/signature-style/localSignatureStyleReasons';

// Style DNA Phase 0/3 — per-message local feedback hook.
// Phase 0: loads any persisted Helpful/Not-my-style selection on mount, then exposes an
// optimistic save that reverts on write failure.
// Phase 3 (flag-gated): optional reason code per message. Reason capture never blocks the
// feedback tap; changing feedback polarity clears any now-incompatible reason.

export interface UseSignatureStyleFeedbackParams {
  userKey: string | null | undefined;
  sessionId: string;
  messageId: string;
  enabled?: boolean;
  onSaved?: (value: LocalSignatureStyleFeedbackValue) => void;
}

export interface UseSignatureStyleFeedbackReturn {
  selectedFeedback: LocalSignatureStyleFeedbackValue | null;
  isSavingFeedback: boolean;
  feedbackError: string | null;
  saveFeedback: (value: LocalSignatureStyleFeedbackValue) => Promise<boolean>;
  // Phase 3 (optional reason enrichment)
  reasonEnabled: boolean;
  selectedReason: SignatureStyleReasonCode | null;
  isSavingReason: boolean;
  saveReason: (code: SignatureStyleReasonCode) => void;
}

export function useSignatureStyleFeedback({
  userKey,
  sessionId,
  messageId,
  enabled = true,
  onSaved,
}: UseSignatureStyleFeedbackParams): UseSignatureStyleFeedbackReturn {
  const [selectedFeedback, setSelectedFeedback] = useState<LocalSignatureStyleFeedbackValue | null>(null);
  const [isSavingFeedback, setIsSavingFeedback] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [selectedReason, setSelectedReason] = useState<SignatureStyleReasonCode | null>(null);
  const [isSavingReason, setIsSavingReason] = useState(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(false);
  const selectedFeedbackRef = useRef<LocalSignatureStyleFeedbackValue | null>(null);
  const selectedReasonRef = useRef<SignatureStyleReasonCode | null>(null);
  const savingFeedbackRef = useRef(false);
  const savingReasonRef = useRef(false);
  const scopeVersionRef = useRef(0);
  const hydrationVersionRef = useRef(0);
  const scopeKeyRef = useRef('');

  const active = Boolean(enabled && userKey && sessionId && messageId);
  const reasonEnabled = SIGNATURE_STYLE_REASON_FEEDBACK_ENABLED;
  const scopeKey = `${userKey ?? ''}\u0000${sessionId}\u0000${messageId}`;
  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey;
    scopeVersionRef.current += 1;
    hydrationVersionRef.current += 1;
    savingFeedbackRef.current = false;
    savingReasonRef.current = false;
  }
  activeRef.current = active;

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
    const scopeVersion = scopeVersionRef.current;
    const hydrationVersion = ++hydrationVersionRef.current;
    if (!active) {
      selectedFeedbackRef.current = null;
      selectedReasonRef.current = null;
      setSelectedFeedback(null);
      setSelectedReason(null);
      setIsSavingFeedback(false);
      setIsSavingReason(false);
      setFeedbackError(null);
      return;
    }
    void (async () => {
      try {
        const record = await getFeedbackForMessage({
          userKey: userKey as string,
          sessionId,
          messageId,
        });
        if (
          cancelled ||
          scopeVersionRef.current !== scopeVersion ||
          hydrationVersionRef.current !== hydrationVersion
        ) return;
        const feedback = record?.feedback ?? null;
        selectedFeedbackRef.current = feedback;
        setSelectedFeedback(feedback);

        if (!reasonEnabled || !feedback) {
          selectedReasonRef.current = null;
          setSelectedReason(null);
          return;
        }
        const reasonRecord = await getReasonForMessage({
          userKey: userKey as string,
          sessionId,
          messageId,
        });
        if (
          cancelled ||
          scopeVersionRef.current !== scopeVersion ||
          hydrationVersionRef.current !== hydrationVersion
        ) return;
        // Defensive: only surface a stored reason that still matches the stored polarity.
        const code = reasonRecord?.reasonCode ?? null;
        const nextReason = code && isReasonValidForFeedback(code, feedback) ? code : null;
        selectedReasonRef.current = nextReason;
        setSelectedReason(nextReason);
      } catch {
        if (
          !cancelled &&
          scopeVersionRef.current === scopeVersion &&
          hydrationVersionRef.current === hydrationVersion
        ) {
          selectedFeedbackRef.current = null;
          selectedReasonRef.current = null;
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
    async (value: LocalSignatureStyleFeedbackValue): Promise<boolean> => {
      if (!activeRef.current || savingFeedbackRef.current) return false;
      // Re-tapping the current selection is a no-op (no write, no confirmation spam).
      if (value === selectedFeedbackRef.current) return false;

      const operationScopeVersion = scopeVersionRef.current;
      const previous = selectedFeedbackRef.current;
      const previousReason = selectedReasonRef.current;
      hydrationVersionRef.current += 1;
      savingFeedbackRef.current = true;
      selectedFeedbackRef.current = value;
      setSelectedFeedback(value); // optimistic
      setIsSavingFeedback(true);
      setFeedbackError(null);

      // Polarity changed: any prior reason is now incompatible. Keep enough state to
      // restore it if either durable write fails.
      if (previousReason !== null) {
        selectedReasonRef.current = null;
        setSelectedReason(null);
      }

      try {
        if (previousReason !== null) {
          await clearReasonForMessage({
            userKey: userKey as string,
            sessionId,
            messageId,
          });
        }
        await setFeedbackForMessage({
          userKey: userKey as string,
          sessionId,
          messageId,
          feedback: value,
        });
        if (mountedRef.current && scopeVersionRef.current === operationScopeVersion) {
          savingFeedbackRef.current = false;
          setIsSavingFeedback(false);
          onSaved?.(value);
        }
        return true;
      } catch {
        if (previous !== null && previousReason !== null) {
          try {
            await setReasonForMessage({
              userKey: userKey as string,
              sessionId,
              messageId,
              feedback: previous,
              reasonCode: previousReason,
            });
          } catch {
            // The feedback error remains visible; a later hydration reconciles storage.
          }
        }
        // Revert optimistic state on write failure, but never repaint a newer
        // actor/message scope with the previous scope's state.
        if (mountedRef.current && scopeVersionRef.current === operationScopeVersion) {
          savingFeedbackRef.current = false;
          selectedFeedbackRef.current = previous;
          selectedReasonRef.current = previousReason;
          setSelectedFeedback(previous);
          setSelectedReason(previousReason);
          setIsSavingFeedback(false);
          setFeedbackError("Couldn't save feedback");
        }
        return false;
      }
    },
    [userKey, sessionId, messageId, onSaved],
  );

  const saveReason = useCallback(
    (code: SignatureStyleReasonCode) => {
      if (!activeRef.current || !reasonEnabled || savingReasonRef.current) return;
      const feedback = selectedFeedbackRef.current;
      // Reason requires a current feedback selection and must match its polarity.
      if (!feedback || !isReasonValidForFeedback(code, feedback)) return;

      // Tapping the current reason again clears it (fully optional, easy to undo).
      if (code === selectedReasonRef.current) {
        const previous = selectedReasonRef.current;
        selectedReasonRef.current = null;
        savingReasonRef.current = true;
        setSelectedReason(null);
        setIsSavingReason(true);
        const operationScopeVersion = scopeVersionRef.current;
        void (async () => {
          try {
            await clearReasonForMessage({ userKey: userKey as string, sessionId, messageId });
          } catch {
            if (mountedRef.current && scopeVersionRef.current === operationScopeVersion) {
              selectedReasonRef.current = previous;
              setSelectedReason(previous);
            }
          } finally {
            if (mountedRef.current && scopeVersionRef.current === operationScopeVersion) {
              savingReasonRef.current = false;
              setIsSavingReason(false);
            }
          }
        })();
        return;
      }

      const operationScopeVersion = scopeVersionRef.current;
      const previous = selectedReasonRef.current;
      selectedReasonRef.current = code;
      savingReasonRef.current = true;
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
          if (mountedRef.current && scopeVersionRef.current === operationScopeVersion) {
            savingReasonRef.current = false;
            setIsSavingReason(false);
          }
        } catch {
          if (mountedRef.current && scopeVersionRef.current === operationScopeVersion) {
            savingReasonRef.current = false;
            selectedReasonRef.current = previous;
            setSelectedReason(previous);
            setIsSavingReason(false);
          }
        }
      })();
    },
    [reasonEnabled, userKey, sessionId, messageId],
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
