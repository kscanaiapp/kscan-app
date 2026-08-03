/**
 * Product Match V1 — ADVISORY similarity against the user's own items.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THIS MODULE MUST NEVER BECOME DEDUPLICATION. Read this before editing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dedupe.ts` and this file look superficially similar and are governed by
 * opposite rules, because they carry opposite risks.
 *
 *   dedupe.ts            "are these two RETAILER LISTINGS the same product?"
 *                        wrong answer costs: a duplicate row in a result list
 *                        may therefore: merge, collapse, pick a winner
 *
 *   closetSimilarity.ts  "is what you just scanned something you ALREADY OWN?"
 *                        wrong answer costs: the user loses an item they wanted
 *                        may therefore: point it out, and nothing else
 *
 * Concretely, and permanently:
 *   - the output field is `potentialSimilarItem: true`. There is no
 *     `isDuplicate`, and adding one is a breaking change to the safety model.
 *   - nothing is merged, replaced, hidden or deleted here or downstream
 *   - both records keep existing unless the USER chooses otherwise
 *   - `resolution` is always `user_required` — the backend reports, the person
 *     decides
 *   - every one of the six actions is always offered; this module never decides
 *     that an action is inapplicable
 *
 * A high `advisoryConfidence` is not permission to act. It orders candidates so
 * the most likely one is shown first, and that is its entire job.
 *
 * NO DATABASE ACCESS. Candidates are passed in by the caller, who owns the
 * closet and the recent-scan list. That keeps this endpoint free of user-scoped
 * reads and makes the comparison testable without a database.
 *
 * ── CHECKPOINT 4 ─────────────────────────────────────────────────────────────
 *
 * Checkpoint 3 shipped a single flat gate (`reasonsAreSufficient`: two named
 * agreements, at least one non-weak). It is KEPT, unchanged, as a standalone,
 * independently tested utility — but the operative decision inside
 * `classifySimilarItems` is now the versioned, source/evidence/category/
 * coverage/image-aware threshold model in `similarityThresholds.ts`. Every
 * outcome the old gate produced on the Checkpoint 3 governed fixtures is
 * preserved (see the margin notes in that file); the new gate is additionally
 * able to REFUSE a comparison the old flat gate would have allowed — a
 * uniform t-shirt, a barcode mismatch, a different category entirely — which
 * the old gate had no vocabulary for.
 *
 * Checkpoint 4 also adds CONFLICT signals (`ConflictReason`) alongside the
 * existing agreement signals. `identifier_conflict` and `category_conflict`
 * are structural: either one present means no notice is produced at all, full
 * stop, regardless of how many attributes otherwise agree. The rest are soft:
 * they lower the score but a real product can legitimately vary this way (the
 * same shoe, a different colourway), so they do not block a notice outright.
 */

import type {
  ConflictReason,
  ExistingItemCandidate,
  PotentialSimilarItem,
  ProductMatchQuery,
  SimilarityInternalDebug,
  SimilarityReason,
  SimilarityScanIdentity,
} from './contracts.ts';
import { SIMILAR_ITEM_ACTIONS } from './contracts.ts';
import {
  canonicalizeProductUrl,
  contentTokens,
  normalizeBrand,
  normalizeColor,
  normalizeText,
  slugify,
} from './identity.ts';
import {
  capClassification,
  categoryFamilyOf,
  coverageOf,
  resolveThresholds,
  type CategoryFamily,
  type EvidenceMode,
  type ImageAvailability,
  type MetadataCoverage,
  type SimilarityClassification,
  type ThresholdOverrides,
} from './similarityThresholds.ts';

/**
 * Weight per POSITIVE reason. Used to order candidates and, since Checkpoint
 * 4, to compute the net score compared against `similarityThresholds.ts`.
 *
 * `authoritative_identifier_match` outranks `shared_product_url` — a caller-
 * normalized GTIN/SKU/style-code agreement is not sensitive to the item being
 * relisted at a different URL, so it is the stronger of the two identity
 * claims. Both remain advisory: see the module header.
 */
