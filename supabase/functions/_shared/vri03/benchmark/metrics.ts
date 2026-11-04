/**
 * VRI-03 benchmark metrics — the owner's four acceptance criteria.
 *
 *   1. Item identification (per stratum, incl. multi-object target selection)
 *   2. Candidate recall in retrieved candidates and in shown results, with
 *      exact-match recall reported separately
 *   3. Fabrication audit: shown results must trace to the recorded provider /
 *      catalog pool; ownership labels only on rows eligible at capture time
 *   4. Latency p95 and Gemini cost per scan (from usageMetadata via the ledger)
 *
 * Inputs are per-item run records. Human labels on retrieved results come from
 * the collection kit's results-labeling sheet. Nothing here infers a label.
 *
 * Offline and pure.
 */

export type MatchLabel = 'exact_match' | 'visually_similar_acceptable' | 'wrong_category' | 'no_result' | 'unlabeled';

export type LabeledResult = {
  /** Canonical product URL (tracking stripped), the join key for the audit. */
  canonicalUrl: string;
  merchant: string;
  label: MatchLabel;
  /** Present only on Black-owned discovery results that carry a label. */
  ownershipRowId?: string | null;
};

export type ItemRun = {
  itemId: string;
  strata: { scene: 'single_object' | 'multi_object'; type: 'garment' | 'accessory' };
  identification: {
    categoryCorrect: boolean;
    itemCorrect: boolean;
    /** multi_object only: did the scan analyze the human-named target? */
    targetSelectedCorrect: boolean | null;
  };
  /** Every candidate the providers/catalog returned before filtering (labeled). */
  candidates: LabeledResult[];
  /** Final shelf shown to the user (labeled, top 10). */
  shown: LabeledResult[];
  /** Raw recorded provider pool + Black-owned catalog snapshot rows (canonical URLs). */
  recordedPoolUrls: string[];
  /** Catalog row ids eligible for an ownership label at capture time. */
  eligibleOwnershipRowIds: string[];
  /** Scan start → first shelf rendered, measured by the harness clock. */
  scanToResultsMs: number | null;
  /** Gemini cost for this scan, summed from settled ledger entries. */
  geminiCostUsd: number | null;
  /** True if any ledger entry for this scan was charged worst case (no usage). */
  costFromWorstCase: boolean;
  providerCalls: number;
};

const ACCEPTABLE: ReadonlySet<MatchLabel> = new Set(['exact_match', 'visually_similar_acceptable']);

export function p95(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil(0.95 * v.length) - 1)];
}

