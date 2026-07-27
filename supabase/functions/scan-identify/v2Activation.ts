// Phase 2B.1 — fashion-identification-v2 activation for scan-identify.
//
// WHY THIS MODULE EXISTS SEPARATELY FROM index.ts: the handler is ~1750 lines
// with many exit points and hard Deno/provider dependencies, so logic embedded
// in it cannot be unit-tested without standing up the whole Edge Function.
// Everything here is pure — no Deno globals, no remote imports, no I/O — so the
// routing, validation, mapping, gating and response-shaping decisions are
// directly testable. index.ts calls into this and keeps its own pipeline.
//
// This is an ACTIVATION layer, not a second implementation. Validation and
// normalization come from ../_shared/fashionIdentificationV2.ts; this module
// routes to them, adapts V2 into the request shape the existing pipeline
// already consumes, and shapes the transitional response.

import {
  classifyContractVersion,
  normalizeToV2,
  projectV2ToLegacy,
  shouldRunCommerce,
  validateFashionIdentificationRequestV2,
  FASHION_IDENTIFICATION_CONTRACT_V2,
  FASHION_IDENTIFICATION_RESOLUTION_LEVELS,
  FASHION_IDENTIFICATION_STATUSES,
  LEGACY_DEFAULT_INTENT,
  type FashionIdentificationIntent,
  type FashionIdentificationMode,
  type FashionIdentificationRequestV2,
  type FashionIdentificationResultV2,
  type FashionIdentificationStatus,
  type ValidationFailure,
} from '../_shared/fashionIdentificationV2.ts';

// ── Bounded client-error contract ────────────────────────────────────────────

/**
 * Every client-caused contract failure maps to one of these. Bounded on purpose:
 * a code is a stable thing a client can branch on, whereas a free-form message
 * invites callers to string-match, and an exception message risks leaking a
 * request body, a Base64 excerpt, or provider output.
 */
export const V2_ERROR_CODES = [
  'UNSUPPORTED_CONTRACT_VERSION',
  'MALFORMED_REQUEST',
  'MISSING_INTENT',
  'INVALID_INTENT',
  'INVALID_MODE',
  'INVALID_SOURCE',
  'INVALID_PRIVACY',
  'INVALID_EVIDENCE',
  'INVALID_EVIDENCE_ID',
  'MULTIPLE_EVIDENCE_NOT_SUPPORTED',
  'MISSING_SELECTED_CANDIDATE',
  'INVALID_SELECTED_CANDIDATE',
  'PAYLOAD_TOO_LARGE',
] as const;

export type V2ErrorCode = typeof V2_ERROR_CODES[number];

/** Foundation validation code → bounded HTTP contract code. */
const VALIDATION_CODE_TO_HTTP: Record<ValidationFailure['errorCode'], V2ErrorCode> = {
  unsupported_contract_version: 'UNSUPPORTED_CONTRACT_VERSION',
  malformed_request: 'MALFORMED_REQUEST',
  missing_intent: 'MISSING_INTENT',
  invalid_intent: 'INVALID_INTENT',
  invalid_mode: 'INVALID_MODE',
  invalid_source: 'INVALID_SOURCE',
  invalid_privacy: 'INVALID_PRIVACY',
  invalid_evidence: 'INVALID_EVIDENCE',
  invalid_evidence_id: 'INVALID_EVIDENCE_ID',
  too_many_evidence_entries: 'MULTIPLE_EVIDENCE_NOT_SUPPORTED',
  duplicate_evidence_id: 'INVALID_EVIDENCE_ID',
  invalid_transport: 'INVALID_EVIDENCE',
  invalid_selected_candidate: 'INVALID_SELECTED_CANDIDATE',
};

