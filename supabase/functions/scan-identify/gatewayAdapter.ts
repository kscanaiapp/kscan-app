/**
 * Deno-safe gateway adapter for legacy scan-identify ↔ canonical contract mapping.
 * Aligned with root services/aiGateway/scanIdentifyAdapter.ts.
 * No network calls, no Supabase imports, no provider API invocations.
 */

import {
  KScanAIRequest,
  KScanAIResponse,
  AI_GATEWAY_API_VERSION,
  KScanAIPrivacy,
  KScanAISource,
  KScanFashionItem,
  KScanAITelemetry,
  KScanAIProvider,
  KScanAIIntent,
  KScanAIError,
} from './gatewayContract.ts';

const DEFAULT_INTENT: KScanAIIntent = { inferredGoal: 'identify', nextActions: ['ask_followup'] };

function toProvider(source?: string): KScanAIProvider {
  const s = (source ?? '').toLowerCase();
  if (s.includes('gemini')) return 'gemini';
  if (s.includes('openrouter')) return 'openrouter';
  if (s.includes('llama')) return 'llama';
  if (s.includes('local')) return 'local';
  if (s.includes('mock')) return 'mock';
  return 'unknown';
}

function mapAttributesToItems(attributes?: Record<string, unknown>): KScanFashionItem[] {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return [];
  const a = attributes as Record<string, unknown>;
  const item: KScanFashionItem = {
    category: typeof a.category === 'string' ? a.category : undefined,
    itemType: typeof a.itemType === 'string' ? a.itemType : undefined,
    silhouette: typeof a.silhouette === 'string' ? a.silhouette : undefined,
    colorPalette: Array.isArray(a.colorPalette) ? a.colorPalette.filter((x): x is string => typeof x === 'string') : undefined,
    materialEstimate: typeof a.materialEstimate === 'string' ? a.materialEstimate : undefined,
    pattern: typeof a.pattern === 'string' ? a.pattern : undefined,
    texture: typeof a.texture === 'string' ? a.texture : undefined,
    styleTags: Array.isArray(a.styleTags) ? a.styleTags.filter((x): x is string => typeof x === 'string') : undefined,
    occasion: typeof a.occasion === 'string' ? a.occasion : undefined,
    confidenceScore: typeof a.confidenceScore === 'number' ? a.confidenceScore : undefined,
  };
  const cleaned: KScanFashionItem = {};
  for (const [key, value] of Object.entries(item)) {
    if (value !== undefined) (cleaned as Record<string, unknown>)[key] = value;
  }
  return Object.keys(cleaned).length ? [cleaned] : [];
}

function isPartialAttributes(attributes?: Record<string, unknown>): boolean {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;
  const a = attributes as Record<string, unknown>;
  const hasCategory = typeof a.category === 'string' && !!a.category;
  const hasItemType = typeof a.itemType === 'string' && !!a.itemType;
  const hasSilhouette = typeof a.silhouette === 'string' && !!a.silhouette;
  const hasMaterial = typeof a.materialEstimate === 'string' && !!a.materialEstimate;
  const lowConfidence = typeof a.confidenceScore === 'number' && a.confidenceScore < 0.6;
  return (!hasCategory || !hasItemType || !hasSilhouette || !hasMaterial || lowConfidence);
}

function emptyTelemetry(requestId: string): KScanAITelemetry {
  return {
    requestId,
    surface: 'mobile_scan',
    inputType: 'image',
    apiVersion: AI_GATEWAY_API_VERSION,
  };
}

// ── Legacy body → Canonical request ──────────────────────────────────────────

