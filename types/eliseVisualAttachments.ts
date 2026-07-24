// Elise visual attachment client model (composer-facing).
//
// Wire transport still uses V2 StyleChatAttachment types only
// (owned_item | shared_item | look | outfit_draft). Client source kinds below
// are UI/provenance labels — never invent wire attachmentType names.

import {
  MAX_LOOK_ATTACHMENTS,
  MAX_MULTIMODAL_IMAGES,
  MAX_OWNED_ITEM_ATTACHMENTS,
  MAX_OUTFIT_DRAFT_ATTACHMENTS,
  MAX_SHARED_ITEM_ATTACHMENTS,
  STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
  type AttachmentState,
  type StyleChatAttachment,
  type StyleChatAttachmentSummary,
} from './styleChatAttachments';

/** Verified stylechat-generate v2 attachment array ceiling (3+2+1+1). */
export const VERIFIED_BACKEND_MAX_ATTACHMENTS =
  MAX_OWNED_ITEM_ATTACHMENTS +
  MAX_SHARED_ITEM_ATTACHMENTS +
  MAX_LOOK_ATTACHMENTS +
  MAX_OUTFIT_DRAFT_ATTACHMENTS;

/** Verified multimodal direct-image ceiling. */
export const VERIFIED_BACKEND_MAX_DIRECT_IMAGES = MAX_MULTIMODAL_IMAGES;

/** Verified multimodal total byte budget (not per-image). */
export const VERIFIED_BACKEND_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const VERIFIED_BACKEND_ACCEPTED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/** Product ceilings for the Elise composer (never exceed backend). */
export const PRODUCT_MAX_ATTACHMENTS = 4;
export const PRODUCT_MAX_DIRECT_IMAGES = 2;

export const MAX_ELISE_ATTACHMENTS = Math.min(
  VERIFIED_BACKEND_MAX_ATTACHMENTS,
  PRODUCT_MAX_ATTACHMENTS,
);

export const MAX_ELISE_DIRECT_IMAGES = Math.min(
  VERIFIED_BACKEND_MAX_DIRECT_IMAGES,
  PRODUCT_MAX_DIRECT_IMAGES,
);

export const ELISE_ATTACHMENT_LIMIT_MESSAGE =
  `You can attach up to ${MAX_ELISE_ATTACHMENTS} items. Remove one to add another.`;

export const ELISE_DIRECT_IMAGE_LIMIT_MESSAGE =
  `You can attach up to ${MAX_ELISE_DIRECT_IMAGES} photos. Remove one to add another.`;

/**
 * Client-facing source kinds for the Elise composer.
 * Exact V2 wire names are applied only in the request adapter.
 */
export type EliseAttachmentSourceKind =
  | 'local_image'
  | 'recent_scan'
  | 'closet_item'
  | 'saved_scan'
  | 'saved_inspiration'
  | 'saved_product'
  | 'dressing_room_item'
  | 'shared_room_item';

export type EliseAttachmentProvenance =
  | 'camera'
  | 'photo_library'
  | 'recent_scan'
  | 'closet'
  | 'saved_scan'
  | 'saved_inspiration'
  | 'saved_product'
  | 'owned_room'
  | 'shared_room';

export type EliseAttachmentPreparationStatus =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'failed';

export type EliseComposerAttachment = {
  localKey: string;
  sourceKind: EliseAttachmentSourceKind;
  previewUri?: string | null;
  displayLabel: string;
  preparationStatus: EliseAttachmentPreparationStatus;
  resolutionStatus: AttachmentState;
  canonicalSourceType?: string | null;
  canonicalSourceId?: string | null;
  focused: boolean;
  recoverableError?: string | null;
  actorKey?: string | null;
  sessionId?: string | null;
  operationId: string;
  provenance: EliseAttachmentProvenance[];
  /** Bound draft id in the StyleChat attachment store when linked. */
  draftId?: string | null;
  resolved?: StyleChatAttachment | null;
  summary?: StyleChatAttachmentSummary | null;
};

export { STYLECHAT_ATTACHMENT_CONTRACT_VERSION };
