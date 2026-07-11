// StyleChat v0.4 prompt constants.
// The full system prompt lives server-side in the stylechat-generate Edge Function.
// Only UI-facing strings belong here.

export const STYLECHAT_OUT_OF_SCOPE_REPLY =
  "I'm Elise, your K Scan AI stylist. I can only help with clothing, outfits, and fashion guidance.";

export const STYLECHAT_LIMIT_REACHED_NOTICE =
  "You've reached today's Elise beta limit. Come back tomorrow for more styling help.";

export const STYLECHAT_AI_PAUSED_NOTICE =
  'Elise is temporarily in preview mode. I can still help you think through outfit ideas, but live AI styling is paused right now.';

export const STYLECHAT_FALLBACK_REPLY =
  "Elise is having trouble generating styling advice right now. Please try again shortly.";
