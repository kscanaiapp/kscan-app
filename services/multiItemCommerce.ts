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
 */
export function isCandidateCommerceEligible(candidate: OutfitConfirmationCandidate): boolean {
  const identification = candidate.source?.identification;
  if (!identification || typeof identification !== 'object') return false;
  return Object.keys(identification).length > 0;
}

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

function toCardStatus(result: CommerceHydrationResult): ItemCommerceStatus {
  if (result.status === 'success') return 'ready';
  if (result.status === 'empty') return 'no_match';
  return 'error';
}

function searchQueriesOf(identification: Record<string, unknown> | undefined): string[] | undefined {
  const raw = identification?.search_queries;
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === 'string' && !!v.trim());
  return out.length ? out : undefined;
}

/**
 * Fetch commerce for every eligible detected item in parallel. Ineligible
 * candidates are simply absent from the result map — callers render their
 * "no strong shopping match" state locally without treating that as an error.
 *
 * A per-candidate failure never rejects this promise and never removes
 * another candidate's card: `Promise.allSettled` plus a per-item try/catch
 * inside `fetchDeferredCommerce` itself.
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
  for (const entry of settled) {
    if (entry.status !== 'fulfilled') continue;
    const { candidate, result } = entry.value;
    const { bestMatch, alternatives } = splitBestMatchAndAlternatives(result.purchaseOptions);
    out.set(candidate.id, {
      candidateId: candidate.id,
      status: toCardStatus(result),
      bestMatch,
      alternatives,
      retryable: result.retryable,
    });
  }
  return out;
}
