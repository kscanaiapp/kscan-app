// Real-Time Product Search client service.
// All RapidAPI calls are made server-side by the `product-search-deals`
// Supabase Edge Function.  No API key is present here or in the client bundle.

import { supabase } from './supabaseClient';

const EDGE_FN        = 'product-search-deals';
const INVOKE_TIMEOUT = 25_000; // slightly longer than the edge fn's 20 s upstream timeout

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductSearchRequest {
  q:                  string;
  limit?:             number;
  offset?:            number;
  country?:           string;
  language?:          string;
  sort_by?:           string;
  product_condition?: string;
}

export interface ProductSearchItem {
  title:       string | null;
  price:       number | null;
  currency:    string | null;
  imageUrl:    string | null;
  productUrl:  string | null;
  sourceName:  string | null;
  rating:      number | null;
  reviewCount: number | null;
  raw:         unknown;
}

export interface ProductSearchResult {
  source:   'real_time_product_search';
  query:    string;
  products: ProductSearchItem[];
  raw:      unknown;
}

// ─── Response normalizer ──────────────────────────────────────────────────────

function normalizeItem(item: Record<string, unknown>): ProductSearchItem {
  const priceRaw =
    (item.price      as number | string | undefined) ??
    (item.sale_price as number | string | undefined) ??
    null;

  const price =
    typeof priceRaw === 'number'
      ? priceRaw
      : typeof priceRaw === 'string'
        ? parseFloat(priceRaw) || null
        : null;

  const imageUrl =
    (item.product_photos as string[] | undefined)?.[0] ??
    (item.image_url   as string | undefined) ??
    (item.imageUrl    as string | undefined) ??
    (item.thumbnail   as string | undefined) ??
    null;

  const productUrl =
    (item.product_page_url as string | undefined) ??
    (item.product_url      as string | undefined) ??
    (item.productUrl       as string | undefined) ??
    (item.url              as string | undefined) ??
    null;

  const sourceName =
    (item.store_name   as string | undefined) ??
    (item.retailer     as string | undefined) ??
    (item.source       as string | undefined) ??
    (item.shop_name    as string | undefined) ??
    null;

  const rating =
    typeof item.product_rating === 'number'
      ? item.product_rating
      : typeof item.rating === 'number'
        ? item.rating
        : null;

  const reviewCount =
    typeof item.product_num_reviews === 'number'
      ? item.product_num_reviews
      : typeof item.reviews === 'number'
        ? item.reviews
        : null;

  return {
    title:       typeof item.product_title === 'string' ? item.product_title
                 : typeof item.title === 'string' ? item.title
                 : null,
    price,
    currency:    typeof item.currency === 'string' ? item.currency : null,
    imageUrl:    typeof imageUrl === 'string' ? imageUrl : null,
    productUrl:  typeof productUrl === 'string' ? productUrl : null,
    sourceName:  typeof sourceName === 'string' ? sourceName : null,
    rating,
    reviewCount,
    raw: item,
  };
}

function normalizeResult(query: string, data: Record<string, unknown>): ProductSearchResult {
  const rawProducts =
    (data.products  as unknown[] | undefined) ??
    (data.deals     as unknown[] | undefined) ??
    (data.results   as unknown[] | undefined) ??
    (data.data      as unknown[] | undefined) ??
    [];

  const products = Array.isArray(rawProducts)
    ? rawProducts
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p))
        .map(normalizeItem)
    : [];

  return {
    source:   'real_time_product_search',
    query,
    products,
    raw: data,
  };
}

// ─── Client function ──────────────────────────────────────────────────────────

export async function searchProductDeals(
  request: ProductSearchRequest,
): Promise<ProductSearchResult | null> {
  const { q } = request;

  if (!q || typeof q !== 'string' || q.trim().length === 0) return null;

  const ac        = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), INVOKE_TIMEOUT);

  try {
    const body: Record<string, unknown> = { q: q.trim() };
    if (request.limit             !== undefined) body.limit             = request.limit;
    if (request.offset            !== undefined) body.offset            = request.offset;
    if (request.country           !== undefined) body.country           = request.country;
    if (request.language          !== undefined) body.language          = request.language;
    if (request.sort_by           !== undefined) body.sort_by           = request.sort_by;
    if (request.product_condition !== undefined) body.product_condition = request.product_condition;

    const { data, error } = await supabase.functions.invoke(EDGE_FN, {
      body,
      signal: ac.signal,
    });

    if (error) {
      if (__DEV__) console.warn('[productSearchDeals] invoke error:', error?.message);
      return null;
    }

    if (!data || typeof data !== 'object' || (data as Record<string, unknown>).error) {
      if (__DEV__) {
        const edgeErr = (data as Record<string, unknown> | null)?.error;
        if (edgeErr) console.warn('[productSearchDeals] edge error:', edgeErr);
      }
      return null;
    }

    return normalizeResult(q.trim(), data as Record<string, unknown>);

  } catch (err: any) {
    if (__DEV__) {
      const isAbort = err?.name === 'AbortError';
      console.warn('[productSearchDeals]', isAbort ? 'invoke timed out' : err?.message);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Dev helper ───────────────────────────────────────────────────────────────

export async function testProductSearchDeals(): Promise<void> {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;

  console.log('[productSearchDeals-test] ── Starting integration test ──');

  const start  = Date.now();
  const result = await searchProductDeals({ q: 'Nike sneakers', limit: 5 });
  const ms     = Date.now() - start;

  if (!result) {
    console.warn('[productSearchDeals-test] returned null —', ms, 'ms');
  } else {
    console.log(
      `[productSearchDeals-test] "${result.query}" — ${result.products.length} product(s) in ${ms}ms`,
      result.products.map(p => `${p.sourceName ?? 'unknown'}: ${p.title} $${p.price ?? '?'} ${p.productUrl ? '(has URL)' : '(no URL)'}`),
    );
  }

  console.log('[productSearchDeals-test] ── Done ──');
}
