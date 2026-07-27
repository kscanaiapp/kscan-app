// Image evidence for the Elise header visual-context gallery (IMG-007).
//
// WHY THIS EXISTS: before this module, a header-gallery selection produced a
// local sanitized preview, a `ready` entry titled "Uploaded photo", and nothing
// else. `toServerSafeActiveContext()` strips local URIs by design and the path
// created no remote media backing, so `stylechat-generate` received an entry
// with no category, no colours, no brand and no image reference. The user saw
// their photo in the composer and Elise never saw anything at all.
//
// This module turns that selection into real evidence, reusing the components
// the Scanner and direct-attachment paths already trust:
//
//   sanitized derivative (already produced by the caller)
//     → compressSanitizedImageForAnalysis   896/0.75 JPEG base64, transient
//     → identifyScanImage                   the current scan-identify contract
//     → mapScanIdentifyToAnalysis           the shared Scanner response mapper
//     → resolvePreparedDirectImageAttachment  actor-bound saved scan + private
//                                             media → stable savedScanId
//
// Sequencing note: the Phase 2A.5 brief diagrams staging BEFORE identification.
// This module identifies first and stages second, deliberately. Staging first
// would write a placeholder saved scan and cloud row, then need a second write
// to correct it once identification returned — and a classification failure
// would leave an orphaned row and uploaded media behind. Identifying first
// yields exactly one correct write and no orphans. The properties the brief
// actually requires are preserved: scan-identify runs before anything is
// represented as identified context, and neither a staging failure nor a
// classification failure can produce a `ready`, image-aware-looking entry.
//
// Nothing here sends a local URI, raw EXIF, or base64 to StyleChat. The base64
// derivative exists only for the scan-identify call and is never persisted or
// placed in conversational state.

import {
  compressSanitizedImageForAnalysis,
  PrivacyPrepareError,
} from '../privacyImageUpload';
import { identifyScanImage } from '../scanIdentification';
import { mapScanIdentifyToAnalysis } from '../scanIdentificationMapper';
import { resolvePreparedDirectImageAttachment } from './eliseDirectImageAttachment';
import type { EliseVisualContextInput } from '../../types/eliseVisualContext';

/** Structured, server-safe descriptive fields derived from identification. */
export type VisualContextEvidenceFields = Omit<EliseVisualContextInput, 'source'>;

export type VisualContextEvidenceFailureReason =
  | 'cancelled'
  | 'identification_failed'
  | 'non_fashion'
  | 'staging_failed';

export type VisualContextEvidenceResult =
  | {
      ok: true;
      /** Stable actor-owned reference proving the image has authorized backing. */
      savedScanId: string;
      fields: VisualContextEvidenceFields;
    }
  | {
      ok: false;
      reason: VisualContextEvidenceFailureReason;
      /** User-facing, non-technical. Never claims the image was understood. */
      message: string;
    };

const IDENTIFICATION_FAILED_MESSAGE = 'Could not identify this photo';
const NON_FASHION_MESSAGE = 'No clothing found in this photo';
const STAGING_FAILED_MESSAGE = 'Could not prepare this photo for Elise';
const CANCELLED_MESSAGE = 'Cancelled';

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = trimmedOrNull(value);
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Projects the shared Scanner mapper output onto the server-safe visual-context
 * shape. Only fields the mapper actually produced are populated — an absent
 * attribute stays null rather than becoming an invented default, so Elise is
 * never told something the model did not observe.
 */
export function toVisualContextFields(
  mapped: ReturnType<typeof mapScanIdentifyToAnalysis>,
): VisualContextEvidenceFields | null {
  if (!mapped || mapped.type !== 'fashion') return null;
  const metadata = mapped.metadata ?? ({} as Record<string, never>);

  // The shared mapper flattens primary + secondary colours into one
  // comma-joined string. The visual-context contract wants a real list, so it
  // is split back out rather than sent as a single pseudo-colour.
  const colors = uniqueStrings(
    typeof metadata.color === 'string' ? metadata.color.split(',') : [],
  );
  const materials = uniqueStrings([metadata.materialEstimate, metadata.material]);
  const styleAttributes = uniqueStrings([
    ...(Array.isArray(metadata.styleTags) ? metadata.styleTags : []),
    ...(Array.isArray(metadata.styleDescriptors) ? metadata.styleDescriptors : []),
    metadata.pattern,
    metadata.texture,
    metadata.fit,
    metadata.occasion,
  ]);

  return {
    title:
      trimmedOrNull(mapped.title) ??
      trimmedOrNull(metadata.displayCategory) ??
      trimmedOrNull(metadata.category) ??
      'Photo',
    summary: trimmedOrNull(mapped.result),
    category: trimmedOrNull(metadata.displayCategory) ?? trimmedOrNull(metadata.category),
    colors: colors.length > 0 ? colors : null,
    materials: materials.length > 0 ? materials : null,
    silhouette: trimmedOrNull(metadata.silhouette),
    styleAttributes: styleAttributes.length > 0 ? styleAttributes : null,
    brand: trimmedOrNull(metadata.brand),
    confidence:
      typeof metadata.confidenceScore === 'number' && Number.isFinite(metadata.confidenceScore)
        ? metadata.confidenceScore
        : null,
  };
}

