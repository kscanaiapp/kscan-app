import { SCAN_CONTRACT_VERSION } from './version';
import { buildScanRequest, createScanRequestId } from './request';
import { buildScanResponse } from './response';
import { normalizeLegacyAttributes, sanitizeUserMessage } from './normalize';
import { createScanError } from './errors';
import { formatProductPrice } from './productMatch';
import type { ScanRequest, ScanSource, ScanImageInput, ScanPrivacyContext, ScanDeviceContext } from './request';
import type { ScanResponse, ScanStatus } from './response';
import type { FashionAttributes } from './fashionAttributes';
import type { ProductMatch } from './productMatch';

/**
 * Convert a legacy mobile/Render request into the shared ScanRequest shape.
 * Unknown fields are ignored. This adapter is for tests, fixtures, and future
 * migration only; existing mobile code does not import it.
 */
export function toSharedScanRequest(legacyInput: Record<string, unknown>): ScanRequest {
  const source = inferSource(legacyInput);
  const image = extractImage(legacyInput);
  const textQuery = extractTextQuery(legacyInput);

  const privacy: ScanPrivacyContext = {
    sanitizerVersion: '1.0.0',
    mode: 'passthrough',
    faceDetectionPerformed: false,
    faceMaskApplied: false,
    plateDetectionPerformed: false,
    plateMaskApplied: false,
  };

  const device: ScanDeviceContext | undefined =
    typeof legacyInput.source === 'string' && legacyInput.source.startsWith('wearable')
      ? { deviceClass: 'wearable_mock', platform: legacyInput.platform as string | undefined }
      : { deviceClass: 'mobile', platform: legacyInput.platform as string | undefined };

  return buildScanRequest(source, {
    image,
    textQuery,
    privacy,
    device,
  });
}

function inferSource(input: Record<string, unknown>): ScanSource {
  const rawSource = String(input.source ?? '').toLowerCase();
  const mode = String(input.mode ?? '').toLowerCase();

  if (rawSource.includes('wearable') || rawSource.includes('glasses')) return 'wearable_mock';
  if (mode === 'text' || rawSource.includes('textscan')) return 'text_scan';
  if (input.image || input.imageBase64) return 'mobile_upload';
  return 'mobile_camera';
}

function extractImage(input: Record<string, unknown>): ScanRequest['image'] | undefined {
  const raw = input.image ?? input.imageBase64;
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const mimeMatch = trimmed.match(/^data:(image\/(?:jpeg|png|webp));base64,/i);
  // FIX (glasses-foundation-audit): `ScanRequest['image']` resolves to
  // `ScanImageInput | undefined` because `image` is an optional property.
  // Indexing `['mimeType']` directly on that union fails to compile under
  // `tsc --noEmit`. Using the non-optional `ScanImageInput` type directly
  // fixes the type error without changing runtime behavior.
  const mimeType: ScanImageInput['mimeType'] = mimeMatch
    ? (mimeMatch[1] as ScanImageInput['mimeType'])
    : 'image/jpeg';
  const base64 = trimmed.replace(/^data:[^;]+;base64,/, '');

  return { base64, mimeType };
}

function extractTextQuery(input: Record<string, unknown>): string | undefined {
  const raw = input.query ?? input.textQuery;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return undefined;
}

/**
 * Normalize a legacy analyze response (from server.js or app/api/analyze+api.js)
 * into the shared ScanResponse shape.
 */
export function normalizeLegacyAnalyzeResponse(
  legacyResponse: Record<string, unknown>,
  requestId?: string,
): ScanResponse {
  const rid = typeof requestId === 'string' && requestId.trim() ? requestId : createScanRequestId();
  const type = String(legacyResponse.type ?? '').toLowerCase();

  if (type.includes('non')) {
    return buildScanResponse(rid, 'non_fashion', {
      message: sanitizeUserMessage(legacyResponse.message as string) ?? 'Not a fashion item.',
    });
  }

  const attrs = normalizeLegacyAttributes(legacyResponse.metadata);
  const products = normalizeLegacyProducts(legacyResponse.products);

  return buildScanResponse(rid, products.length || (attrs && Object.keys(attrs).length) ? 'success' : 'partial', {
    attributes: attrs,
    products,
    message: sanitizeUserMessage(legacyResponse.result as string) ?? undefined,
  });
}

