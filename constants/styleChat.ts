export const STYLE_CHAT_PREMIUM_REQUIRED = false;
export const STYLE_CHAT_MONTHLY_MESSAGE_LIMIT = 50; // retained for legacy monthly tracking
export const STYLE_CHAT_NEAR_LIMIT_THRESHOLD = 5;

// v0.4 beta: daily cap enforced server-side. Mobile displays this as the limit.
export const STYLE_CHAT_DAILY_MESSAGE_LIMIT = 25;

export const STYLE_CHAT_COPY = {
  header: 'Elise',
  subtitle: 'YOUR AI-POWERED VIRTUAL STYLIST',
  premiumBadge: 'FOUNDER PREVIEW',
  emptySessionList:
    'Start a conversation for outfit ideas, product comparisons, or styling advice.',
  emptyChat:
    'Ask Elise how to style a scan, compare saved Looks, or choose from a Dressing Room.',
  newSessionCta: 'NEW CONVERSATION',
  errorGeneric: 'Elise is unavailable. Try again.',
  errorUsageLimit:
    "You've reached today's Elise beta limit. Come back tomorrow for more styling help.",
  systemLimitNotice:
    "You've reached today's Elise beta limit. Come back tomorrow for more styling help.",
  burstLimitNotice:
    'Elise is receiving messages too quickly. Please wait a moment and try again.',
  // Voice is an enhancement over the written reply, which stays on screen. The
  // notice is deliberately short and never names the provider or server error.
  voiceFailedNotice: "Voice couldn't play.",
  voiceRetryLabel: 'Try again',
  homeEntryLabel: 'ASK ELISE',
  homeEntrySubtitle:
    'Style a scan, compare Looks, or choose from a Dressing Room.',
} as const;
