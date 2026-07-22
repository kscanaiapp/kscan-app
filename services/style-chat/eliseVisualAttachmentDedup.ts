// Attachment deduplication for the Elise composer.
// Merge by strongest stable identity before constructing the V2 request.

import type { EliseComposerAttachment } from '../../types/eliseVisualAttachments';
import type { StyleChatAttachment } from '../../types/styleChatAttachments';

function identityKey(attachment: EliseComposerAttachment): string | null {
  if (attachment.canonicalSourceType && attachment.canonicalSourceId) {
    return `${attachment.canonicalSourceType}:${attachment.canonicalSourceId.toLowerCase()}`;
  }
  if (attachment.resolved) {
    return resolvedIdentity(attachment.resolved);
  }
  if (attachment.sourceKind === 'local_image' && attachment.previewUri) {
    return `local_image:${attachment.previewUri}`;
  }
  return null;
}

function resolvedIdentity(resolved: StyleChatAttachment): string | null {
  if (resolved.attachmentType === 'owned_item' || resolved.attachmentType === 'shared_item') {
    return `${resolved.sourceType}:${resolved.sourceId.toLowerCase()}`;
  }
  if (resolved.attachmentType === 'look') {
    return `look:${resolved.lookId.toLowerCase()}`;
  }
  if (resolved.attachmentType === 'outfit_draft') {
    return `outfit_draft:${resolved.itemRefs
      .map((ref) => `${ref.sourceType}:${ref.sourceId.toLowerCase()}`)
      .sort()
      .join('|')}`;
  }
  return null;
}

/** Provenance precedence: owned > saved > shared > transient local. */
function provenanceRank(attachment: EliseComposerAttachment): number {
  const set = new Set(attachment.provenance);
  if (set.has('closet') || set.has('owned_room')) return 100;
  if (set.has('saved_scan') || set.has('saved_inspiration') || set.has('saved_product')) return 80;
  if (set.has('recent_scan')) return 60;
  if (set.has('shared_room')) return 40;
  if (set.has('camera') || set.has('photo_library')) return 20;
  return 0;
}

function mergeProvenance(
  a: EliseComposerAttachment['provenance'],
  b: EliseComposerAttachment['provenance'],
): EliseComposerAttachment['provenance'] {
  return Array.from(new Set([...a, ...b]));
}

export type DedupResult = {
  attachments: EliseComposerAttachment[];
  deduplicatedCount: number;
  focusedLocalKey: string | null;
};

/**
 * Deduplicate attachments by stable identity. Preserves focus. Prefers owned
 * over saved/shared. Does not convert shared into owned.
 */
export function dedupeEliseAttachments(
  attachments: EliseComposerAttachment[],
  focusedLocalKey?: string | null,
): DedupResult {
  const focused = focusedLocalKey ?? attachments.find((entry) => entry.focused)?.localKey ?? null;
  const byKey = new Map<string, EliseComposerAttachment>();
  const order: string[] = [];
  let deduplicatedCount = 0;

  for (const attachment of attachments) {
    const key = identityKey(attachment) ?? `unique:${attachment.localKey}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...attachment, focused: false });
      order.push(key);
      continue;
    }

    deduplicatedCount += 1;
    const preferIncoming = provenanceRank(attachment) > provenanceRank(existing);
    const winner = preferIncoming ? attachment : existing;
    const loser = preferIncoming ? existing : attachment;
    // Never escalate shared → owned without server-backed ownership.
    const keepShared =
      winner.sourceKind === 'shared_room_item' || loser.sourceKind === 'shared_room_item'
        ? winner.sourceKind === 'shared_room_item' && provenanceRank(winner) >= provenanceRank(loser)
          ? winner
          : provenanceRank(existing) >= provenanceRank(attachment)
            ? existing
            : attachment
        : winner;

    byKey.set(key, {
      ...keepShared,
      provenance: mergeProvenance(existing.provenance, attachment.provenance),
      focused: false,
      previewUri: keepShared.previewUri || existing.previewUri || attachment.previewUri,
      displayLabel: keepShared.displayLabel || existing.displayLabel,
    });
  }

  const merged = order.map((key) => byKey.get(key)!).filter(Boolean);
  let nextFocus = focused && merged.some((entry) => entry.localKey === focused)
    ? focused
    : merged[0]?.localKey ?? null;

  // If the focused draft was merged away, recover via identity of the focused entry.
  if (focused && !merged.some((entry) => entry.localKey === focused)) {
    const focusedOriginal = attachments.find((entry) => entry.localKey === focused);
    const focusedIdentity = focusedOriginal ? identityKey(focusedOriginal) : null;
    if (focusedIdentity) {
      const match = merged.find((entry) => identityKey(entry) === focusedIdentity);
      if (match) nextFocus = match.localKey;
    }
  }

  return {
    attachments: merged.map((entry) => ({
      ...entry,
      focused: entry.localKey === nextFocus,
    })),
    deduplicatedCount,
    focusedLocalKey: nextFocus,
  };
}

/**
 * Order drafts so the focused attachment is first.
 * V2 has no attachment focus field; multimodal inspection preserves order.
 */
export function orderAttachmentsForSend<T extends { draftId?: string | null; focused?: boolean }>(
  attachments: T[],
  focusedDraftId?: string | null,
): T[] {
  if (!attachments.length) return attachments;
  const focusId =
    focusedDraftId ??
    attachments.find((entry) => entry.focused)?.draftId ??
    null;
  if (!focusId) return [...attachments];
  const focused = attachments.filter((entry) => entry.draftId === focusId);
  const rest = attachments.filter((entry) => entry.draftId !== focusId);
  return [...focused, ...rest];
}
