// stylechat-generate v2 — attachment resolution and bounded context building.
//
// Resolution is dependency-injected so this module stays pure and
// Node-testable; index.ts supplies the userClient-backed queries (which are
// additionally RLS-scoped). Every attachment reference is independently
// verified for ownership, existence, and active status. Client display
// metadata never reaches this module.
//
// The context builder produces a deterministic, bounded model block that
// NEVER contains: user ids, storage buckets/paths, signed URLs, raw
// analysis_result blobs, product arrays, or Style Memory history.

import type { OwnedSourceType, ParsedAttachment } from './attachments.ts';
import { MAX_TOTAL_RESOLVED_ITEMS } from './attachments.ts';

export const MAX_ATTACHMENT_CONTEXT_CHARS = 4000;
export const MAX_CONTEXT_HINT_CHARS = 200;
const MAX_FIELD_CHARS = 60;
const STYLE_LIBRARY_IMAGES_BUCKET = 'style-library-images';

// ── Resolved shapes ───────────────────────────────────────────────────────────

export type ResolvedAttachmentItem = {
  /** Opaque action reference: the stable id actions may point at. */
  ref: { sourceType: OwnedSourceType; sourceId: string };
  title: string;
  category: string | null;
  role: string;
  color: string | null;
  pattern: string | null;
  material: string | null;
  silhouette: string | null;
  fit: string | null;
  brand: string | null;
  styleTags: string[];
  /** Private media availability for multimodal selection (never sent to model as text). */
  media: { bucket: string; path: string } | null;
};

export type ResolvedAttachment =
  | { attachmentType: 'owned_item'; items: [ResolvedAttachmentItem] }
  | {
      attachmentType: 'look';
      lookId: string;
      title: string;
      occasion: string | null;
      dressCode: string | null;
      setting: string | null;
      items: ResolvedAttachmentItem[];
    }
  | { attachmentType: 'outfit_draft'; variation: string | null; items: ResolvedAttachmentItem[] };

export type AttachmentResolutionResult =
  | { ok: true; resolved: ResolvedAttachment[]; totalItems: number }
  | {
      ok: false;
      errorCode:
        | 'ATTACHMENT_NOT_OWNED'
        | 'ATTACHMENT_UNAVAILABLE'
        | 'LOOK_NOT_AVAILABLE'
        | 'ATTACHMENT_LIMIT_EXCEEDED';
    };

export type AttachmentDegradationOutcome =
  | 'accepted'
  | 'rejected_unauthorized'
  | 'not_found'
  | 'expired_reference'
  | 'invalid_shape'
  | 'image_unavailable'
  | 'inspection_failed';

export function attachmentOutcomeForResolution(
  result: AttachmentResolutionResult,
): AttachmentDegradationOutcome {
  if (result.ok) return 'accepted';
  if (result.errorCode === 'ATTACHMENT_NOT_OWNED') return 'rejected_unauthorized';
  if (result.errorCode === 'ATTACHMENT_LIMIT_EXCEEDED') return 'invalid_shape';
  return 'not_found';
}

// ── Injected data access (implemented in index.ts with the user client) ───────

export type AttachmentDataSource = {
  /** Rows for the ids, ALREADY scoped to the authenticated user and active. */
  fetchSavedScans(ids: string[]): Promise<Array<Record<string, unknown>>>;
  fetchInspirationItems(ids: string[]): Promise<Array<Record<string, unknown>>>;
  fetchLook(lookId: string): Promise<Record<string, unknown> | null>;
  fetchLookItems(lookId: string): Promise<Array<Record<string, unknown>>>;
};

// ── Field helpers ─────────────────────────────────────────────────────────────

function bound(value: unknown, maxChars = MAX_FIELD_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, maxChars);
}

