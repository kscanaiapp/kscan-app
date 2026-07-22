// Direct-image attachment preparation for Elise.
// Reuses Scanner-compatible compress + privacy preparation. Does NOT call
// scan-identify merely to manufacture an attachment — creates a saved_scan
// row with private media so V2 can attach owned_item/saved_scan.

import {
  compressForUpload,
  SCANNER_IMAGE_JPEG_QUALITY,
  SCANNER_IMAGE_MAX_WIDTH,
} from '../imageUtils';
import {
  cleanupSanitizedImage,
  prepareImageForPrivacyUpload,
} from '../privacyImageUpload';
import {
  getPrivacySanitizerStatus,
  sanitizeImageBeforeUpload,
} from '../privacyImageSanitizer';
import { saveScan } from '../library';
import { saveScanToCloud } from '../savedScansCloud';
import { ensureSavedScanMediaBacking } from '../savedScanMedia';
import { supabase } from '../supabaseClient';
import {
  STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
  type StyleChatAttachment,
  type StyleChatAttachmentSummary,
} from '../../types/styleChatAttachments';

export type PreparedDirectImage = {
  previewUri: string;
  preparedUri: string;
  dataUri: string;
  width?: number;
  height?: number;
  source: 'camera' | 'photo_library';
  operationId: string;
};

export type DirectImageAttachResult =
  | {
      ok: true;
      resolved: StyleChatAttachment;
      summary: StyleChatAttachmentSummary;
      prepared: PreparedDirectImage;
    }
  | {
      ok: false;
      errorCode: 'PREPARATION_FAILED' | 'UPLOAD_FAILED' | 'RESOLUTION_FAILED';
      message: string;
    };

function newOperationId(): string {
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Prepare a local camera/gallery URI with the accepted Scanner pathway:
 * URI validate → metadata-stripped re-encode (896/0.65) → compressForUpload.
 */
export async function prepareEliseDirectImage(
  localUri: string,
  source: 'camera' | 'photo_library',
): Promise<PreparedDirectImage> {
  if (!localUri || typeof localUri !== 'string') {
    throw new Error('No image selected.');
  }

  const operationId = newOperationId();
  const prepared = await prepareImageForPrivacyUpload(localUri, {
    maxDimension: SCANNER_IMAGE_MAX_WIDTH,
    quality: SCANNER_IMAGE_JPEG_QUALITY,
  });

  // compressForUpload is the Scanner transport helper (896 / 0.65 / JPEG base64).
  const dataUri = await compressForUpload(prepared.sanitizedUri);
  // Keep sanitizer alignment for any downstream callers that expect it.
  const sanitized = await sanitizeImageBeforeUpload(dataUri);
  void getPrivacySanitizerStatus();

  return {
    previewUri: prepared.sanitizedUri,
    preparedUri: prepared.sanitizedUri,
    dataUri: typeof sanitized === 'string' ? sanitized : dataUri,
    width: prepared.width,
    height: prepared.height,
    source,
    operationId,
  };
}

/**
 * Persist a prepared direct image as a cloud-backed saved_scan and return the
 * V2 owned_item attachment. Skips scan-identify.
 */
export async function resolvePreparedDirectImageAttachment(
  prepared: PreparedDirectImage,
  options?: { title?: string; category?: string; signal?: AbortSignal },
): Promise<DirectImageAttachResult> {
  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: 'PREPARATION_FAILED',
      message: 'Attachment cancelled.',
    };
  }

  try {
    const title = (options?.title ?? 'Photo').trim().slice(0, 80) || 'Photo';
    const category = (options?.category ?? 'tops').trim().slice(0, 80) || 'tops';

    const scan = await saveScan({
      photoUri: prepared.preparedUri,
      analysis: {
        result: `${title} — attached for Elise`,
        metadata: { category, color: undefined },
      },
      source: prepared.source === 'camera' ? 'camera' : 'upload',
    });
    if (!scan) {
      return {
        ok: false,
        errorCode: 'UPLOAD_FAILED',
        message: 'Could not save the photo. Please try again.',
      };
    }

    const cloudResult = await saveScanToCloud(scan);
    if (!cloudResult.ok) {
      return {
        ok: false,
        errorCode: 'UPLOAD_FAILED',
        message: 'Could not sync the photo. Please try again.',
      };
    }

    const { data: row } = await supabase
      .from('saved_scans')
      .select('id')
      .eq('local_id', scan.id)
      .is('deleted_at', null)
      .maybeSingle();
    const savedScanId = row?.id as string | undefined;
    if (!savedScanId) {
      return {
        ok: false,
        errorCode: 'RESOLUTION_FAILED',
        message: 'Could not finish attaching the photo. Please try again.',
      };
    }

    const media = await ensureSavedScanMediaBacking({
      savedScanId,
      localImageUri: prepared.preparedUri,
    });
    if (!media.ok) {
      return {
        ok: false,
        errorCode: media.retryable ? 'UPLOAD_FAILED' : 'RESOLUTION_FAILED',
        message: 'Could not prepare the photo for Elise. Please try again.',
      };
    }

    const resolved: StyleChatAttachment = {
      attachmentType: 'owned_item',
      sourceType: 'saved_scan',
      sourceId: savedScanId,
      contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION,
    };

    return {
      ok: true,
      resolved,
      summary: {
        title,
        subtitle: prepared.source === 'camera' ? 'Photo' : 'Photo',
        imageUri: prepared.previewUri,
        itemCount: 1,
      },
      prepared,
    };
  } catch {
    return {
      ok: false,
      errorCode: 'RESOLUTION_FAILED',
      message: 'Could not attach the photo. Please try again.',
    };
  }
}

export async function cleanupPreparedDirectImage(
  prepared: PreparedDirectImage | null | undefined,
): Promise<void> {
  if (!prepared) return;
  await cleanupSanitizedImage(prepared.preparedUri);
}