export function normalizeLegacyBody(
  body: Record<string, unknown>,
  opts?: {
    requestId?: string;
    surface?: KScanAIRequest['surface'];
    session?: KScanAIRequest['session'];
    client?: KScanAIRequest['client'];
  },
): KScanAIRequest {
  if (
    typeof body.apiVersion === 'string' &&
    typeof body.requestId === 'string' &&
    body.privacy &&
    typeof body.privacy === 'object' &&
    !Array.isArray(body.privacy)
  ) {
    const input = (body.input as Record<string, unknown>) ?? {};
    return {
      apiVersion: body.apiVersion as typeof AI_GATEWAY_API_VERSION,
      requestId: body.requestId as string,
      surface: (body.surface as KScanAIRequest['surface']) ?? 'mobile_scan',
      inputType: (body.inputType as KScanAIRequest['inputType']) ?? 'image',
      privacy: body.privacy as KScanAIPrivacy,
      input: {
        imageBase64: typeof input.imageBase64 === 'string' ? input.imageBase64 : undefined,
        imageMimeType: typeof input.imageMimeType === 'string' ? input.imageMimeType : undefined,
        textQuery: typeof input.textQuery === 'string' ? input.textQuery : undefined,
        imageBytes: typeof input.imageBytes === 'number' ? input.imageBytes : undefined,
      },
      intent: body.intent && typeof body.intent === 'object' && !Array.isArray(body.intent) ? (body.intent as KScanAIRequest['intent']) : undefined,
      session: body.session && typeof body.session === 'object' && !Array.isArray(body.session) ? (body.session as KScanAIRequest['session']) : undefined,
      client: body.client && typeof body.client === 'object' && !Array.isArray(body.client) ? (body.client as KScanAIRequest['client']) : undefined,
      timestamp: typeof body.timestamp === 'string' ? body.timestamp : undefined,
    };
  }

  const mode = typeof body.mode === 'string' ? body.mode.toLowerCase() : 'image';
  const inputType: KScanAIRequest['inputType'] = mode === 'text' ? 'text' : 'image';
  const legacySource = typeof body.source === 'string' ? body.source : 'unknown';
  const surface: KScanAIRequest['surface'] = opts?.surface ?? (inputType === 'text' ? 'text_scan' : 'mobile_scan');
  const localPrivacyFiltered = typeof body.localPrivacyFiltered === 'boolean' ? body.localPrivacyFiltered : false;

  const privacy: KScanAIPrivacy = {
    piiMasked: localPrivacyFiltered,
    rawImageSent: localPrivacyFiltered === true ? false : true,
    maskingMode: localPrivacyFiltered ? 'pass_through' : 'unknown',
    privacyVerifiedBy: 'none',
    privacyVerified: false,
    legacyLocalPrivacyFiltered: localPrivacyFiltered,
  };

  const input: KScanAIRequest['input'] = {
    imageBase64: inputType === 'image' || inputType === 'mixed'
      ? (typeof body.imageBase64 === 'string' ? body.imageBase64 : undefined)
      : undefined,
    textQuery: inputType === 'text'
      ? (typeof body.textQuery === 'string' ? body.textQuery : undefined)
      : undefined,
  };

  const timestamp = typeof body.clientTimestamp === 'string' ? body.clientTimestamp : new Date().toISOString();

  return {
    apiVersion: AI_GATEWAY_API_VERSION,
    requestId: opts?.requestId ?? (typeof body.requestId === 'string' ? body.requestId : `scan-${Date.now()}`),
    surface,
    inputType,
    privacy,
    input,
    client: opts?.client ?? { platform: legacySource },
    session: opts?.session ?? undefined,
    timestamp,
  };
}

// ── scan-identify response → Canonical response ──────────────────────────────

export function mapScanIdentifyResponseToGatewayResponse(
  scanResp: Record<string, unknown>,
  opts?: {
    requestId?: string;
    source?: KScanAISource;
    telemetry?: KScanAITelemetry;
  },
): KScanAIResponse {
  const requestId = opts?.requestId ?? (typeof scanResp.scanId === 'string' ? scanResp.scanId : `resp-${Date.now()}`);
  const source: KScanAISource = opts?.source ?? { primary: 'gemini' };
  const telemetry = opts?.telemetry ?? emptyTelemetry(requestId);
  const rawStatus = typeof scanResp.status === 'string' ? scanResp.status.toLowerCase() : '';
  const userMessage = typeof scanResp.userMessage === 'string' ? scanResp.userMessage : undefined;

  if (rawStatus.includes('non')) {
    return {
      apiVersion: AI_GATEWAY_API_VERSION,
      requestId,
      status: 'success',
      source,
      fashionAnalysis: {
        items: [],
        styleAttributes: {},
        summary: userMessage ?? 'No fashion items detected.',
      },
      userIntent: {
        inferredGoal: 'identify',
        nextActions: ['ask_followup'],
      },
      products: [],
      errors: [],
      telemetry,
    };
  }

  if (rawStatus === 'completed') {
    const attributes = typeof scanResp.attributes === 'object' && scanResp.attributes !== null && !Array.isArray(scanResp.attributes)
      ? (scanResp.attributes as Record<string, unknown>)
      : undefined;
    const items = mapAttributesToItems(attributes);
    const status: KScanAIResponse['status'] = items.length === 0 || isPartialAttributes(attributes) ? 'partial' : 'success';
    const errors: KScanAIResponse['errors'] = [];
    if (status === 'partial') {
      errors.push({
        code: 'PARTIAL_RESULT',
        userMessage: 'Some fashion details could not be determined.',
        recoverable: true,
      });
    }
    return {
      apiVersion: AI_GATEWAY_API_VERSION,
      requestId,
      status,
      source,
      fashionAnalysis: {
        items,
        styleAttributes: attributes ?? {},
        summary: userMessage ?? 'Identified a fashion item.',
      },
      userIntent: { ...DEFAULT_INTENT },
      products: [],
      errors,
      telemetry,
    };
  }

  const recoverable = !!scanResp.scanId;
  const status: KScanAIResponse['status'] = recoverable ? 'fallback' : 'error';
  return {
    apiVersion: AI_GATEWAY_API_VERSION,
    requestId,
    status,
    source: { primary: 'fallback' },
    fashionAnalysis: {
      items: [],
      styleAttributes: {},
      summary: userMessage ?? 'Analysis failed.',
    },
    userIntent: { ...DEFAULT_INTENT },
    products: [],
    errors: [
      {
        code: recoverable ? 'PROVIDER_UNAVAILABLE' : 'UNKNOWN_ERROR',
        userMessage: userMessage ?? 'We could not complete this analysis. Please try again.',
        recoverable,
      },
    ],
    telemetry,
  };
}

