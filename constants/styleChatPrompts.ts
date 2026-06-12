// StyleChat v0.4 prompt constants.
// The full system prompt lives server-side in the stylechat-generate Edge Function.
// Only UI-facing strings belong here.

export const STYLECHAT_OUT_OF_SCOPE_REPLY =
  'I am your K Scan styling assistant. I can only provide clothing, look-book, and fashion guidance.';

export const STYLECHAT_LIMIT_REACHED_NOTICE =
  "You've reached today's StyleChat beta limit. Come back tomorrow for more styling help.";

export const STYLECHAT_AI_PAUSED_NOTICE =
  'StyleChat AI is temporarily in preview mode. I can still help you think through outfit ideas, but live AI styling is paused right now.';

export const STYLECHAT_FALLBACK_REPLY =
  "I'm having trouble generating styling advice right now. Please try again shortly.";
