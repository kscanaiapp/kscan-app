// StyleChat attachment contract v2 (Phase 2 — Closet Intelligence).
//
// One canonical name is used throughout: StyleChatAttachment.
//
// Three attachment types:
//   owned_item   — a verified Closet record (saved_scan | inspiration_item)
//   look         — a persisted Look owned by the caller
//   outfit_draft — an UNSAVED validated AI Stylist result; ephemeral, no
//                  database row and no new table; revalidated server-side
//
// The client may keep bounded display summaries for rendering, but the server
// ignores every client-supplied title/category/image/role/reason for ownership
// and reasoning: only stable references cross the wire as authority.

import type { GarmentRole, OutfitVariation } from './fashionReasoning';
import type { OwnedItemSourceType } from './ownedClosetItem';

export const STYLECHAT_ATTACHMENT_CONTRACT_VERSION = '2';

// ── Limits (Part 2) ───────────────────────────────────────────────────────────

export const MAX_OWNED_ITEM_ATTACHMENTS = 3;
export const MAX_LOOK_ATTACHMENTS = 1;
export const MAX_OUTFIT_DRAFT_ATTACHMENTS = 1;
export const MAX_TOTAL_RESOLVED_ITEMS = 6;
export const MAX_MULTIMODAL_IMAGES = 2;
export const MAX_UPLOAD_FLOWS_IN_FLIGHT = 1;

// ── Wire contracts (server-usable references only) ────────────────────────────

export type StyleChatOwnedItemAttachment = {
  attachmentType: 'owned_item';
  sourceType: OwnedItemSourceType;
  sourceId: string;
  contractVersion: typeof STYLECHAT_ATTACHMENT_CONTRACT_VERSION;
};

export type StyleChatLookAttachment = {
  attachmentType: 'look';
  lookId: string;
  contractVersion: typeof STYLECHAT_ATTACHMENT_CONTRACT_VERSION;
};

export type StyleChatOutfitDraftItemRef = {
  sourceType: OwnedItemSourceType;
  sourceId: string;
  role: GarmentRole;
  position: number;
};

export type StyleChatOutfitDraftAttachment = {
  attachmentType: 'outfit_draft';
  itemRefs: StyleChatOutfitDraftItemRef[];
  variation?: OutfitVariation | null;
  /** Bounded display reason; NOT authoritative server-side. */
  reason?: string | null;
  contractVersion: typeof STYLECHAT_ATTACHMENT_CONTRACT_VERSION;
};

export type StyleChatAttachment =
  | StyleChatOwnedItemAttachment
  | StyleChatLookAttachment
  | StyleChatOutfitDraftAttachment;

/** Bounded, client-local display summary. Never authoritative. */
export type StyleChatAttachmentSummary = {
  title: string;
  subtitle?: string | null;
  imageUri?: string | null;
  itemCount?: number;
};

// ── Selection / resolution state machine (Part 3) ─────────────────────────────

export const ATTACHMENT_STATES = [
  'selected',
  'sanitizing',
  'identifying',
  'awaiting_review',
  'creating_record',
  'uploading_media',
  'finalizing',
  'ready',
  'failed_retryable',
  'rejected',
  'cancelled',
  'unavailable',
] as const;
export type AttachmentState = (typeof ATTACHMENT_STATES)[number];

export const PENDING_ATTACHMENT_STATES: readonly AttachmentState[] = [
  'selected',
  'sanitizing',
  'identifying',
  'awaiting_review',
  'creating_record',
  'uploading_media',
  'finalizing',
];

export function isPendingAttachmentState(state: AttachmentState): boolean {
  return (PENDING_ATTACHMENT_STATES as readonly string[]).includes(state);
}

/**
 * One draft attachment entry. The selection layer (local ids, local URIs,
 * job/retry state) NEVER becomes an Edge Function payload; only `resolved`
 * does, and only when state === 'ready'.
 */
export type DraftAttachment = {
  /** Stable local draft/job id (client-only; never sent to the server). */
  draftId: string;
  state: AttachmentState;
  /** Local selection layer (client-only). */
  selection: {
    localScanId?: string | null;
    localImageUri?: string | null;
    sanitizedImageUri?: string | null;
    retryCount: number;
    lastErrorCode?: string | null;
    updatedAt: string;
  };
  /** Server-usable contract; present only once resolution succeeds. */
  resolved?: StyleChatAttachment | null;
  /** Bounded display summary for chips/bubbles. */
  summary: StyleChatAttachmentSummary;
};

// ── Validation (pure; shared by client and tests) ─────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

export type AttachmentValidationResult =
  | { ok: true; resolvedItemCount: number }
  | { ok: false; errorCode: 'ATTACHMENT_LIMIT_EXCEEDED' | 'ATTACHMENT_INVALID' | 'ATTACHMENT_AMBIGUOUS'; message: string };

/**
 * Validates a proposed attachment combination against the Part 2 limits.
 * Counts resolved items (a Look/draft counts as its item count). Ambiguous
 * combinations (Look + draft, multiple Looks, etc.) are rejected explicitly —
 * never silently trimmed.
 */