/** Static, client-safe copy. Never derived from the request or an exception. */
const ERROR_MESSAGES: Record<V2ErrorCode, string> = {
  UNSUPPORTED_CONTRACT_VERSION: 'Unsupported contract version.',
  MALFORMED_REQUEST: 'Malformed request.',
  MISSING_INTENT: 'Request intent is required.',
  INVALID_INTENT: 'Unsupported request intent.',
  INVALID_MODE: 'Unsupported request mode.',
  INVALID_SOURCE: 'Request source is required.',
  INVALID_PRIVACY: 'Invalid privacy attestation.',
  INVALID_EVIDENCE: 'Invalid request evidence.',
  INVALID_EVIDENCE_ID: 'Invalid evidence identifier.',
  MULTIPLE_EVIDENCE_NOT_SUPPORTED: 'Only one evidence payload per request is supported.',
  MISSING_SELECTED_CANDIDATE: 'A selected candidate is required for this mode.',
  INVALID_SELECTED_CANDIDATE: 'Invalid selected candidate.',
  PAYLOAD_TOO_LARGE: 'Request payload is too large.',
};

export type V2ContractErrorBody = {
  status: 'failed';
  error: { code: V2ErrorCode; message: string };
};

/**
 * The one place a contract error body is built. Callers may not pass their own
 * message, which is what keeps raw exception text and request content out of
 * client responses by construction.
 */
export function buildContractErrorBody(code: V2ErrorCode): V2ContractErrorBody {
  return { status: 'failed', error: { code, message: ERROR_MESSAGES[code] } };
}

// ── Internal canonical request ───────────────────────────────────────────────

/**
 * The internal representation both entry paths converge on.
 *
 * These field names deliberately match what the existing pipeline already reads
 * (`multiItemDetection`, `requestMode`, `selectedCandidate`), so activation is a
 * mapping rather than a rewrite of the provider stage.
 */