function rate(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

function recallOf(items: readonly ItemRun[]) {
  const n = items.length;
  const anyCand = items.filter((i) => i.candidates.some((c) => ACCEPTABLE.has(c.label))).length;
  const exactCand = items.filter((i) => i.candidates.some((c) => c.label === 'exact_match')).length;
  const anyShown = items.filter((i) => i.shown.some((c) => ACCEPTABLE.has(c.label))).length;
  const exactShown = items.filter((i) => i.shown.some((c) => c.label === 'exact_match')).length;
  const unlabeled = items.reduce((s, i) => s + [...i.candidates, ...i.shown].filter((c) => c.label === 'unlabeled').length, 0);
  // Exact and visually-similar are reported as disjoint buckets as well, so a
  // similar-match gain can never be read as (or mask) an exact-match change.
  return {
    n,
    /** exact OR visually-similar-acceptable (union) */
    candidateAcceptable: rate(anyCand, n),
    candidateExact: rate(exactCand, n),
    /** visually-similar-acceptable present AND no exact match (disjoint from exact) */
    candidateSimilarOnly: rate(anyCand - exactCand, n),
    shownAcceptable: rate(anyShown, n),
    shownExact: rate(exactShown, n),
    shownSimilarOnly: rate(anyShown - exactShown, n),
    unlabeledResults: unlabeled,
  };
}

function identificationOf(items: readonly ItemRun[]) {
  const multi = items.filter((i) => i.strata.scene === 'multi_object');
  return {
    n: items.length,
    categoryCorrect: rate(items.filter((i) => i.identification.categoryCorrect).length, items.length),
    itemCorrect: rate(items.filter((i) => i.identification.itemCorrect).length, items.length),
    multiObjectTargetSelected: rate(multi.filter((i) => i.identification.targetSelectedCorrect === true).length, multi.length),
  };
}

/** Criterion 3. A violation is a fact about the record, not a judgment. */
export function auditFabrication(items: readonly ItemRun[]) {
  let unsourcedShown = 0;
  let ineligibleOwnershipLabels = 0;
  let shownChecked = 0;
  let ownershipLabelsChecked = 0;
  const violations: { itemId: string; kind: 'unsourced_result' | 'ineligible_ownership_label'; canonicalUrl: string }[] = [];
  for (const item of items) {
    const pool = new Set(item.recordedPoolUrls);
    const eligible = new Set(item.eligibleOwnershipRowIds);
    for (const r of item.shown) {
      shownChecked++;
      if (!pool.has(r.canonicalUrl)) {
        unsourcedShown++;
        violations.push({ itemId: item.itemId, kind: 'unsourced_result', canonicalUrl: r.canonicalUrl });
      }
      if (r.ownershipRowId) {
        ownershipLabelsChecked++;
        if (!eligible.has(r.ownershipRowId)) {
          ineligibleOwnershipLabels++;
          violations.push({ itemId: item.itemId, kind: 'ineligible_ownership_label', canonicalUrl: r.canonicalUrl });
        }
      }
    }
  }
  return { shownChecked, ownershipLabelsChecked, unsourcedShown, ineligibleOwnershipLabels, violations, pass: violations.length === 0 };
}

export class CohortError extends Error {
  constructor(message: string) {
    super(`VRI-03 cohort: ${message}`);
    this.name = 'CohortError';
  }
}

/**
 * One result per item, matching the expected item list exactly. Duplicate,
 * missing or extra results make the arm unusable rather than silently skewed.
 */
export function validateCohort(arm: string, items: readonly ItemRun[], expectedItemIds?: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.itemId)) problems.push(`${arm}: duplicate result for ${i.itemId}`);
    seen.add(i.itemId);
  }
  if (expectedItemIds) {
    const expected = new Set(expectedItemIds);
    if (expected.size !== expectedItemIds.length) problems.push(`${arm}: expected item list has duplicates`);
    for (const id of expected) if (!seen.has(id)) problems.push(`${arm}: missing result for ${id}`);
    for (const id of seen) if (!expected.has(id)) problems.push(`${arm}: unexpected result for ${id}`);
  }
  return problems;
}

export function computeArmMetrics(arm: string, items: readonly ItemRun[], expectedItemIds?: readonly string[]) {
  const cohortProblems = validateCohort(arm, items, expectedItemIds);
  if (cohortProblems.length) throw new CohortError(cohortProblems.join('; '));
  const strataKeys = [
    ['single_object', (i: ItemRun) => i.strata.scene === 'single_object'],
    ['multi_object', (i: ItemRun) => i.strata.scene === 'multi_object'],
    ['garment', (i: ItemRun) => i.strata.type === 'garment'],
    ['accessory', (i: ItemRun) => i.strata.type === 'accessory'],
  ] as const;
  const byStratum: Record<string, { identification: ReturnType<typeof identificationOf>; recall: ReturnType<typeof recallOf> }> = {};
  for (const [k, pred] of strataKeys) {
    const sub = items.filter(pred);
    byStratum[k] = { identification: identificationOf(sub), recall: recallOf(sub) };
  }
  const latencies = items.map((i) => i.scanToResultsMs).filter((x): x is number => x !== null);
  const costs = items.map((i) => i.geminiCostUsd).filter((x): x is number => x !== null);
  const anyWorstCase = items.some((i) => i.costFromWorstCase);
  return {
    arm,
    n: items.length,
    itemIds: items.map((i) => i.itemId).sort(),
    identification: identificationOf(items),
    recall: recallOf(items),
    byStratum,
    fabrication: auditFabrication(items),
    latency: {
      scanToResultsP95Ms: p95(latencies),
      measured: latencies.length,
      status: latencies.length === items.length && items.length > 0 ? 'MEASURED' : 'INSUFFICIENT_EVIDENCE',
    },
    cost: {
      geminiMeanUsdPerScan: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      geminiP95UsdPerScan: p95(costs),
      status: costs.length === items.length && items.length > 0 && !anyWorstCase ? 'MEASURED' : 'INSUFFICIENT_EVIDENCE',
      providerCallsTotal: items.reduce((s, i) => s + i.providerCalls, 0),
      providerCostStatus: 'INSUFFICIENT_EVIDENCE' as const,
    },
  };
}

