import type { StyleChatMessage } from '../style-chat/types';

function hasRecommendationMetadata(message: StyleChatMessage): boolean {
  const blocks = Array.isArray(message.uiBlocks) ? message.uiBlocks : [];
  const hasRecommendationBlock = blocks.some((block) => {
    if (block?.type === 'why_this_works') {
      return typeof block.body === 'string' && block.body.trim().length > 0;
    }
    if (block?.type === 'stylechat_actions') {
      return Array.isArray(block.actions) && block.actions.length > 0;
    }
    return false;
  });
  if (hasRecommendationBlock) return true;

  return [
    message.referencedScanIds,
    message.referencedSavedItemIds,
    message.referencedDressingRoomIds,
    message.referencedCatalogItems,
  ].some((references) => Array.isArray(references) && references.length > 0);
}

// Eligibility is deliberately metadata-driven. The backend emits
// `why_this_works` only for concrete recommendations, while validated action or
// reference metadata covers recommendations without an explanation. Plain text
// and arbitrary keywords never make a greeting/general/weather-only reply
// eligible.
export function isEligibleForStyleFeedback(params: {
  message: StyleChatMessage;
  userKey: string | null | undefined;
  isError?: boolean;
}): boolean {
  const { message, userKey, isError } = params;
  const isAssistant = message.sender === 'assistant';
  const content = typeof message.content === 'string' ? message.content : '';
  return (
    isAssistant &&
    !isError &&
    Boolean(userKey) &&
    content.trim().length > 0 &&
    typeof message.id === 'string' &&
    message.id.length > 0 &&
    !message.id.startsWith('optimistic-') &&
    message.provider !== 'fallback' &&
    message.model !== 'fallback' &&
    hasRecommendationMetadata(message)
  );
}

export function shouldShowStyleFeedbackControls(params: {
  message: StyleChatMessage;
  userKey: string | null | undefined;
  isError?: boolean;
  learnFromFeedback: boolean;
  showFeedbackControls: boolean;
}): boolean {
  return (
    params.learnFromFeedback &&
    params.showFeedbackControls &&
    isEligibleForStyleFeedback({
      message: params.message,
      userKey: params.userKey,
      isError: params.isError,
    })
  );
}