const REASON_WEIGHTS: Record<SimilarityReason, number> = {
  authoritative_identifier_match: 0.65,
  shared_product_url: 0.60,
  same_brand: 0.20,
  same_model_tokens: 0.20,
  same_normalized_color: 0.12,
  same_canonical_category: 0.10,
  same_material: 0.06,
  same_silhouette: 0.06,
  same_pattern: 0.04,
};

/** Weight subtracted per SOFT conflict. Structural conflicts are not scored
 *  here — they veto the comparison entirely before a score is ever computed;
 *  see `classifySimilarItems`. */
const SOFT_CONFLICT_WEIGHTS: Partial<Record<ConflictReason, number>> = {
  different_model_family: 0.18,
  different_silhouette: 0.10,
  different_colorway: 0.06,
  // Weighted at colourway level rather than silhouette level: a pattern
  // disagreement is a strong signal that two garments differ, but the
  // vocabulary is noisy enough ("striped"/"stripe"/"breton stripe") that a
  // heavier penalty would punish inconsistent description as if it were a
  // real difference.
  different_pattern: 0.08,
};

const STRUCTURAL_CONFLICTS = new Set<ConflictReason>(['identifier_conflict', 'category_conflict']);

/**
 * Minimum evidence before a comparison is worth showing, per the ORIGINAL flat
 * gate.
 *
 * Two independent agreements, at least one of which is stronger than category.
 * "Same category" alone would flag every coat against every other coat, and a
 * comparison prompt the user dismisses every time is worse than no prompt — it
 * trains them to dismiss the one that matters.
 *
 * Kept as a standalone, tested utility (see `productMatchUserValue.test.ts`
 * "category agreement alone is never enough to prompt"). Not the operative
 * gate inside `classifySimilarItems` as of Checkpoint 4 — see the module
 * header — but every value it currently accepts is still accepted by the new
 * gate, and it remains true as a necessary (not sufficient) condition.
 */
export const MIN_REASONS = 2;

const WEAK_REASONS = new Set<SimilarityReason>(['same_canonical_category']);

function sameNonEmpty(a: unknown, b: unknown): boolean {
  const left = normalizeText(a);
  const right = normalizeText(b);
  return left.length > 0 && left === right;
}

function bothPresentAndDifferent(a: unknown, b: unknown): boolean {
  const left = normalizeText(a);
  const right = normalizeText(b);
  return left.length > 0 && right.length > 0 && left !== right;
}

function sharedModelTokens(a: unknown, b: unknown): boolean {
  const left = contentTokens(a);
  const right = new Set(contentTokens(b));
  if (left.length === 0 || right.size === 0) return false;
  const hits = left.filter((token) => right.has(token)).length;
  // Majority overlap, so "Air Force 1" and "Air Max 90" do not match on "air".
  return hits >= Math.ceil(left.length / 2);
}

/** Both sides have model text, and it shares no majority of tokens. */
function differentModelFamily(a: unknown, b: unknown): boolean {
  return contentTokens(a).length > 0 && contentTokens(b).length > 0 && !sharedModelTokens(a, b);
}

type IdentifierEvaluation = {
  /** At most one of these two — an identifier decides the comparison alone
   *  when present, see `classifySimilarItemsForPair`. */
  reason: 'authoritative_identifier_match' | 'shared_product_url' | null;
  conflict: boolean;
};

const NO_SCAN_IDENTITY: SimilarityScanIdentity = {};

/**
 * The single implementation both `collectSimilarityReasons` and
 * `collectConflictSignals` delegate to, so the two can never disagree about
 * what counts as an identifier match versus a conflict.
 *
 * `authoritativeId` takes precedence over `productUrl` when both sides supply
 * it: a caller-normalized GTIN/SKU/style-code is authoritative in a way a URL
 * is not (the same product can be relisted at a new URL without becoming a
 * different product), so once it is present it is the whole answer.
 *
 * Takes `SimilarityScanIdentity` rather than `ProductMatchQuery` — the
 * identifier and URL live OUTSIDE the query on purpose; see that type's doc
 * comment in contracts.ts for why.
 */
