// KicksCrew provider — all RapidAPI calls are made server-side by the
// `kickscrew-sneaker-description` Supabase Edge Function.
// The RapidAPI key is NEVER present here, in EXPO_PUBLIC_ vars, or in the bundle.

import { supabase } from '../../supabaseClient';
import type { SneakerReference } from '../types';
import { buildCacheKey, cacheGet, cacheSet } from '../cache';
import { markRateLimited, throttleProvider } from '../rateLimit';

const PROVIDER       = 'kickscrew';
const INVOKE_TIMEOUT = 5000;
const EDGE_FN        = 'kickscrew-sneaker-description';
const KC_ORIGIN      = 'https://www.kickscrew.com/';

// ─── Price helpers ────────────────────────────────────────────────────────────

type RawVariant = Record<string, unknown>;

function lowestVariantPrice(product: Record<string, unknown>): number | null {
  const variants = Array.isArray(product.variants) ? (product.variants as RawVariant[]) : [];
  const prices = variants
    .map(v => parseFloat(String(v?.price ?? '')))
    .filter(p => isFinite(p) && p > 0);
  if (prices.length === 0) return null;
  return Math.min(...prices);
}

// ─── Normalizer ───────────────────────────────────────────────────────────────

function normalize(data: Record<string, unknown>, productUrl: string): SneakerReference | null {
  const product = data?.product as Record<string, unknown> | undefined;
  if (!product || typeof product !== 'object') return null;

  const name = (product.title as string | undefined) ?? null;
  if (!name) return null;

  const marketPrice = lowestVariantPrice(product);

  const imageUrl =
    (product.image as Record<string, unknown> | undefined)?.src as string | null ??
    (Array.isArray(product.images) && product.images.length > 0
      ? (product.images[0] as Record<string, unknown>)?.src as string | null
      : null) ??
    null;

  const firstVariant = Array.isArray(product.variants) && product.variants.length > 0
    ? (product.variants[0] as RawVariant)
    : null;

  return {
    source:               PROVIDER,
    confidence:           0.95,
    name,
    brand:                (product.vendor as string | undefined) ?? null,
    model:                null,
    sku:                  firstVariant ? String(firstVariant.sku ?? '') || null : null,
    colorway:             null,
    retailPrice:          null,
    estimatedMarketValue: marketPrice,
    lowestAsk:            marketPrice,
    lastSale:             null,
    releaseDate:          null,
    imageUrl:             typeof imageUrl === 'string' ? imageUrl : null,
    productUrl,
    marketplaceLinks:     { kickscrew: productUrl },
    raw:                  data,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export async function searchKicksCrewRapidApi(
  productUrl: string | null | undefined,
): Promise<SneakerReference[]> {
  if (!productUrl || typeof productUrl !== 'string') return [];
  if (!productUrl.startsWith(KC_ORIGIN)) return [];

  const key    = buildCacheKey(PROVIDER, productUrl);
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  return throttleProvider(PROVIDER, async () => {
    const ac        = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), INVOKE_TIMEOUT);

    try {
      const { data, error } = await supabase.functions.invoke(EDGE_FN, {
        body:   { productUrl },
        signal: ac.signal,
      });

      if (error) {
        const msg = String(error?.message ?? '');
        if (__DEV__) console.warn(`[sneakers/${PROVIDER}] invoke error: ${msg}`);
        if (msg.includes('429')) markRateLimited(PROVIDER);
        cacheSet(key, []);
        return [];
      }

      // Edge Function returned a structured error body.
      if (
        !data ||
        typeof data !== 'object' ||
        (data as Record<string, unknown>).error
      ) {
        if (__DEV__) {
          const edgeErr = (data as Record<string, unknown> | null)?.error;
          if (edgeErr) console.warn(`[sneakers/${PROVIDER}] edge error: ${edgeErr}`);
        }
        cacheSet(key, []);
        return [];
      }

      const ref = normalize(data as Record<string, unknown>, productUrl);
      const results: SneakerReference[] = ref ? [ref] : [];

      cacheSet(key, results);
      return results;

    } catch (err: any) {
      if (__DEV__) {
        const isAbort = err?.name === 'AbortError';
        console.warn(`[sneakers/${PROVIDER}]`, isAbort ? 'invoke timed out' : err?.message);
      }
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);
}