export type InternalScanRequest = {
  contractPath: 'v2' | 'legacy';
  intent: FashionIdentificationIntent;
  /** True only for a legacy request that carried no intent of its own. */
  intentDefaulted: boolean;
  resolvedMode: 'detect_items' | 'identify_selected_item' | 'legacy_single_item';
  multiItemDetection: boolean;
  requestMode: 'multi_item_detection' | 'selected_item' | 'legacy_single_item';
  selectedCandidate?: {
    candidateId: string;
    category: string;
    subtype?: string;
    bounds?: { x: number; y: number; width: number; height: number };
  };
  /** Present only on the V2 path; echoed verbatim in the V2 response. */
  evidenceId?: string;
  detectionDigest?: string;
  requestId?: string;
  entryPath?: string;
  platform?: string;
  imageBase64?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * How a LEGACY request selects its behaviour today, preserved exactly.
 *
 * Legacy clients must not be required to send a mode. This reads the fields they
 * already send and produces the same internal mode the V2 path produces, so
 * there is one downstream shape rather than two.
 */
export function resolveLegacyInternalMode(
  body: unknown,
): 'detect_items' | 'identify_selected_item' | 'legacy_single_item' {
  if (!isRecord(body)) return 'legacy_single_item';
  if (body.requestMode === 'selected_item') return 'identify_selected_item';
  if (isRecord(body.selectedCandidate)) return 'identify_selected_item';
  if (body.multiItemDetection === true || body.requestMode === 'multi_item_detection') {
    return 'detect_items';
  }
  return 'legacy_single_item';
}

/** Maps the V2 mode onto the existing pipeline's flags. */
function internalFlagsForMode(mode: InternalScanRequest['resolvedMode']): {
  multiItemDetection: boolean;
  requestMode: InternalScanRequest['requestMode'];
} {
  if (mode === 'detect_items') {
    return { multiItemDetection: true, requestMode: 'multi_item_detection' };
  }
  if (mode === 'identify_selected_item') {
    return { multiItemDetection: true, requestMode: 'selected_item' };
  }
  return { multiItemDetection: false, requestMode: 'legacy_single_item' };
}

export function buildLegacyInternalRequest(body: unknown): InternalScanRequest {
  const resolvedMode = resolveLegacyInternalMode(body);
  const flags = internalFlagsForMode(resolvedMode);
  return {
    contractPath: 'legacy',
    // Compatibility only. Legacy clients never sent an intent, and defaulting
    // to shop is what preserves today's Scanner behaviour during rollout.
    intent: LEGACY_DEFAULT_INTENT,
    intentDefaulted: true,
    resolvedMode,
    ...flags,
  };
}

/** V2 modes this backend can actually execute in Phase 2B.1. */
const ACTIVE_V2_MODES: FashionIdentificationMode[] = ['detect_items', 'identify_selected_item'];

export function adaptV2ToInternalRequest(
  request: FashionIdentificationRequestV2,
): InternalScanRequest {
  const resolvedMode = request.mode === 'detect_items'
    ? 'detect_items'
    : 'identify_selected_item';
  const flags = internalFlagsForMode(resolvedMode);
  const evidence = request.evidence[0];
  const transport = evidence?.transport;

  return {
    contractPath: 'v2',
    intent: request.intent,
    intentDefaulted: false,
    resolvedMode,
    ...flags,
    ...(request.selectedCandidate
      ? {
        selectedCandidate: {
          candidateId: request.selectedCandidate.candidateId,
          category: request.selectedCandidate.category,
          ...(request.selectedCandidate.subtype
            ? { subtype: request.selectedCandidate.subtype }
            : {}),
          ...(request.selectedCandidate.bounds
            ? { bounds: request.selectedCandidate.bounds }
            : {}),
        },
      }
      : {}),
    ...(request.selectedCandidate?.detectionDigest
      ? { detectionDigest: request.selectedCandidate.detectionDigest }
      : {}),
    ...(evidence ? { evidenceId: evidence.evidenceId } : {}),
    requestId: request.requestId,
    entryPath: request.source.entryPath,
    platform: request.source.platform,
    ...(transport && transport.type === 'jpeg_base64'
      ? { imageBase64: transport.imageBase64 }
      : {}),
  };
}

// ── Routing ──────────────────────────────────────────────────────────────────

export type ScanIdentifyRoute =
  | { kind: 'legacy'; internal: InternalScanRequest }
  | { kind: 'v2'; request: FashionIdentificationRequestV2; internal: InternalScanRequest }
  | { kind: 'contract_error'; httpStatus: 400; body: V2ContractErrorBody };

function contractError(code: V2ErrorCode): ScanIdentifyRoute {
  return { kind: 'contract_error', httpStatus: 400, body: buildContractErrorBody(code) };
}

/**
 * The single entry decision.
 *
 *   contractVersion === v2   → validate, then adapt to the internal shape
 *   contractVersion absent   → legacy, behaviour unchanged
 *   contractVersion unknown  → HTTP 400, never a silent legacy fallback
 *
 * A silent fallback is the dangerous case: a future client asking for a contract
 * this build does not implement would get a response shaped for a different
 * contract and have no way to detect it.
 */
export function routeScanIdentifyRequest(body: unknown): ScanIdentifyRoute {
  const versionClass = classifyContractVersion(body);

  if (versionClass === 'legacy') {
    return { kind: 'legacy', internal: buildLegacyInternalRequest(body) };
  }
  if (versionClass === 'unsupported') {
    return contractError('UNSUPPORTED_CONTRACT_VERSION');
  }

  const validated = validateFashionIdentificationRequestV2(body);
  if (!validated.ok) {
    // A selected-item request with no candidate at all is a different client
    // mistake from one that sent a malformed candidate, so they get different
    // codes even though the validator reports one.
    if (validated.errorCode === 'invalid_selected_candidate') {
      const candidateAbsent = !isRecord(body) ||
        body.selectedCandidate === undefined ||
        body.selectedCandidate === null;
      return contractError(
        candidateAbsent ? 'MISSING_SELECTED_CANDIDATE' : 'INVALID_SELECTED_CANDIDATE',
      );
    }
    return contractError(VALIDATION_CODE_TO_HTTP[validated.errorCode]);
  }

  // Reserved for Phase 2D. Rejected rather than silently degraded to a
  // single-image identification the caller did not ask for.
  if (!ACTIVE_V2_MODES.includes(validated.request.mode)) {
    return contractError('INVALID_MODE');
  }

  return {
    kind: 'v2',
    request: validated.request,
    internal: adaptV2ToInternalRequest(validated.request),
  };
}

// ── Commerce gating ──────────────────────────────────────────────────────────

export type CommerceDecision = { run: boolean; skipReason: string | null };

/**
 * The hard commerce decision, evaluated BEFORE any commerce client, catalog
 * query, similarity matcher or network promise is created.
 *
 * Two rules compose here:
 *   - the shared intent/status gate from the contract module, and
 *   - the detection override: a detection request has not yet chosen an item,
 *     so shopping for one is meaningless regardless of intent.
 */
export function resolveCommerceDecision(input: {
  intent: FashionIdentificationIntent;
  resolvedMode: InternalScanRequest['resolvedMode'];
  status: FashionIdentificationStatus;
}): CommerceDecision {
  if (input.resolvedMode === 'detect_items') {
    return { run: false, skipReason: 'detection_mode' };
  }
  const gate = shouldRunCommerce({ intent: input.intent, status: input.status });
  return { run: gate.run, skipReason: gate.skippedReason };
}

// ── Response validation ──────────────────────────────────────────────────────

export type ResultValidation =
  | { ok: true }
  | { ok: false; category: string };

const REQUIRED_CONFIDENCE_KEYS = ['category', 'subtype', 'brand', 'modelFamily', 'exactProduct'];

/**
 * Strict structural validation of the outgoing V2 result.
 *
 * Returns a bounded failure CATEGORY, never the offending value: this runs on
 * the response path, and echoing what was wrong would put provider output into
 * a log line.
 */
export function validateFashionIdentificationResultV2(raw: unknown): ResultValidation {
  if (!isRecord(raw)) return { ok: false, category: 'not_an_object' };
  if (raw.contractVersion !== FASHION_IDENTIFICATION_CONTRACT_V2) {
    return { ok: false, category: 'contract_version' };
  }
  if (typeof raw.requestId !== 'string') return { ok: false, category: 'request_id' };
  if (!(FASHION_IDENTIFICATION_STATUSES as readonly string[]).includes(String(raw.status))) {
    return { ok: false, category: 'status' };
  }
  if (
    !(FASHION_IDENTIFICATION_RESOLUTION_LEVELS as readonly string[])
      .includes(String(raw.resolutionLevel))
  ) {
    return { ok: false, category: 'resolution_level' };
  }

  const item = raw.item;
  if (!isRecord(item)) return { ok: false, category: 'item' };
  const brand = item.brand;
  if (!isRecord(brand)) return { ok: false, category: 'brand' };
  if (!Array.isArray(brand.evidence)) return { ok: false, category: 'brand_evidence' };
  const colors = item.colors;
  if (!isRecord(colors) || !Array.isArray(colors.secondary)) {
    return { ok: false, category: 'colors' };
  }
  for (const key of ['material', 'silhouette', 'pattern']) {
    if (!Array.isArray(item[key])) return { ok: false, category: `item_${key}` };
  }
  const attributes = item.attributes;
  if (!isRecord(attributes)) return { ok: false, category: 'attributes' };
  for (const key of ['pockets', 'visible', 'distinctive']) {
    if (!Array.isArray(attributes[key])) return { ok: false, category: `attributes_${key}` };
  }

  const confidence = raw.confidence;
  if (!isRecord(confidence)) return { ok: false, category: 'confidence' };
  for (const key of REQUIRED_CONFIDENCE_KEYS) {
    // The key must EXIST and be null-or-number. A missing key is the failure
    // mode that `undefined` + JSON.stringify silently produces.
    if (!Object.prototype.hasOwnProperty.call(confidence, key)) {
      return { ok: false, category: `confidence_missing_${key}` };
    }
    const value = confidence[key];
    if (value !== null && typeof value !== 'number') {
      return { ok: false, category: `confidence_type_${key}` };
    }
  }

  if (raw.exactProduct !== null && !isRecord(raw.exactProduct)) {
    return { ok: false, category: 'exact_product' };
  }
  if (!Array.isArray(raw.evidence)) return { ok: false, category: 'evidence' };
  if (!Array.isArray(raw.conflicts)) return { ok: false, category: 'conflicts' };

  const compatibility = raw.compatibility;
  if (!isRecord(compatibility)) return { ok: false, category: 'compatibility' };
  if (typeof compatibility.legacyProjectionAvailable !== 'boolean') {
    return { ok: false, category: 'compatibility_projection' };
  }
  if (
    compatibility.globalConfidence !== null &&
    typeof compatibility.globalConfidence !== 'number'
  ) {
    return { ok: false, category: 'compatibility_confidence' };
  }

  return { ok: true };
}

/**
 * Detects anything JSON.stringify would silently drop or corrupt.
 *
 * `undefined` is the important one: attaching it to a required nullable field
 * makes the key vanish during serialization, so the client receives a result
 * that passed validation in memory and fails it on arrival.
 */
export function findJsonUnsafePath(value: unknown, path = '$', seen = new Set<unknown>()): string | null {
  if (value === undefined) return `${path}:undefined`;
  if (value === null) return null;

  const valueType = typeof value;
  if (valueType === 'function') return `${path}:function`;
  if (valueType === 'bigint') return `${path}:bigint`;
  if (valueType === 'symbol') return `${path}:symbol`;
  if (valueType === 'number') {
    return Number.isFinite(value as number) ? null : `${path}:non_finite_number`;
  }
  if (valueType !== 'object') return null;

  if (seen.has(value)) return `${path}:circular`;
  seen.add(value);

  if (value instanceof Map) return `${path}:map`;
  if (value instanceof Set) return `${path}:set`;
  if (value instanceof Error) return `${path}:error`;
  if (value instanceof Date) return `${path}:date`;

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findJsonUnsafePath(value[index], `${path}[${index}]`, seen);
      if (found) return found;
    }
    seen.delete(value);
    return null;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const found = findJsonUnsafePath(entry, `${path}.${key}`, seen);
    if (found) return found;
  }
  seen.delete(value);
  return null;
}

