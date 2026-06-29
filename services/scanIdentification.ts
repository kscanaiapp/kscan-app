/**
 * Scan Identification client adapter (KS-REL-008C).
 *
 * Calls the `scan-identify` Supabase Edge Function with a compressed, locally
 * privacy-prepared image and returns a normalized {@link ScanIdentifyResponse}.
 *
 * Guarantees:
 *   - Uses the current authenticated Supabase client (token attached by invoke).
 *   - Validates + size-guards the payload before any network call (<= 2 MB).
 *   - Always returns a normalized response (status, recommendedProducts: [],
 *     userMessage); never throws raw provider/network errors at the UI.
 *   - recommendedProducts is always [] in this slice (product matching deferred).
 *   - Does not touch TextScan.
 */

import { supabase } from './supabaseClient';
import type {
  ScanIdentifyRequest,
  ScanIdentifyResponse,
  FashionAttributes,
  DetailedIdentification,
} from '../types/scanIdentification';

const EDGE_FN = 'scan-identify';
// Slightly longer than the edge function's provider timeout (~8 s) + overhead.
const INVOKE_TIMEOUT_MS = 12_000;
// Mirror the server guard so oversized payloads never leave the device.
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;

const SAFE_FAILED_MESSAGE =
  "We couldn't complete this scan. Please try again in better light or retake the photo.";
const IMAGE_TOO_LARGE_MESSAGE =
  'Image too large. Please retake the photo closer or in better light.';
const SIGN_IN_REQUIRED_MESSAGE = 'Please sign in to scan and identify fashion items.';
const NON_FASHION_MESSAGE =
  'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.';

export type IdentifyScanOptions = {
  source?: 'camera' | 'upload';
  localPrivacyFiltered?: boolean;
};

function failed(userMessage = SAFE_FAILED_MESSAGE): ScanIdentifyResponse {
  return { status: 'failed', recommendedProducts: [], userMessage };
}

/** Strip a data-URI prefix so only raw base64 is sent over the wire. */
function toRawBase64(image: string): string {
  return image.replace(/^data:[^;]+;base64,/, '').trim();
}

const STRING_ATTR_KEYS: (keyof FashionAttributes)[] = [
  'category',
  'itemType',
  'silhouette',
  'materialEstimate',
  'pattern',
  'texture',
  'occasion',
];
const ARRAY_ATTR_KEYS: (keyof FashionAttributes)[] = ['colorPalette', 'styleTags'];

function normalizeAttributes(raw: unknown): FashionAttributes | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: FashionAttributes = {};

  for (const key of STRING_ATTR_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) (out as Record<string, unknown>)[key] = v.trim();
  }
  for (const key of ARRAY_ATTR_KEYS) {
    const v = src[key];
    if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
      if (items.length) (out as Record<string, unknown>)[key] = items;
    }
  }
  const conf = src.confidenceScore;
  const n = typeof conf === 'number' ? conf : typeof conf === 'string' ? Number(conf) : NaN;
  if (Number.isFinite(n)) out.confidenceScore = Math.max(0, Math.min(1, n));

  return Object.keys(out).length ? out : undefined;
}

function normalizeIdentification(raw: unknown): DetailedIdentification | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: DetailedIdentification = {};

  const stringKeys: (keyof DetailedIdentification)[] = [
    'visual_observation',
    'item_type',
    'subtype',
    'primary_color',
    'pattern',
    'material_estimate',
    'silhouette',
    'fit',
    'length',
    'sleeve_length',
    'neckline_or_lapel',
    'closure',
    'visible_brand_text',
    'brand_guess',
  ];
  const arrayKeys: (keyof DetailedIdentification)[] = [
    'secondary_colors',
    'distinctive_features',
    'style_tags',
    'occasion_tags',
    'search_queries',
  ];

  for (const key of stringKeys) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) (out as Record<string, unknown>)[key] = v.trim();
  }
  for (const key of arrayKeys) {
    const v = src[key];
    if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
      if (items.length) (out as Record<string, unknown>)[key] = items;
    }
  }
  if (typeof src.logo_detected === 'boolean') out.logo_detected = src.logo_detected;
  if (typeof src.non_fashion === 'boolean') out.non_fashion = src.non_fashion;
  const conf = src.confidence_score;
  const n = typeof conf === 'number' ? conf : typeof conf === 'string' ? Number(conf) : NaN;
  if (Number.isFinite(n)) out.confidence_score = Math.max(0, Math.min(1, n));

  return Object.keys(out).length ? out : undefined;
}

/**
 * Normalize a raw Edge Function payload into a guaranteed-safe response shape.
 * Exported for unit testing.
 */
export function normalizeScanIdentifyResponse(raw: unknown): ScanIdentifyResponse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failed();
  const src = raw as Record<string, unknown>;

  const rawStatus = typeof src.status === 'string' ? src.status.toLowerCase() : '';
  const userMessage =
    typeof src.userMessage === 'string' && src.userMessage.trim()
      ? src.userMessage.trim()
      : undefined;

  if (rawStatus.includes('non')) {
    return { status: 'non_fashion', recommendedProducts: [], userMessage: userMessage ?? NON_FASHION_MESSAGE };
  }

  if (rawStatus === 'completed') {
    const attributes = normalizeAttributes(src.attributes);
    if (!attributes) return failed();
    return {
      status: 'completed',
      recommendedProducts: [],
      attributes,
      identification: normalizeIdentification(src.identification),
      userMessage: userMessage ?? 'Identified a fashion item from your scan.',
      scanId: typeof src.scanId === 'string' ? src.scanId : undefined,
    };
  }

  // Anything else (including explicit 'failed') maps to a safe failure.
  return failed(userMessage ?? SAFE_FAILED_MESSAGE);
}

/**
 * Identify a fashion item from a compressed, locally privacy-prepared image.
 *
 * @param image  data URI ("data:image/jpeg;base64,...") or raw base64.
 */
export async function identifyScanImage(
  image: string,
  options: IdentifyScanOptions = {},
): Promise<ScanIdentifyResponse> {
  if (!image || typeof image !== 'string') return failed();

  const imageBase64 = toRawBase64(image);
  if (!imageBase64) return failed();

  // Local size guard — compression already ran upstream; we cannot recompress here.
  if (imageBase64.length > MAX_IMAGE_BASE64_BYTES) {
    return failed(IMAGE_TOO_LARGE_MESSAGE);
  }

  // Authenticated calls only (default stance). Short-circuit before the network.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return failed(SIGN_IN_REQUIRED_MESSAGE);
  } catch {
    return failed(SIGN_IN_REQUIRED_MESSAGE);
  }

  const requestBody: ScanIdentifyRequest = {
    imageBase64,
    source: options.source === 'upload' ? 'upload' : 'camera',
    localPrivacyFiltered: options.localPrivacyFiltered ?? false,
    clientTimestamp: new Date().toISOString(),
  };

  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), INVOKE_TIMEOUT_MS);

  try {
    const { data, error } = await supabase.functions.invoke(EDGE_FN, {
      body: requestBody,
      signal: ac.signal,
    });

    if (error) {
      if (__DEV__) console.warn('[scanIdentification] invoke error:', error?.message);
      return failed();
    }

    return normalizeScanIdentifyResponse(data);
  } catch (err: any) {
    if (__DEV__) {
      const isAbort = err?.name === 'AbortError';
      console.warn('[scanIdentification]', isAbort ? 'invoke timed out' : err?.message);
    }
    return failed();
  } finally {
    clearTimeout(timeoutId);
  }
}