// ── Canonical response → Legacy scan-identify response ───────────────────────

export function canonicalToLegacyResponse(
  canonical: KScanAIResponse,
  mode: 'image' | 'text',
): Record<string, unknown> {
  const safeFailed = mode === 'text'
    ? "We couldn't analyze this request. Please try describing a garment, style, or outfit."
    : "We couldn't complete this scan. Please try again in better light or retake the photo.";
  const safeNonFashion = mode === 'text'
    ? "This doesn't appear to be a fashion query. Try describing a garment, style, or outfit."
    : 'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.';

  const status = canonical.status;
  const items = canonical.fashionAnalysis.items;
  const summary = canonical.fashionAnalysis.summary;

  if (status === 'success' && items.length === 0) {
    return {
      status: 'non_fashion',
      recommendedProducts: [],
      userMessage: summary ?? safeNonFashion,
    };
  }

  if (status === 'success' || status === 'partial') {
    const firstItem = items[0];
    const attributes: Record<string, unknown> = {};
    if (firstItem?.category) attributes.category = firstItem.category;
    if (firstItem?.itemType) attributes.itemType = firstItem.itemType;
    if (firstItem?.silhouette) attributes.silhouette = firstItem.silhouette;
    if (Array.isArray(firstItem?.colorPalette)) attributes.colorPalette = firstItem.colorPalette;
    if (firstItem?.materialEstimate) attributes.materialEstimate = firstItem.materialEstimate;
    if (firstItem?.pattern) attributes.pattern = firstItem.pattern;
    if (firstItem?.texture) attributes.texture = firstItem.texture;
    if (Array.isArray(firstItem?.styleTags)) attributes.styleTags = firstItem.styleTags;
    if (firstItem?.occasion) attributes.occasion = firstItem.occasion;
    if (typeof firstItem?.confidenceScore === 'number') attributes.confidenceScore = firstItem.confidenceScore;

    return {
      status: 'completed',
      recommendedProducts: [],
      userMessage: summary ?? (mode === 'text' ? 'Analyzed your fashion request.' : 'Identified a fashion item from your scan.'),
      attributes: Object.keys(attributes).length ? attributes : undefined,
    };
  }

  const error = canonical.errors[0];
  return {
    status: 'failed',
    recommendedProducts: [],
    userMessage: error?.userMessage ?? safeFailed,
  };
}

// ── Enrich legacy response with optional non-breaking metadata ───────────────

export function enrichLegacyResponse(
  legacy: Record<string, unknown>,
  canonical: KScanAIResponse,
): Record<string, unknown> {
  const enriched = { ...legacy };
  enriched.requestId = canonical.requestId;
  enriched.apiVersion = canonical.apiVersion;
  enriched.source = canonical.source;
  enriched.telemetry = canonical.telemetry;
  if (canonical.errors.length) {
    enriched.errors = canonical.errors.map(e => ({ code: e.code, userMessage: e.userMessage, recoverable: e.recoverable }));
  }
  return enriched;
}