/**
 * A V2 result that is guaranteed to satisfy the technical-failure branch of the
 * validator. Used when normalization or response validation fails: a V2 client
 * must still receive a parseable contract rather than an opaque 500.
 */
export function buildTechnicalFailureResultV2(
  requestId: string,
  evidenceIds: string[] = [],
): FashionIdentificationResultV2 {
  return normalizeToV2({
    requestId,
    outcome: 'technical_failure',
    evidenceIds,
    identification: {},
    attributes: {},
  });
}

// ── Transitional response ────────────────────────────────────────────────────

/**
 * Legacy fields untouched, plus the two additive V2 fields.
 *
 * Both derive from the same normalized result, so a legacy client that ignores
 * unknown fields and a V2 client that reads `identificationV2` cannot disagree.
 * Legacy requests never receive these fields.
 */
export function buildTransitionalResponse(
  legacyResponse: Record<string, unknown>,
  v2Result: FashionIdentificationResultV2,
): Record<string, unknown> {
  return {
    ...legacyResponse,
    contractVersion: FASHION_IDENTIFICATION_CONTRACT_V2,
    identificationV2: v2Result,
  };
}

/**
 * Cross-checks the legacy fields against the V2 result they were derived from.
 *
 * Returns the list of materially disagreeing fields. Empty means the two views
 * of the same scan agree. This exists because "one normalized source" is a
 * claim that has to be enforced, not asserted.
 */