function evaluateIdentifier(
  scanIdentity: SimilarityScanIdentity,
  existing: ExistingItemCandidate,
): IdentifierEvaluation {
  const queryId = normalizeText(scanIdentity.authoritativeId);
  const existingId = normalizeText(existing.authoritativeId);
  if (queryId && existingId) {
    return queryId === existingId
      ? { reason: 'authoritative_identifier_match', conflict: false }
      : { reason: null, conflict: true };
  }

  const queryUrl = canonicalizeProductUrl(scanIdentity.productUrl);
  const existingUrl = canonicalizeProductUrl(existing.productUrl);
  if (queryUrl && existingUrl) {
    return queryUrl === existingUrl
      ? { reason: 'shared_product_url', conflict: false }
      : { reason: null, conflict: true };
  }

  return { reason: null, conflict: false };
}

/**
 * Collects the named agreements between a scan and one existing item.
 *
 * Exported so a caller can show the reasons without re-deriving them, and so
 * the test suite can assert on reasons rather than on a score. `scanIdentity`
 * is optional and defaults to empty — see `SimilarityScanIdentity` — so every
 * existing two-argument call site (the whole Checkpoint 3 governed suite)
 * keeps working unchanged.
 */
export function collectSimilarityReasons(
  query: ProductMatchQuery,
  existing: ExistingItemCandidate,
  scanIdentity: SimilarityScanIdentity = NO_SCAN_IDENTITY,
): SimilarityReason[] {
  const reasons: SimilarityReason[] = [];

  const identifier = evaluateIdentifier(scanIdentity, existing);
  if (identifier.reason) reasons.push(identifier.reason);

  const scanBrand = normalizeBrand(query.visibleBrandText ?? query.brand);
  const existingBrand = normalizeBrand(existing.brand);
  if (scanBrand && existingBrand && scanBrand === existingBrand) {
    reasons.push('same_brand');
  }

  if (sharedModelTokens(query.model, existing.model)) {
    reasons.push('same_model_tokens');
  }

  const scanColor = normalizeColor(query.color);
  const existingColor = normalizeColor(existing.color);
  if (scanColor && existingColor && scanColor === existingColor) {
    reasons.push('same_normalized_color');
  }

  const scanCategory = slugify(query.canonicalCategory);
  const existingCategory = slugify(existing.canonicalCategory);
  if (scanCategory && existingCategory && scanCategory === existingCategory) {
    reasons.push('same_canonical_category');
  }

  if (sameNonEmpty(query.material, existing.material)) reasons.push('same_material');
  if (sameNonEmpty(query.silhouette, existing.silhouette)) reasons.push('same_silhouette');
  if (sameNonEmpty(query.pattern, existing.pattern)) reasons.push('same_pattern');

  reasons.sort((a, b) => REASON_WEIGHTS[b] - REASON_WEIGHTS[a]);
  return reasons;
}

/**
 * Checkpoint 4 — collects the named DISAGREEMENTS between a scan and one
 * existing item. Symmetric with `collectSimilarityReasons`: same inputs, same
 * "both sides must actually say something" requirement, opposite direction.
 *
 * `identifier_conflict` and `category_conflict` are listed first because they
 * are the two `classifySimilarItems` treats as structural — see the module
 * header.
 */
export function collectConflictSignals(
  query: ProductMatchQuery,
  existing: ExistingItemCandidate,
  scanIdentity: SimilarityScanIdentity = NO_SCAN_IDENTITY,
): ConflictReason[] {
  const conflicts: ConflictReason[] = [];

  if (evaluateIdentifier(scanIdentity, existing).conflict) conflicts.push('identifier_conflict');

  const scanCategory = slugify(query.canonicalCategory);
  const existingCategory = slugify(existing.canonicalCategory);
  if (scanCategory && existingCategory && scanCategory !== existingCategory) {
    conflicts.push('category_conflict');
  }

  if (differentModelFamily(query.model, existing.model)) conflicts.push('different_model_family');
  if (bothPresentAndDifferent(query.silhouette, existing.silhouette)) conflicts.push('different_silhouette');

  const scanColor = normalizeColor(query.color);
  const existingColor = normalizeColor(existing.color);
  if (scanColor && existingColor && scanColor !== existingColor) conflicts.push('different_colorway');

  if (bothPresentAndDifferent(query.pattern, existing.pattern)) conflicts.push('different_pattern');

  return conflicts;
}

