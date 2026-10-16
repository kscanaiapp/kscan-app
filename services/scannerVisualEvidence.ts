/** Scanner-owned evidence producer interface. No OCR/logo classifier is installed. */
type Region = { x: number; y: number; width: number; height: number };
export type ScannerVisualEvidenceInput = {
  /** SHA-256 prefix of the exact sanitized, prepared base64 bytes sent to identify. */
  sourceImageDigest: string;
  selectedCandidate?: { candidateId: string; category?: string; subtype?: string; bounds?: Region };
  /** Supply only after the actual sanitizer returns a protected derivative. */
  privacy?: { state: 'sanitized' | 'unknown'; metadataRemoved: boolean };
};
const clean = (value: unknown, max = 100) => typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : null;
function bounds(value: Region | undefined): Region | null {
  if (!value) return null;
  if (![value.x, value.y, value.width, value.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  if (value.width <= 0 || value.height <= 0 || value.x + value.width > 1.000001 || value.y + value.height > 1.000001) return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

/**
 * Versioned extension to the existing transport, never another recognizer.
 * Unknowns remain explicit. Selection context comes from the existing candidate;
 * local OCR/logo observations stay empty until a real adapter is implemented.
 * Privacy state is descriptive; it never authorizes network transmission.
 */
export function buildScannerVisualEvidence(input: ScannerVisualEvidenceInput): Record<string, unknown> | null {
  if (!input || !/^[a-f0-9]{12}$/.test(input.sourceImageDigest)) return null;
  const selected = input.selectedCandidate;
  const candidateId = clean(selected?.candidateId, 120);
  if (selected && !candidateId) return null;
  const region = bounds(selected?.bounds);
  if (selected?.bounds && !region) return null;
  return {
    version: 1,
    sourceImageDigest: input.sourceImageDigest,
    candidateId,
    region,
    privacy: { state: input.privacy?.state === 'sanitized' ? 'sanitized' : 'unknown', metadataRemoved: input.privacy?.metadataRemoved === true, verification: 'client_attested' },
    producer: { method: 'none', id: null, version: null, independentlyVerified: false },
    observations: {
      category: clean(selected?.category), subtype: clean(selected?.subtype), wordmarks: [], logos: [],
      attributes: { primaryColor: null, secondaryColors: [], material: null, texture: null, pattern: null, silhouette: null, construction: [], hardware: [], distinguishingDetails: [] },
    },
    warnings: ['local_ocr_unavailable', 'local_logo_classifier_unavailable'],
  };
}

/** Capability disclosure: these values must not be inferred from model output. */
export const SCANNER_LOCAL_EVIDENCE_CAPABILITIES = Object.freeze({
  onDeviceOcr: false,
  independentlyVerifiedLogoClassifier: false,
  localMaterialClassifier: false,
  localVisualEmbeddings: false,
  selectionContext: true,
});