export type ArmMetrics = ReturnType<typeof computeArmMetrics>;

/**
 * Keep/revert rule for one change versus its baseline. A change is KEPT only
 * if it wins on recall without any of the guarded regressions. Anything
 * unmeasured cannot be kept.
 */
export function decideKeep(before: ArmMetrics, after: ArmMetrics, limits = { latencyPct: 5, costPct: 5 }) {
  const reasons: string[] = [];
  const b = before.recall, a = after.recall;
  if (before.n === 0) reasons.push('baseline cohort is empty');
  if (before.itemIds.join('\n') !== after.itemIds.join('\n')) reasons.push('baseline and treatment item IDs differ');
  if (!before.fabrication.pass) reasons.push('baseline fabrication audit failed (comparison is untrustworthy)');
  if (a.unlabeledResults > 0 || b.unlabeledResults > 0) reasons.push('unlabeled results remain');
  if (a.shownAcceptable === null || b.shownAcceptable === null || !(a.shownAcceptable > b.shownAcceptable)) {
    reasons.push('no gain in shown acceptable-match recall');
  }
  if (a.shownExact !== null && b.shownExact !== null && a.shownExact < b.shownExact) reasons.push('exact-match recall regressed');
  if (a.candidateExact !== null && b.candidateExact !== null && a.candidateExact < b.candidateExact) {
    reasons.push('exact-match candidate recall regressed');
  }
  for (const k of ['single_object', 'multi_object', 'garment', 'accessory']) {
    const be = before.byStratum[k]?.recall.shownExact, ae = after.byStratum[k]?.recall.shownExact;
    if (be !== null && be !== undefined && ae !== null && ae !== undefined && ae < be) reasons.push(`exact-match recall regressed in ${k}`);
  }
  if ((after.identification.categoryCorrect ?? 0) < (before.identification.categoryCorrect ?? 0)) reasons.push('category identification regressed');
  if (!after.fabrication.pass) reasons.push('fabrication audit failed');
  const lb = before.latency.scanToResultsP95Ms, la = after.latency.scanToResultsP95Ms;
  if (before.latency.status !== 'MEASURED' || after.latency.status !== 'MEASURED' || lb === null || la === null) reasons.push('latency unmeasured');
  else if (la > lb * (1 + limits.latencyPct / 100)) reasons.push(`latency p95 +${(((la - lb) / lb) * 100).toFixed(1)}% exceeds +${limits.latencyPct}%`);
  const cb = before.cost.geminiMeanUsdPerScan, ca = after.cost.geminiMeanUsdPerScan;
  if (before.cost.status !== 'MEASURED' || after.cost.status !== 'MEASURED' || cb === null || ca === null) reasons.push('Gemini cost unmeasured');
  else if (cb > 0 && ca > cb * (1 + limits.costPct / 100)) reasons.push(`Gemini cost +${(((ca - cb) / cb) * 100).toFixed(1)}% exceeds +${limits.costPct}%`);
  return { keep: reasons.length === 0, decision: reasons.length === 0 ? 'KEPT' as const : 'REVERTED' as const, reasons };
}
