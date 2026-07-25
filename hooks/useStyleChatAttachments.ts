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
  buildOwnedDressingRoomItemAttachment,
  buildSharedRoomItemAttachment,
  isPendingAttachmentState,
  validateAttachmentCombination,
  type DraftAttachment,
  type StyleChatAttachment,
  type StyleChatAttachmentSummary,
  type StyleChatOutfitDraftItemRef,
} from '../types/styleChatAttachments';
import {
  ELISE_ATTACHMENT_LIMIT_MESSAGE,
  ELISE_DIRECT_IMAGE_LIMIT_MESSAGE,
  MAX_ELISE_ATTACHMENTS,
  MAX_ELISE_DIRECT_IMAGES,
} from '../types/eliseVisualAttachments';
import {
  ensureRemoteBackedOwnedItem,
  normalizeLocalSavedScan,
} from '../services/ownedClosetItems';
import { ensureSavedScanMediaBacking } from '../services/savedScanMedia';
import { recordAiStylistEvent } from '../services/styleMemoryEvents';
import {
  cleanupPreparedDirectImage,
  prepareEliseDirectImage,
  resolvePreparedDirectImageAttachment,
} from '../services/style-chat/eliseDirectImageAttachment';
import { orderAttachmentsForSend } from '../services/style-chat/eliseVisualAttachmentDedup';
import { trackEliseAttachmentTelemetry } from '../services/style-chat/eliseVisualAttachmentTelemetry';
import type { OwnedClosetItem, OwnedItemSourceType } from '../types/ownedClosetItem';
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

function countDirectImageDrafts(attachments: DraftAttachment[]): number {
  return attachments.filter((entry) => {
    if (entry.state === 'cancelled') return false;
    const subtitle = entry.summary.subtitle?.toLowerCase() ?? '';
    return (
      subtitle === 'photo' ||
      Boolean(entry.selection.sanitizedImageUri) ||
      (entry.resolved?.attachmentType === 'owned_item' &&
        entry.resolved.sourceType === 'saved_scan' &&
        subtitle.includes('photo'))
    );
  }).length;
}

/** Resolution guard: one saga per draftId at a time. */
const resolvingDraftIds = new Set<string>();
/** Focused draft id per session (client UI only). */
const focusedDraftBySession = new Map<string, string | null>();
const focusListeners = new Set<() => void>();

