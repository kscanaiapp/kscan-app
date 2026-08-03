/**
 * Client consumption of the scan-journey contract.
 *
 * WHAT THIS IS FOR
 *
 * The backend now emits `applicationState`, `selectionRequired`,
 * `selectionCandidates` and `potentialSimilarItems` (Checkpoint 3). No client
 * read any of it, so the repaired multi-item flow existed in the contract and
 * not in the app. This module is the single place the client interprets that
 * contract, so every screen agrees on what a response means.
 *
 * LEGACY FALLBACK IS THE DEFAULT, NOT THE EXCEPTION
 *
 * `applicationState` is emitted on the COMPLETED response path only. The
 * backend handler has 26 return sites and the early terminal ones — invalid
 * image, rate limited, safety failure, non-fashion, technical failure — return
 * before the contract layer runs. On top of that, the whole contract is behind
 * `SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED`, which is off.
 *
 * So an absent `applicationState` is the NORMAL case and means "legacy shape",
 * never an error. Every function here derives a usable answer from the legacy
 * fields when the new ones are missing, which is what lets the client ship
 * ahead of the flag being turned on.
 */

import type { ScanJourneyState } from './scanJourneyTypes';

export type { ScanJourneyState };

export type SelectionLineageToken = {
  candidateId: string;
  scanId?: string | null;
  scanSessionId?: string | null;
  imageDigestPrefix?: string | null;
  evidenceId?: string | null;
};

export type SelectionCandidateView = {
  candidateId: string;
  label: string | null;
  category: string | null;
  subtype: string | null;
  bounds?: unknown;
  /** Echoed back verbatim on the selected-item request. Never reconstructed. */
  selectionToken: SelectionLineageToken;
};

export type SimilarityReason =
  | 'shared_product_url'
  | 'authoritative_identifier_match'
  | 'same_brand'
  | 'same_model_tokens'
  | 'same_normalized_color'
  | 'same_canonical_category'
  | 'same_material'
  | 'same_silhouette'
  | 'same_pattern';

/**
 * Checkpoint 4 — named disagreements. See the backend's `ConflictReason` in
 * `supabase/functions/product-match/contracts.ts` for the full rationale.
 * `identifier_conflict` and `category_conflict` never reach the client: they
 * suppress the notice on the backend instead of appearing here.
 */
export type ConflictReason =
  | 'identifier_conflict'
  | 'category_conflict'
  | 'different_model_family'
  | 'different_silhouette'
  | 'different_colorway'
  | 'different_pattern';

export type SimilarItemAction =
  | 'reject_new_scan'
  | 'add_to_closet'
  | 'keep_in_recent_scans'
  | 'delete_existing_item'
  | 'shop_identified_product'
  | 'keep_both';

export type PotentialSimilarItemView = {
  existingItemId: string;
  existingItemSource: 'closet' | 'recent_scan';
  comparison: {
    newScanImageUri: string | null;
    existingItemImageUri: string | null;
    newScanLabel: string | null;
    existingItemLabel: string | null;
  };
  reasons: SimilarityReason[];
  /**
   * Checkpoint 4. Soft disagreements alongside `reasons` — may be non-empty
   * even though a notice is shown (e.g. same brand and model, different
   * colourway). Defaults to `[]` on a response that predates this field.
   */
  conflicts: ConflictReason[];
  advisoryConfidence: number;
  /** Every action the CONTRACT permits. Filtered for display by eligibility. */
  contractActions: SimilarItemAction[];
};

export type ScanJourneyView = {
  state: ScanJourneyState;
  /** True only when the backend explicitly said so. Never inferred. */
  selectionRequired: boolean;
  selectionCandidates: SelectionCandidateView[];
  potentialSimilarItems: PotentialSimilarItemView[];
  /**
   * True when the response predates the contract, so the caller knows the
   * state was derived rather than received. Screens use this to keep their
   * existing behaviour instead of adopting a state they were never sent.
   */
  derivedFromLegacy: boolean;
};

const VALID_STATES: ScanJourneyState[] = [
  'MULTI_ITEM_SELECTION_REQUIRED',
  'FASHION_IDENTIFIED',
  'CANDIDATES_READY',
  'ENRICHED',
  'NO_CONFIDENT_MATCH',
  'FAILED',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function parseToken(raw: unknown, fallbackCandidateId: string): SelectionLineageToken | null {
  if (!isRecord(raw)) return null;
  const candidateId = str(raw.candidateId, 64) ?? fallbackCandidateId;
  if (!candidateId) return null;
  return {
    candidateId,
    scanId: str(raw.scanId, 64),
    scanSessionId: str(raw.scanSessionId, 64),
    imageDigestPrefix: str(raw.imageDigestPrefix, 32),
    evidenceId: str(raw.evidenceId, 64),
  };
}

function parseSelectionCandidates(raw: unknown): SelectionCandidateView[] {
  if (!Array.isArray(raw)) return [];
  const out: SelectionCandidateView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const candidateId = str(entry.candidateId, 64);
    if (!candidateId) continue;
    const token = parseToken(entry.selectionToken, candidateId);
    // A candidate with no token cannot be dispatched, so offering it would
    // produce a request the backend rejects. Dropped rather than shown.
    if (!token) continue;
    out.push({
      candidateId,
      label: str(entry.label, 160),
      category: str(entry.category, 60),
      subtype: str(entry.subtype, 60),
      ...(entry.bounds ? { bounds: entry.bounds } : {}),
      selectionToken: token,
    });
  }
  return out;
}