function normalizeLegacyProducts(raw: unknown): ProductMatch[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => p && typeof p === 'object' && !Array.isArray(p))
    .map((p, index) => {
      const title =
        typeof p.name === 'string' && p.name.trim()
          ? p.name.trim()
          : typeof p.title === 'string' && p.title.trim()
            ? p.title.trim()
            : `Product ${index + 1}`;
      const retailer = typeof p.retailer === 'string' && p.retailer.trim() ? p.retailer.trim() : 'Retailer unavailable';
      const out: ProductMatch = {
        id: typeof p.id === 'string' && p.id.trim() ? p.id.trim() : String(index),
        title,
        retailer,
      };
      if (typeof p.price === 'number' && Number.isFinite(p.price)) out.price = p.price;
      if (typeof p.currency === 'string' && p.currency.trim()) out.currency = p.currency.trim();
      if (typeof p.imageUrl === 'string' && p.imageUrl.trim()) out.imageUrl = p.imageUrl.trim();
      if (typeof p.productUrl === 'string' && p.productUrl.trim()) out.productUrl = p.productUrl.trim();
      if (typeof p.purchaseUrl === 'string' && p.purchaseUrl.trim()) out.productUrl = p.purchaseUrl.trim();
      if (typeof p.affiliateUrl === 'string' && p.affiliateUrl.trim()) out.affiliateUrl = p.affiliateUrl.trim();
      if (typeof p.similarity === 'number' && Number.isFinite(p.similarity)) out.similarity = p.similarity;
      if (typeof p.source === 'string' && p.source.trim()) out.source = p.source.trim();
      if (typeof p.availability === 'string' && p.availability.trim()) out.availability = p.availability.trim();
      return out;
    });
}

/**
 * Convert a shared ScanResponse into a legacy-compatible result object.
 * Existing mobile screens expect `{ type: 'fashion' | 'non-fashion', result, message, metadata, products }`.
 */
export function toLegacyCompatibleResult(response: ScanResponse): Record<string, unknown> {
  if (response.status === 'non_fashion') {
    return {
      type: 'non-fashion',
      message: response.message ?? 'Not a fashion item.',
      metadata: { category: '', color: '', silhouette: '' },
      products: [],
    };
  }

  if (response.status === 'error') {
    return {
      type: 'error',
      result: response.error?.message ?? defaultErrorMessage(),
      metadata: { category: '', color: '', silhouette: '' },
      products: [],
    };
  }

  const attrs = response.attributes ?? {};
  return {
    type: 'fashion',
    result: response.message ?? 'Identified a fashion item from your scan.',
    metadata: {
      category: attrs.category ?? '',
      color: attrs.color ?? (Array.isArray(attrs.colorPalette) && attrs.colorPalette[0] ? attrs.colorPalette[0] : ''),
      silhouette: attrs.silhouette ?? '',
      itemType: attrs.subcategory ?? '',
      material: attrs.materialEstimate ?? '',
    },
    products: (response.products ?? []).map((p) => ({
      id: p.id ?? '',
      name: p.title,
      retailer: p.retailer,
      // FIX (glasses-foundation-audit): previously hardcoded a '$' prefix,
      // ignoring `p.currency`. `formatProductPrice` already implements
      // currency-aware formatting (falling back to '$' when currency is
      // absent), so reuse it instead of duplicating and diverging logic.
      price: formatProductPrice(p) ?? 'Price unavailable',
      imageUrl: p.imageUrl ?? null,
      productUrl: p.productUrl ?? null,
      purchaseUrl: p.productUrl ?? null,
      affiliateUrl: p.affiliateUrl ?? null,
    })),
  };
}

function defaultErrorMessage(): string {
  return "We couldn't complete this scan. Please try again.";
}