function notifyFocus() {
  for (const listener of [...focusListeners]) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

function getFocusedDraftId(sessionId: string): string | null {
  return focusedDraftBySession.get(sessionId) ?? null;
}

function setFocusedDraftId(sessionId: string, draftId: string | null): void {
  focusedDraftBySession.set(sessionId, draftId);
  notifyFocus();
}

export function useStyleChatAttachments(sessionId: string) {
  const attachments = useSyncExternalStore(
    subscribeToAttachmentDrafts,
    () => getDraftAttachments(sessionId),
    () => getDraftAttachments(sessionId),
  );
  const focusedDraftId = useSyncExternalStore(
    (listener) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
    () => getFocusedDraftId(sessionId),
    () => getFocusedDraftId(sessionId),
  );

  const hasPending = attachments.some((entry) => isPendingAttachmentState(entry.state));
  const hasFailed = attachments.some((entry) => entry.state === 'failed_retryable');
  const allReady = attachments.length > 0 && attachments.every((entry) => entry.state === 'ready');
  const canSendWithAttachments = attachments.length === 0 || allReady;
  const atAttachmentLimit = attachments.filter((entry) => entry.state !== 'cancelled').length >= MAX_ELISE_ATTACHMENTS;
  const atDirectImageLimit = countDirectImageDrafts(attachments) >= MAX_ELISE_DIRECT_IMAGES;

  const validateAddition = useCallback(
    (candidate: StyleChatAttachment, candidateItemCount: number, options?: { isDirectImage?: boolean }): AddAttachmentResult => {
      const live = getDraftAttachments(sessionId).filter((entry) => entry.state !== 'cancelled');
      if (live.length >= MAX_ELISE_ATTACHMENTS) {
        return { ok: false, message: ELISE_ATTACHMENT_LIMIT_MESSAGE };
      }
      if (options?.isDirectImage && countDirectImageDrafts(live) >= MAX_ELISE_DIRECT_IMAGES) {
        return { ok: false, message: ELISE_DIRECT_IMAGE_LIMIT_MESSAGE };
      }

      // Use a unique placeholder per unresolved draft entry so multiple
      // pending local selections do not collide as duplicates.
      let pendingIndex = 0;
      const proposed = [
        ...live
          .filter((entry) => entry.resolved || entry.state !== 'cancelled')
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
            localImageUri:
              draft.selection.sanitizedImageUri ??
              draft.selection.localImageUri ??
              item.imageUri,
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
      if (!getFocusedDraftId(sessionId)) setFocusedDraftId(sessionId, draft.draftId);
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
      const draftId = getDraftAttachments(sessionId).slice(-1)[0]?.draftId;
      if (draftId && !getFocusedDraftId(sessionId)) setFocusedDraftId(sessionId, draftId);
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
    (resolved: StyleChatAttachment, summary: StyleChatAttachmentSummary, options?: { isDirectImage?: boolean }): AddAttachmentResult => {
      const validation = validateAddition(
        resolved,
        attachmentItemCount(resolved, summary.itemCount),
        { isDirectImage: options?.isDirectImage },
      );
      if (!validation.ok) return validation;
      const draftId = newDraftId();
      upsertDraftAttachment(sessionId, {
        draftId,
        state: 'ready',
        selection: { retryCount: 0, updatedAt: now() },
        resolved,
        summary,
      });
      if (!getFocusedDraftId(sessionId)) setFocusedDraftId(sessionId, draftId);
      return { ok: true };
    },
    [sessionId, validateAddition],
  );

  const addSharedItem = useCallback(
    (input: {
      sourceId: string;
      title: string;
      imageUri?: string | null;
      subtitle?: string | null;
    }): AddAttachmentResult => {
      const candidate = buildSharedRoomItemAttachment(input.sourceId);
      const validation = validateAddition(candidate, 1);
      if (!validation.ok) return validation;
      const draftId = newDraftId();
      upsertDraftAttachment(sessionId, {
        draftId,
        state: 'ready',
        selection: { retryCount: 0, updatedAt: now() },
        resolved: candidate,
        summary: {
          title: input.title,
          subtitle: input.subtitle ?? 'Shared',
          imageUri: input.imageUri ?? null,
          itemCount: 1,
        },
      });
      if (!getFocusedDraftId(sessionId)) setFocusedDraftId(sessionId, draftId);
      return { ok: true };
    },
    [sessionId, validateAddition],
  );

  const addDressingRoomItem = useCallback(
    (input: {
      sourceId: string;
      title: string;
      imageUri?: string | null;
      shared?: boolean;
      subtitle?: string | null;
    }): AddAttachmentResult => {
      if (input.shared) {
        return addSharedItem({
          sourceId: input.sourceId,
          title: input.title,
          imageUri: input.imageUri,
          subtitle: input.subtitle ?? 'Shared',
        });
      }
      const candidate = buildOwnedDressingRoomItemAttachment(input.sourceId);
      const validation = validateAddition(candidate, 1);
      if (!validation.ok) return validation;
      const draftId = newDraftId();
      upsertDraftAttachment(sessionId, {
        draftId,
        state: 'ready',
        selection: { retryCount: 0, updatedAt: now() },
        resolved: candidate,
        summary: {
          title: input.title,
          subtitle: input.subtitle ?? 'Dressing Room',
          imageUri: input.imageUri ?? null,
          itemCount: 1,
        },
      });
      if (!getFocusedDraftId(sessionId)) setFocusedDraftId(sessionId, draftId);
      return { ok: true };
    },
    [sessionId, validateAddition, addSharedItem],
  );

  /**
   * Camera / gallery → Scanner-compatible prep → saved_scan owned_item.
   * Does not call scan-identify merely to manufacture the attachment.
   */
  const addDirectImage = useCallback(
    async (
      localUri: string,
      source: 'camera' | 'photo_library',
    ): Promise<AddAttachmentResult> => {
      const live = getDraftAttachments(sessionId).filter((entry) => entry.state !== 'cancelled');
      if (live.length >= MAX_ELISE_ATTACHMENTS) {
        return { ok: false, message: ELISE_ATTACHMENT_LIMIT_MESSAGE };
      }
      if (countDirectImageDrafts(live) >= MAX_ELISE_DIRECT_IMAGES) {
        return { ok: false, message: ELISE_DIRECT_IMAGE_LIMIT_MESSAGE };
      }

      const draftId = newDraftId();
      const startedAt = Date.now();
      upsertDraftAttachment(sessionId, {
        draftId,
        state: 'sanitizing',
        selection: {
          localImageUri: localUri,
          retryCount: 0,
          updatedAt: now(),
        },
        resolved: null,
        summary: {
          title: 'Photo',
          subtitle: 'Photo',
          imageUri: localUri,
          itemCount: 1,
        },
      });
      if (!getFocusedDraftId(sessionId)) setFocusedDraftId(sessionId, draftId);

      let prepared: Awaited<ReturnType<typeof prepareEliseDirectImage>> | null = null;
      try {
        prepared = await prepareEliseDirectImage(localUri, source);
        if (!updateDraftAttachment(sessionId, {
          draftId,
          state: 'creating_record',
          selection: {
            localImageUri: localUri,
            sanitizedImageUri: prepared.preparedUri,
            retryCount: 0,
            updatedAt: now(),
          },
          resolved: null,
          summary: {
            title: 'Photo',
            subtitle: 'Photo',
            imageUri: prepared.previewUri,
            itemCount: 1,
          },
        })) {
          await cleanupPreparedDirectImage(prepared);
          return { ok: false, message: 'Attachment removed.' };
        }

        const result = await resolvePreparedDirectImageAttachment(prepared, {
          title: 'Photo',
          category: 'tops',
        });
        if (result.ok) {
          updateDraftAttachment(sessionId, {
            draftId,
            state: 'ready',
            selection: {
              localImageUri: localUri,
              sanitizedImageUri: prepared.preparedUri,
              remoteSourceType: 'saved_scan',
              remoteSourceId:
                result.resolved.attachmentType === 'owned_item' ? result.resolved.sourceId : null,
              retryCount: 0,
              lastErrorCode: null,
              updatedAt: now(),
            },
            resolved: result.resolved,
            summary: result.summary,
          });
          trackEliseAttachmentTelemetry('elise_attachment_direct_image', {
            attachmentCount: 1,
            directImageCount: 1,
            attachmentsResolved: 1,
            preparationOutcome: 'ready',
            resolutionOutcome: 'ready',
            transportOutcome: 'saved_scan',
            sendOutcome: 'pending',
            latencyMs: Date.now() - startedAt,
            contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
          });
          return { ok: true };
        }

        const failureCode =
          'errorCode' in result && typeof result.errorCode === 'string'
            ? result.errorCode
            : 'RESOLUTION_FAILED';
        const failureMessage =
          'message' in result && typeof result.message === 'string'
            ? result.message
            : 'Could not attach the photo. Please try again.';

        updateDraftAttachment(sessionId, {
          draftId,
          state: 'failed_retryable',
          selection: {
            localScanId:
              'localScanId' in result && typeof result.localScanId === 'string'
                ? result.localScanId
                : null,
            localImageUri: localUri,
            sanitizedImageUri: prepared.preparedUri,
            remoteSourceType:
              'savedScanId' in result && typeof result.savedScanId === 'string'
                ? 'saved_scan'
                : null,
            remoteSourceId:
              'savedScanId' in result && typeof result.savedScanId === 'string'
                ? result.savedScanId
                : null,
            retryCount: 1,
            lastErrorCode: failureCode,
            updatedAt: now(),
          },
          resolved: null,
          summary: {
            title: 'Photo',
            subtitle: 'Photo',
            imageUri: prepared.previewUri,
            itemCount: 1,
          },
        });
        trackEliseAttachmentTelemetry('elise_attachment_direct_image', {
          attachmentCount: 1,
          directImageCount: 1,
          preparationOutcome: 'failed',
          resolutionOutcome: failureCode,
          sendOutcome: 'not_sent',
          latencyMs: Date.now() - startedAt,
          contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
          failureCode,
        });
        return { ok: false, message: failureMessage };
      } catch {
        updateDraftAttachment(sessionId, {
          draftId,
          state: 'failed_retryable',
          selection: {
            localImageUri: localUri,
            sanitizedImageUri: prepared?.preparedUri ?? null,
            retryCount: 1,
            lastErrorCode: 'PREPARATION_FAILED',
            updatedAt: now(),
          },
          resolved: null,
          summary: {
            title: 'Photo',
            subtitle: 'Photo',
            imageUri: prepared?.previewUri ?? localUri,
            itemCount: 1,
          },
        });
        return { ok: false, message: 'Could not prepare that photo. Please try again.' };
      }
    },
    [sessionId],
  );

  const setFocusedAttachment = useCallback(
    (draftId: string) => {
      const exists = getDraftAttachments(sessionId).some((entry) => entry.draftId === draftId);
      if (!exists) return;
      setFocusedDraftId(sessionId, draftId);
    },
    [sessionId],
  );

  const retryAttachment = useCallback(
    (draftId: string, items: OwnedClosetItem[], localScans?: SavedScanModel[]) => {
      const draft = getDraftAttachments(sessionId).find((entry) => entry.draftId === draftId);
      if (!draft || draft.state !== 'failed_retryable') return;
      const suppliedLocalScan = (localScans ?? []).find(
        (scan) => scan.id === draft.selection.localScanId,
      );
      const retryImageUri =
        draft.selection.sanitizedImageUri ?? draft.selection.localImageUri ?? null;
      const localScan =
        suppliedLocalScan ??
        (draft.selection.localScanId && retryImageUri
          ? ({
              id: draft.selection.localScanId,
              createdAt: draft.selection.updatedAt,
              imageUri: retryImageUri,
              thumbnailUri: retryImageUri,
              attributes: {
                category: 'tops',
                silhouette: '',
                color_palette: '',
                material_estimate: null,
                style_tags: [],
                confidence_score: null,
              },
              result: `${draft.summary.title || 'Photo'} — attached for Elise`,
              products: [],
              source: 'upload',
            } satisfies SavedScanModel)
          : null);
      const item =
        items.find(
        (candidate) =>
          (draft.selection.localScanId && candidate.localId === draft.selection.localScanId) ||
          (draft.resolved?.attachmentType === 'owned_item' && candidate.sourceId === draft.resolved.sourceId),
        ) ?? (localScan ? normalizeLocalSavedScan(localScan) : null);
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
              localImageUri:
                draft.selection.sanitizedImageUri ?? draft.selection.localImageUri,
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
      void resolveOwnedItemDraft({ ...draft, state: 'selected' }, item, localScan);
    },
    [sessionId, resolveOwnedItemDraft],
  );

  const removeAttachment = useCallback(
    (draftId: string) => {
      removeDraftAttachment(sessionId, draftId);
      if (getFocusedDraftId(sessionId) === draftId) {
        const remaining = getDraftAttachments(sessionId).filter((entry) => entry.state !== 'cancelled');
        setFocusedDraftId(sessionId, remaining[0]?.draftId ?? null);
      }
    },
    [sessionId],
  );

  const clearAttachments = useCallback(
    (options?: { keepText?: boolean }) => {
      clearDraftAttachments(sessionId, options);
      setFocusedDraftId(sessionId, null);
    },
    [sessionId],
  );

  const snapshotForSend = useCallback(() => {
    const snapshot = snapshotReadyAttachments(sessionId);
    // V2 treats attachment order as multimodal focus priority; no explicit
    // attachment focus field exists. Bind UI focus by placing the focused
    // draft first. Visual-collection focus still uses focusEvidenceId when present.
    const orderedDrafts = orderAttachmentsForSend(
      getDraftAttachments(sessionId)
        .filter((entry) => entry.state === 'ready' && entry.resolved)
        .map((entry) => ({
          draftId: entry.draftId,
          focused: entry.draftId === getFocusedDraftId(sessionId),
          resolved: entry.resolved!,
        })),
      getFocusedDraftId(sessionId),
    );
    const byId = new Map(snapshot.references.map((ref) => {
      const key =
        ref.attachmentType === 'owned_item' || ref.attachmentType === 'shared_item'
          ? `${ref.attachmentType}:${ref.sourceType}:${ref.sourceId}`
          : ref.attachmentType === 'look'
            ? `look:${ref.lookId}`
            : `draft:${JSON.stringify(ref)}`;
      return [key, ref] as const;
    }));
    const orderedRefs = orderedDrafts
      .map((entry) => {
        const ref = entry.resolved;
        const key =
          ref.attachmentType === 'owned_item' || ref.attachmentType === 'shared_item'
            ? `${ref.attachmentType}:${ref.sourceType}:${ref.sourceId}`
            : ref.attachmentType === 'look'
              ? `look:${ref.lookId}`
              : null;
        return key ? byId.get(key) ?? ref : ref;
      })
      .filter(Boolean) as StyleChatAttachment[];

    return {
      ...snapshot,
      references: orderedRefs.length ? orderedRefs : snapshot.references,
      focusedDraftId: getFocusedDraftId(sessionId),
    };
  }, [sessionId]);

  // Ensure first attachment is focused by default.
  useEffect(() => {
    const live = attachments.filter((entry) => entry.state !== 'cancelled');
    if (!live.length) {
      if (getFocusedDraftId(sessionId)) setFocusedDraftId(sessionId, null);
      return;
    }
    const current = getFocusedDraftId(sessionId);
    if (!current || !live.some((entry) => entry.draftId === current)) {
      setFocusedDraftId(sessionId, live[0].draftId);
    }
  }, [attachments, sessionId]);

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
  useEffect(() => registerAttachmentSagaReset(() => {
    resolvingDraftIds.clear();
    focusedDraftBySession.clear();
    notifyFocus();
  }), []);

  return {
    attachments,
    focusedDraftId,
    hasPending,
    hasFailed,
    allReady,
    canSendWithAttachments,
    atAttachmentLimit,
    atDirectImageLimit,
    addOwnedItem,
    addLook,
    addOutfitDraft,
    addResolvedOwnedItem,
    addSharedItem,
    addDressingRoomItem,
    addDirectImage,
    setFocusedAttachment,
    retryAttachment,
    removeAttachment,
    clearAttachments,
    snapshotForSend,
  };
}