function parseSimilarItems(raw: unknown): PotentialSimilarItemView[] {
  if (!Array.isArray(raw)) return [];
  const out: PotentialSimilarItemView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    // The advisory flag is a literal `true` in the contract. Anything else is
    // not a comparison this client will render — including, deliberately, a
    // payload that tried to assert a duplicate verdict some other way.
    if (entry.potentialSimilarItem !== true) continue;
    const existingItemId = str(entry.existingItemId, 128);
    const source = str(entry.existingItemSource, 24);
    if (!existingItemId) continue;
    if (source !== 'closet' && source !== 'recent_scan') continue;

    const comparison = isRecord(entry.comparison) ? entry.comparison : {};
    const reasons = Array.isArray(entry.reasons)
      ? (entry.reasons.filter((r) => typeof r === 'string') as SimilarityReason[])
      : [];
    const conflicts = Array.isArray(entry.conflicts)
      ? (entry.conflicts.filter((c) => typeof c === 'string') as ConflictReason[])
      : [];
    const contractActions = Array.isArray(entry.availableActions)
      ? (entry.availableActions.filter((a) => typeof a === 'string') as SimilarItemAction[])
      : [];

    out.push({
      existingItemId,
      existingItemSource: source,
      comparison: {
        newScanImageUri: str(comparison.newScanImageUri, 2048),
        existingItemImageUri: str(comparison.existingItemImageUri, 2048),
        newScanLabel: str(comparison.newScanLabel, 160),
        existingItemLabel: str(comparison.existingItemLabel, 160),
      },
      reasons,
      conflicts,
      advisoryConfidence: typeof entry.advisoryConfidence === 'number' ? entry.advisoryConfidence : 0,
      contractActions,
    });
  }
  return out;
}

/**
 * Derives a state from the legacy response shape.
 *
 * Deliberately conservative. It will never return
 * `MULTI_ITEM_SELECTION_REQUIRED`: that state carries a promise — that the
 * backend suppressed its guess and supplied dispatchable tokens — which a
 * legacy response has not kept. Inferring it from `detectedGarments.length > 1`
 * would put the client into a selection flow with no tokens to send, which is
 * worse than the legacy behaviour it replaced.
 */
function deriveLegacyState(response: Record<string, unknown>): ScanJourneyState {
  const status = str(response.status, 32);
  if (status === 'failed') return 'FAILED';
  if (status === 'non_fashion') return 'NO_CONFIDENT_MATCH';

  const products = Array.isArray(response.recommendedProducts) ? response.recommendedProducts : [];
  if (products.length > 0) return 'CANDIDATES_READY';
  if (isRecord(response.identification)) return 'FASHION_IDENTIFIED';
  return 'NO_CONFIDENT_MATCH';
}

/** Reads a scan response into the single view every screen shares. */
export function readScanJourney(response: unknown): ScanJourneyView {
  if (!isRecord(response)) {
    return {
      state: 'FAILED',
      selectionRequired: false,
      selectionCandidates: [],
      potentialSimilarItems: [],
      derivedFromLegacy: true,
    };
  }

  const declared = str(response.applicationState, 48) as ScanJourneyState | null;
  const hasDeclaredState = declared !== null && VALID_STATES.includes(declared);

  const productMatch = isRecord(response.productMatch) ? response.productMatch : null;
  const potentialSimilarItems = parseSimilarItems(
    productMatch?.potentialSimilarItems ?? response.potentialSimilarItems,
  );

  // Selection is honoured only when the backend BOTH declared it and supplied
  // dispatchable candidates. A declared state with no usable tokens would
  // strand the user on a selection screen with nothing to send.
  const selectionCandidates = parseSelectionCandidates(response.selectionCandidates);
  const selectionRequired = response.selectionRequired === true && selectionCandidates.length > 0;

  let state: ScanJourneyState;
  if (selectionRequired) {
    state = 'MULTI_ITEM_SELECTION_REQUIRED';
  } else if (hasDeclaredState && declared !== 'MULTI_ITEM_SELECTION_REQUIRED') {
    state = declared;
  } else {
    state = deriveLegacyState(response);
  }

  return {
    state,
    selectionRequired,
    selectionCandidates,
    potentialSimilarItems,
    derivedFromLegacy: !hasDeclaredState,
  };
}

/**
 * The correlation payload for the follow-up selected-item request.
 *
 * Returns the backend's token VERBATIM when one exists. The legacy pair is a
 * fallback for responses that predate the contract — reconstructing a token
 * from parts would defeat the point of the backend issuing one, since the whole
 * value of the bundle is that the client did not assemble it.
 */
export function selectionDispatchFor(
  candidate: SelectionCandidateView | null | undefined,
  legacyResponse?: unknown,
): { selectionToken?: SelectionLineageToken; scanSessionId?: string; imageDigestPrefix?: string } {
  if (candidate?.selectionToken) {
    const token = candidate.selectionToken;
    return {
      selectionToken: token,
      ...(token.scanSessionId ? { scanSessionId: token.scanSessionId } : {}),
      ...(token.imageDigestPrefix ? { imageDigestPrefix: token.imageDigestPrefix } : {}),
    };
  }
  const legacy = isRecord(legacyResponse) ? legacyResponse : {};
  const scanSessionId = str(legacy.scanSessionId, 64);
  const imageDigestPrefix = str(legacy.imageDigestPrefix, 32);
  return {
    ...(scanSessionId ? { scanSessionId } : {}),
    ...(imageDigestPrefix ? { imageDigestPrefix } : {}),
  };
}
