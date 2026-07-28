// Elise identify-for-style orchestration (Phase 2B.3).
//
// THE SINGLE NETWORK ENTRY POINT FOR ELISE IDENTIFICATION. Direct camera, direct
// gallery and every image of a header-gallery selection call
// `identifyPreparedImageForStyle`. With the flag on, a direct legacy
// `identifyScanImage` call happens in exactly one place — the bounded
// UNSUPPORTED_CONTRACT_VERSION fallback below — and its response is handed to
// callers so none of them re-purchases it. Flag-off paths are untouched legacy
// by definition. The fallback-governance tests in
// `__tests__/eliseIdentificationV2Migration.test.js` pin both properties.
//
// Kept separate from `eliseIdentificationV2.ts` so that module stays pure —
// request building, validation and telemetry there are testable with no
// transport, no Supabase client and no mocking.
//
// SHAPE OF ONE OPERATION (Part VIII):
//
//   prepared evidence
//     → detect_items          / identify_for_style
//     → candidate resolution  (auto-continue on exactly one, aggregate for an
//                              outfit path, defer to selection for an item path)
//     → identify_selected_item / identify_for_style
//
// Two network stages, ONE guarded attachment operation. The evidence id is minted
// once and reused across both stages, because the bytes detection ran on must be
// the bytes the selected-item request re-sends.

import { identifyScanImage, type IdentifyScanOptions } from '../scanIdentification';
import type { ScanIdentifyResponse } from '../../types/scanIdentification';
import type {
  FashionIdentificationPlatform,
  FashionIdentificationResultV2,
} from '../../types/fashionIdentificationV2';
import type { PreparedFashionEvidenceObject } from '../fashionEvidenceGateway';
import {
  isUnsupportedContractVersion,
  extractFashionV2Candidates,
  validateFashionV2Response,
  type FashionCandidateCorrelation,
  type FashionLegacyCorrelation,
  type FashionV2Mode,
} from '../fashionIdentificationV2Core';
import {
  buildEliseV2Request,
  validateEliseV2Request,
  type EliseEntryPathKey,
  type EliseV2RejectReason,
  type EliseV2SessionFlag,
} from './eliseIdentificationV2';

export type EliseIdentificationTransport = (
  image: string,
  options: IdentifyScanOptions,
) => Promise<ScanIdentifyResponse>;

export type EliseStageOutcome = {
  /** Which contract actually produced `response`. */
  contractPath: 'v2' | 'legacy';
  response: ScanIdentifyResponse;
  /** Validated V2 identity, or null on the legacy path. */
  identificationV2: FashionIdentificationResultV2 | null;
  /** Detection candidates correlated to this request's evidence. */
  candidates: FashionCandidateCorrelation[];
  /** Server-issued correlation to carry into the selected-item request. */
  legacyCorrelation: FashionLegacyCorrelation;
  /** True only after an UNSUPPORTED_CONTRACT_VERSION legacy retry. */
  fallbackUsed: boolean;
  /** Set when the request was rejected locally, before any network call. */
  rejection?: EliseV2RejectReason;
  /**
   * Set when a V2 response arrived but failed structural validation. This is NOT
   * a fallback trigger — it is a real failure of a backend that claims to
   * implement the contract, and hiding it behind a legacy retry would mask a
   * genuine server defect while charging the user a second scan.
   */
  v2ValidationFailure?: string;
};

export type RunEliseStageInput = {
  mode: FashionV2Mode;
  evidence: PreparedFashionEvidenceObject;
  entryPath: EliseEntryPathKey;
  platform: FashionIdentificationPlatform;
  requestId: string;
  appVersion?: string;
  sessionFlag: EliseV2SessionFlag;
  selectedCandidate?: FashionCandidateCorrelation;
  /** Server-issued correlation the deployed handler still requires. */
  legacyCorrelation?: FashionLegacyCorrelation;
  signal?: AbortSignal;
  /** Injected in tests. Defaults to the real transport. */
  transport?: EliseIdentificationTransport;
};

/**
 * Reads the server-issued correlation pair off a response.
 *
 * These come from the SERVER. Nothing here computes, guesses or substitutes
 * either value, and neither is ever written into
 * `selectedCandidate.detectionDigest` — a session id is not a detection digest.
 */
function readLegacyCorrelation(response: unknown): FashionLegacyCorrelation {
  if (!response || typeof response !== 'object') return {};
  const record = response as Record<string, unknown>;
  const scanSessionId = typeof record.scanSessionId === 'string' && record.scanSessionId.trim()
    ? record.scanSessionId
    : undefined;
  const imageDigestPrefix =
    typeof record.imageDigestPrefix === 'string' && record.imageDigestPrefix.trim()
      ? record.imageDigestPrefix
      : undefined;
  return {
    ...(scanSessionId ? { scanSessionId } : {}),
    ...(imageDigestPrefix ? { imageDigestPrefix } : {}),
  };
}

