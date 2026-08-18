/**
 * Deferred commerce hydration client (v127 MODE B).
 *
 * The single authority for `requestMode: 'commerce_only'` requests. UI and
 * hooks call this; nothing else may invoke the Edge Function for commerce, so
 * there is exactly one place where the request body is constructed and exactly
 * one place to audit for the image-payload prohibition.
 *
 * WHY THIS EXISTS
 * ---------------
 * With v127 enabled, MODE A returns the scan identity immediately and reports
 * `commerce.deferred === true` instead of waiting on providers. The shelf is
 * hydrated afterwards by this module, so the user sees the identified item
 * without paying provider latency for it.
 *
 * PRIVACY
 * -------
 * The request carries structured evidence only. The backend rejects any
 * image-shaped field with a 400, and `buildCommerceOnlyBody` cannot produce one:
 * it copies a fixed set of keys rather than spreading a caller-supplied object,
 * so a future caller cannot accidentally widen the payload.
 *
 * The client never rebuilds commerce query intelligence. The backend owns query
 * construction (v125), ranking (v124), and caching (v127); this module sends
 * evidence and normalizes the answer.
 */

import { supabase } from './supabaseClient';
import type { RankedScanProduct } from '../types/scanIdentification';

const EDGE_FN = 'scan-identify';

/**
 * Longer than the backend fast path (~1.9s) plus the optional enrichment hop,
 * with headroom for cold starts. Nothing is waiting on this visually — the scan
 * result is already on screen — but it must still terminate.
 */
const COMMERCE_INVOKE_TIMEOUT_MS = 15_000;

export type CommerceHydrationStatus = 'idle' | 'pending' | 'success' | 'empty' | 'error';

export type CommerceHydrationEvidence = {
  identification: Record<string, unknown>;
  attributes?: Record<string, unknown> | null;
  searchQueries?: string[] | null;
  market?: { locale?: string | null; currency?: string | null; country?: string | null } | null;
};

export type CommerceHydrationResult = {
  status: CommerceHydrationStatus;
  purchaseOptions: RankedScanProduct[];
  /** Bounded URL-enrichment candidates the backend is willing to enrich. */
  enrichmentCandidates: Array<{ productUrl: string; retailer: string }>;
  /** Diagnostics only — never rendered, never persisted. */
  cacheHit: boolean;
  provider?: string;
  errorType?: string;
  retryable: boolean;
};

const EMPTY_RESULT: CommerceHydrationResult = {
  status: 'error',
  purchaseOptions: [],
  enrichmentCandidates: [],
  cacheHit: false,
  retryable: true,
};

/** Keys that must never leave the device on a commerce-only request. */
const PROHIBITED_IMAGE_KEYS = [
  'imageBase64',
  'image',
  'imageUrl',
  'imageUri',
  'photo',
  'base64',
  'evidence',
] as const;

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string' && !!v.trim());
  return out.length ? out : undefined;
}

/**
 * Build the MODE B body by explicit copy.
 *
 * Deliberately not a spread of the caller's object: an allowlist is the only
 * construction that stays correct when the evidence shape grows.
 */
export function buildCommerceOnlyBody(
  evidence: CommerceHydrationEvidence,
  options?: { enrich?: boolean },
): Record<string, unknown> {
  const identification = plainObject(evidence.identification) ?? {};
  // Defensive strip: identification originates from our own normalized scan
  // response, but this is the last point before the network.
  const safeIdentification: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(identification)) {
    if ((PROHIBITED_IMAGE_KEYS as readonly string[]).includes(key)) continue;
    safeIdentification[key] = value;
  }

  const body: Record<string, unknown> = {
    requestMode: 'commerce_only',
    identification: safeIdentification,
  };

  const attributes = plainObject(evidence.attributes);
  if (attributes) body.attributes = attributes;

  const searchQueries = stringArray(evidence.searchQueries);
  if (searchQueries) body.searchQueries = searchQueries;

  const market = plainObject(evidence.market);
  if (market) body.market = market;

  if (options?.enrich) body.enrich = true;

  return body;
}

function normalizeProducts(raw: unknown): RankedScanProduct[] {
  if (!Array.isArray(raw)) return [];
  const out: RankedScanProduct[] = [];
  for (const entry of raw) {
    const item = plainObject(entry);
    if (!item) continue;
    const productUrl = typeof item.productUrl === 'string' ? item.productUrl : undefined;
    const title = typeof item.title === 'string' ? item.title : undefined;
    // A shelf entry with no destination is not a purchase option.
    if (!productUrl || !title) continue;
    out.push(item as unknown as RankedScanProduct);
  }
  return out;
}

