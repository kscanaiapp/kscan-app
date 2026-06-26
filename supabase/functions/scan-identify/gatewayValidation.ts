/**
 * Deno-safe gateway validation and privacy evaluation.
 * Aligned with root services/aiGateway/validateKScanAIRequest.ts and evaluatePrivacyState.ts.
 */

import {
  AI_GATEWAY_API_VERSION,
  KScanAIRequest,
  KScanAIValidationResult,
  KScanAISurface,
  KScanAIInputType,
  KScanAIPrivacy,
  MAX_GATEWAY_TEXT_LENGTH,
  MAX_GATEWAY_IMAGE_BYTES,
  GATEWAY_ALLOWED_IMAGE_MIME_TYPES,
  KScanAIResponse,
  KScanAIError,
  KScanAISource,
  KScanAIIntent,
  KScanAITelemetry,
} from './gatewayContract.ts';

const ALLOWED_SURFACES: readonly KScanAISurface[] = ['mobile_scan', 'text_scan', 'style_match', 'xr_debug', 'debug'];
const ALLOWED_INPUT_TYPES: readonly KScanAIInputType[] = ['image', 'text', 'mixed'];

const DEFAULT_INTENT: KScanAIIntent = { inferredGoal: 'identify', nextActions: ['ask_followup'] };

function emptyTelemetry(requestId: string, surface: KScanAISurface, inputType: KScanAIInputType): KScanAITelemetry {
  return { requestId, surface, inputType, apiVersion: AI_GATEWAY_API_VERSION };
}

function makeError(code: string, userMessage: string, opts?: { debugMessage?: string; recoverable?: boolean; retryAfterMs?: number }): KScanAIError {
  return { code, userMessage, debugMessage: opts?.debugMessage, recoverable: opts?.recoverable ?? false, retryAfterMs: opts?.retryAfterMs };
}

function baseResponse(requestId: string, status: KScanAIResponse['status'], source: KScanAISource, overrides?: Partial<KScanAIResponse>): KScanAIResponse {
  return {
    apiVersion: AI_GATEWAY_API_VERSION,
    requestId,
    status,
    source,
    fashionAnalysis: { items: [], styleAttributes: {}, summary: undefined },
    userIntent: { ...DEFAULT_INTENT },
    products: [],
    errors: [],
    telemetry: overrides?.telemetry ?? emptyTelemetry(requestId, 'mobile_scan', 'image'),
    ...overrides,
  };
}

function coerceSurface(value: unknown): KScanAISurface {
  return ALLOWED_SURFACES.includes(value as KScanAISurface) ? (value as KScanAISurface) : 'mobile_scan';
}

function coerceInputType(value: unknown): KScanAIInputType {
  return ALLOWED_INPUT_TYPES.includes(value as KScanAIInputType) ? (value as KScanAIInputType) : 'image';
}

function buildValidationErrorResponse(
  requestId: string,
  code: string,
  userMessage: string,
  debugMessage?: string,
  telemetryContext?: { surface?: unknown; inputType?: unknown },
): KScanAIResponse {
  return baseResponse(requestId, 'error', { primary: 'unknown' }, {
    telemetry: emptyTelemetry(
      requestId,
      coerceSurface(telemetryContext?.surface),
      coerceInputType(telemetryContext?.inputType),
    ),
    errors: [makeError(code, userMessage, { debugMessage, recoverable: false })],
  });
}

function isValidDataUri(dataUri: string): { mimeType?: string; base64?: string; byteLength?: number } {
  const match = dataUri.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return {};
  const mimeType = match[1];
  const base64 = match[2];
  const byteLength = Math.floor(base64.length * 0.75);
  return { mimeType, base64, byteLength };
}

function estimateImageBytes(input: KScanAIRequest['input']): number {
  if (!input.imageBase64) return 0;
  if (input.imageBase64.startsWith('data:')) {
    const { byteLength } = isValidDataUri(input.imageBase64);
    return byteLength ?? 0;
  }
  return Math.floor(input.imageBase64.length * 0.75);
}

function detectMimeType(input: KScanAIRequest['input']): string | undefined {
  if (input.imageMimeType) return input.imageMimeType;
  if (input.imageBase64?.startsWith('data:')) {
    const { mimeType } = isValidDataUri(input.imageBase64);
    return mimeType;
  }
  return undefined;
}

