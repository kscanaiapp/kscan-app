/**
 * Multi-item selection contract.
 *
 * THE DEFECT THIS FIXES
 *
 * When a scan detects several garments, the deployed function returns
 * `detectedGarments[]` AND promotes `detectedGarments[0]` to the top-level
 * `identification`, `attributes` and `displayResult` via
 * `primaryGarmentResponseFields`. A client reading the response cannot tell the
 * difference between "we identified this jacket" and "we found four things and
 * are showing you the first one". The backend is guessing which garment the
 * user meant, and the guess is indistinguishable from a real identification.
 *
 * Production telemetry shows the cost: 23 `multi_item_detection` events,
 * 19 completed, **0 with products**, still active through 2026-08-03 — while
 * `selected_item`, the request that would actually retrieve products, last
 * fired 2026-07-30. Users run multi-item scans and never reach the step where
 * products appear.
 *
 * WHAT THIS MODULE GUARANTEES
 *
 *   1. An UNAMBIGUOUS state. `MULTI_ITEM_SELECTION_REQUIRED` is an explicit
 *      field, not something a client infers from an array length.
 *   2. NO GUESSED PRIMARY. When selection is required, the guessed top-level
 *      identification is suppressed. There is no "probably this one".
 *   3. LINEAGE THAT SURVIVES THE ROUND TRIP. Each candidate carries the
 *      correlation fields the follow-up request must echo, and the backend
 *      validates them rather than trusting the client to have got it right.
 *
 * ROLLBACK
 *
 * Everything here is gated by `SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED`,
 * default FALSE. With the flag off, callers receive byte-identical behaviour to
 * the currently deployed function — including the guessed primary. That is the
 * legacy rollback path, and it is preserved deliberately: the guess is wrong,
 * but it is what shipped clients currently read, and turning it off is a
 * coordinated client change rather than a backend decision.
 */

import type { ScanJourneyState } from '../_shared/scanJourneyState.ts';

export const SELECTION_CONTRACT_VERSION = 'multi-item-selection-v1';

export type EnvGet = (key: string) => string | undefined;

const defaultEnvGet: EnvGet = (key) => {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
};

/** Default OFF. See the ROLLBACK note in the file header. */
export const SELECTION_CONTRACT_DEFAULT_ENABLED = false;

export function isSelectionContractEnabled(envGet: EnvGet = defaultEnvGet): boolean {
  const raw = envGet('SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED')?.trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  return SELECTION_CONTRACT_DEFAULT_ENABLED;
}

/**
 * Correlation fields a selected-item request must echo back.
 *
 * Bundled into one object rather than left as loose top-level fields because
 * the client's job is "send this back unchanged", and a bundle is much harder
 * to partially forget than four sibling strings. The backend still validates
 * each field — a bundle is an ergonomic aid, not a trust boundary.
 *
 * `detectionDigest` is optional and currently absent: the deployed backend does
 * not emit one, so selected-item correlation runs on `scanSessionId` +
 * `imageDigestPrefix`. It is declared here so that adding a digest later is a
 * populated field rather than a contract change.
 */
export type SelectionLineage = {
  scanId: string;
  scanSessionId: string | null;
  imageDigestPrefix: string | null;
  evidenceId: string | null;
  detectionDigest?: string | null;
};

export type SelectionCandidate = {
  candidateId: string;
  /** What the user is choosing between. Enough to render, not to shop. */
  label: string | null;
  category: string | null;
  /** Phase 7. See `SanitizedDetectedGarment.clothingType` in multiItemGarments.ts. */
  clothingType: string | null;
  subtype: string | null;
  bounds?: unknown;
  /**
   * The exact object to send back with the selected-item request. Per candidate
   * rather than per response, so a client cannot pair candidate A's id with
   * candidate B's lineage.
   */
  selectionToken: SelectionLineage & { candidateId: string };
};