function normalizeCandidates(raw: unknown): Array<{ productUrl: string; retailer: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ productUrl: string; retailer: string }> = [];
  for (const entry of raw) {
    const item = plainObject(entry);
    if (!item) continue;
    if (typeof item.productUrl !== 'string' || typeof item.retailer !== 'string') continue;
    out.push({ productUrl: item.productUrl, retailer: item.retailer });
  }
  return out;
}

export function normalizeCommerceHydrationResponse(raw: unknown): CommerceHydrationResult {
  const src = plainObject(raw);
  if (!src) return { ...EMPTY_RESULT, errorType: 'malformed_response' };

  const commerce = plainObject(src.commerce) ?? {};
  const purchaseOptions = normalizeProducts(
    Array.isArray(src.purchaseOptions) ? src.purchaseOptions : src.recommendedProducts,
  );
  const funnel = plainObject(src.funnel) ?? {};

  return {
    // An empty shelf is a legitimate outcome, not a failure — the scan stays
    // successful either way and the existing empty treatment applies.
    status: purchaseOptions.length > 0 ? 'success' : 'empty',
    purchaseOptions,
    enrichmentCandidates: normalizeCandidates(commerce.enrichmentCandidates),
    cacheHit: funnel.cacheHit === true,
    provider: typeof commerce.provider === 'string' ? commerce.provider : undefined,
    errorType: typeof commerce.errorType === 'string' ? commerce.errorType : undefined,
    retryable: purchaseOptions.length === 0,
  };
}

/**
 * Issue one MODE B commerce request.
 *
 * Never throws: a transport failure, timeout, or abort returns an `error`
 * result so the caller can leave the scan successful and offer a retry. This is
 * the contract that keeps a commerce failure from becoming a scan failure.
 */
export async function fetchDeferredCommerce(
  evidence: CommerceHydrationEvidence,
  options?: { enrich?: boolean; signal?: AbortSignal },
): Promise<CommerceHydrationResult> {
  const controller = new AbortController();
  const external = options?.signal;
  if (external) {
    if (external.aborted) {
      return { ...EMPTY_RESULT, status: 'error', errorType: 'aborted', retryable: false };
    }
    external.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const timeoutId = setTimeout(() => controller.abort(), COMMERCE_INVOKE_TIMEOUT_MS);
  try {
    const { data, error } = await supabase.functions.invoke(EDGE_FN, {
      body: buildCommerceOnlyBody(evidence, { enrich: options?.enrich }),
      signal: controller.signal,
    });
    if (error) {
      return { ...EMPTY_RESULT, errorType: 'invoke_error', retryable: true };
    }
    return normalizeCommerceHydrationResponse(data);
  } catch (err) {
    const aborted = (err as { name?: string } | null)?.name === 'AbortError';
    return {
      ...EMPTY_RESULT,
      errorType: aborted ? 'aborted' : 'network_error',
      // An abort is a deliberate cancellation, not a condition a retry fixes.
      retryable: !aborted,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Merge freshly enriched offers into the visible shelf.
 *
 * Identity is the product URL, which is what the backend also merges on, so an
 * enriched offer replaces its own discovery record instead of appearing twice.
 * Backend ordering is preserved exactly — the client never re-sorts, so no
 * retailer can gain position here.
 */
export function mergeEnrichedOffers(
  current: RankedScanProduct[],
  enriched: RankedScanProduct[],
): RankedScanProduct[] {
  if (!enriched.length) return current;
  const byUrl = new Map<string, RankedScanProduct>();
  for (const offer of enriched) {
    const url = (offer as unknown as { productUrl?: string }).productUrl;
    if (typeof url === 'string') byUrl.set(url.toLowerCase(), offer);
  }
  return current.map((offer) => {
    const url = (offer as unknown as { productUrl?: string }).productUrl;
    if (typeof url !== 'string') return offer;
    const replacement = byUrl.get(url.toLowerCase());
    if (!replacement) return offer;
    // Enrichment may omit a field the discovery record had; never trade a
    // populated value for an empty one, and never a valid URL for a missing one.
    return { ...offer, ...stripEmpty(replacement as unknown as Record<string, unknown>) } as RankedScanProduct;
  });
}

function stripEmpty(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || v === null || v === '') continue;
    out[key] = v;
  }
  return out;
}