export function validateAttachmentCombination(
  attachments: Array<{ attachment: StyleChatAttachment; itemCount: number }>,
): AttachmentValidationResult {
  let ownedItems = 0;
  let looks = 0;
  let drafts = 0;
  let resolvedItemCount = 0;
  const seenKeys = new Set<string>();

  for (const { attachment, itemCount } of attachments) {
    if (attachment.attachmentType === 'owned_item') {
      if (!isUuid(attachment.sourceId)) {
        return { ok: false, errorCode: 'ATTACHMENT_INVALID', message: 'This item cannot be attached yet.' };
      }
      const key = `${attachment.sourceType}:${attachment.sourceId.toLowerCase()}`;
      if (seenKeys.has(key)) {
        return { ok: false, errorCode: 'ATTACHMENT_INVALID', message: 'That item is already attached.' };
      }
      seenKeys.add(key);
      ownedItems += 1;
      resolvedItemCount += 1;
    } else if (attachment.attachmentType === 'look') {
      if (!isUuid(attachment.lookId)) {
        return { ok: false, errorCode: 'ATTACHMENT_INVALID', message: 'This Look cannot be attached yet.' };
      }
      looks += 1;
      resolvedItemCount += Math.max(1, itemCount);
    } else if (attachment.attachmentType === 'outfit_draft') {
      if (!Array.isArray(attachment.itemRefs) || attachment.itemRefs.length < 2) {
        return { ok: false, errorCode: 'ATTACHMENT_INVALID', message: 'This outfit cannot be attached yet.' };
      }
      const refKeys = new Set<string>();
      for (const ref of attachment.itemRefs) {
        if (!isUuid(ref.sourceId)) {
          return { ok: false, errorCode: 'ATTACHMENT_INVALID', message: 'This outfit cannot be attached yet.' };
        }
        const key = `${ref.sourceType}:${ref.sourceId.toLowerCase()}`;
        if (refKeys.has(key)) {
          return { ok: false, errorCode: 'ATTACHMENT_INVALID', message: 'This outfit cannot be attached yet.' };
        }
        refKeys.add(key);
      }
      drafts += 1;
      resolvedItemCount += attachment.itemRefs.length;
    } else {
      return { ok: false, errorCode: 'ATTACHMENT_INVALID', message: 'Unsupported attachment.' };
    }
  }

  if (ownedItems > MAX_OWNED_ITEM_ATTACHMENTS) {
    return {
      ok: false,
      errorCode: 'ATTACHMENT_LIMIT_EXCEEDED',
      message: `You can attach up to ${MAX_OWNED_ITEM_ATTACHMENTS} closet items.`,
    };
  }
  if (looks > MAX_LOOK_ATTACHMENTS || drafts > MAX_OUTFIT_DRAFT_ATTACHMENTS) {
    return {
      ok: false,
      errorCode: 'ATTACHMENT_LIMIT_EXCEEDED',
      message: 'You can attach one Look or one outfit per message.',
    };
  }
  // One Look OR one draft per message — never both.
  if (looks > 0 && drafts > 0) {
    return {
      ok: false,
      errorCode: 'ATTACHMENT_AMBIGUOUS',
      message: 'Attach either a Look or an outfit, not both.',
    };
  }
  // Look + owned anchor is allowed only as ONE item alongside the Look.
  if ((looks > 0 || drafts > 0) && ownedItems > 1) {
    return {
      ok: false,
      errorCode: 'ATTACHMENT_AMBIGUOUS',
      message: 'Attach one closet item alongside a Look or outfit at most.',
    };
  }
  if (resolvedItemCount > MAX_TOTAL_RESOLVED_ITEMS) {
    return {
      ok: false,
      errorCode: 'ATTACHMENT_LIMIT_EXCEEDED',
      message: `Attachments can cover up to ${MAX_TOTAL_RESOLVED_ITEMS} items in total.`,
    };
  }

  return { ok: true, resolvedItemCount };
}

/** Bounded ui_blocks representation persisted with chat messages (Part 30). */
export function buildAttachmentUiBlock(drafts: DraftAttachment[]): {
  type: 'stylechat_attachments';
  contractVersion: typeof STYLECHAT_ATTACHMENT_CONTRACT_VERSION;
  items: Array<{
    attachmentType: StyleChatAttachment['attachmentType'];
    reference: StyleChatAttachment;
    title: string;
    subtitle: string | null;
    itemCount: number | null;
  }>;
} {
  return {
    type: 'stylechat_attachments',
    contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
    items: drafts
      .filter((draft) => draft.state === 'ready' && draft.resolved)
      .map((draft) => ({
        attachmentType: (draft.resolved as StyleChatAttachment).attachmentType,
        reference: draft.resolved as StyleChatAttachment,
        title: draft.summary.title.slice(0, 80),
        subtitle: draft.summary.subtitle ? draft.summary.subtitle.slice(0, 80) : null,
        itemCount: draft.summary.itemCount ?? null,
      })),
  };
}