export function findLegacyV2Disagreements(
  legacyResponse: Record<string, unknown>,
  v2Result: FashionIdentificationResultV2,
): string[] {
  const projected = projectV2ToLegacy(v2Result);
  const disagreements: string[] = [];

  const identification = isRecord(legacyResponse.identification)
    ? legacyResponse.identification
    : {};
  const attributes = isRecord(legacyResponse.attributes) ? legacyResponse.attributes : {};

  const legacyCategory = typeof identification.item_type === 'string'
    ? identification.item_type
    : typeof attributes.category === 'string'
    ? attributes.category
    : null;
  if (projected.item_type !== null && legacyCategory !== null &&
    projected.item_type !== legacyCategory) {
    disagreements.push('category');
  }

  const legacySubtype = typeof identification.subtype === 'string' ? identification.subtype : null;
  if (projected.subtype !== null && legacySubtype !== null && projected.subtype !== legacySubtype) {
    disagreements.push('subtype');
  }

  const legacyBrand = typeof identification.brand_guess === 'string'
    ? identification.brand_guess
    : null;
  if (projected.brand_guess !== null && legacyBrand !== null &&
    projected.brand_guess !== legacyBrand) {
    disagreements.push('brand');
  }

  const legacyColor = typeof identification.primary_color === 'string'
    ? identification.primary_color
    : null;
  if (projected.primary_color !== null && legacyColor !== null &&
    projected.primary_color !== legacyColor) {
    disagreements.push('primary_color');
  }

  const legacyStatus = typeof legacyResponse.status === 'string' ? legacyResponse.status : null;
  if (legacyStatus !== null && projected.status !== legacyStatus) {
    disagreements.push('status');
  }

  return disagreements;
}

