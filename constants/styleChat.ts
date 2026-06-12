export const STYLE_CHAT_PREMIUM_REQUIRED = false;
export const STYLE_CHAT_MONTHLY_MESSAGE_LIMIT = 50; // retained for legacy monthly tracking
export const STYLE_CHAT_NEAR_LIMIT_THRESHOLD = 5;

// v0.4 beta: daily cap enforced server-side. Mobile displays this as the limit.
export const STYLE_CHAT_DAILY_MESSAGE_LIMIT = 25;

export const STYLE_CHAT_COPY = {
  header: 'STYLECHAT',
  subtitle: 'PRIVATE AI STYLING PREVIEW',
  premiumBadge: 'FOUNDER PREMIUM PREVIEW',
  emptySessionList:
    'Start a private styling session to compare scans, saved looks, or Dressing Room feedback.',
  emptyChat:
    'Ask StyleChat how to style a scan, compare saved looks, or choose from a Dressing Room.',
  newSessionCta: 'NEW SESSION',
  errorGeneric: 'StyleChat preview is unavailable. Try again.',
  errorUsageLimit:
    "You've reached today's StyleChat beta limit. Come back tomorrow for more styling help.",
  systemLimitNotice:
    "You've reached today's StyleChat beta limit. Come back tomorrow for more styling help.",
  burstLimitNotice:
    'StyleChat is receiving messages too quickly. Please wait a moment and try again.',
  homeEntryLabel: 'ASK STYLECHAT',
  homeEntrySubtitle:
    'Style a scan, compare looks, or choose from a Dressing Room.',
} as const;
