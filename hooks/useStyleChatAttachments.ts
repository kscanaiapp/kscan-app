// StyleChat composer attachment state machine (Phase 2).
//
// Two layers (Part 3): the SELECTION layer (local ids, local URIs, retry
// metadata) lives inside DraftAttachment.selection and never leaves the
// device; the RESOLVED layer (stable contracts) is produced only by the
// resolution saga and is the only thing a send may snapshot.
//
// Send rule: while any attachment is pending, attachment-bearing sends are
// disabled; the user may retry, or remove the pending attachment and send
// text only. Nothing is ever silently dropped or silently sent.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  clearDraftAttachments,
  consumeAttachmentHandoff,
  getDraftAttachments,
  removeDraftAttachment,
  snapshotReadyAttachments,
  subscribeToAttachmentDrafts,
  upsertDraftAttachment,
} from '../services/style-chat/styleChatAttachmentStore';
import {
  STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
  isPendingAttachmentState,
  validateAttachmentCombination,
  type DraftAttachment,
  type StyleChatAttachment,
  type StyleChatAttachmentSummary,
  type StyleChatOutfitDraftItemRef,
} from '../types/styleChatAttachments';
import {
  ensureRemoteBackedOwnedItem,
} from '../services/ownedClosetItems';
import { ensureSavedScanMediaBacking } from '../services/savedScanMedia';
import { recordAiStylistEvent } from '../services/styleMemoryEvents';
import type { OwnedClosetItem } from '../types/ownedClosetItem';
import type { OutfitVariation } from '../types/fashionReasoning';
import type { SavedScanModel } from '../services/savedScansCloud';
import type { Look } from '../types/styleObjects';

export type AddAttachmentResult = { ok: boolean; message?: string };

function newDraftId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

function attachmentItemCount(attachment: StyleChatAttachment, summaryCount?: number): number {
  if (attachment.attachmentType === 'owned_item') return 1;
  if (attachment.attachmentType === 'outfit_draft') return attachment.itemRefs.length;
  return Math.max(1, summaryCount ?? 1);
}

/** Resolution guard: one saga per draftId at a time. */
const resolvingDraftIds = new Set<string>();