/**
 * Whether the reasons justify showing a comparison at all, per the ORIGINAL
 * flat gate. See the `MIN_REASONS` doc comment for why this is kept but is no
 * longer the operative gate.
 */
export function reasonsAreSufficient(reasons: SimilarityReason[]): boolean {
  if (reasons.length < MIN_REASONS) return false;
  return reasons.some((reason) => !WEAK_REASONS.has(reason));
}

const COMPARABLE_ATTRIBUTE_PAIRS: ReadonlyArray<
  [keyof ProductMatchQuery, keyof ExistingItemCandidate]
> = [
  ['model', 'model'],
  ['canonicalCategory', 'canonicalCategory'],
  ['color', 'color'],
  ['material', 'material'],
  ['silhouette', 'silhouette'],
  ['pattern', 'pattern'],
];

/**
 * How many of the fields the engine knows how to compare were actually
 * present on BOTH sides. Feeds `coverageOf` — see `similarityThresholds.ts`
 * for why thin coverage raises the bar rather than lowering it.
 */
function comparableFieldCount(
  query: ProductMatchQuery,
  existing: ExistingItemCandidate,
  scanIdentity: SimilarityScanIdentity,
): number {
  let count = 0;
  if (normalizeText(query.visibleBrandText ?? query.brand) && normalizeText(existing.brand)) count += 1;
  for (const [queryField, existingField] of COMPARABLE_ATTRIBUTE_PAIRS) {
    if (normalizeText(query[queryField] as unknown) && normalizeText(existing[existingField] as unknown)) {
      count += 1;
    }
  }
  const identifierComparable = Boolean(
    (normalizeText(scanIdentity.authoritativeId) && normalizeText(existing.authoritativeId))
      || (canonicalizeProductUrl(scanIdentity.productUrl) && canonicalizeProductUrl(existing.productUrl)),
  );
  if (identifierComparable) count += 1;
  return count;
}

/**
 * Availability is read from an EXPLICIT quality hint, never inferred from
 * whether a display URI happens to be present. See the "DEFAULT IS `both`"
 * note in `similarityThresholds.ts` for why: many legitimate calls omit the
 * display URI without the underlying photo being missing, and punishing that
 * would conflate a display-wiring gap with an actual missing photo.
 */
function imageAvailabilityOf(
  newScanQuality: 'ok' | 'poor' | 'missing' | null | undefined,
  existingQuality: 'ok' | 'poor' | 'missing' | null | undefined,
): ImageAvailability {
  const scan = newScanQuality ?? 'ok';
  const existing = existingQuality ?? 'ok';
  if (scan === 'missing' && existing === 'missing') return 'none';
  if (scan === 'missing' || existing === 'missing') return 'one_missing';
  if (scan === 'poor' || existing === 'poor') return 'poor_quality';
  return 'both';
}

/** One pair's full classification. Used by the runtime path and by the
 *  dev-only inspection tooling, which additionally wants the NO_NOTICE case. */
export type PairClassification = {
  classification: SimilarityClassification;
  reasons: SimilarityReason[];
  conflicts: ConflictReason[];
  structuralVeto: ConflictReason | null;
  evidenceMode: EvidenceMode;
  categoryFamily: CategoryFamily;
  coverage: MetadataCoverage;
  imageAvailability: ImageAvailability;
  netScore: number;
  distinctPositiveClasses: number;
  potentialAt: number;
  strongAt: number;
  minDistinctPositiveClasses: number;
  thresholdVersion: string;
  adjustmentsApplied: string[];
};

