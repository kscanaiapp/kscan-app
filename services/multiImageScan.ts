import type {
  DetectedGarment,
  ScanIdentifyResponse,
  ScanSelectedCandidate,
} from '../types/scanIdentification';
import type { FashionIdentificationResultV2 } from '../types/fashionIdentificationV2';
import type { PreparedScannerEvidence } from './scannerEvidenceGateway';
import type { ScannerCandidateCorrelation } from './scannerIdentificationV2';

export const MAX_SCAN_IMAGES = 5;
export const MAX_MULTI_SCAN_ITEMS = 5;

export type ScanImageSource = 'camera' | 'upload' | 'fixture';

export type ScanImageSelection = {
  id: string;
  uri: string;
  source: ScanImageSource;
  originalIndex: number;
  qaFixtureName?: string;
};

export type DetectionBatchResult = {
  image: ScanImageSelection;
  response: ScanIdentifyResponse;
  preparedImage: string;
  /** True only when a real local privacy filter ran on this prepared image. */
  preparedPrivacyFiltered?: boolean;
  /** Phase 2B.2 evidence this image's candidates were detected in. */
  evidence?: PreparedScannerEvidence;
  evidenceId?: string;
  identificationV2?: FashionIdentificationResultV2 | null;
  /** Server-issued V2 candidate correlation for this evidence only. */
  v2Candidates?: ScannerCandidateCorrelation[];
  contractPath?: 'v2' | 'legacy';
};

export type MultiScanCandidate = {
  id: string;
  sourceImageId: string;
  sourceImageIndex: number;
  sourceImageUri: string;
  source: ScanImageSource;
  preparedImage: string;
  /** Privacy posture of the prepared image, reused verbatim by selected_item. */
  preparedPrivacyFiltered?: boolean;

  garment: DetectedGarment | null;
  selectedCandidate: ScanSelectedCandidate | null;
  detectionResponse: ScanIdentifyResponse;
  /**
   * Phase 2B.2 correlation, bound to the evidence this candidate was detected
   * in. Absent on the legacy path.
   *
   * This is what makes multi-image selection safe: a candidate carries the
   * identity of ITS OWN source image, so selecting it can never reach for
   * another image's derivative or another image's evidence id. Array position
   * is never used as identity.
   */
  evidence?: PreparedScannerEvidence;
  v2Correlation?: ScannerCandidateCorrelation | null;
};

export type MultiScanItem = Omit<MultiScanCandidate, 'preparedImage'> & {
  label: string;
  analysis: Record<string, unknown>;
  detailStatus: 'complete' | 'partial';
};

function safeUri(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001F]/.test(trimmed)) return null;
  return trimmed;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function normalizeImageSelections(
  assets: ReadonlyArray<{ uri?: unknown; assetId?: unknown; qaFixtureName?: unknown }>,
  source: ScanImageSource,
  existing: ReadonlyArray<ScanImageSelection> = [],
): ScanImageSelection[] {
  if (!Array.isArray(assets)) throw new Error('INVALID_IMAGE_SELECTION');
  const out = [...existing];
  const seen = new Set(existing.map((image) => image.uri));

  for (const asset of assets) {
    const uri = safeUri(asset?.uri);
    if (!uri) throw new Error('MALFORMED_IMAGE');
    if (seen.has(uri)) continue;
    if (out.length >= MAX_SCAN_IMAGES) throw new Error('TOO_MANY_IMAGES');
    const suppliedId = typeof asset.assetId === 'string' && asset.assetId.trim()
      ? asset.assetId.trim().slice(0, 80)
      : null;
    out.push({
      id: suppliedId || `image-${out.length + 1}-${stableHash(uri)}`,
      uri,
      source,
      originalIndex: out.length,
      ...(typeof asset.qaFixtureName === 'string' && asset.qaFixtureName.trim()
        ? { qaFixtureName: asset.qaFixtureName.trim().slice(0, 80) }
        : {}),
    });
    seen.add(uri);
  }

  if (out.length === 0) throw new Error('EMPTY_IMAGE_SELECTION');
  return out;
}

export function removeImageSelection(
  images: ReadonlyArray<ScanImageSelection>,
  imageId: string,
): ScanImageSelection[] {
  return images
    .filter((image) => image.id !== imageId)
    .map((image, index) => ({ ...image, originalIndex: index }));
}

function candidateFingerprint(imageId: string, garment: DetectedGarment): string {
  const bounds = garment.bounds
    ? [garment.bounds.x, garment.bounds.y, garment.bounds.width, garment.bounds.height]
      .map((value) => value.toFixed(3))
      .join(':')
    : 'no-bounds';
  return [imageId, garment.category, garment.subtype, bounds].join('|').toLowerCase();
}

/**
 * Builds the immutable selection tuple for one detected garment.
 *
 * The category and bounds come from DETECTION — they are not re-derived or
 * reclassified, because doing so would be the client guessing at which garment
 * the user picked. The detection digest is echoed only when the server actually
 * issued one for this exact candidate under this exact evidence id.
 */