export function useStyleChatAttachments(sessionId: string) {
  const attachments = useSyncExternalStore(
    subscribeToAttachmentDrafts,
    () => getDraftAttachments(sessionId),
    () => getDraftAttachments(sessionId),
  );

  const hasPending = attachments.some((entry) => isPendingAttachmentState(entry.state));
  const hasFailed = attachments.some((entry) => entry.state === 'failed_retryable');
  const allReady = attachments.length > 0 && attachments.every((entry) => entry.state === 'ready');
  const canSendWithAttachments = attachments.length === 0 || allReady;

  const validateAddition = useCallback(
    (candidate: StyleChatAttachment, candidateItemCount: number): AddAttachmentResult => {
      const proposed = [
        ...getDraftAttachments(sessionId)
          .filter((entry) => entry.resolved || entry.state !== 'cancelled')
          .map((entry) => ({
            attachment:
              entry.resolved ??
              // Unresolved local selections count as one owned item for limits.
              ({
                attachmentType: 'owned_item',
                sourceType: 'saved_scan',
                sourceId: '00000000-0000-4000-8000-000000000000',
                contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
              } as StyleChatAttachment),
            itemCount: entry.summary.itemCount ?? 1,
          })),
        { attachment: candidate, itemCount: candidateItemCount },
      ];
      const validation = validateAttachmentCombination(proposed);
      if (!validation.ok) return { ok: false, message: validation.message };
      return { ok: true };
    },
    [sessionId],
  );

  // ── Owned-item resolution saga ─────────────────────────────────────────────

  const resolveOwnedItemDraft = useCallback(
    async (draft: DraftAttachment, item: OwnedClosetItem, localScan?: SavedScanModel | null) => {
      if (resolvingDraftIds.has(draft.draftId)) return;
      resolvingDraftIds.add(draft.draftId);
      try {
        let current = item;

        // Step 1: stable remote row (existing cloud-sync path; never invents ids).
        if (!current.remoteBacked || !current.sourceId) {
          upsertDraftAttachment(sessionId, { ...draft, state: 'creating_record' });
          current = await ensureRemoteBackedOwnedItem(current, { localScan: localScan ?? undefined });
        }
        if (!current.sourceId) throw new Error('sync');

        // Step 2: private media backing for saved scans (idempotent saga).
        if (current.sourceType === 'saved_scan' && current.mediaStatus !== 'ready') {
          upsertDraftAttachment(sessionId, {
            ...draft,
            state: 'uploading_media',
            selection: { ...draft.selection, updatedAt: now() },
          });
          const media = await ensureSavedScanMediaBacking({
            savedScanId: current.sourceId,
            localImageUri: draft.selection.localImageUri ?? item.imageUri,
          });
          if (!media.ok && media.retryable) throw new Error('media');
          // Non-retryable media rejection: attach metadata-only is NOT allowed
          // to masquerade as image-aware; keep it attachable (metadata) only
          // when media was never required — here we mark rejected.
          if (!media.ok) {
            upsertDraftAttachment(sessionId, {
              ...draft,
              state: 'rejected',
              selection: { ...draft.selection, lastErrorCode: media.errorCode, updatedAt: now() },
            });
            return;
          }
        }

        // Step 3: resolved contract replaces the local selection.
        upsertDraftAttachment(sessionId, {
          ...draft,
          state: 'ready',
          resolved: {
            attachmentType: 'owned_item',
            sourceType: current.sourceType,
            sourceId: current.sourceId,
            contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
          },
          selection: { ...draft.selection, lastErrorCode: null, updatedAt: now() },
        });
        void recordAiStylistEvent({
          eventType: 'stylechat_item_attached',
          signalKey: `${current.sourceType}:${current.sourceId}`,
          payload: { category: current.category ?? null },
        });
      } catch {
        // Failure preserves the local selection for retry; never invents ids,
        // never silently removes, never sends local ids.
        upsertDraftAttachment(sessionId, {
          ...draft,
          state: 'failed_retryable',
          selection: {
            ...draft.selection,
            retryCount: draft.selection.retryCount + 1,
            lastErrorCode: 'MEDIA_UPLOAD_FAILED',
            updatedAt: now(),
          },
        });
      } finally {
        resolvingDraftIds.delete(draft.draftId);
      }
    },
    [sessionId],
  );

  // ── Public API ─────────────────────────────────────────────────────────────

  const addOwnedItem = useCallback(
    (item: OwnedClosetItem, localScan?: SavedScanModel | null): AddAttachmentResult => {
      const candidate: StyleChatAttachment = {
        attachmentType: 'owned_item',
        sourceType: item.sourceType,
        // Placeholder for validation when local-only; real id set at resolution.
        sourceId: item.sourceId ?? '00000000-0000-4000-8000-000000000001',
        contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
      };
      const validation = validateAddition(candidate, 1);
      if (!validation.ok) return validation;

      const draft: DraftAttachment = {
        draftId: newDraftId(),
        state: 'selected',
        selection: {
          localScanId: item.localId ?? null,
          localImageUri: item.imageUri ?? null,
          retryCount: 0,
          updatedAt: now(),
        },
        resolved: null,
        summary: {
          title: item.title,
          subtitle: item.category ?? null,
          imageUri: item.imageUri ?? null,
          itemCount: 1,
        },
      };
      upsertDraftAttachment(sessionId, draft);
      void resolveOwnedItemDraft(draft, item, localScan);
      return { ok: true };
    },
    [sessionId, validateAddition, resolveOwnedItemDraft],
  );

  const addLook = useCallback(
    (look: Pick<Look, 'id' | 'title' | 'occasion'> & { itemCount?: number; coverImageUrl?: string | null }): AddAttachmentResult => {
      const candidate: StyleChatAttachment = {
        attachmentType: 'look',
        lookId: look.id,
        contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
      };
      const itemCount = Math.max(1, look.itemCount ?? 1);
      const validation = validateAddition(candidate, itemCount);
      if (!validation.ok) return validation;

      upsertDraftAttachment(sessionId, {
        draftId: newDraftId(),
        state: 'ready', // server re-verifies ownership at send time
        selection: { retryCount: 0, updatedAt: now() },
        resolved: candidate,
        summary: {
          title: look.title,
          subtitle: look.occasion ?? null,
          imageUri: look.coverImageUrl ?? null,
          itemCount,
        },
      });
      void recordAiStylistEvent({
        eventType: 'stylechat_look_attached',
        signalKey: look.id,
        payload: { occasion: look.occasion ?? null },
      });
      return { ok: true };
    },
    [sessionId, validateAddition],
  );

  const addOutfitDraft = useCallback(
    (input: {
      itemRefs: StyleChatOutfitDraftItemRef[];
      variation?: OutfitVariation | null;
      reason?: string | null;
      summary: StyleChatAttachmentSummary;
    }): AddAttachmentResult => {
      const candidate: StyleChatAttachment = {
        attachmentType: 'outfit_draft',
        itemRefs: input.itemRefs,
        variation: input.variation ?? null,
        reason: input.reason ? input.reason.slice(0, 240) : null,
        contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
      };
      const validation = validateAddition(candidate, input.itemRefs.length);
      if (!validation.ok) return validation;

      upsertDraftAttachment(sessionId, {
        draftId: newDraftId(),
        state: 'ready', // refs come from a validated Stylist response; server revalidates
        selection: { retryCount: 0, updatedAt: now() },
        resolved: candidate,
        summary: { ...input.summary, itemCount: input.itemRefs.length },
      });
      void recordAiStylistEvent({
        eventType: 'stylechat_outfit_attached',
        signalKey: input.itemRefs.map((ref) => ref.sourceId).sort().join('|').slice(0, 120),
        payload: { variation: input.variation ?? null, itemCount: input.itemRefs.length },
      });
      return { ok: true };
    },
    [sessionId, validateAddition],
  );

  /** Adds a fully-resolved photo-intake result (already row+media backed). */
  const addResolvedOwnedItem = useCallback(
    (resolved: StyleChatAttachment, summary: StyleChatAttachmentSummary): AddAttachmentResult => {
      const validation = validateAddition(resolved, attachmentItemCount(resolved, summary.itemCount));
      if (!validation.ok) return validation;
      upsertDraftAttachment(sessionId, {
        draftId: newDraftId(),
        state: 'ready',
        selection: { retryCount: 0, updatedAt: now() },
        resolved,
        summary,
      });
      return { ok: true };
    },
    [sessionId, validateAddition],
  );

  const retryAttachment = useCallback(
    (draftId: string, items: OwnedClosetItem[], localScans?: SavedScanModel[]) => {
      const draft = getDraftAttachments(sessionId).find((entry) => entry.draftId === draftId);
      if (!draft || draft.state !== 'failed_retryable') return;
      const item = items.find(
        (candidate) =>
          (draft.selection.localScanId && candidate.localId === draft.selection.localScanId) ||
          (draft.resolved?.attachmentType === 'owned_item' && candidate.sourceId === draft.resolved.sourceId),
      );
      if (!item) return;
      const localScan = (localScans ?? []).find((scan) => scan.id === draft.selection.localScanId);
      void resolveOwnedItemDraft({ ...draft, state: 'selected' }, item, localScan);
    },
    [sessionId, resolveOwnedItemDraft],
  );

  const removeAttachment = useCallback(
    (draftId: string) => removeDraftAttachment(sessionId, draftId),
    [sessionId],
  );

  const clearAttachments = useCallback(
    (options?: { keepText?: boolean }) => clearDraftAttachments(sessionId, options),
    [sessionId],
  );

  const snapshotForSend = useCallback(() => snapshotReadyAttachments(sessionId), [sessionId]);

  // One-time entry handoff consumption (Case 2 navigation). Never auto-sends:
  // the attachment only lands in the unsent composer draft.
  useEffect(() => {
    const handoff = consumeAttachmentHandoff();
    if (!handoff) return;
    if (handoff.resolved) {
      addResolvedOwnedItem(handoff.resolved, handoff.summary);
    } else if (handoff.ownedItem) {
      // Local-only closet item: runs the full resolution saga (row + media).
      addOwnedItem(
        handoff.ownedItem as OwnedClosetItem,
        (handoff.localScan as SavedScanModel | null) ?? null,
      );
    }
  }, [addResolvedOwnedItem, addOwnedItem]);

  return {
    attachments,
    hasPending,
    hasFailed,
    allReady,
    canSendWithAttachments,
    addOwnedItem,
    addLook,
    addOutfitDraft,
    addResolvedOwnedItem,
    retryAttachment,
    removeAttachment,
    clearAttachments,
    snapshotForSend,
  };
}
