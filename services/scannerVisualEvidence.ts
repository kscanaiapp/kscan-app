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

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): string[] => Array.isArray(value) ? value.slice(0, 8).map(v => clean(v)).filter((v): v is string => v !== null) : [];
function normalizeAttributes(value: unknown) {
  const src = record(value);
  return { category: clean(src.category), subtype: clean(src.subtype), primaryColor: clean(src.primaryColor), secondaryColors: list(src.secondaryColors), material: clean(src.material), texture: clean(src.texture), pattern: clean(src.pattern), silhouette: clean(src.silhouette), construction: list(src.construction), hardware: list(src.hardware), distinguishingDetails: list(src.distinguishingDetails) };
}

/** Preserve advisory observations without turning server/model wording into independent proof. */
export function normalizeScannerVisualEvidenceResponse(value: unknown, binding: { sourceImageDigest: string; candidateId?: string | null }): Record<string, unknown> | undefined {
  const src = record(value);
  if (src.version !== 1 || !/^[a-f0-9]{12}$/.test(binding.sourceImageDigest)) return undefined;
  const sameSource = (v: Record<string, unknown>) => v.version === 1 && v.sourceImageDigest === binding.sourceImageDigest;
  const normalizeModel = (value: unknown, expected?: string | null) => {
    const item = record(value);
    if (!sameSource(item) || record(item.provenance).method !== 'vision_model') return null;
    const candidateId = clean(item.candidateId, 120);
    if (expected !== undefined && candidateId !== expected) return null;
    const modelRegion = item.region == null ? null : bounds(item.region as Region);
    if (item.region != null && !modelRegion) return null;
    return {
      version: 1, sourceImageDigest: binding.sourceImageDigest, candidateId, region: modelRegion,
      provenance: { method: 'vision_model', independentlyVerified: false },
      observedWordmark: clean(item.observedWordmark, 60), logoDetected: item.logoDetected === true,
      logoDescription: clean(item.logoDescription), logoBrandHypothesis: clean(item.logoBrandHypothesis, 60),
      logoConfidence: ['high', 'medium', 'low'].includes(String(item.logoConfidence)) ? item.logoConfidence : null,
      uncertainty: { conflictingBrandSignals: record(item.uncertainty).conflictingBrandSignals === true, qualityNote: clean(record(item.uncertainty).qualityNote) },
      attributes: normalizeAttributes(item.attributes),
    };
  };
  const interpretation = normalizeModel(src.interpretation, binding.candidateId);
  if (!interpretation) return undefined;
  const seen = new Set<string>();
  const items = Array.isArray(src.items) ? src.items.slice(0, 5).flatMap(value => {
    const item = normalizeModel(value);
    if (!item?.candidateId || seen.has(item.candidateId)) return [];
    seen.add(item.candidateId);
    return [item];
  }) : undefined;
  // Retain only input binding/capability/attribute summaries. Detailed advisory
  // OCR/mark strings are omitted from mobile hydration, never re-certified here.
  const supplied = record(src.input);
  const producer = record(supplied.producer);
  const inputPrivacy = record(supplied.privacy);
  const input = sameSource(supplied) && clean(supplied.candidateId, 120) === interpretation.candidateId ? {
    version: 1, sourceImageDigest: binding.sourceImageDigest, candidateId: interpretation.candidateId,
    region: supplied.region == null ? null : bounds(supplied.region as Region),
    privacy: { state: inputPrivacy.state === 'sanitized' ? 'sanitized' : 'unknown', metadataRemoved: inputPrivacy.metadataRemoved === true, verification: 'client_attested' },
    producer: { method: ['none', 'local_ocr', 'local_logo_classifier'].includes(String(producer.method)) ? producer.method : 'none', id: clean(producer.id, 60), version: clean(producer.version, 30), independentlyVerified: false },
    observations: { category: clean(record(supplied.observations).category), subtype: clean(record(supplied.observations).subtype), attributes: normalizeAttributes(record(supplied.observations).attributes) },
    warnings: list(supplied.warnings),
    detailedSignalsRetained: false,
  } : null;
  return { version: 1, input, interpretation, ...(items ? { items } : {}) };
}