/**
 * The legacy request this Elise operation would have sent with the flag off.
 *
 * Built from the SAME prepared derivative and the SAME server-issued
 * correlation, so a fallback re-sends identical bytes. Nothing is recompressed,
 * re-oriented or re-prepared, and no new evidence id is minted for the operation
 * being retried.
 *
 * `source: 'upload'` for a gallery image and `'camera'` for a capture is exactly
 * what the current Elise paths already send.
 */
function legacyOptionsFor(input: RunEliseStageInput): IdentifyScanOptions {
  const isSelected = input.mode === 'identify_selected_item';
  return {
    source: input.evidence.source === 'camera' ? 'camera' : 'upload',
    // Truthful: metadata stripping and re-encoding are not face or plate masking.
    localPrivacyFiltered: false,
    multiItemDetection: true,
    requestMode: isSelected ? 'selected_item' : 'multi_item_detection',
    ...(input.legacyCorrelation?.scanSessionId
      ? { scanSessionId: input.legacyCorrelation.scanSessionId }
      : {}),
    ...(input.legacyCorrelation?.imageDigestPrefix
      ? { imageDigestPrefix: input.legacyCorrelation.imageDigestPrefix }
      : {}),
    ...(isSelected && input.selectedCandidate
      ? {
        selectedCandidate: {
          candidateId: input.selectedCandidate.candidateId,
          category: input.selectedCandidate.category,
          ...(input.selectedCandidate.subtype ? { subtype: input.selectedCandidate.subtype } : {}),
          ...(input.selectedCandidate.bounds ? { bounds: input.selectedCandidate.bounds } : {}),
        },
      }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

function rejected(reason: EliseV2RejectReason): EliseStageOutcome {
  return {
    contractPath: 'v2',
    response: { status: 'failed', recommendedProducts: [] },
    identificationV2: null,
    candidates: [],
    legacyCorrelation: {},
    fallbackUsed: false,
    rejection: reason,
  };
}

/** One V2 network stage: detection or selected-item identification. */
export async function runEliseIdentificationStage(
  input: RunEliseStageInput,
): Promise<EliseStageOutcome> {
  const send = input.transport ?? identifyScanImage;
  const legacyOptions = legacyOptionsFor(input);

  // Flag off → the legacy path, unchanged. The session-latched value is used,
  // never a fresh read, so an operation cannot switch contracts mid-flight.
  if (!input.sessionFlag?.enabled) {
    const response = await send(input.evidence.imageBase64, legacyOptions);
    return {
      contractPath: 'legacy',
      response,
      identificationV2: null,
      candidates: [],
      legacyCorrelation: readLegacyCorrelation(response),
      fallbackUsed: false,
    };
  }

  const built = buildEliseV2Request({
    mode: input.mode,
    evidence: input.evidence,
    entryPath: input.entryPath,
    platform: input.platform,
    requestId: input.requestId,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    ...(input.selectedCandidate ? { selectedCandidate: input.selectedCandidate } : {}),
  });

  // A missing or mismatched correlation value is rejected HERE, with no network
  // call: sending it would either 400 or, worse, identify the selected candidate
  // against a different image's bytes.
  if (built.kind === 'rejected') return rejected(built.reason);
  if (!validateEliseV2Request(built.request)) return rejected('invalid_evidence');

  const response = await send(input.evidence.imageBase64, {
    ...legacyOptions,
    contractRequestV2: built.request as unknown as Record<string, unknown>,
  });

  // ── The ONE permitted fallback ────────────────────────────────────────────
  // HTTP 400 + UNSUPPORTED_CONTRACT_VERSION is the backend stating plainly that
  // it does not implement this contract — the only condition under which
  // retrying the same operation on the legacy contract is correct and lossless.
  // Exactly one retry, same prepared derivative, same evidence id, never in
  // parallel with the V2 attempt, and never looped.
  if (isUnsupportedContractVersion({
    httpStatus: response.httpStatus ?? null,
    errorCode: response.contractErrorCode ?? null,
  })) {
    const legacyResponse = await send(input.evidence.imageBase64, legacyOptions);
    return {
      contractPath: 'legacy',
      response: legacyResponse,
      identificationV2: null,
      candidates: [],
      legacyCorrelation: readLegacyCorrelation(legacyResponse),
      fallbackUsed: true,
    };
  }

  // Every other failure keeps its real identity. A timeout, a dropped
  // connection, an HTTP 500, an auth or quota failure, a technical_failure or
  // insufficient_visual_evidence result: none of these say anything about
  // contract support, so none of them may trigger a second scan.
  const correlation = readLegacyCorrelation(response);
  if (!Object.prototype.hasOwnProperty.call(response, 'identificationV2')) {
    return {
      contractPath: 'v2',
      response,
      identificationV2: null,
      candidates: [],
      legacyCorrelation: correlation,
      fallbackUsed: false,
      ...(response.status === 'failed' ? {} : { v2ValidationFailure: 'missing_identification_v2' }),
    };
  }

  const validated = validateFashionV2Response(response.identificationV2);
  if (validated.kind === 'invalid') {
    return {
      contractPath: 'v2',
      response,
      identificationV2: null,
      candidates: [],
      legacyCorrelation: correlation,
      fallbackUsed: false,
      v2ValidationFailure: validated.category,
    };
  }

  return {
    contractPath: 'v2',
    response,
    identificationV2: validated.result,
    candidates: extractFashionV2Candidates(validated.result, input.evidence.evidenceId),
    legacyCorrelation: correlation,
    fallbackUsed: false,
  };
}

// ── Full two-stage operation ─────────────────────────────────────────────────

/**
 * How a path resolves several detected candidates.
 *
 *   `item`   — the UX analyzes ONE garment. Several candidates require an
 *              explicit user choice; the orchestrator returns them and does not
 *              pick. Choosing "the top one" would be the client guessing.
 *   `outfit` — the UX analyzes a whole fashion image. Every valid candidate the
 *              backend reported is identified and aggregated into one context.
 */
export type EliseCandidatePolicy = 'item' | 'outfit';

export type EliseIdentifyResultState =
  | 'ready'
  | 'partial'
  | 'insufficient_evidence'
  | 'non_fashion'
  | 'technical_failure'
  | 'needs_selection'
  | 'cancelled'
  | 'legacy_fallback';

export type EliseIdentifyResult = {
  state: EliseIdentifyResultState;
  /** Validated identities, in candidate order. Empty unless ready/partial. */
  identifications: FashionIdentificationResultV2[];
  /** Populated only for `needs_selection`. */
  candidates: FashionCandidateCorrelation[];
  /** Set on `legacy_fallback` so the caller can run its own legacy path. */
  legacyResponse?: ScanIdentifyResponse;
  fallbackUsed: boolean;
  /** Bounded diagnostic code. Never a provider message or a raw value. */
  failureCode?: string;
};

/** Maps a V2 result status onto the caller-facing outcome. */
function stateForStatus(result: FashionIdentificationResultV2): EliseIdentifyResultState {
  switch (result.status) {
    case 'completed':
      return 'ready';
    case 'partial':
      return 'partial';
    case 'non_fashion':
      return 'non_fashion';
    case 'insufficient_visual_evidence':
      return 'insufficient_evidence';
    default:
      return 'technical_failure';
  }
}

/**
 * Maps a DETECTION status onto the caller-facing outcome.
 *
 * `multiple_items_need_selection` is the backend's NORMAL answer to a
 * `detect_items` request that found garments: `scan-identify` sets that outcome
 * whenever the multi-item detection provider returned at least one candidate,
 * and every V2 detection request enables that provider. It is a continue
 * signal, not a failure.
 *
 * Routing it through `stateForStatus` would hit the `default` branch and
 * classify each real multi-candidate detection as `technical_failure`,
 * discarding the candidates the request just paid for — while Scanner, which
 * does not map status to a state at all, carries the same candidates forward.
 * That divergence is the defect; the two paths must read one canonical status
 * the same way.
 *
 * Kept separate from `stateForStatus` because the selected-item stage is a
 * different question: a SELECTION that came back "still needs selection" is
 * genuinely anomalous and must stay a failure there.
 */
function detectionStateForStatus(result: FashionIdentificationResultV2): EliseIdentifyResultState {
  return result.status === 'multiple_items_need_selection'
    ? 'ready'
    : stateForStatus(result);
}

/**
 * Identify ONE prepared image for styling.
 *
 * Runs detection, then resolves candidates according to `policy`, then runs one
 * selected-item request per candidate it is allowed to identify. All of it is one
 * guarded attachment operation from the caller's point of view.
 *
 * A single candidate failing does NOT discard the ones that succeeded: an outfit
 * where three of four garments resolved is still useful styling evidence, and
 * throwing it away because the fourth timed out would be a worse answer than a
 * partial one.
 */
export async function identifyPreparedImageForStyle(input: {
  evidence: PreparedFashionEvidenceObject;
  entryPath: EliseEntryPathKey;
  platform: FashionIdentificationPlatform;
  requestId: string;
  appVersion?: string;
  sessionFlag: EliseV2SessionFlag;
  policy: EliseCandidatePolicy;
  signal?: AbortSignal;
  transport?: EliseIdentificationTransport;
  /** Checked between stages so a removed attachment stops costing money. */
  isCurrent?: () => boolean;
}): Promise<EliseIdentifyResult> {
  const stillCurrent = () => {
    if (input.signal?.aborted) return false;
    return input.isCurrent ? input.isCurrent() === true : true;
  };
  if (!stillCurrent()) {
    return { state: 'cancelled', identifications: [], candidates: [], fallbackUsed: false };
  }

  const detection = await runEliseIdentificationStage({
    mode: 'detect_items',
    evidence: input.evidence,
    entryPath: input.entryPath,
    platform: input.platform,
    requestId: input.requestId,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    sessionFlag: input.sessionFlag,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
  });

  if (!stillCurrent()) {
    return { state: 'cancelled', identifications: [], candidates: [], fallbackUsed: detection.fallbackUsed };
  }

  // The backend does not implement V2 → hand the legacy response back so the
  // caller can preserve its exact current path for this platform.
  if (detection.contractPath === 'legacy') {
    return {
      state: 'legacy_fallback',
      identifications: [],
      candidates: [],
      legacyResponse: detection.response,
      fallbackUsed: detection.fallbackUsed,
    };
  }
  if (detection.rejection) {
    return {
      state: 'technical_failure',
      identifications: [],
      candidates: [],
      fallbackUsed: false,
      failureCode: `rejected_${detection.rejection}`,
    };
  }
  if (!detection.identificationV2) {
    return {
      state: 'technical_failure',
      identifications: [],
      candidates: [],
      fallbackUsed: false,
      failureCode: detection.v2ValidationFailure ?? 'detection_failed',
    };
  }

  // Detection itself may terminate the operation honestly: non-fashion and
  // insufficient evidence are real answers, not failures to work around.
  const detectionState = detectionStateForStatus(detection.identificationV2);
  if (detectionState === 'non_fashion' || detectionState === 'insufficient_evidence') {
    return { state: detectionState, identifications: [], candidates: [], fallbackUsed: false };
  }
  if (detectionState === 'technical_failure') {
    return {
      state: 'technical_failure',
      identifications: [],
      candidates: [],
      fallbackUsed: false,
      failureCode: 'detection_technical_failure',
    };
  }

  const candidates = detection.candidates;

  // Zero candidates from a completed detection means the backend saw the image
  // and found no garment worth identifying.
  if (candidates.length === 0) {
    return { state: 'insufficient_evidence', identifications: [], candidates: [], fallbackUsed: false };
  }

  // Several candidates on an ITEM path require an explicit user choice. The
  // orchestrator returns them untouched — never the first, never the
  // highest-ranked.
  if (candidates.length > 1 && input.policy === 'item') {
    return { state: 'needs_selection', identifications: [], candidates, fallbackUsed: false };
  }

  // One candidate auto-continues; an outfit path identifies the whole bounded
  // set the backend reported. No new client-side maximum is introduced — the
  // backend's candidate bound is the bound.
  const targets = candidates.length === 1 ? [candidates[0]] : candidates;
  const identifications: FashionIdentificationResultV2[] = [];
  let anyPartial = false;
  let lastFailureCode: string | null = null;

  for (const candidate of targets) {
    if (!stillCurrent()) {
      // Keep whatever already succeeded rather than discarding it.
      break;
    }
    const selected = await runEliseIdentificationStage({
      mode: 'identify_selected_item',
      evidence: input.evidence,
      entryPath: input.entryPath,
      platform: input.platform,
      requestId: input.requestId,
      ...(input.appVersion ? { appVersion: input.appVersion } : {}),
      sessionFlag: input.sessionFlag,
      selectedCandidate: candidate,
      // The server-issued pair from DETECTION, carried forward verbatim.
      legacyCorrelation: detection.legacyCorrelation,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.transport ? { transport: input.transport } : {}),
    });

    if (!selected.identificationV2) {
      lastFailureCode =
        selected.v2ValidationFailure ??
        (selected.rejection ? `rejected_${selected.rejection}` : 'selection_failed');
      continue;
    }
    const state = stateForStatus(selected.identificationV2);
    if (state === 'ready' || state === 'partial') {
      if (state === 'partial') anyPartial = true;
      identifications.push(selected.identificationV2);
    } else {
      lastFailureCode = `selection_${state}`;
    }
  }

  if (identifications.length === 0) {
    if (!stillCurrent()) {
      return { state: 'cancelled', identifications: [], candidates: [], fallbackUsed: false };
    }
    return {
      state: 'technical_failure',
      identifications: [],
      candidates: [],
      fallbackUsed: false,
      failureCode: lastFailureCode ?? 'selection_failed',
    };
  }

  // A partial garment, or an outfit that lost a garment, is `partial`: honest
  // about being incomplete while still carrying real evidence.
  const lostSome = identifications.length < targets.length;
  return {
    state: anyPartial || lostSome ? 'partial' : 'ready',
    identifications,
    candidates: [],
    fallbackUsed: false,
    ...(lostSome && lastFailureCode ? { failureCode: lastFailureCode } : {}),
  };
}
