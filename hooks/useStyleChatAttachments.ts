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
  registerAttachmentSagaReset,
  removeDraftAttachment,
  snapshotReadyAttachments,
  subscribeToAttachmentDrafts,
  updateDraftAttachment,
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
import { resolveSendFashionContext } from '../services/style-chat/eliseSendContext';
import type { OwnedClosetItem, OwnedItemSourceType } from '../types/ownedClosetItem';
import type { OutfitVariation } from '../types/fashionReasoning';
import type { SavedScanModel } from '../services/savedScansCloud';
import type { Look } from '../types/styleObjects';
import { createActorRequest } from '../services/actorContext';
import { deleteClosetCandidate } from '../services/closetCandidateLibrary';
import { promoteSelectedClosetCandidates } from '../services/closetCandidatePromotion';

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
const savingClosetCandidateIds = new Set<string>();

export type UnsavedDirectImageInput = {
  candidateId: string;
  batchId: string;
  imageUri: string;
  thumbnailUri?: string | null;
  summary: StyleChatAttachmentSummary;
  fashionContext: unknown;
  identificationState?: DraftAttachment['identificationState'];
  closetState?: DraftAttachment['closetState'];
  closetItemId?: string | null;
};

export function useStyleChatAttachments(sessionId: string) {
  const attachments = useSyncExternalStore(
    subscribeToAttachmentDrafts,
    () => getDraftAttachments(sessionId),
    () => getDraftAttachments(sessionId),
  );

  const activeForSend = attachments.filter(
    (entry) => entry.state !== 'sent' && entry.state !== 'cancelled',
  );
  const hasPending = activeForSend.some(
    (entry) => isPendingAttachmentState(entry.state) || entry.state === 'sending',
  );
  const hasFailed = activeForSend.some(
    (entry) => entry.state === 'failed_retryable' || entry.state === 'send_failed',
  );
  const allReady =
    activeForSend.length > 0 &&
    activeForSend.every(
      (entry) => entry.state === 'ready' || entry.state === 'send_failed',
    );
  const canSendWithAttachments = activeForSend.length === 0 || allReady;
  const hasActiveAttachments = activeForSend.length > 0;

  const validateAddition = useCallback(
    (candidate: StyleChatAttachment, candidateItemCount: number): AddAttachmentResult => {
      // Use a unique placeholder per unresolved draft entry so multiple
      // pending local selections do not collide as duplicates.
      let pendingIndex = 0;
      const proposed = [
        ...getDraftAttachments(sessionId)
          .filter((entry) => entry.state !== 'cancelled' && entry.state !== 'sent')
          .map((entry) => ({
            attachment:
              entry.resolved ??
              // Unresolved local selections count as one owned item for limits.
              ({
                attachmentType: 'owned_item',
                sourceType: 'saved_scan',
                sourceId: `00000000-0000-4000-8000-${String(pendingIndex++).padStart(12, '0')}`,
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
      let remoteSource: { sourceType: OwnedItemSourceType; sourceId: string } | null = null;
      try {
        let current = item;

        // Step 1: stable remote row (existing cloud-sync path; never invents ids).
        if (!current.remoteBacked || !current.sourceId) {
          // Update-only: if the user removed this attachment mid-resolution, the
          // transition no-ops instead of resurrecting a ghost draft.
          if (!updateDraftAttachment(sessionId, { ...draft, state: 'creating_record' })) return;
          current = await ensureRemoteBackedOwnedItem(current, { localScan: localScan ?? undefined });
        }
        if (!current.sourceId) throw new Error('sync');
        remoteSource = { sourceType: current.sourceType, sourceId: current.sourceId };
        const remoteSelection = {
          ...draft.selection,
          remoteSourceType: remoteSource.sourceType,
          remoteSourceId: remoteSource.sourceId,
        };

        // Step 2: private media backing for saved scans (idempotent saga).
        if (current.sourceType === 'saved_scan' && current.mediaStatus !== 'ready') {
          if (
            !updateDraftAttachment(sessionId, {
              ...draft,
              state: 'uploading_media',
              selection: { ...remoteSelection, updatedAt: now() },
            })
          ) {
            return;
          }
          const media = await ensureSavedScanMediaBacking({
            savedScanId: current.sourceId,
            localImageUri: draft.selection.localImageUri ?? item.imageUri,
          });
          if (!media.ok && media.retryable) throw new Error('media');
          // Non-retryable media rejection: attach metadata-only is NOT allowed
          // to masquerade as image-aware; keep it attachable (metadata) only
          // when media was never required — here we mark rejected.
          if (!media.ok) {
            updateDraftAttachment(sessionId, {
              ...draft,
              state: 'rejected',
              selection: { ...remoteSelection, lastErrorCode: media.errorCode, updatedAt: now() },
            });
            return;
          }
        }

        // Step 3: resolved contract replaces the local selection. Update-only:
        // a removal during resolution invalidates this late completion.
        const applied = updateDraftAttachment(sessionId, {
          ...draft,
          state: 'ready',
          resolved: {
            attachmentType: 'owned_item',
            sourceType: current.sourceType,
            sourceId: current.sourceId,
            contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
          },
          selection: { ...remoteSelection, lastErrorCode: null, updatedAt: now() },
        });
        // Only record the "attached" signal when the attachment actually landed
        // in the live composer (not when it was removed mid-resolution).
        if (applied) {
          void recordAiStylistEvent({
            eventType: 'stylechat_item_attached',
            signalKey: `${current.sourceType}:${current.sourceId}`,
            payload: { category: current.category ?? null },
          });
        }
      } catch {
        // Failure preserves the local selection for retry; never invents ids,
        // never silently removes, never sends local ids. Update-only: a removal
        // during resolution is not resurrected as a ghost failed attachment.
        updateDraftAttachment(sessionId, {
          ...draft,
          state: 'failed_retryable',
          selection: {
            ...draft.selection,
            remoteSourceType: remoteSource?.sourceType ?? draft.selection.remoteSourceType ?? null,
            remoteSourceId: remoteSource?.sourceId ?? draft.selection.remoteSourceId ?? null,
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
    (
      resolved: StyleChatAttachment,
      summary: StyleChatAttachmentSummary,
      /**
       * Canonical identity from the intake (Phase 2B.3).
       *
       * Held on the DRAFT, not merged into `resolved`: `resolved` is the
       * attachment-reference contract the backend has always received, and
       * widening it would change an established payload. This travels in the
       * separate top-level `fashionContextV2` request field.
       */
      fashionContext?: unknown,
    ): AddAttachmentResult => {
      const validation = validateAddition(resolved, attachmentItemCount(resolved, summary.itemCount));
      if (!validation.ok) return validation;
      upsertDraftAttachment(sessionId, {
        draftId: newDraftId(),
        state: 'ready',
        selection: { retryCount: 0, updatedAt: now() },
        resolved,
        summary,
        ...(fashionContext ? { fashionContext, identificationState: 'ready' as const } : {}),
      });
      return { ok: true };
    },
    [sessionId, validateAddition],
  );

  /** A direct image is ready from its validated identity; Closet is optional. */
  const addUnsavedDirectImage = useCallback(
    (input: UnsavedDirectImageInput): AddAttachmentResult => {
      const placeholder: StyleChatAttachment = {
        attachmentType: 'owned_item',
        sourceType: 'saved_scan',
        sourceId: '00000000-0000-4000-8000-000000000001',
        contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
      };
      const validation = validateAddition(placeholder, 1);
      if (!validation.ok) return validation;
      upsertDraftAttachment(sessionId, {
        draftId: newDraftId(),
        state: 'ready',
        selection: {
          localImageUri: input.imageUri,
          sanitizedImageUri: input.imageUri,
          closetCandidateId: input.candidateId,
          closetCandidateBatchId: input.batchId,
          retryCount: 0,
          updatedAt: now(),
        },
        resolved: null,
        summary: {
          ...input.summary,
          imageUri: input.thumbnailUri ?? input.summary.imageUri ?? input.imageUri,
          itemCount: 1,
        },
        fashionContext: input.fashionContext,
        identificationState: input.identificationState ?? 'ready',
        closetState: input.closetState ?? 'not_saved',
        closetItemId: input.closetItemId ?? null,
      });
      return { ok: true };
    },
    [sessionId, validateAddition],
  );

  const applyClosetOutcome = useCallback(
    (
      candidateId: string,
      closetState: NonNullable<DraftAttachment['closetState']>,
      closetItemId?: string | null,
    ) => {
      const live = getDraftAttachments(sessionId).find(
        (entry) => entry.selection.closetCandidateId === candidateId,
      );
      if (!live) return;
      updateDraftAttachment(sessionId, {
        ...live,
        closetState,
        closetItemId: closetItemId ?? live.closetItemId ?? null,
        selection: { ...live.selection, updatedAt: now() },
      });
    },
    [sessionId],
  );

  const saveDirectImageToCloset = useCallback(
    async (draftId: string): Promise<AddAttachmentResult> => {
      const draft = getDraftAttachments(sessionId).find((entry) => entry.draftId === draftId);
      const candidateId = draft?.selection.closetCandidateId ?? null;
      if (!draft || !candidateId) return { ok: false, message: 'This photo cannot be saved.' };
      if (draft.closetState === 'saved') return { ok: true };
      if (savingClosetCandidateIds.has(candidateId)) return { ok: true };

      savingClosetCandidateIds.add(candidateId);
      applyClosetOutcome(candidateId, 'saving');
      const actorRequest = createActorRequest();
      try {
        const result = await promoteSelectedClosetCandidates({
          actorId: actorRequest.actorId,
          actorEpoch: actorRequest.epoch,
          batchId: draft.selection.closetCandidateBatchId ?? null,
          candidateIds: [candidateId],
        });
        const item = result?.results?.[0];
        const closetItemId = item?.committedClosetItemId ?? null;
        if (
          (item?.status === 'promoted' || item?.status === 'already_promoted') &&
          typeof closetItemId === 'string' &&
          closetItemId
        ) {
          applyClosetOutcome(candidateId, 'saved', closetItemId);
          return { ok: true };
        }
        applyClosetOutcome(candidateId, 'save_failed');
        return { ok: false, message: "Couldn't save to Closet. You can retry." };
      } catch {
        applyClosetOutcome(candidateId, 'save_failed');
        return { ok: false, message: "Couldn't save to Closet. You can retry." };
      } finally {
        savingClosetCandidateIds.delete(candidateId);
      }
    },
    [sessionId, applyClosetOutcome],
  );

  /**
   * Record that this item has been handed off to the private Dressing Room.
   *
   * IN-MEMORY AND CLIENT-ONLY, like every other field on the draft. It changes
   * which follow-up the composer offers next — "Open Dressing Room" rather than
   * "Style This Item" — and nothing else reads it. It is emphatically NOT a
   * claim that a Look was saved, and it never participates in the ownership
   * decision, which stays `closetState === 'saved'` plus a committed item id.
   *
   * Update-only: a draft removed between the handoff and this call is not
   * resurrected.
   */
  const markStyledInDressingRoom = useCallback(
    (draftId: string) => {
      const live = getDraftAttachments(sessionId).find((entry) => entry.draftId === draftId);
      if (!live || live.styledInDressingRoom === true) return;
      updateDraftAttachment(sessionId, {
        ...live,
        styledInDressingRoom: true,
        selection: { ...live.selection, updatedAt: now() },
      });
    },
    [sessionId],
  );

  const setSnapshotSendState = useCallback(
    (drafts: DraftAttachment[], state: 'sending' | 'send_failed' | 'sent') => {
      for (const snapshot of drafts) {
        const live = getDraftAttachments(sessionId).find(
          (entry) => entry.draftId === snapshot.draftId,
        );
        if (!live) continue;
        if (!live.selection.closetCandidateId && state === 'sent') {
          removeDraftAttachment(sessionId, live.draftId);
          continue;
        }
        updateDraftAttachment(sessionId, {
          ...live,
          state,
          selection: { ...live.selection, updatedAt: now() },
        });
      }
    },
    [sessionId],
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
      if (!item) {
        const savedScanId =
          draft.selection.remoteSourceType === 'saved_scan'
            ? draft.selection.remoteSourceId
            : draft.resolved?.attachmentType === 'owned_item' && draft.resolved.sourceType === 'saved_scan'
              ? draft.resolved.sourceId
              : null;
        if (!savedScanId || resolvingDraftIds.has(draft.draftId)) return;
        resolvingDraftIds.add(draft.draftId);
        const retrySelection = {
          ...draft.selection,
          remoteSourceType: 'saved_scan' as const,
          remoteSourceId: savedScanId,
          updatedAt: now(),
        };
        // Update-only: if the attachment was removed between the failed state
        // and this retry tap, do not resurrect it — release the guard and stop.
        if (
          !updateDraftAttachment(sessionId, {
            ...draft,
            state: 'uploading_media',
            selection: retrySelection,
          })
        ) {
          resolvingDraftIds.delete(draft.draftId);
          return;
        }
        void (async () => {
          try {
            const media = await ensureSavedScanMediaBacking({
              savedScanId,
              localImageUri: draft.selection.localImageUri,
            });
            if (!media.ok && media.retryable) throw new Error('media');
            if (!media.ok) {
              updateDraftAttachment(sessionId, {
                ...draft,
                state: 'rejected',
                selection: {
                  ...retrySelection,
                  lastErrorCode: media.errorCode,
                  updatedAt: now(),
                },
              });
              return;
            }
            updateDraftAttachment(sessionId, {
              ...draft,
              state: 'ready',
              resolved: {
                attachmentType: 'owned_item',
                sourceType: 'saved_scan',
                sourceId: savedScanId,
                contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
              },
              selection: {
                ...retrySelection,
                lastErrorCode: null,
                updatedAt: now(),
              },
            });
          } catch {
            updateDraftAttachment(sessionId, {
              ...draft,
              state: 'failed_retryable',
              selection: {
                ...retrySelection,
                retryCount: draft.selection.retryCount + 1,
                lastErrorCode: 'MEDIA_UPLOAD_FAILED',
                updatedAt: now(),
              },
            });
          } finally {
            resolvingDraftIds.delete(draft.draftId);
          }
        })();
        return;
      }
      const localScan = (localScans ?? []).find((scan) => scan.id === draft.selection.localScanId);
      void resolveOwnedItemDraft({ ...draft, state: 'selected' }, item, localScan);
    },
    [sessionId, resolveOwnedItemDraft],
  );

  const removeAttachment = useCallback(
    (draftId: string) => {
      const draft = getDraftAttachments(sessionId).find((entry) => entry.draftId === draftId);
      removeDraftAttachment(sessionId, draftId);
      const candidateId = draft?.selection.closetCandidateId;
      const stillReferenced = candidateId
        ? getDraftAttachments(sessionId).some(
            (entry) => entry.selection.closetCandidateId === candidateId,
          )
        : false;
      if (
        draft &&
        candidateId &&
        !stillReferenced &&
        draft.closetState !== 'saved'
      ) {
        void deleteClosetCandidate(createActorRequest(), candidateId);
      }
    },
    [sessionId],
  );

  const clearAttachments = useCallback(
    (options?: { keepText?: boolean }) => clearDraftAttachments(sessionId, options),
    [sessionId],
  );

  const snapshotForSend = useCallback(() => {
    const snapshot = snapshotReadyAttachments(sessionId);
    // Phase 2B.3: the canonical identities of the ready drafts, in source order.
    const fashionContextDecision = resolveSendFashionContext(snapshot.drafts);
    return {
      ...snapshot,
      fashionContext:
        fashionContextDecision.kind === 'send' ? fashionContextDecision.context : null,
      /**
       * Set when visual attachments exist but carry nothing groundable. The
       * composer must not send an image-backed message in this state: the reply
       * would be written without the image while the transcript shows it.
       */
      fashionContextBlockedReason:
        fashionContextDecision.kind === 'blocked' ? fashionContextDecision.reason : null,
      /**
       * True while an attachment is still identifying.
       *
       * The existing `canSendWithAttachments` gate already blocks a send with any
       * pending attachment, so this is a second, explicit statement of the same
       * rule rather than the only thing enforcing it — a send must never claim
       * visual grounding for a garment that has not been identified yet.
       */
      fashionContextPending: fashionContextDecision.kind === 'pending',
    };
  }, [sessionId]);

  // One-time entry handoff consumption (Case 2 navigation). Re-evaluate when
  // the session id changes so a handoff set while the screen was mounted for
  // another session is still consumed. Never auto-sends: the attachment only
  // lands in the unsent composer draft.
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
  }, [sessionId, addResolvedOwnedItem, addOwnedItem]);

  // Register the store-reset callback so sign-out also clears in-flight saga
  // guards. The cleanup only unregisters this component's callback if it is
  // still the active one; module-level guards remain otherwise.
  useEffect(() => registerAttachmentSagaReset(() => resolvingDraftIds.clear()), []);

  return {
    attachments,
    hasPending,
    hasFailed,
    allReady,
    canSendWithAttachments,
    hasActiveAttachments,
    addOwnedItem,
    addLook,
    addOutfitDraft,
    addResolvedOwnedItem,
    addUnsavedDirectImage,
    applyClosetOutcome,
    saveDirectImageToCloset,
    markStyledInDressingRoom,
    markSending: (drafts: DraftAttachment[]) => setSnapshotSendState(drafts, 'sending'),
    markSent: (drafts: DraftAttachment[]) => setSnapshotSendState(drafts, 'sent'),
    markSendFailed: (drafts: DraftAttachment[]) => setSnapshotSendState(drafts, 'send_failed'),
    retryAttachment,
    removeAttachment,
    clearAttachments,
    snapshotForSend,
  };
}