/**
 * Runs the full Checkpoint 4 pipeline for one (query, existing) pair.
 *
 * Exported (not just used internally) because the directional fixture suite
 * and the dev inspection tooling both need the NO_NOTICE case explained, not
 * just the admitted results — "why didn't this flag" is exactly the question
 * a calibration pass has to be able to answer.
 */
export function classifyPair(
  query: ProductMatchQuery,
  existing: ExistingItemCandidate,
  scanIdentity: SimilarityScanIdentity = NO_SCAN_IDENTITY,
  overrides: ThresholdOverrides = {},
): PairClassification {
  const reasons = collectSimilarityReasons(query, existing, scanIdentity);
  const conflicts = collectConflictSignals(query, existing, scanIdentity);
  const structuralVeto = conflicts.find((conflict) => STRUCTURAL_CONFLICTS.has(conflict)) ?? null;

  const evidenceMode: EvidenceMode = reasons.includes('authoritative_identifier_match')
      || reasons.includes('shared_product_url')
    ? 'identifier_backed'
    : 'attribute_only';
  const categoryFamily = categoryFamilyOf(existing.canonicalCategory ?? query.canonicalCategory ?? null);
  const coverage = coverageOf(comparableFieldCount(query, existing, scanIdentity));
  const imageAvailability = imageAvailabilityOf(scanIdentity.imageQuality, existing.imageQuality);

  const resolved = resolveThresholds(
    { source: existing.source, evidenceMode, categoryFamily, coverage, imageAvailability },
    overrides,
  );

  const distinctPositiveClasses = reasons.length;
  const hasNonWeakPositive = reasons.some((reason) => !WEAK_REASONS.has(reason));
  const softConflicts = conflicts.filter((conflict) => !STRUCTURAL_CONFLICTS.has(conflict));
  const positiveScore = reasons.reduce((sum, reason) => sum + REASON_WEIGHTS[reason], 0);
  const conflictPenalty = softConflicts.reduce(
    (sum, conflict) => sum + (SOFT_CONFLICT_WEIGHTS[conflict] ?? 0),
    0,
  );
  const netScore = Math.max(0, positiveScore - conflictPenalty);

  let classification: SimilarityClassification = 'NO_NOTICE';
  if (
    !structuralVeto
    && distinctPositiveClasses > 0
    && distinctPositiveClasses >= resolved.minDistinctPositiveClasses
    && (!resolved.requiresNonWeakPositive || hasNonWeakPositive)
    && netScore >= resolved.potentialAt
  ) {
    classification = capClassification(
      netScore >= resolved.strongAt ? 'STRONG_SIMILARITY' : 'POTENTIAL_SIMILAR_ITEM',
      resolved.maxClassification,
    );
  }

  return {
    classification,
    reasons,
    conflicts: softConflicts,
    structuralVeto,
    evidenceMode,
    categoryFamily,
    coverage,
    imageAvailability,
    netScore: Number(netScore.toFixed(4)),
    distinctPositiveClasses,
    potentialAt: resolved.potentialAt,
    strongAt: resolved.strongAt,
    minDistinctPositiveClasses: resolved.minDistinctPositiveClasses,
    thresholdVersion: resolved.version,
    adjustmentsApplied: resolved.adjustmentsApplied,
  };
}

export type SimilarityInput = {
  query: ProductMatchQuery;
  existingItems: ExistingItemCandidate[];
  newScanImageUri?: string | null;
  newScanLabel?: string | null;
  /** Cap on comparisons returned. The user is being asked to decide; a wall of
   *  comparisons is not a decision aid. */
  maxComparisons?: number;
  /**
   * Checkpoint 4 — the scan's own identifier/URL/image-quality, kept OUT of
   * `query` on purpose. See `SimilarityScanIdentity`.
   */
  newScanIdentity?: SimilarityScanIdentity;
  /** Checkpoint 4 — see `ProductMatchRequest.debugSimilarity`. */
  debug?: boolean;
  /** Checkpoint 4 — calibration-only. See `similarityThresholds.ts`. */
  thresholdOverrides?: ThresholdOverrides;
};

