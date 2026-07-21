// stylechat-generate v2 — attachment parsing and limits (pure module).
//
// Mirrors the mobile StyleChatAttachment v2 contract. No Deno APIs, no
// network: unit-tested from the Node harness. Client-supplied titles,
// categories, images, roles, and reasons are parsed ONLY as bounded display
// hints and are never authoritative — resolution happens against the
// database in attachmentContext.ts.

export const STYLECHAT_ATTACHMENT_CONTRACT_VERSION = '2';

export const MAX_OWNED_ITEM_ATTACHMENTS = 3;
export const MAX_LOOK_ATTACHMENTS = 1;
export const MAX_OUTFIT_DRAFT_ATTACHMENTS = 1;
export const MAX_TOTAL_RESOLVED_ITEMS = 6;
export const MAX_DRAFT_ITEM_REFS = 6;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OwnedSourceType = 'saved_scan' | 'inspiration_item' | 'dressing_room_item';

export type ParsedOwnedItemAttachment = {
  attachmentType: 'owned_item';
  sourceType: OwnedSourceType;
  sourceId: string;
};

export type ParsedLookAttachment = {
  attachmentType: 'look';
  lookId: string;
};

export type ParsedOutfitDraftAttachment = {
  attachmentType: 'outfit_draft';
  itemRefs: Array<{ sourceType: OwnedSourceType; sourceId: string }>;
};

export type ParsedAttachment =
  | ParsedOwnedItemAttachment
  | ParsedLookAttachment
  | ParsedOutfitDraftAttachment;

export type AttachmentParseResult =
  | { ok: true; attachments: ParsedAttachment[] }
  | { ok: false; errorCode: 'ATTACHMENT_INVALID' | 'ATTACHMENT_LIMIT_EXCEEDED' };

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function isOwnedSourceType(value: unknown): value is OwnedSourceType {
  return value === 'saved_scan' || value === 'inspiration_item' || value === 'dressing_room_item';
}

/**
 * Parses the v2 attachments array. Only stable references survive parsing;
 * every display field is dropped here. Ambiguous combinations and limit
 * violations are rejected, never silently trimmed.
 */
export function parseStyleChatAttachments(raw: unknown): AttachmentParseResult {
  if (raw == null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
  if (raw.length === 0) return { ok: true, attachments: [] };
  if (raw.length > MAX_OWNED_ITEM_ATTACHMENTS + MAX_LOOK_ATTACHMENTS + MAX_OUTFIT_DRAFT_ATTACHMENTS) {
    return { ok: false, errorCode: 'ATTACHMENT_LIMIT_EXCEEDED' };
  }

  const attachments: ParsedAttachment[] = [];
  let ownedItems = 0;
  let looks = 0;
  let drafts = 0;
  const seenOwnedKeys = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
    const record = entry as Record<string, unknown>;

    if (record.attachmentType === 'owned_item') {
      if (!isOwnedSourceType(record.sourceType) || !isUuid(record.sourceId)) {
        return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
      }
      const key = `${record.sourceType}:${normalizeId(record.sourceId as string)}`;
      if (seenOwnedKeys.has(key)) return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
      seenOwnedKeys.add(key);
      ownedItems += 1;
      attachments.push({
        attachmentType: 'owned_item',
        sourceType: record.sourceType,
        sourceId: normalizeId(record.sourceId as string),
      });
    } else if (record.attachmentType === 'look') {
      if (!isUuid(record.lookId)) return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
      looks += 1;
      attachments.push({ attachmentType: 'look', lookId: normalizeId(record.lookId as string) });
    } else if (record.attachmentType === 'outfit_draft') {
      if (!Array.isArray(record.itemRefs)) return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
      if (record.itemRefs.length < 2 || record.itemRefs.length > MAX_DRAFT_ITEM_REFS) {
        return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
      }
      const refs: Array<{ sourceType: OwnedSourceType; sourceId: string }> = [];
      const seen = new Set<string>();
      for (const rawRef of record.itemRefs) {
        if (!rawRef || typeof rawRef !== 'object') return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
        const ref = rawRef as Record<string, unknown>;
        if (!isOwnedSourceType(ref.sourceType) || !isUuid(ref.sourceId)) {
          return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
        }
        const key = `${ref.sourceType}:${normalizeId(ref.sourceId as string)}`;
        if (seen.has(key)) return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
        seen.add(key);
        refs.push({ sourceType: ref.sourceType, sourceId: normalizeId(ref.sourceId as string) });
      }
      drafts += 1;
      attachments.push({ attachmentType: 'outfit_draft', itemRefs: refs });
    } else {
      return { ok: false, errorCode: 'ATTACHMENT_INVALID' };
    }
  }

  if (ownedItems > MAX_OWNED_ITEM_ATTACHMENTS) return { ok: false, errorCode: 'ATTACHMENT_LIMIT_EXCEEDED' };
  if (looks > MAX_LOOK_ATTACHMENTS) return { ok: false, errorCode: 'ATTACHMENT_LIMIT_EXCEEDED' };
  if (drafts > MAX_OUTFIT_DRAFT_ATTACHMENTS) return { ok: false, errorCode: 'ATTACHMENT_LIMIT_EXCEEDED' };
  if (looks > 0 && drafts > 0) return { ok: false, errorCode: 'ATTACHMENT_LIMIT_EXCEEDED' };
  if ((looks > 0 || drafts > 0) && ownedItems > 1) {
    return { ok: false, errorCode: 'ATTACHMENT_LIMIT_EXCEEDED' };
  }

  return { ok: true, attachments };
}

/** True when the request must take the v2 path. */
export function isV2StyleChatRequest(body: Record<string, unknown>): boolean {
  if (body.contractVersion === STYLECHAT_ATTACHMENT_CONTRACT_VERSION) return true;
  return Array.isArray(body.attachments) && body.attachments.length > 0;
}