export type SelectionRequiredPayload = {
  selectionContractVersion: string;
  applicationState: Extract<ScanJourneyState, 'MULTI_ITEM_SELECTION_REQUIRED'>;
  /** Literal `true`. An explicit field, never inferred from an array length. */
  selectionRequired: true;
  /**
   * Named `selectionCandidates`, NOT `candidates`.
   *
   * A V2 response already carries `identificationV2.candidates` with a
   * different shape. Two differently-shaped `candidates` in one payload — one
   * at the root, one nested — is exactly the ambiguity a client team
   * implementing this would trip over, and the cost of avoiding it is one
   * clearer name.
   */
  selectionCandidates: SelectionCandidate[];
  lineage: SelectionLineage;
  /**
   * States plainly, in the payload, that no identification is being asserted.
   * A client that ignores `selectionRequired` and looks for a reason will still
   * find one.
   */
  primarySuppressedReason: 'backend_must_not_guess_selection';
};

type RawGarment = {
  candidateId?: unknown;
  label?: unknown;
  category?: unknown;
  clothingType?: unknown;
  subtype?: unknown;
  bounds?: unknown;
};

function str(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Builds the selection payload.
 *
 * Returns null when there is nothing to choose between — zero or one garment is
 * not a selection problem, and emitting `MULTI_ITEM_SELECTION_REQUIRED` for a
 * single garment would block a journey that has no ambiguity in it.
 */
export function buildSelectionRequiredPayload(input: {
  detectedGarments: RawGarment[];
  lineage: SelectionLineage;
}): SelectionRequiredPayload | null {
  const garments = Array.isArray(input.detectedGarments) ? input.detectedGarments : [];
  if (garments.length < 2) return null;

  const candidates: SelectionCandidate[] = [];
  for (const garment of garments) {
    const candidateId = str(garment.candidateId, 64);
    // A candidate with no id cannot be selected, and offering it would produce
    // a request the backend must reject. Dropped rather than shown.
    if (!candidateId) continue;
    candidates.push({
      candidateId,
      label: str(garment.label),
      category: str(garment.category, 60),
      clothingType: str(garment.clothingType, 60),
      subtype: str(garment.subtype, 60),
      ...(garment.bounds ? { bounds: garment.bounds } : {}),
      selectionToken: { ...input.lineage, candidateId },
    });
  }

  if (candidates.length < 2) return null;

  return {
    selectionContractVersion: SELECTION_CONTRACT_VERSION,
    applicationState: 'MULTI_ITEM_SELECTION_REQUIRED',
    selectionRequired: true,
    selectionCandidates: candidates,
    lineage: input.lineage,
    primarySuppressedReason: 'backend_must_not_guess_selection',
  };
}

/**
 * Neutralizes the identity a V2 envelope asserts when selection is required.
 *
 * FOUND IN VALIDATION. Suppressing the legacy `identification` was not enough:
 * `normalizeToV2` treats `multiple_items_need_selection` as identity-bearing,
 * so `identificationV2.item.category`, `.subtype` and `.brand` are populated
 * from the SAME guessed primary the legacy fields were stripped of. A V2 client
 * therefore still received "we identified this jacket" for an image containing
 * four garments — the guess survived the suppression by living one level down.
 *
 * Handled here rather than in `fashionIdentificationV2.ts` deliberately: that
 * module is shared with other functions and pinned by the cross-path parity
 * manifest, so changing its semantics is a wider blast radius than this
 * checkpoint should take. The identity fields are blanked on the way out; the
 * candidates in the V2 envelope are left intact, because those are the answer.
 *
 * Phase 7: `clothingType` is exactly the same kind of guessed-primary identity
 * field as `category` and `subtype` — `normalizeToV2` populates it from the
 * same identity-bearing path — so it is blanked here too. Leaving it out would
 * reopen the precise leak this function exists to close, one field over.
 */
export function suppressV2GuessedIdentity(v2: unknown): unknown {
  if (!v2 || typeof v2 !== 'object' || Array.isArray(v2)) return v2;
  const record = v2 as Record<string, unknown>;
  if (record.status !== 'multiple_items_need_selection') return v2;

  const item = record.item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return v2;
  const itemRecord = item as Record<string, unknown>;

  const brand = itemRecord.brand && typeof itemRecord.brand === 'object' && !Array.isArray(itemRecord.brand)
    ? { ...(itemRecord.brand as Record<string, unknown>), value: null, confidence: null }
    : itemRecord.brand;

  return {
    ...record,
    resolutionLevel: 'unknown',
    item: {
      ...itemRecord,
      category: null,
      clothingType: null,
      subtype: null,
      brand,
    },
  };
}

/**
 * Fields that must be REMOVED from a response when selection is required.
 *
 * Exported as data rather than applied inline so the suppression is auditable:
 * a test can assert the exact list, and a future field that would re-introduce
 * a guess has one obvious place to be added.
 */
export const SUPPRESSED_WHEN_SELECTION_REQUIRED: readonly string[] = [
  'identification',
  'attributes',
  'displayResult',
  'userMessage',
] as const;

/**
 * Strips the guessed primary from a response body.
 *
 * `detectedGarments` is deliberately NOT stripped — the candidates are the
 * answer to a multi-item scan, and the client needs them to render the choice.
 * What is removed is only the pretence that one of them was identified.
 */
export function suppressGuessedPrimary<T extends Record<string, unknown>>(body: T): T {
  const out: Record<string, unknown> = { ...body };
  for (const field of SUPPRESSED_WHEN_SELECTION_REQUIRED) delete out[field];
  return out as T;
}

// ── Selected-item validation ─────────────────────────────────────────────────

export type SelectionValidationFailure =
  | 'missing_selection_token'
  | 'missing_candidate_id'
  | 'lineage_mismatch_scan_session'
  | 'lineage_mismatch_image_digest'
  | 'unknown_candidate';

export type SelectionValidationResult =
  | { ok: true; candidateId: string }
  | { ok: false; reason: SelectionValidationFailure };

/**
 * Validates a selected-item request against the detection it claims to follow.
 *
 * Every check is a REJECTION, never a repair. If the lineage does not match,
 * the correct answer is to fail loudly and let the client re-detect — silently
 * proceeding would mean matching products against an image the user is no
 * longer looking at, which is precisely the "backend guesses" failure this
 * contract exists to remove, arriving by a different door.
 *
 * `expected` values of null are treated as "the backend did not emit this",
 * and the corresponding check is skipped rather than failed. The deployed
 * backend does not emit a detection digest, and failing every request over a
 * field that is structurally absent would take the whole journey offline.
 */
export function validateSelectedItemRequest(input: {
  token: Partial<SelectionLineage & { candidateId: string }> | null | undefined;
  expected: SelectionLineage;
  knownCandidateIds?: string[];
}): SelectionValidationResult {
  const { token, expected } = input;
  if (!token || typeof token !== 'object') {
    return { ok: false, reason: 'missing_selection_token' };
  }

  const candidateId = str(token.candidateId, 64);
  if (!candidateId) return { ok: false, reason: 'missing_candidate_id' };

  if (expected.scanSessionId && token.scanSessionId !== expected.scanSessionId) {
    return { ok: false, reason: 'lineage_mismatch_scan_session' };
  }
  if (expected.imageDigestPrefix && token.imageDigestPrefix !== expected.imageDigestPrefix) {
    return { ok: false, reason: 'lineage_mismatch_image_digest' };
  }

  if (Array.isArray(input.knownCandidateIds) && input.knownCandidateIds.length > 0) {
    if (!input.knownCandidateIds.includes(candidateId)) {
      return { ok: false, reason: 'unknown_candidate' };
    }
  }

  return { ok: true, candidateId };
}
