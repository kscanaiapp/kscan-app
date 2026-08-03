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
 */

import type {
  ExistingItemCandidate,
  PotentialSimilarItem,
  ProductMatchQuery,
  SimilarityReason,
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

/**
 * Weight per reason. Used only to order candidates.
 *
 * A shared canonical product URL is near-conclusive and weighted accordingly —
 * but note that even at 1.0 it produces an advisory record, never a merge.
 */
const REASON_WEIGHTS: Record<SimilarityReason, number> = {
  shared_product_url: 0.60,
  same_brand: 0.20,
  same_model_tokens: 0.20,
  same_normalized_color: 0.12,
  same_canonical_category: 0.10,
  same_material: 0.06,
  same_silhouette: 0.06,
  same_pattern: 0.04,
};

/**
 * Minimum evidence before a comparison is worth showing.
 *
 * Two independent agreements, at least one of which is stronger than category.
 * "Same category" alone would flag every coat against every other coat, and a
 * comparison prompt the user dismisses every time is worse than no prompt — it
 * trains them to dismiss the one that matters.
 */
export const MIN_REASONS = 2;

const WEAK_REASONS = new Set<SimilarityReason>(['same_canonical_category']);

function sameNonEmpty(a: unknown, b: unknown): boolean {
  const left = normalizeText(a);
  const right = normalizeText(b);
  return left.length > 0 && left === right;
}

function sharedModelTokens(a: unknown, b: unknown): boolean {
  const left = contentTokens(a);
  const right = new Set(contentTokens(b));
  if (left.length === 0 || right.size === 0) return false;
  const hits = left.filter((token) => right.has(token)).length;
  // Majority overlap, so "Air Force 1" and "Air Max 90" do not match on "air".
  return hits >= Math.ceil(left.length / 2);
}

/**
 * Collects the named agreements between a scan and one existing item.
 *
 * Exported so a caller can show the reasons without re-deriving them, and so
 * the test suite can assert on reasons rather than on a score.
 */
export function collectSimilarityReasons(
  query: ProductMatchQuery,
  existing: ExistingItemCandidate,
): SimilarityReason[] {
  const reasons: SimilarityReason[] = [];

  const scanUrl = canonicalizeProductUrl(null);
  const existingUrl = canonicalizeProductUrl(existing.productUrl);
  if (scanUrl && existingUrl && scanUrl === existingUrl) {
    reasons.push('shared_product_url');
  }

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
 * Whether the reasons justify showing a comparison at all.
 *
 * Requires `MIN_REASONS` agreements including at least one non-weak reason.
 * Deliberately conservative in the direction of NOT prompting: the cost of a
 * missed prompt is a duplicate entry the user can delete later, and the cost of
 * a noisy prompt is that the feature gets ignored.
 */
export function reasonsAreSufficient(reasons: SimilarityReason[]): boolean {
  if (reasons.length < MIN_REASONS) return false;
  return reasons.some((reason) => !WEAK_REASONS.has(reason));
}

function advisoryConfidenceOf(reasons: SimilarityReason[]): number {
  const total = reasons.reduce((sum, reason) => sum + REASON_WEIGHTS[reason], 0);
  return Number(Math.min(1, total).toFixed(4));
}

export type SimilarityInput = {
  query: ProductMatchQuery;
  existingItems: ExistingItemCandidate[];
  newScanImageUri?: string | null;
  newScanLabel?: string | null;
  /** Cap on comparisons returned. The user is being asked to decide; a wall of
   *  comparisons is not a decision aid. */
  maxComparisons?: number;
};

export const DEFAULT_MAX_COMPARISONS = 3;

/**
 * Produces advisory comparisons, strongest first.
 *
 * Returns `[]` when nothing was supplied or nothing looked alike. An empty
 * array means "no comparison to offer", never "confirmed not a duplicate" —
 * this module makes no negative claims either.
 */
export function detectPotentialSimilarItems(input: SimilarityInput): PotentialSimilarItem[] {
  const { query, existingItems } = input;
  if (!Array.isArray(existingItems) || existingItems.length === 0) return [];

  const results: PotentialSimilarItem[] = [];

  for (const existing of existingItems) {
    if (!existing || typeof existing.id !== 'string' || !existing.id) continue;
    if (existing.source !== 'closet' && existing.source !== 'recent_scan') continue;

    const reasons = collectSimilarityReasons(query, existing);
    if (!reasonsAreSufficient(reasons)) continue;

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
      reasons,
      advisoryConfidence: advisoryConfidenceOf(reasons),
      // Always every action. This module never decides an action is
      // inapplicable — the user's intent is not derivable from attribute
      // agreement, and pre-filtering the choices would be deciding for them.
      availableActions: [...SIMILAR_ITEM_ACTIONS],
      resolution: 'user_required',
    });
  }

  results.sort((a, b) => {
    if (b.advisoryConfidence !== a.advisoryConfidence) {
      return b.advisoryConfidence - a.advisoryConfidence;
    }
    return a.existingItemId.localeCompare(b.existingItemId);
  });

  return results.slice(0, input.maxComparisons ?? DEFAULT_MAX_COMPARISONS);
}