function inferRole(category?: string | null, subcategory?: string | null): string {
  const text = `${category ?? ''} ${subcategory ?? ''}`.toLowerCase();
  if (!text.trim()) return 'other';
  if (/jumpsuit|romper|overall/.test(text)) return 'jumpsuit';
  if (/dress|gown/.test(text)) return 'dress';
  if (/jacket|coat|blazer|cardigan|parka|trench|outerwear|vest/.test(text)) return 'outerwear';
  if (/shoe|sneaker|boot|heel|loafer|sandal|flat|footwear|trainer|oxford|mule|pump/.test(text)) return 'shoes';
  if (/bag|tote|purse|backpack|clutch|handbag|crossbody/.test(text)) return 'bag';
  if (/hat|scarf|belt|jewelr|necklace|earring|bracelet|watch|sunglass|glove|accessor|tie\b|beanie|cap\b/.test(text)) return 'accessory';
  if (/pant|jean|trouser|skirt|short|legging|chino|bottom|culotte|slack/.test(text)) return 'bottom';
  if (/top|shirt|blouse|tee|t-shirt|sweater|hoodie|tank|polo|knit|pullover|sweatshirt|camisole|bodysuit|turtleneck/.test(text)) return 'top';
  return 'other';
}

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return text ? text : null;
}

function mediaRefForSavedScan(row: Record<string, unknown>): { bucket: string; path: string } | null {
  const userId = cleanId(row.user_id);
  const sourceId = cleanId(row.id);
  const bucket = typeof row.storage_bucket === 'string' ? row.storage_bucket.trim() : '';
  const path = typeof row.storage_path === 'string' ? row.storage_path.trim() : '';
  if (!userId || !sourceId || row.media_status !== 'ready') return null;
  if (bucket !== STYLE_LIBRARY_IMAGES_BUCKET) return null;
  if (path !== `${userId}/saved-scans/${sourceId}.jpg`) return null;
  return { bucket, path };
}

function mediaRefForInspiration(row: Record<string, unknown>): { bucket: string; path: string } | null {
  const userId = cleanId(row.user_id);
  const bucket = typeof row.storage_bucket === 'string' ? row.storage_bucket.trim() : '';
  const path = typeof row.storage_path === 'string' ? row.storage_path.trim() : '';
  if (!userId || bucket !== STYLE_LIBRARY_IMAGES_BUCKET) return null;
  const prefix = `${userId}/inspirations/`;
  if (!path.startsWith(prefix)) return null;
  const filename = path.slice(prefix.length);
  if (!/^[A-Za-z0-9._-]+[.]jpg$/.test(filename)) return null;
  return { bucket, path };
}

function savedScanToItem(row: Record<string, unknown>): ResolvedAttachmentItem {
  const analysis =
    row.analysis_result && typeof row.analysis_result === 'object'
      ? (row.analysis_result as Record<string, unknown>)
      : {};
  const meta =
    analysis.metadata && typeof analysis.metadata === 'object'
      ? (analysis.metadata as Record<string, unknown>)
      : {};
  const category = bound(meta.category);
  const subcategory = bound(meta.subcategory) ?? bound(meta.itemType);
  const media = mediaRefForSavedScan(row);

  return {
    ref: { sourceType: 'saved_scan', sourceId: String(row.id).toLowerCase() },
    title: bound(row.title, 80) ?? category ?? 'Saved item',
    category,
    role: inferRole(category, subcategory),
    color: bound(meta.color) ?? bound(meta.color_palette),
    pattern: bound(meta.pattern),
    material: bound(meta.material_estimate) ?? bound(meta.material),
    silhouette: bound(meta.silhouette),
    fit: bound(meta.fit),
    brand: bound(meta.brand),
    styleTags: Array.isArray(meta.style_tags)
      ? (meta.style_tags as unknown[]).map((tag) => bound(tag, 24)).filter((tag): tag is string => !!tag).slice(0, 6)
      : [],
    media,
  };
}

function inspirationToItem(row: Record<string, unknown>): ResolvedAttachmentItem {
  const category = bound(row.category);
  const explicitRole = bound(row.garment_role, 20);
  const media = mediaRefForInspiration(row);
  return {
    ref: { sourceType: 'inspiration_item', sourceId: String(row.id).toLowerCase() },
    title: bound(row.note, 80) ?? category ?? 'Inspiration item',
    category,
    role: explicitRole ?? inferRole(category),
    color: bound(row.color),
    pattern: bound(row.pattern),
    material: bound(row.material),
    silhouette: bound(row.silhouette),
    fit: null,
    brand: null,
    styleTags: [],
    media,
  };
}