export function validateKScanAIRequest(raw: unknown): KScanAIValidationResult {
  const requestId = raw && typeof raw === 'object' && 'requestId' in raw && typeof (raw as Record<string, unknown>).requestId === 'string'
    ? (raw as Record<string, unknown>).requestId
    : 'unknown';
  const telemetryContext = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? {
        surface: (raw as Record<string, unknown>).surface,
        inputType: (raw as Record<string, unknown>).inputType,
      }
    : undefined;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, response: buildValidationErrorResponse(requestId, 'INVALID_REQUEST', 'Invalid request format.', undefined, telemetryContext) };
  }

  const src = raw as Record<string, unknown>;

  const required = ['apiVersion', 'requestId', 'surface', 'inputType', 'privacy', 'input'] as const;
  for (const key of required) {
    if (!(key in src) || src[key] === undefined || src[key] === null) {
      return { ok: false, response: buildValidationErrorResponse(requestId, 'INVALID_REQUEST', `Missing required field: ${key}.`, `Field '${key}' is missing or null.`, telemetryContext) };
    }
  }

  if (src.apiVersion !== AI_GATEWAY_API_VERSION) {
    return { ok: false, response: buildValidationErrorResponse(requestId, 'INVALID_REQUEST', 'Unsupported API version.', `Expected ${AI_GATEWAY_API_VERSION}, received ${src.apiVersion}.`, telemetryContext) };
  }

  if (typeof src.requestId !== 'string' || !src.requestId.trim()) {
    return { ok: false, response: buildValidationErrorResponse(requestId, 'INVALID_REQUEST', 'Missing or invalid requestId.', undefined, telemetryContext) };
  }

  if (!ALLOWED_SURFACES.includes(src.surface as KScanAISurface)) {
    return { ok: false, response: buildValidationErrorResponse(requestId, 'INVALID_REQUEST', 'Invalid surface.', `Surface '${src.surface}' is not allowed.`, telemetryContext) };
  }

  if (!ALLOWED_INPUT_TYPES.includes(src.inputType as KScanAIInputType)) {
    return { ok: false, response: buildValidationErrorResponse(requestId, 'INVALID_REQUEST', 'Invalid input type.', `inputType '${src.inputType}' is not allowed.`, telemetryContext) };
  }

  const inputType = src.inputType as KScanAIInputType;
  const input = src.input as Record<string, unknown>;

  if (inputType === 'image' || inputType === 'mixed') {
    const hasImageBase64 = typeof input.imageBase64 === 'string' && input.imageBase64.trim().length > 0;
    if (!hasImageBase64) {
      return { ok: false, response: buildValidationErrorResponse(requestId, 'INVALID_INPUT', 'Image input is required for image/mixed requests.', undefined, telemetryContext) };
    }
  }

  if (inputType === 'text' || inputType === 'mixed') {
    const textQuery = typeof input.textQuery === 'string' ? input.textQuery : '';
    if (!textQuery.trim()) {
      return { ok: false, response: buildValidationErrorResponse(requestId, 'INVALID_INPUT', 'Text query is required for text/mixed requests.', undefined, telemetryContext) };
    }
    if (textQuery.length > MAX_GATEWAY_TEXT_LENGTH) {
      return { ok: false, response: buildValidationErrorResponse(requestId, 'TEXT_TOO_LONG', `Text query exceeds ${MAX_GATEWAY_TEXT_LENGTH} characters.`, undefined, telemetryContext) };
    }
  }

  if (inputType === 'image' || inputType === 'mixed') {
    const imageBytes = estimateImageBytes(input as KScanAIRequest['input']);
    if (imageBytes > MAX_GATEWAY_IMAGE_BYTES) {
      return { ok: false, response: buildValidationErrorResponse(requestId, 'IMAGE_TOO_LARGE', 'Image exceeds maximum allowed size.', `Image payload estimated at ${imageBytes} bytes (max ${MAX_GATEWAY_IMAGE_BYTES}).`, telemetryContext) };
    }

    const mimeType = detectMimeType(input as KScanAIRequest['input']);
    if (mimeType && !GATEWAY_ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
      return { ok: false, response: buildValidationErrorResponse(requestId, 'UNSUPPORTED_IMAGE_TYPE', 'Unsupported image format.', `MIME type '${mimeType}' is not allowed.`, telemetryContext) };
    }
  }

  const privacy = src.privacy as Record<string, unknown>;
  if (!privacy || typeof privacy !== 'object' || Array.isArray(privacy)) {
    return { ok: false, response: buildValidationErrorResponse(requestId, 'PRIVACY_FLAGS_MISSING', 'Privacy configuration is missing.', undefined, telemetryContext) };
  }

  if (inputType === 'image' || inputType === 'mixed') {
    if (!('piiMasked' in privacy)) {
      return { ok: false, response: buildValidationErrorResponse(requestId, 'PRIVACY_FLAGS_MISSING', 'Privacy flag piiMasked is required for image requests.', undefined, telemetryContext) };
    }
    if (!('rawImageSent' in privacy)) {
      return { ok: false, response: buildValidationErrorResponse(requestId, 'PRIVACY_FLAGS_MISSING', 'Privacy flag rawImageSent is required for image requests.', undefined, telemetryContext) };
    }
  }

  const normalized: KScanAIRequest = {
    apiVersion: AI_GATEWAY_API_VERSION,
    requestId: src.requestId as string,
    surface: src.surface as KScanAISurface,
    inputType,
    privacy: privacy as KScanAIPrivacy,
    input: {
      imageBase64: typeof input.imageBase64 === 'string' ? input.imageBase64 : undefined,
      imageMimeType: typeof input.imageMimeType === 'string' ? input.imageMimeType : undefined,
      textQuery: typeof input.textQuery === 'string' ? input.textQuery : undefined,
      imageBytes: typeof input.imageBytes === 'number' ? input.imageBytes : undefined,
    },
    intent: src.intent && typeof src.intent === 'object' && !Array.isArray(src.intent) ? (src.intent as KScanAIRequest['intent']) : undefined,
    session: src.session && typeof src.session === 'object' && !Array.isArray(src.session) ? (src.session as KScanAIRequest['session']) : undefined,
    client: src.client && typeof src.client === 'object' && !Array.isArray(src.client) ? (src.client as KScanAIRequest['client']) : undefined,
    timestamp: typeof src.timestamp === 'string' ? src.timestamp : undefined,
  };

  return { ok: true, value: normalized };
}

