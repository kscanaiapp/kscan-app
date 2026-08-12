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
import {
  discardPreparedDirectImage,
  resolvePreparedDirectImageAttachment,
  stageSanitizedEliseDirectImage,
} from './eliseDirectImageAttachment';
import type { EliseVisualContextInput } from '../../types/eliseVisualContext';
import type { FashionIdentificationResultV2 } from '../../types/fashionIdentificationV2';
import { prepareFashionEvidence } from '../fashionEvidenceGateway';
import {
  identifyPreparedImageForStyle,
  type EliseIdentificationTransport,
} from './eliseIdentifyForStyle';
import {
  beginEliseV2Session,
  createEvidenceId,
  type EliseV2SessionFlag,
} from './eliseIdentificationV2';
import { currentIdentificationPlatform } from './eliseDirectImageIdentification';
import { projectV2ToVisualContextFields } from './eliseVisualContextV2Projection';

/** Structured, server-safe descriptive fields derived from identification. */
export type VisualContextEvidenceFields = Omit<EliseVisualContextInput, 'source'>;

export type VisualContextEvidenceFailureReason =
  | 'cancelled'
  | 'identification_failed'
  | 'non_fashion'
  | 'staging_failed';

export type VisualContextEvidenceSuccess = {
  ok: true;
  /** Stable actor-owned local candidate; not a committed Closet item. */
  candidateId: string;
  fields: VisualContextEvidenceFields;
  /**
   * Canonical V2 identity for this reference (Phase 2B.3).
   *
   * Present only when the Elise V2 flag was latched on for this operation AND the
   * backend served the contract. Absent on the legacy path, which is why `fields`
   * remains the display projection for both paths rather than being derived from
   * this.
   */
  identificationV2?: FashionIdentificationResultV2;
  /** `ready` or `partial`, matching the canonical status. */
  identificationState?: 'ready' | 'partial';
};

export type VisualContextEvidenceFailure = {
  ok: false;
  reason: VisualContextEvidenceFailureReason;
  /** User-facing, non-technical. Never claims the image was understood. */
  message: string;
};

export type VisualContextEvidenceResult =
  | VisualContextEvidenceSuccess
  | VisualContextEvidenceFailure;

/**
 * Explicit type predicate rather than a bare `!result.ok` check.
 *
 * Callers use the failure branch inside store-update callbacks, where relying
 * on control-flow narrowing of the boolean discriminant does not survive under
 * this project's compiler settings.
 */
export function isVisualContextEvidenceFailure(
  result: VisualContextEvidenceResult,
): result is VisualContextEvidenceFailure {
  return result.ok === false;
}

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
 * Stages a V2-identified header-gallery reference.
 *
 * Identical staging saga to the legacy branch — the same actor-bound saveScan,
 * the same cloud row, the same private media backing — so the only difference
 * between the two paths is WHICH identity was written, never how ownership or
 * media authorization was obtained.
 *
 * The analysis persisted with the saved scan is projected from the canonical
 * identity rather than from provider prose, so the durable record and the model's
 * grounding describe the same garment.
 */