function lookItemToItem(row: Record<string, unknown>): ResolvedAttachmentItem | null {
  const snapshot =
    row.snapshot_payload && typeof row.snapshot_payload === 'object'
      ? (row.snapshot_payload as Record<string, unknown>)
      : {};
  const sourceType: OwnedSourceType | null =
    row.source_saved_scan_id ? 'saved_scan' : row.source_inspiration_item_id ? 'inspiration_item' : null;
  const sourceId = row.source_saved_scan_id ?? row.source_inspiration_item_id;
  const category = bound(snapshot.category) ?? bound(row.category);
  const hasMedia = typeof row.storage_bucket === 'string' && !!row.storage_bucket
    && typeof row.storage_path === 'string' && !!row.storage_path;
  return {
    // Legacy dressing-room-derived items have no owned-item ref; use an
    // opaque look-item marker that can never be used as an action anchor.
    ref: sourceType && sourceId
      ? { sourceType, sourceId: String(sourceId).toLowerCase() }
      : { sourceType: 'saved_scan', sourceId: '' },
    title: bound(snapshot.title, 80) ?? bound(row.title, 80) ?? 'Item',
    category,
    role: bound(row.item_role, 20) ?? inferRole(category, bound(snapshot.subcategory)),
    color: bound(snapshot.color),
    pattern: bound(snapshot.pattern),
    material: bound(snapshot.material),
    silhouette: bound(snapshot.silhouette),
    fit: null,
    brand: bound(snapshot.brand) ?? bound(row.brand),
    styleTags: [],
    media: hasMedia ? { bucket: String(row.storage_bucket), path: String(row.storage_path) } : null,
  };
}

// ── Resolution ────────────────────────────────────────────────────────────────

export async function resolveStyleChatAttachments(
  attachments: ParsedAttachment[],
  data: AttachmentDataSource,
): Promise<AttachmentResolutionResult> {
  const resolved: ResolvedAttachment[] = [];
  let totalItems = 0;

  // Batch owned-item lookups.
  const scanIds = new Set<string>();
  const inspirationIds = new Set<string>();
  for (const attachment of attachments) {
    if (attachment.attachmentType === 'owned_item') {
      (attachment.sourceType === 'saved_scan' ? scanIds : inspirationIds).add(attachment.sourceId);
    } else if (attachment.attachmentType === 'outfit_draft') {
      for (const ref of attachment.itemRefs) {
        (ref.sourceType === 'saved_scan' ? scanIds : inspirationIds).add(ref.sourceId);
      }
    }
  }

  const [scanRows, inspirationRows] = await Promise.all([
    scanIds.size ? data.fetchSavedScans([...scanIds]) : Promise.resolve([]),
    inspirationIds.size ? data.fetchInspirationItems([...inspirationIds]) : Promise.resolve([]),
  ]);

  const itemByKey = new Map<string, ResolvedAttachmentItem>();
  for (const row of scanRows) {
    if (row?.id) itemByKey.set(`saved_scan:${String(row.id).toLowerCase()}`, savedScanToItem(row));
  }
  for (const row of inspirationRows) {
    if (row?.id) itemByKey.set(`inspiration_item:${String(row.id).toLowerCase()}`, inspirationToItem(row));
  }

  for (const attachment of attachments) {
    if (attachment.attachmentType === 'owned_item') {
      const item = itemByKey.get(`${attachment.sourceType}:${attachment.sourceId}`);
      // A miss means foreign, deleted, or nonexistent — one safe error for all
      // three so record existence never leaks.
      if (!item) return { ok: false, errorCode: 'ATTACHMENT_NOT_OWNED' };
      resolved.push({ attachmentType: 'owned_item', items: [item] });
      totalItems += 1;
    } else if (attachment.attachmentType === 'look') {
      const lookRow = await data.fetchLook(attachment.lookId);
      if (!lookRow) return { ok: false, errorCode: 'LOOK_NOT_AVAILABLE' };
      const itemRows = await data.fetchLookItems(attachment.lookId);
      if (itemRows.length === 0) return { ok: false, errorCode: 'LOOK_NOT_AVAILABLE' };
      const items = itemRows
        .map(lookItemToItem)
        .filter((item): item is ResolvedAttachmentItem => item !== null)
        .slice(0, MAX_TOTAL_RESOLVED_ITEMS);
      resolved.push({
        attachmentType: 'look',
        lookId: attachment.lookId,
        title: bound(lookRow.title, 80) ?? 'Look',
        occasion: bound(lookRow.occasion, 20),
        dressCode: bound(lookRow.dress_code, 20),
        setting: bound(lookRow.setting, 20),
        items,
      });
      totalItems += items.length;
    } else {
      // Outfit draft: every reference must independently resolve; one invalid
      // item rejects the entire draft atomically.
      const items: ResolvedAttachmentItem[] = [];
      for (const ref of attachment.itemRefs) {
        const item = itemByKey.get(`${ref.sourceType}:${ref.sourceId}`);
        if (!item) return { ok: false, errorCode: 'ATTACHMENT_NOT_OWNED' };
        items.push(item);
      }
      resolved.push({ attachmentType: 'outfit_draft', variation: null, items });
      totalItems += items.length;
    }
  }

  if (totalItems > MAX_TOTAL_RESOLVED_ITEMS) {
    return { ok: false, errorCode: 'ATTACHMENT_LIMIT_EXCEEDED' };
  }

  return { ok: true, resolved, totalItems };
}

