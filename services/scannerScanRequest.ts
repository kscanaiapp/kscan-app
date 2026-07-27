// Scanner identification orchestration (Phase 2B.2).
//
// THE SINGLE NETWORK ENTRY POINT FOR SCANNER. Camera, gallery, retry, every
// image of an Android batch, detection and selection all call
// `runScannerIdentification`. The path-governance test asserts that no active
// Scanner path calls `identifyScanImage` directly.
//
// Kept separate from `scannerIdentificationV2.ts` so that module stays pure —
// request building, validation and telemetry there are testable with no
// transport, no Supabase client and no mocking.

import { identifyScanImage, type IdentifyScanOptions } from './scanIdentification';
import type { ScanIdentifyResponse } from '../types/scanIdentification';
import type {
  FashionIdentificationResultV2,
  FashionIdentificationPlatform,
} from '../types/fashionIdentificationV2';
import type { PreparedScannerEvidence } from './scannerEvidenceGateway';
import {
  buildScannerV2Request,
  extractScannerV2Candidates,
  isUnsupportedContractVersion,
  validateScannerV2Request,
  validateScannerV2Response,
  type ScannerCandidateCorrelation,
  type ScannerLegacyCorrelation,
  type ScannerV2Mode,
  type ScannerV2RejectReason,
  type ScannerV2SessionFlag,
} from './scannerIdentificationV2';

export type ScannerIdentificationOutcome = {
  /** Which contract actually produced `response`. */
  contractPath: 'v2' | 'legacy';
  response: ScanIdentifyResponse;
  /** Validated V2 identity, or null on the legacy path. */
  identificationV2: FashionIdentificationResultV2 | null;
  /** Detection candidates correlated to this request's evidence. */
  candidates: ScannerCandidateCorrelation[];
  /** True only after an UNSUPPORTED_CONTRACT_VERSION legacy retry. */
  fallbackUsed: boolean;
  /** Set when the request was rejected locally, before any network call. */
  rejection?: ScannerV2RejectReason;
  /**
   * Set when a V2 response arrived but failed structural validation. This is
   * NOT a fallback trigger — it is a real failure of a backend that claims to
   * implement the contract, and hiding it behind a legacy retry would mask a
   * genuine server defect while charging the user a second scan.
   */
  v2ValidationFailure?: string;
};

export type RunScannerIdentificationInput = {
  mode: ScannerV2Mode;
  evidence: PreparedScannerEvidence;
  platform: FashionIdentificationPlatform;
  requestId: string;
  appVersion?: string;
  sessionFlag: ScannerV2SessionFlag;
  selectedCandidate?: ScannerCandidateCorrelation;
  /** Server-issued correlation the deployed handler still requires. */
  legacyCorrelation?: ScannerLegacyCorrelation;
  localPrivacyFiltered?: boolean;
  signal?: AbortSignal;
  /** Injected in tests. Defaults to the real transport. */
  transport?: (image: string, options: IdentifyScanOptions) => Promise<ScanIdentifyResponse>;
};

/**
 * The legacy request this Scanner operation would have sent with the flag off.
 *
 * Built from the SAME prepared derivative and the SAME server-issued
 * correlation, so a fallback re-sends identical bytes. Nothing is recompressed,
 * re-oriented or re-prepared, and no new evidence id is minted for the
 * operation being retried.
 */
function legacyOptionsFor(input: RunScannerIdentificationInput): IdentifyScanOptions {
  const isSelected = input.mode === 'identify_selected_item';
  return {
    source: input.evidence.source === 'gallery' ? 'upload' : 'camera',
    localPrivacyFiltered: input.localPrivacyFiltered === true,
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

export async function runScannerIdentification(
  input: RunScannerIdentificationInput,
): Promise<ScannerIdentificationOutcome> {
  const send = input.transport ?? identifyScanImage;
  const legacyOptions = legacyOptionsFor(input);

  // Flag off → the legacy path, unchanged. The session-latched value is used,
  // never a fresh read, so an operation cannot switch contracts mid-flight.
  if (!input.sessionFlag?.enabled) {
    const response = await send(input.evidence.imageBase64, legacyOptions);
    return { contractPath: 'legacy', response, identificationV2: null, candidates: [], fallbackUsed: false };
  }

  const built = buildScannerV2Request({
    mode: input.mode,
    evidence: input.evidence,
    platform: input.platform,
    requestId: input.requestId,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    ...(input.selectedCandidate ? { selectedCandidate: input.selectedCandidate } : {}),
  });

  // A missing or mismatched correlation value is rejected HERE, with no network
  // call: sending it would either 400 or, worse, identify the selected
  // candidate against a different image's bytes.
  if (built.kind === 'rejected') {
    return {
      contractPath: 'v2',
      response: { status: 'failed', recommendedProducts: [] },
      identificationV2: null,
      candidates: [],
      fallbackUsed: false,
      rejection: built.reason,
    };
  }
  if (!validateScannerV2Request(built.request)) {
    return {
      contractPath: 'v2',
      response: { status: 'failed', recommendedProducts: [] },
      identificationV2: null,
      candidates: [],
      fallbackUsed: false,
      rejection: 'invalid_evidence',
    };
  }

  const response = await send(input.evidence.imageBase64, {
    ...legacyOptions,
    contractRequestV2: built.request as unknown as Record<string, unknown>,
  });

  // ── The ONE permitted fallback ────────────────────────────────────────────
  // HTTP 400 + UNSUPPORTED_CONTRACT_VERSION is the backend stating plainly that
  // it does not implement this contract — the only condition under which
  // retrying the same scan on the legacy contract is correct and lossless.
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
      fallbackUsed: true,
    };
  }

  // Every other failure keeps its real identity. A timeout, a dropped
  // connection, an HTTP 500, an auth or quota failure, a technical_failure or
  // insufficient_visual_evidence result: none of these say anything about
  // contract support, so none of them may trigger a second scan.
  if (!Object.prototype.hasOwnProperty.call(response, 'identificationV2')) {
    return {
      contractPath: 'v2',
      response,
      identificationV2: null,
      candidates: [],
      fallbackUsed: false,
      ...(response.status === 'failed' ? {} : { v2ValidationFailure: 'missing_identification_v2' }),
    };
  }

  const validated = validateScannerV2Response(response.identificationV2);
  if (validated.kind === 'invalid') {
    return {
      contractPath: 'v2',
      response,
      identificationV2: null,
      candidates: [],
      fallbackUsed: false,
      v2ValidationFailure: validated.category,
    };
  }

  return {
    contractPath: 'v2',
    response,
    identificationV2: validated.result,
    candidates: extractScannerV2Candidates(validated.result, input.evidence.evidenceId),
    fallbackUsed: false,
  };
}