async function finishVisualContextEvidence(input: {
  identification: FashionIdentificationResultV2 | undefined;
  identificationState: 'ready' | 'partial';
  sanitizedUri: string;
  previewUri?: string;
  signal?: AbortSignal;
}): Promise<VisualContextEvidenceResult> {
  const projected = projectV2ToVisualContextFields(input.identification);
  if (!projected || !input.identification) {
    // Canonical identity with no category AND no subtype cannot title a reference.
    return { ok: false, reason: 'identification_failed', message: IDENTIFICATION_FAILED_MESSAGE };
  }
  const fields: VisualContextEvidenceFields = projected;

  let prepared: Awaited<ReturnType<typeof stageSanitizedEliseDirectImage>>;
  try {
    prepared = await stageSanitizedEliseDirectImage(
      input.sanitizedUri,
      'photo_library',
      input.previewUri,
    );
  } catch {
    return { ok: false, reason: 'staging_failed', message: STAGING_FAILED_MESSAGE };
  }
  const staged = await resolvePreparedDirectImageAttachment(
    prepared,
    {
      title: fields.title,
      category: fields.category as string,
      ...(input.signal ? { signal: input.signal } : {}),
      analysis: {
        result: fields.summary ?? fields.title,
        metadata: {
          category: fields.category,
          ...(fields.colors?.length ? { color: fields.colors.join(', ') } : {}),
          ...(fields.brand ? { brand: fields.brand } : {}),
          ...(fields.materials?.length ? { material: fields.materials[0] } : {}),
          ...(fields.silhouette ? { silhouette: fields.silhouette } : {}),
          ...(fields.styleAttributes?.length ? { styleTags: fields.styleAttributes } : {}),
          ...(fields.confidence !== null ? { confidenceScore: fields.confidence } : {}),
        },
      },
    },
  );

  if (!staged.ok) {
    await discardPreparedDirectImage(prepared);
    return { ok: false, reason: 'staging_failed', message: STAGING_FAILED_MESSAGE };
  }

  return {
    ok: true,
    candidateId: staged.prepared.candidateId,
    fields,
    identificationV2: input.identification,
    identificationState: input.identificationState,
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
  /**
   * Latched once per header-gallery selection by the caller and passed to every
   * image of that selection, so a flag change cannot make image 1 speak V2 while
   * image 4 speaks legacy inside one attachment operation.
   */
  sessionFlag?: EliseV2SessionFlag;
  /** Injected in tests. */
  transport?: EliseIdentificationTransport;
  isCurrent?: () => boolean;
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

  // ── 2a. Phase 2B.3: canonical identification when latched on ───────────────
  // The SAME derivative computed above is reused — nothing is recompressed and no
  // second base64 pass runs, so the bytes detection sees are the bytes the
  // selected-item request re-sends.
  //
  // The header gallery is OUTFIT-ORIENTED: its whole purpose is several references
  // reasoned about together, so a multi-candidate image identifies the bounded set
  // the backend reported rather than demanding a per-garment selection the existing
  // UX has no affordance for.
  const sessionFlag = input.sessionFlag ?? beginEliseV2Session();
  // Populated only when the V2 orchestrator already performed its one permitted
  // legacy retry (UNSUPPORTED_CONTRACT_VERSION). Reused below instead of paying
  // for a third identification of the same bytes.
  let paidLegacyResponse: Awaited<ReturnType<typeof identifyScanImage>> | null = null;
  if (sessionFlag.enabled) {
    const evidence = prepareFashionEvidence({
      preparedImage: imageBase64,
      source: 'header_gallery',
      evidenceId: createEvidenceId(),
    });
    if (evidence) {
      const outcome = await identifyPreparedImageForStyle({
        evidence,
        entryPath: 'header_gallery',
        platform: currentIdentificationPlatform(),
        requestId: evidence.evidenceId,
        sessionFlag,
        policy: 'outfit',
        ...(signal ? { signal } : {}),
        ...(input.transport ? { transport: input.transport } : {}),
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
      });

      if (outcome.state === 'cancelled') {
        return { ok: false, reason: 'cancelled', message: CANCELLED_MESSAGE };
      }
      if (outcome.state === 'non_fashion') {
        return { ok: false, reason: 'non_fashion', message: NON_FASHION_MESSAGE };
      }
      if (outcome.state === 'insufficient_evidence') {
        return { ok: false, reason: 'identification_failed', message: IDENTIFICATION_FAILED_MESSAGE };
      }
      if (outcome.state === 'ready' || outcome.state === 'partial') {
        return finishVisualContextEvidence({
          identification: outcome.identifications[0],
          identificationState: outcome.state,
          sanitizedUri,
          previewUri: input.previewUri,
          signal,
        });
      }
      if (outcome.state === 'technical_failure') {
        // A timeout, 500 or quota failure on a deployment that DOES serve V2
        // says nothing about contract support. Falling through to the legacy
        // envelope here would issue an intentless request the backend defaults
        // to identify_and_shop — a style photo entering the commerce path — and
        // bill a second identification for a transient error. The reference
        // fails retryable instead, exactly like the direct-attachment path.
        return { ok: false, reason: 'identification_failed', message: IDENTIFICATION_FAILED_MESSAGE };
      }
      // `legacy_fallback` (the backend does not implement V2) falls through to
      // the unchanged path below — the ONLY state that does. When the
      // orchestrator already performed its one permitted legacy retry, that
      // paid response is reused rather than re-purchased.
      if (outcome.state === 'legacy_fallback' && outcome.legacyResponse !== undefined) {
        paidLegacyResponse = outcome.legacyResponse;
      }
    }
  }

  // ── 2b. The current scan-identify contract, with real image bytes ──────────
  // `localPrivacyFiltered` stays false: the derivative is a metadata-stripping
  // re-encode, which is not face or plate masking and must not be reported as
  // such.
  const response = paidLegacyResponse ?? await identifyScanImage(imageBase64, {
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
  // Reuses private actor-scoped candidate staging. This creates neither a
  // saved_scan row nor a committed Closet item.
  let prepared: Awaited<ReturnType<typeof stageSanitizedEliseDirectImage>>;
  try {
    prepared = await stageSanitizedEliseDirectImage(
      sanitizedUri,
      'photo_library',
      input.previewUri,
    );
  } catch {
    return { ok: false, reason: 'staging_failed', message: STAGING_FAILED_MESSAGE };
  }
  const staged = await resolvePreparedDirectImageAttachment(
    prepared,
    {
      title: fields.title,
      category: fields.category,
      signal,
      analysis: mapped,
    },
  );

  if (!staged.ok) {
    await discardPreparedDirectImage(prepared);
    return { ok: false, reason: 'staging_failed', message: STAGING_FAILED_MESSAGE };
  }

  return { ok: true, candidateId: staged.prepared.candidateId, fields };
}