// ── Privacy evaluation ───────────────────────────────────────────────────────

export type PrivacyEvaluationResult = {
  privacyVerified: boolean;
  warnings: string[];
  effectivePrivacy: KScanAIPrivacy;
  wouldRejectInPhase2: boolean;
};

export function evaluatePrivacyState(
  request: Pick<KScanAIRequest, 'inputType' | 'privacy'>,
): PrivacyEvaluationResult {
  const rawPrivacy = request.privacy as Record<string, unknown> | undefined;
  const inputType = request.inputType as KScanAIInputType;

  const warnings: string[] = [];
  let privacyVerified = false;
  let wouldRejectInPhase2 = false;

  const effectivePrivacy: KScanAIPrivacy = {
    piiMasked: typeof rawPrivacy?.piiMasked === 'boolean' ? rawPrivacy.piiMasked : false,
    rawImageSent: typeof rawPrivacy?.rawImageSent === 'boolean' ? rawPrivacy.rawImageSent : true,
    maskingMode: typeof rawPrivacy?.maskingMode === 'string' ? (rawPrivacy.maskingMode as KScanAIPrivacy['maskingMode']) : 'unknown',
    privacyVerifiedBy: typeof rawPrivacy?.privacyVerifiedBy === 'string' ? rawPrivacy.privacyVerifiedBy : undefined,
    privacyVerified: typeof rawPrivacy?.privacyVerified === 'boolean' ? rawPrivacy.privacyVerified : false,
    legacyLocalPrivacyFiltered: typeof rawPrivacy?.legacyLocalPrivacyFiltered === 'boolean' ? rawPrivacy.legacyLocalPrivacyFiltered : false,
  };

  if (rawPrivacy && 'localPrivacyFiltered' in rawPrivacy && effectivePrivacy.legacyLocalPrivacyFiltered === false) {
    const legacy = typeof rawPrivacy.localPrivacyFiltered === 'boolean' ? rawPrivacy.localPrivacyFiltered : false;
    if (legacy === true) {
      effectivePrivacy.legacyLocalPrivacyFiltered = true;
      warnings.push('Legacy localPrivacyFiltered was mapped to legacyLocalPrivacyFiltered as transitional metadata; this is not proof of PII masking.');
    }
  }

  const isImageRequest = inputType === 'image' || inputType === 'mixed';

  if (isImageRequest) {
    if (effectivePrivacy.piiMasked !== true) {
      warnings.push('piiMasked is not true; active sanitizer may be pass-through.');
      wouldRejectInPhase2 = true;
    }
    if (effectivePrivacy.rawImageSent !== false) {
      warnings.push('rawImageSent is not false; raw image may be transmitted.');
      wouldRejectInPhase2 = true;
    }
    if (effectivePrivacy.maskingMode === 'pass_through' || effectivePrivacy.maskingMode === 'unknown') {
      warnings.push(`maskingMode is '${effectivePrivacy.maskingMode}'; privacy masking is not proven.`);
    }
    privacyVerified = false;
  } else {
    privacyVerified = effectivePrivacy.piiMasked === true && effectivePrivacy.rawImageSent === false;
  }

  if (effectivePrivacy.privacyVerified === true && warnings.length > 0) {
    warnings.push('privacyVerified was claimed true but could not be proven by gateway.');
    effectivePrivacy.privacyVerified = false;
  }

  return { privacyVerified, warnings, effectivePrivacy, wouldRejectInPhase2 };
}
