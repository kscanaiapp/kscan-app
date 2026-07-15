export type StyleChatComposerControlInput = {
  hasValidDraft: boolean;
  isSessionUnavailable: boolean;
  isDeletingSession: boolean;
  isSubmitting: boolean;
  hasQueuedEvidence: boolean;
  hasPreparingEvidence: boolean;
  hasBlockedEvidence: boolean;
  hasFailedEvidence: boolean;
  hasAdditionalSendBlock?: boolean;
};

export type StyleChatComposerControls = {
  inputEditable: boolean;
  sendDisabled: boolean;
};

/**
 * Draft editing is a session capability. Sending is a stricter operation that
 * can also be gated by draft, request, evidence, or attachment state.
 */
export function getStyleChatComposerControls({
  hasValidDraft,
  isSessionUnavailable,
  isDeletingSession,
  isSubmitting,
  hasQueuedEvidence,
  hasPreparingEvidence,
  hasBlockedEvidence,
  hasFailedEvidence,
  hasAdditionalSendBlock = false,
}: StyleChatComposerControlInput): StyleChatComposerControls {
  const inputEditable = !isSessionUnavailable && !isDeletingSession;
  const evidenceBlocksSend =
    hasQueuedEvidence ||
    hasPreparingEvidence ||
    hasBlockedEvidence ||
    hasFailedEvidence;

  return {
    inputEditable,
    sendDisabled:
      !hasValidDraft ||
      !inputEditable ||
      isSubmitting ||
      evidenceBlocksSend ||
      hasAdditionalSendBlock,
  };
}
