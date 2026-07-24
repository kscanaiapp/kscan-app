// Runtime normalization boundary for Elise visual attachments.
// Server/repository objects may use snake_case; client state uses camelCase.
// Only map source-supported fields. Never spread unknown properties.

import type {
  EliseAttachmentProvenance,
  EliseAttachmentSourceKind,
  EliseComposerAttachment,
} from '../../types/eliseVisualAttachments';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function asUuid(value: unknown): string | null {
  const text = asNonEmptyString(value, 64);
  if (!text) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    return null;
  }
  return text.toLowerCase();
}

export type NormalizedAttachmentResource = {
  sourceType: string;
  sourceId: string;
  roomId?: string | null;
  itemId?: string | null;
  savedScanId?: string | null;
  storagePath?: string | null;
  actorRelationship?: string | null;
  title?: string | null;
  imageUri?: string | null;
  sourceKind: EliseAttachmentSourceKind;
  provenance: EliseAttachmentProvenance[];
};

/**
 * Normalize a repository/RPC row into a typed client attachment resource.
 * Returns null on malformed required fields. Does not log the rejected raw object.
 */
export function normalizeAttachmentResource(raw: unknown): NormalizedAttachmentResource | null {
  if (!isRecord(raw)) return null;

  const sourceType =
    asNonEmptyString(raw.sourceType) ??
    asNonEmptyString(raw.source_type);
  const sourceId =
    asUuid(raw.sourceId) ??
    asUuid(raw.source_id) ??
    asUuid(raw.itemId) ??
    asUuid(raw.item_id) ??
    asUuid(raw.savedScanId) ??
    asUuid(raw.saved_scan_id) ??
    asUuid(raw.id);

  if (!sourceType || !sourceId) return null;

  const roomId = asUuid(raw.roomId) ?? asUuid(raw.room_id);
  const itemId = asUuid(raw.itemId) ?? asUuid(raw.item_id);
  const savedScanId = asUuid(raw.savedScanId) ?? asUuid(raw.saved_scan_id);
  const storagePath = asNonEmptyString(raw.storagePath ?? raw.storage_path, 512);
  const actorRelationship = asNonEmptyString(
    raw.actorRelationship ?? raw.actor_relationship,
    64,
  );
  const title = asNonEmptyString(raw.title ?? raw.display_label ?? raw.name, 120);
  const imageUri = asNonEmptyString(
    raw.imageUri ?? raw.image_uri ?? raw.thumbnailUri ?? raw.thumbnail_uri,
    2048,
  );

  let sourceKind: EliseAttachmentSourceKind;
  let provenance: EliseAttachmentProvenance[];

  switch (sourceType) {
    case 'saved_scan':
      sourceKind = 'saved_scan';
      provenance = ['saved_scan'];
      break;
    case 'inspiration_item':
      sourceKind = 'saved_inspiration';
      provenance = ['saved_inspiration'];
      break;
    case 'dressing_room_item':
      sourceKind = 'dressing_room_item';
      provenance = ['owned_room'];
      break;
    case 'shared_room_item':
      sourceKind = 'shared_room_item';
      provenance = ['shared_room'];
      break;
    case 'recent_scan':
      sourceKind = 'recent_scan';
      provenance = ['recent_scan'];
      break;
    default:
      return null;
  }

  if (actorRelationship === 'shared' || actorRelationship === 'shared_with_me') {
    if (sourceKind === 'dressing_room_item') {
      sourceKind = 'shared_room_item';
      provenance = ['shared_room'];
    }
  }

  return {
    sourceType,
    sourceId,
    roomId: roomId ?? null,
    itemId: itemId ?? null,
    savedScanId: savedScanId ?? null,
    storagePath: storagePath ?? null,
    actorRelationship: actorRelationship ?? null,
    title: title ?? null,
    imageUri: imageUri ?? null,
    sourceKind,
    provenance,
  };
}

/**
 * Strip any accidental snake_case leakage before UI/prompt models consume state.
 */
export function toClientAttachmentView(
  attachment: EliseComposerAttachment,
): EliseComposerAttachment {
  return {
    localKey: attachment.localKey,
    sourceKind: attachment.sourceKind,
    previewUri: attachment.previewUri ?? null,
    displayLabel: attachment.displayLabel,
    preparationStatus: attachment.preparationStatus,
    resolutionStatus: attachment.resolutionStatus,
    canonicalSourceType: attachment.canonicalSourceType ?? null,
    canonicalSourceId: attachment.canonicalSourceId ?? null,
    focused: Boolean(attachment.focused),
    recoverableError: attachment.recoverableError ?? null,
    actorKey: attachment.actorKey ?? null,
    sessionId: attachment.sessionId ?? null,
    operationId: attachment.operationId,
    provenance: [...(attachment.provenance ?? [])],
    draftId: attachment.draftId ?? null,
    resolved: attachment.resolved ?? null,
    summary: attachment.summary
      ? {
          title: attachment.summary.title,
          subtitle: attachment.summary.subtitle ?? null,
          imageUri: attachment.summary.imageUri ?? null,
          itemCount: attachment.summary.itemCount,
        }
      : null,
  };
}
