/**
 * Multi-item commerce orchestration (Build 32).
 *
 * Connects multi-item detection (up to 5 `OutfitConfirmationCandidate`s, each
 * already carrying its own per-garment `identification`/`attributes` from the
 * SAME detection call) to the existing MODE B commerce-only route. No new
 * Gemini call, no new AI pass: every candidate's evidence already exists.
 *
 * One MODE B request per eligible candidate, dispatched in parallel via
 * `Promise.allSettled` — one item's failure can never block or remove another
 * item's card. This module is the only caller of `fetchDeferredCommerce` for
 * more than one item at a time; it does not change what that function sends
 * or how commerce is ranked.
 */

import { fetchDeferredCommerce, type CommerceHydrationResult } from './commerceHydration';
import { isCandidateCommerceEligible } from './commerceShelfState';
import type { OutfitConfirmationCandidate } from './outfitConfirmation/outfitDetectionBridge';
import type { RankedScanProduct } from '../types/scanIdentification';

export type ItemCommerceStatus = 'ready' | 'no_match' | 'error';

export type ItemCommerceCard = {
  candidateId: string;
  status: ItemCommerceStatus;
  bestMatch: RankedScanProduct | null;
  alternatives: RankedScanProduct[];
  retryable: boolean;
};

/**
 * Structural commerce eligibility, using only evidence multi-item detection
 * already produced. No confidence threshold, no new scoring model: a
 * candidate is eligible when it carries identification content a commerce
 * query can be built from, matching the same non-emptiness bar the backend
 * itself applies (`readCommerceOnlyEvidence` requires identification).
 *
 * The predicate lives in the dependency-free services/commerceShelfState.ts so
 * the shelf component can ask it without importing this network-facing module;
 * it is re-exported here so every existing caller keeps working.
 */
export { isCandidateCommerceEligible };

/**
 * Two-tier split of an already-ranked offer array. The backend documents
 * that ordering is final and the client never re-sorts (see
 * commerceHydration.ts / mergeEnrichedOffers) — this reuses that ordering
 * rather than computing a new confidence-based rank.
 */
export function splitBestMatchAndAlternatives(purchaseOptions: RankedScanProduct[]): {
  bestMatch: RankedScanProduct | null;
  alternatives: RankedScanProduct[];
} {
  if (!purchaseOptions.length) return { bestMatch: null, alternatives: [] };
  const [bestMatch, ...alternatives] = purchaseOptions;
  return { bestMatch, alternatives };
}

/**
 * The one errorType that means commerce genuinely ran and found nothing.
 *
 * The backend already separates the two empty-shelf causes it can report
 * (scanCommerceRouter: `merged.length > 0 ? undefined : discoveryErrorType ??
 * 'no_results'`): `no_results` is "we searched, nothing matched", while
 * `provider_error`, `no_key`, `disabled`, `timeout` and friends mean retrieval
 * never completed. Only the first is a no-match.
 */
const GENUINE_NO_MATCH_ERROR_TYPES = new Set(['no_results']);

/**
 * An empty shelf is only a NO_MATCH when the search demonstrably completed empty.
 *
 * The evidence is the backend's own statement: `commerce.errorType ===
 * 'no_results'`. A healthy MODE B answer always names its cause when the shelf
 * is empty (scanCommerceRouter: `errorType: merged.length > 0 ? undefined :
 * (discoveryErrorType ?? 'no_results')`), so an empty result that names NO cause
 * is not a healthy answer at all. It is what a backend without the MODE B route
 * returns: with the v127 funnel off a commerce_only body falls through to the
 * image path and is answered HTTP 200 `status:'failed'` with no `commerce` block
 * (index.ts:2407-2408), which normalizes to an empty shelf with no errorType.
 * Treating that as "no match" stated a fact about the garment for a search that
 * never ran, so an absent errorType is UNKNOWN, and UNKNOWN is an error here,
 * never a no-match. Provider failures (`provider_error`, `no_key`, `disabled`,
 * `timeout`, `weak_query`, ...) are errors for the same reason.
 */
function toCardStatus(result: CommerceHydrationResult): ItemCommerceStatus {
  if (result.status === 'success') return 'ready';
  if (
    result.status === 'empty' &&
    result.errorType !== undefined &&
    GENUINE_NO_MATCH_ERROR_TYPES.has(result.errorType)
  ) {
    return 'no_match';
  }
  return 'error';
}

/** A card for an eligible item whose request produced no usable answer. */
function errorCard(candidateId: string): ItemCommerceCard {
  return { candidateId, status: 'error', bestMatch: null, alternatives: [], retryable: true };
}

function searchQueriesOf(identification: Record<string, unknown> | undefined): string[] | undefined {
  const raw = identification?.search_queries;
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === 'string' && !!v.trim());
  return out.length ? out : undefined;
}

/**
 * Fetch commerce for every eligible detected item in parallel. Ineligible
 * candidates are simply absent from the result map: they cannot be searched, and
 * callers resolve them to NOT_STARTED (services/commerceShelfState.ts), which is
 * not an error and not a no-match.
 *
 * A per-candidate failure never rejects this promise and never removes
 * another candidate's card: `Promise.allSettled` plus a per-item try/catch
 * inside `fetchDeferredCommerce` itself. Should an eligible candidate's request
 * reject anyway, it gets an ERROR card of its own. It used to be dropped from the
 * map, and an item with no card was indistinguishable from an item nothing had
 * searched for.
 */
export async function fetchMultiItemCommerce(
  candidates: OutfitConfirmationCandidate[],
  options?: { signal?: AbortSignal },
): Promise<Map<string, ItemCommerceCard>> {
  const eligible = candidates.filter(isCandidateCommerceEligible);

  const settled = await Promise.allSettled(
    eligible.map(async (candidate) => {
      const identification = candidate.source.identification as Record<string, unknown>;
      const result = await fetchDeferredCommerce(
        {
          identification,
          attributes: (candidate.source.attributes as Record<string, unknown> | undefined) ?? null,
          searchQueries: searchQueriesOf(identification) ?? null,
          candidateId: candidate.id,
        },
        { signal: options?.signal },
      );
      return { candidate, result };
    }),
  );

  const out = new Map<string, ItemCommerceCard>();
  settled.forEach((entry, index) => {
    if (entry.status !== 'fulfilled') {
      // allSettled preserves order, so this entry belongs to eligible[index].
      const failed = eligible[index];
      out.set(failed.id, errorCard(failed.id));
      return;
    }
    const { candidate, result } = entry.value;
    const { bestMatch, alternatives } = splitBestMatchAndAlternatives(result.purchaseOptions);
    out.set(candidate.id, {
      candidateId: candidate.id,
      status: toCardStatus(result),
      bestMatch,
      alternatives,
      retryable: result.retryable,
    });
  });
  return out;
}