// ── Telemetry ────────────────────────────────────────────────────────────────

export type V2Telemetry = {
  contractVersion: string;
  contractPath: 'v2' | 'legacy';
  intent: FashionIdentificationIntent;
  intentDefaulted: boolean;
  mode: string;
  entryPath: string | null;
  platform: string | null;
  evidenceCount: number;
  status: string | null;
  resolutionLevel: string | null;
  commerceExecuted: boolean;
  commerceSkipped: boolean;
  skipReason: string | null;
  responseValidationOk: boolean;
  compatibilityProjectionUsed: boolean;
};

/**
 * Bounded, non-identifying telemetry.
 *
 * Everything here is an enum, a boolean or a count. Notably absent and
 * deliberately so: the evidence id (client-supplied and correlatable across
 * requests), image bytes or references, local URIs, the request body,
 * filenames, user or device identifiers, and raw provider output.
 */
export function buildV2Telemetry(input: {
  internal: InternalScanRequest;
  evidenceCount: number;
  result: FashionIdentificationResultV2 | null;
  commerce: CommerceDecision;
  responseValidationOk: boolean;
}): V2Telemetry {
  return {
    contractVersion: input.internal.contractPath === 'v2'
      ? FASHION_IDENTIFICATION_CONTRACT_V2
      : 'legacy',
    contractPath: input.internal.contractPath,
    intent: input.internal.intent,
    intentDefaulted: input.internal.intentDefaulted,
    mode: input.internal.resolvedMode,
    entryPath: input.internal.entryPath ?? null,
    platform: input.internal.platform ?? null,
    evidenceCount: input.evidenceCount,
    status: input.result?.status ?? null,
    resolutionLevel: input.result?.resolutionLevel ?? null,
    commerceExecuted: input.commerce.run,
    commerceSkipped: !input.commerce.run,
    skipReason: input.commerce.skipReason,
    responseValidationOk: input.responseValidationOk,
    compatibilityProjectionUsed: input.internal.contractPath === 'v2',
  };
}