// ── Context building ──────────────────────────────────────────────────────────

function describeItem(item: ResolvedAttachmentItem, index: number): string {
  const parts = [
    `  ${index}. [ref:${item.ref.sourceType}:${item.ref.sourceId || 'snapshot'}]`,
    item.title,
    item.category ? `category=${item.category}` : null,
    `role=${item.role}`,
    item.color ? `color=${item.color}` : null,
    item.pattern ? `pattern=${item.pattern}` : null,
    item.material ? `material=${item.material}` : null,
    item.silhouette ? `silhouette=${item.silhouette}` : null,
    item.fit ? `fit=${item.fit}` : null,
    item.brand ? `brand=${item.brand}` : null,
    item.styleTags.length ? `tags=${item.styleTags.join(',')}` : null,
  ];
  return parts.filter(Boolean).join(' ');
}

/**
 * Deterministic, bounded attachment context block. Truncation drops whole
 * item lines from the end — it never splits an item line or breaks structure.
 */
export function buildAttachmentContextBlock(resolved: ResolvedAttachment[]): string {
  const lines: string[] = ['[Attached from the user\'s closet — verified items only]'];
  let itemIndex = 0;

  for (const attachment of resolved) {
    if (attachment.attachmentType === 'owned_item') {
      itemIndex += 1;
      lines.push(describeItem(attachment.items[0], itemIndex));
    } else if (attachment.attachmentType === 'look') {
      const context = [
        attachment.occasion ? `occasion=${attachment.occasion}` : null,
        attachment.dressCode ? `dress_code=${attachment.dressCode}` : null,
        attachment.setting ? `setting=${attachment.setting}` : null,
      ].filter(Boolean).join(' ');
      lines.push(`ATTACHED LOOK "${attachment.title}" (${attachment.items.length} items)${context ? ' ' + context : ''}:`);
      for (const item of attachment.items) {
        itemIndex += 1;
        lines.push(describeItem(item, itemIndex));
      }
    } else {
      lines.push(`ATTACHED UNSAVED OUTFIT (${attachment.items.length} items):`);
      for (const item of attachment.items) {
        itemIndex += 1;
        lines.push(describeItem(item, itemIndex));
      }
    }
  }

  lines.push('[/Attached]');

  // Deterministic truncation on whole lines.
  const kept: string[] = [];
  let total = 0;
  const closing = '[/Attached]';
  for (const line of lines) {
    if (line === closing) continue;
    if (total + line.length + 1 > MAX_ATTACHMENT_CONTEXT_CHARS - closing.length - 1) break;
    kept.push(line);
    total += line.length + 1;
  }
  kept.push(closing);
  return kept.join('\n');
}

/** Plain-text, normalized, deterministic 200-char context hint. */
export function normalizeContextHint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_`#\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.slice(0, MAX_CONTEXT_HINT_CHARS);
}
