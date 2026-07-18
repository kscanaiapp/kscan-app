import type {
  DetectedGarment,
  ScanIdentifyResponse,
  ScanSelectedCandidate,
} from '../types/scanIdentification';

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
};

export type MultiScanCandidate = {
  id: string;
  sourceImageId: string;
  sourceImageIndex: number;
  sourceImageUri: string;
  source: ScanImageSource;
  preparedImage: string;
  garment: DetectedGarment | null;
  selectedCandidate: ScanSelectedCandidate | null;
  detectionResponse: ScanIdentifyResponse;
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
          garment,
          selectedCandidate: {
            candidateId: garment.candidateId,
            category: garment.category,
            subtype: garment.subtype,
            ...(garment.bounds ? { bounds: garment.bounds } : {}),
          },
          detectionResponse: batch.response,
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
