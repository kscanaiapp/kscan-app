// Direct-image attachment preparation for Elise.
//
// The selected photo is first reserved in the existing actor-scoped Closet
// candidate store. That gives Elise a durable app-controlled image without
// creating a Recent Scan, saved_scan row, or Closet item. Privacy preparation
// and identification remain unchanged; Closet promotion is explicit and
// idempotent by candidate identity.

import {
  SCANNER_IMAGE_JPEG_QUALITY,
  SCANNER_IMAGE_MAX_WIDTH,
} from '../imageUtils';
import {
  cleanupSanitizedImage,
  prepareImageForPrivacyUpload,
} from '../privacyImageUpload';
import { createActorRequest } from '../actorContext';
import {
  createClosetCandidate,
  deleteClosetCandidate,
  getClosetCandidate,
  transitionClosetCandidate,
  updateClosetCandidate,
} from '../closetCandidateLibrary';
import { promoteSelectedClosetCandidates } from '../closetCandidatePromotion';
import type { StyleChatAttachmentSummary } from '../../types/styleChatAttachments';

export type PreparedDirectImage = {
  previewUri: string;
  preparedUri: string;
  width?: number;
  height?: number;
  source: 'camera' | 'photo_library';
  operationId: string;
  candidateId: string;
  candidateBatchId: string;
  candidateImageUri: string;
  candidateThumbnailUri?: string | null;
};

export type DirectImageAttachResult =
  | {
      ok: true;
      summary: StyleChatAttachmentSummary;
      prepared: PreparedDirectImage;
      closetState: 'not_saved' | 'saved';
      closetItemId?: string | null;
    }
  | {
      ok: false;
      errorCode: 'PREPARATION_FAILED' | 'UPLOAD_FAILED' | 'RESOLUTION_FAILED';
      message: string;
      candidateId?: string;
    };

function newOperationId(): string {
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Stage an image that has already passed the existing privacy preparation. */
export async function stageSanitizedEliseDirectImage(
  sanitizedUri: string,
  source: 'camera' | 'photo_library',
  previewUri?: string,
): Promise<PreparedDirectImage> {
  if (!sanitizedUri || typeof sanitizedUri !== 'string') throw new Error('No image selected.');

  const operationId = newOperationId();
  const staged = await createClosetCandidate(createActorRequest(), {
    sourceUri: sanitizedUri,
    sourceType: source === 'camera' ? 'camera' : 'gallery',
    sourceLineageId: `elise:${operationId}`,
    draft: { title: 'Photo' },
  });
  if (
    staged.kind === 'rejected' ||
    staged.kind === 'already_in_closet' ||
    !('candidate' in staged) ||
    !staged.candidate?.candidateImageUri
  ) {
    throw new Error('Could not keep a durable copy of this photo.');
  }

  const candidate = staged.candidate;
  return {
    previewUri: previewUri ?? candidate.candidateThumbnailUri ?? candidate.candidateImageUri,
    preparedUri: sanitizedUri,
    source,
    operationId,
    candidateId: candidate.candidateId,
    candidateBatchId: candidate.batchId,
    candidateImageUri: candidate.candidateImageUri,
    candidateThumbnailUri: candidate.candidateThumbnailUri,
  };
}

/** Preserve the existing privacy boundary before writing durable app media. */
export async function prepareEliseDirectImage(
  localUri: string,
  source: 'camera' | 'photo_library',
): Promise<PreparedDirectImage> {
  if (!localUri || typeof localUri !== 'string') throw new Error('No image selected.');

  const prepared = await prepareImageForPrivacyUpload(localUri, {
    maxDimension: SCANNER_IMAGE_MAX_WIDTH,
    quality: SCANNER_IMAGE_JPEG_QUALITY,
  });
  try {
    const staged = await stageSanitizedEliseDirectImage(prepared.sanitizedUri, source);
    return { ...staged, width: prepared.width, height: prepared.height };
  } catch (error) {
    await cleanupSanitizedImage(prepared.sanitizedUri);
    throw error;
  }
}

/**
 * Finalize identification metadata on the durable candidate. No Closet or
 * cloud persistence is required for Elise readiness.
 */
export async function resolvePreparedDirectImageAttachment(
  prepared: PreparedDirectImage,
  options?: {
    title?: string;
    category?: string;
    signal?: AbortSignal;
    analysis?: { result?: string; metadata?: Record<string, unknown> } & Record<string, unknown>;
  },
): Promise<DirectImageAttachResult> {
  if (options?.signal?.aborted) {
    return { ok: false, errorCode: 'PREPARATION_FAILED', message: 'Attachment cancelled.' };
  }

  try {
    const title = (options?.title ?? 'Photo').trim().slice(0, 80) || 'Photo';
    const category = (options?.category ?? 'tops').trim().slice(0, 80) || 'tops';
    const actorRequest = createActorRequest();
    let loaded = await getClosetCandidate(actorRequest, prepared.candidateId);
    if (!loaded.ok) throw new Error('candidate');

    if (loaded.candidate.status === 'queued') {
      const classifying = await transitionClosetCandidate(
        actorRequest,
        prepared.candidateId,
        { to: 'classifying', attempt: 'manual' },
      );
      if (!classifying || classifying.ok !== true) throw new Error('candidate');
      loaded = classifying;
    }

    const patch = { title, category, classificationVersion: 'elise-fashion-context-v2' };
    if (loaded.candidate.status === 'classifying') {
      const ready = await transitionClosetCandidate(
        actorRequest,
        prepared.candidateId,
        { to: 'ready_for_review', patch },
      );
      if (!ready || ready.ok !== true) throw new Error('candidate');
      loaded = ready;
    } else if (loaded.candidate.status === 'ready_for_review') {
      const updated = await updateClosetCandidate(actorRequest, prepared.candidateId, patch);
      if (!updated || updated.ok !== true) throw new Error('candidate');
      loaded = updated;
    }

    const closetItemId =
      loaded.candidate.status === 'saved'
        ? loaded.candidate.promotedClosetItemId ?? null
        : loaded.candidate.status === 'duplicate'
          ? loaded.candidate.duplicateMatch?.closetItemId ?? null
          : null;
    if (loaded.candidate.status !== 'ready_for_review' && !closetItemId) {
      throw new Error('candidate');
    }

    return {
      ok: true,
      summary: {
        title,
        subtitle: 'Photo',
        imageUri: prepared.candidateThumbnailUri ?? prepared.candidateImageUri,
        itemCount: 1,
      },
      prepared,
      closetState: closetItemId ? 'saved' : 'not_saved',
      closetItemId,
    };
  } catch {
    return {
      ok: false,
      errorCode: 'RESOLUTION_FAILED',
      message: 'Could not attach the photo. Please try again.',
      candidateId: prepared.candidateId,
    };
  }
}

export async function cleanupPreparedDirectImage(
  prepared: PreparedDirectImage | null | undefined,
): Promise<void> {
  if (!prepared) return;
  await cleanupSanitizedImage(prepared.preparedUri);
}

export async function discardPreparedDirectImage(
  prepared: PreparedDirectImage | null | undefined,
): Promise<void> {
  if (!prepared) return;
  await cleanupPreparedDirectImage(prepared);
  await deleteClosetCandidate(createActorRequest(), prepared.candidateId).catch(() => null);
}

export async function promotePreparedDirectImageToCloset(prepared: PreparedDirectImage) {
  const actorRequest = createActorRequest();
  return promoteSelectedClosetCandidates({
    actorId: actorRequest.actorId,
    actorEpoch: actorRequest.epoch,
    batchId: prepared.candidateBatchId,
    candidateIds: [prepared.candidateId],
  });
}