/**
 * Identify a sanitized header-gallery derivative and give it authorized remote
 * backing.
 *
 * Every failure path returns `ok: false`. The caller must not mark an entry
 * ready on any of them — a local preview with no backend evidence is precisely
 * the defect IMG-007 records.
 */
export async function prepareVisualContextEvidence(input: {
  sanitizedUri: string;
  previewUri?: string;
  signal?: AbortSignal;
}): Promise<VisualContextEvidenceResult> {
  const { sanitizedUri, signal } = input;

  if (signal?.aborted) {
    return { ok: false, reason: 'cancelled', message: CANCELLED_MESSAGE };
  }

  // ── 1. Transient analysis derivative ───────────────────────────────────────
  let imageBase64: string;
  try {
    const compressed = await compressSanitizedImageForAnalysis(sanitizedUri);
    imageBase64 = compressed.base64;
  } catch (error) {
    return {
      ok: false,
      reason: 'identification_failed',
      message: error instanceof PrivacyPrepareError ? error.message : IDENTIFICATION_FAILED_MESSAGE,
    };
  }

  if (signal?.aborted) {
    return { ok: false, reason: 'cancelled', message: CANCELLED_MESSAGE };
  }

  // ── 2. The current scan-identify contract, with real image bytes ───────────
  // `localPrivacyFiltered` stays false: the derivative is a metadata-stripping
  // re-encode, which is not face or plate masking and must not be reported as
  // such.
  const response = await identifyScanImage(imageBase64, {
    source: 'upload',
    localPrivacyFiltered: false,
    signal,
  });

  if (signal?.aborted) {
    return { ok: false, reason: 'cancelled', message: CANCELLED_MESSAGE };
  }

  let mapped: ReturnType<typeof mapScanIdentifyToAnalysis>;
  try {
    mapped = mapScanIdentifyToAnalysis(response);
  } catch {
    return {
      ok: false,
      reason: 'identification_failed',
      message: IDENTIFICATION_FAILED_MESSAGE,
    };
  }

  if (mapped.type === 'non-fashion') {
    // A distinct, honest outcome: the backend understood the image and found no
    // garment. Collapsing this into a technical failure would misreport it.
    return {
      ok: false,
      reason: 'non_fashion',
      message: trimmedOrNull(mapped.message) ?? NON_FASHION_MESSAGE,
    };
  }

  const fields = toVisualContextFields(mapped);
  if (!fields || !fields.category) {
    // Completed but with nothing usable to ground a conversation on.
    return {
      ok: false,
      reason: 'identification_failed',
      message: IDENTIFICATION_FAILED_MESSAGE,
    };
  }

  // ── 3. Authorized, actor-bound remote backing ─────────────────────────────
  // Reuses the direct-attachment staging saga: local saveScan under a captured
  // actor request, cloud row upsert scoped to the authenticated user, then
  // private media upload. Ownership is never supplied by this caller.
  const staged = await resolvePreparedDirectImageAttachment(
    {
      previewUri: input.previewUri ?? sanitizedUri,
      preparedUri: sanitizedUri,
      source: 'photo_library',
      operationId: `vctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    },
    {
      title: fields.title,
      category: fields.category,
      signal,
      analysis: mapped,
    },
  );

  if (!staged.ok) {
    return { ok: false, reason: 'staging_failed', message: STAGING_FAILED_MESSAGE };
  }

  const savedScanId =
    staged.resolved.attachmentType === 'owned_item' ? staged.resolved.sourceId : null;
  if (!savedScanId) {
    return { ok: false, reason: 'staging_failed', message: STAGING_FAILED_MESSAGE };
  }

  return { ok: true, savedScanId, fields };
}
