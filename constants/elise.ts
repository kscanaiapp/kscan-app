// Centralized user-facing identity for Elise, K Scan AI's virtual stylist.
// This module is for product copy only. Internal technical identifiers
// (StyleChat, AI Stylist, stylechat-generate, aiStylist, etc.) must not
// be renamed here or in dependent code.

export const ELISE_IDENTITY = {
  displayName: 'Elise',
  role: 'AI-powered virtual stylist',
  fullRole: 'Elise, your AI-powered virtual stylist',
  introTitle: 'Meet Elise',
  introDescription:
    'Your AI-powered virtual stylist, built around the clothes you already own.',
  suggestionsHeading: "Elise's Suggestions",
  askLabel: 'ASK ELISE',
  askAboutItemLabel: 'ASK ELISE ABOUT THIS ITEM',
  askAboutLookLabel: 'ASK ELISE ABOUT THIS LOOK',
  askAboutOutfitLabel: 'ASK ELISE ABOUT THIS OUTFIT',
  styleWithEliseLabel: 'STYLE WITH ELISE',
  buildOutfitsLabel: 'BUILD OUTFITS WITH ELISE',
  unavailableTitle: "Elise isn't available right now",
  unavailableMessage: 'You can build a Look manually or try again later.',
  headerAccessibilityLabel: 'Elise, AI-powered virtual stylist',
  sendAccessibilityLabel: 'Send message to Elise',
  attachAccessibilityLabel: 'Open Elise attachment menu',
  removeAttachmentAccessibilityLabel: 'Remove item before sending to Elise',
  retryAttachmentAccessibilityLabel: 'Retry preparing item for Elise',
} as const;

export const STYLE_MEMORY_COPY = {
  featureName: 'Signature Style',
  onDeviceLabel: 'Signature Style · On-device',
  learningLabel: 'Signature Style is learning · Rate a few replies',
  detailsAccessibilityLabel: 'Signature Style details',
  detailsHint: 'Opens your on-device Signature Style summary and reset option',
  resetAlertTitle: 'Reset local Signature Style?',
  resetAlertMessage:
    'This clears Helpful and Not my style feedback for this account on this device only. It cannot be undone.',
  resetErrorAlertTitle: 'Could not reset local Signature Style',
  resetErrorAlertMessage:
    "We couldn't clear the local profile right now. Please try again.",
  localBadge: 'LOCAL SIGNATURE STYLE',
} as const;

export const ELISE_LOADING_COPY = {
  thinking: 'Elise is thinking…',
  thinkingSubtext: 'Reading the conversation before she answers.',
  loadingSessions: 'Loading conversations…',
  loadingConversation: 'Loading conversation…',
  stylingFromCloset: 'Elise is putting together a few options…',
  reviewingLook: 'Elise is reviewing this Look…',
  restylingOutfit: 'Elise is finding another way to style this…',
} as const;

export const ELISE_ATTACHMENT_COPY = {
  selected: 'Preparing for Elise…',
  sanitizing: 'Checking image…',
  identifying: 'Identifying…',
  awaiting_review: 'Review needed',
  creating_record: 'Syncing item…',
  uploading_media: 'Uploading securely…',
  finalizing: 'Finishing…',
  failed_retryable: "Couldn't prepare this item. Retry or remove it.",
  rejected: 'Item unavailable',
  unavailable: 'Item unavailable',
} as const;

export const ELISE_STRUCTURED_ACTION_LABELS: Record<string, string> = {
  open_stylist: 'CREATE OUTFITS WITH ELISE',
  style_anchor_item: 'STYLE THIS WITH ELISE',
  style_for_event: 'ASK ELISE TO STYLE THIS EVENT',
  restyle_outfit: 'ASK ELISE TO RESTYLE',
  swap_item: 'ASK ELISE TO SWAP THIS ITEM',
  open_look: 'OPEN THIS LOOK',
  ask_my_room: 'ASK MY ROOM',
};