function correlationForGarment(
  evidenceId: string,
  garment: DetectedGarment,
  v2Candidates: ReadonlyArray<ScannerCandidateCorrelation> | undefined,
): ScannerCandidateCorrelation {
  const match = Array.isArray(v2Candidates)
    ? v2Candidates.find(
      (candidate) =>
        candidate.candidateId === garment.candidateId && candidate.evidenceId === evidenceId,
    )
    : undefined;
  return {
    evidenceId,
    candidateId: garment.candidateId,
    category: match?.category ?? garment.category,
    ...(match?.subtype ?? garment.subtype ? { subtype: match?.subtype ?? garment.subtype } : {}),
    ...(match?.bounds ?? garment.bounds ? { bounds: match?.bounds ?? garment.bounds } : {}),
    ...(match?.detectionDigest ? { detectionDigest: match.detectionDigest } : {}),
  };
}

/**
 * Flattens per-image v119 detection responses in stable image/garment order.
 * The global five-item cap prevents a five-image request from expanding into
 * an unbounded result surface. No candidate is invented for empty responses.
 */
export function buildMultiScanCandidates(
  batches: ReadonlyArray<DetectionBatchResult>,
): MultiScanCandidate[] {
  const out: MultiScanCandidate[] = [];
  const seen = new Set<string>();

  for (const batch of batches) {
    const garments = batch.response.detectedGarments;
    if (Array.isArray(garments) && garments.length > 0) {
      for (const garment of garments) {
        const fingerprint = candidateFingerprint(batch.image.id, garment);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        out.push({
          id: `${batch.image.id}:${garment.candidateId}`,
          sourceImageId: batch.image.id,
          sourceImageIndex: batch.image.originalIndex,
          sourceImageUri: batch.image.uri,
          source: batch.image.source,
          preparedImage: batch.preparedImage,
          preparedPrivacyFiltered: batch.preparedPrivacyFiltered === true,
          garment,
          selectedCandidate: {
            candidateId: garment.candidateId,
            category: garment.category,
            subtype: garment.subtype,
            ...(garment.bounds ? { bounds: garment.bounds } : {}),
          },
          detectionResponse: batch.response,
          ...(batch.evidence ? { evidence: batch.evidence } : {}),
          // Prefer the server's own V2 candidate record for this candidateId.
          // The detection digest is taken ONLY from it — never computed, never
          // copied from another evidence id, never substituted with a session
          // id. When the backend supplies no V2 candidate row, the correlation
          // is still bound to this image's evidence, and the digest simply
          // stays absent rather than being invented.
          ...(batch.evidenceId
            ? {
              v2Correlation: correlationForGarment(
                batch.evidenceId,
                garment,
                batch.v2Candidates,
              ),
            }
            : {}),
        });
        if (out.length >= MAX_MULTI_SCAN_ITEMS) return out;
      }
      continue;
    }

    // A legacy server may return a complete single-item response without the
    // additive detectedGarments field. Preserve that real response as one item.
    if (
      batch.response.detectedGarments === undefined &&
      batch.response.status === 'completed' &&
      batch.response.attributes
    ) {
      out.push({
        id: `${batch.image.id}:legacy`,
        sourceImageId: batch.image.id,
        sourceImageIndex: batch.image.originalIndex,
        sourceImageUri: batch.image.uri,
        source: batch.image.source,
        preparedImage: batch.preparedImage,
        preparedPrivacyFiltered: batch.preparedPrivacyFiltered === true,
        garment: null,
        selectedCandidate: null,
        detectionResponse: batch.response,
      });
      if (out.length >= MAX_MULTI_SCAN_ITEMS) return out;
    }
  }

  return out;
}

export function candidateLabel(candidate: MultiScanCandidate): string {
  if (candidate.garment?.label) return candidate.garment.label;
  return candidate.detectionResponse.identification?.visual_observation
    || candidate.detectionResponse.attributes?.itemType
    || candidate.detectionResponse.attributes?.category
    || 'Detected fashion item';
}

export type ScanItemQueueState = 'queued' | 'analyzing' | 'ready' | 'failed';

export type CandidateReviewDescriptor = {
  id: string;
  label: string;
  category: string | null;
  subtype: string | null;
  primaryColor: string | null;
  sourceImageIndex: number;
  sourceImageId: string;
};

/**
 * Projection of a candidate for the deliberate review surface. Uses only
 * detection metadata — rendering this requires zero commerce work.
 */
export function candidateReviewDescriptor(
  candidate: MultiScanCandidate,
): CandidateReviewDescriptor {
  const identification = candidate.garment?.identification
    ?? candidate.detectionResponse.identification
    ?? {};
  const attributes = candidate.garment?.attributes
    ?? candidate.detectionResponse.attributes
    ?? {};
  const primaryColor = identification.primary_color
    || (Array.isArray(attributes.colorPalette) ? attributes.colorPalette[0] : null)
    || null;
  return {
    id: candidate.id,
    label: candidateLabel(candidate),
    category: candidate.garment?.category || attributes.category || null,
    subtype: candidate.garment?.subtype || identification.subtype || null,
    primaryColor,
    sourceImageIndex: candidate.sourceImageIndex,
    sourceImageId: candidate.sourceImageId,
  };
}
