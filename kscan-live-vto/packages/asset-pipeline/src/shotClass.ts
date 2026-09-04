/**
 * Section P1-D2 — supported garment-image input classes.
 *
 * "Class D failure does not block Phase 1." The ranking below encodes that:
 * A and B are the primary supported targets, C is conditional, D is
 * research-grade and allowed to fail without blocking anything downstream.
 */
export type ShotClass = 'A_FLAT_LAY' | 'B_GHOST_MANNEQUIN' | 'C_CLEAN_STUDIO' | 'D_MODEL_WORN';

export const SHOT_CLASS_SUPPORT_LEVEL: Record<ShotClass, 'primary' | 'conditional' | 'research'> = {
  A_FLAT_LAY: 'primary',
  B_GHOST_MANNEQUIN: 'primary',
  C_CLEAN_STUDIO: 'conditional',
  D_MODEL_WORN: 'research',
};

export interface ShotClassificationResult {
  shotClass: ShotClass;
  confidence: number; // [0,1]
}

/**
 * PIPELINE STUB — not a real classifier.
 *
 * Section P1-D3 calls for a real shot-type classification model as the
 * first asset-pipeline stage. No such model is integrated in this session
 * (no vision-model runtime is available in this sandboxed environment,
 * and Section 8.4 forbids sending retailer images to an external
 * vendor-hosted model by default). This function exists purely so the
 * pipeline composition (pipeline.ts) and QC recording (qc.ts) can be
 * built, wired, and tested end-to-end now, with a single, obvious swap
 * point for a real classifier later.
 *
 * It always returns 'unknown-input' framed as the lowest-confidence,
 * research-tier class so nothing downstream can mistake a stub result for
 * a real classification — see `isStubResult`.
 */
export function classifyShotStub(_imageDescriptor: unknown): ShotClassificationResult {
  return { shotClass: 'D_MODEL_WORN', confidence: 0 };
}

export function isStubResult(result: ShotClassificationResult): boolean {
  return result.confidence === 0;
}