export const DEFAULT_MAX_COMPARISONS = 3;

function toInternalDebug(pair: PairClassification): SimilarityInternalDebug {
  return {
    thresholdVersion: pair.thresholdVersion,
    classification: pair.classification as 'POTENTIAL_SIMILAR_ITEM' | 'STRONG_SIMILARITY',
    evidenceMode: pair.evidenceMode,
    categoryFamily: pair.categoryFamily,
    coverage: pair.coverage,
    imageAvailability: pair.imageAvailability,
    netScore: pair.netScore,
    potentialAt: pair.potentialAt,
    strongAt: pair.strongAt,
    distinctPositiveClasses: pair.distinctPositiveClasses,
    minDistinctPositiveClasses: pair.minDistinctPositiveClasses,
    adjustmentsApplied: pair.adjustmentsApplied,
  };
}

export type ClassifySimilarItemsResult = {
  items: PotentialSimilarItem[];
  /** `items.length` before `maxComparisons` was applied — see
   *  `SimilarityStageDiagnostics.classifiedBeforeCap`. */
  classifiedBeforeCap: number;
};

/**
 * Produces advisory comparisons, strongest first.
 *
 * Returns `{ items: [] }` when nothing was supplied or nothing looked alike.
 * An empty array means "no comparison to offer", never "confirmed not a
 * duplicate" — this module makes no negative claims either.
 */
export function classifySimilarItems(input: SimilarityInput): ClassifySimilarItemsResult {
  const { query, existingItems } = input;
  if (!Array.isArray(existingItems) || existingItems.length === 0) {
    return { items: [], classifiedBeforeCap: 0 };
  }

  const results: PotentialSimilarItem[] = [];

  for (const existing of existingItems) {
    if (!existing || typeof existing.id !== 'string' || !existing.id) continue;
    if (existing.source !== 'closet' && existing.source !== 'recent_scan') continue;

    const pair = classifyPair(query, existing, input.newScanIdentity ?? NO_SCAN_IDENTITY, input.thresholdOverrides ?? {});
    if (pair.classification === 'NO_NOTICE') continue;

    results.push({
      potentialSimilarItem: true,
      existingItemId: existing.id,
      existingItemSource: existing.source,
      comparison: {
        newScanImageUri: input.newScanImageUri ?? null,
        existingItemImageUri: existing.imageUri ?? null,
        newScanLabel: input.newScanLabel ?? null,
        existingItemLabel: existing.label ?? null,
      },
      reasons: pair.reasons,
      conflicts: pair.conflicts,
      advisoryConfidence: Number(Math.min(1, pair.netScore).toFixed(4)),
      // Always every action. This module never decides an action is
      // inapplicable — the user's intent is not derivable from attribute
      // agreement, and pre-filtering the choices would be deciding for them.
      availableActions: [...SIMILAR_ITEM_ACTIONS],
      resolution: 'user_required',
      ...(input.debug ? { internal: toInternalDebug(pair) } : {}),
    });
  }

  results.sort((a, b) => {
    if (b.advisoryConfidence !== a.advisoryConfidence) {
      return b.advisoryConfidence - a.advisoryConfidence;
    }
    return a.existingItemId.localeCompare(b.existingItemId);
  });

  const classifiedBeforeCap = results.length;
  const items = results.slice(0, input.maxComparisons ?? DEFAULT_MAX_COMPARISONS);
  return { items, classifiedBeforeCap };
}

/**
 * Backward-compatible entry point: the array-only shape every caller before
 * Checkpoint 4 depends on (`const [result] = detectPotentialSimilarItems(...)`
 * throughout the governed test suite). New callers that need the pre-cap
 * count for instrumentation should call `classifySimilarItems` directly.
 */
export function detectPotentialSimilarItems(input: SimilarityInput): PotentialSimilarItem[] {
  return classifySimilarItems(input).items;
}
