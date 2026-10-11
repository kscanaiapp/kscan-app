/**
 * What a failed scan may still offer (P-ERR-1).
 *
 * The failed-analysis screen withholds "Add Scan to Dressing Room" unless there is
 * a usable analyzed item, so the app never offers to keep a scan it just reported
 * as failed. An emptiness check on the analysis object is not enough to decide
 * that: when the selected garment's analysis fails, useKScan puts the DETECTION
 * result back (it is what Try Again resumes from). That object has a summary and
 * a category, so it read as usable and the screen offered to add "this scan" to a
 * Dressing Room from a screen saying the analysis had failed, with the detection's
 * metadata standing in for the garment that was never analyzed.
 *
 * A detection result is a list of garments to choose from, not an analyzed item:
 * it carries confirmation candidates and is not marked as a selected garment's
 * result (see services/scanResultStep.ts for the same distinction on the result
 * sheet).
 *
 * Pure and dependency-free, so the source-level tests can load it.
 */
export type FailedScanAnalysisLike = {
  result?: unknown;
  type?: unknown;
  metadata?: { category?: unknown } | null;
  products?: unknown;
  confirmationCandidates?: unknown;
  selectedItemResult?: unknown;
} | null | undefined;

export function hasUsableAnalyzedItem(analysis: FailedScanAnalysisLike): boolean {
  if (!analysis || typeof analysis !== 'object') return false;

  const isDetectionOnly =
    Array.isArray(analysis.confirmationCandidates) &&
    analysis.confirmationCandidates.length > 0 &&
    analysis.selectedItemResult !== true;
  if (isDetectionOnly) return false;

  // Concrete fields, never object truthiness: an empty object ({}) is truthy.
  return Boolean(
    analysis.result ||
      analysis.metadata?.category ||
      (Array.isArray(analysis.products) && analysis.products.length) ||
      analysis.type === 'non-fashion',
  );
}
