// Experimental provider. Upstream RapidAPI endpoint returned 404 for tested Nike URLs as of setup. Do not wire into production flows until a supported URL or endpoint is confirmed.
//
// Nike Shoe Details client service.
// All RapidAPI calls are made server-side by the `nike-shoe-details`
// Supabase Edge Function.  No API key is present here or in the client bundle.

import { supabase } from './supabaseClient';

const EDGE_FN        = 'nike-shoe-details';
const INVOKE_TIMEOUT = 10_000; // slightly longer than the edge fn's 8 s upstream timeout

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NikeShoeRequest {
  product_url: string;
}

export interface NikeShoeResult {
  source:       'nike_shoe_details';
  productUrl:   string;
  title:        string | null;
  subtitle:     string | null;
  price:        number | null;
  currency:     string | null;
  imageUrl:     string | null;
  styleCode:    string | null;
  colorway:     string | null;
  description:  string | null;
  sizes:        unknown;
  availability: unknown;
  raw:          unknown;
}

// ─── Response normalizer ──────────────────────────────────────────────────────
// Field paths are inspected from real payload shapes at runtime.
// Multiple candidate keys are checked in priority order to handle API variation.

function normalizePrice(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = parseFloat(value.replace(/[^0-9.]/g, ''));
    return isFinite(n) ? n : null;
  }
  return null;
}

function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

export function normalizeNikeResult(productUrl: string, data: Record<string, unknown>): NikeShoeResult {
  // Title — common field patterns
  const title = firstString(
    data.title,
    data.name,
    data.product_name,
    data.shoe_name,
    (data.product as Record<string, unknown> | undefined)?.title,
    (data.product as Record<string, unknown> | undefined)?.name,
  );

  // Subtitle — often the colorway description on Nike PDPs
  const subtitle = firstString(
    data.subtitle,
    data.sub_title,
    data.sub_heading,
    (data.product as Record<string, unknown> | undefined)?.subtitle,
  );

  // Price — handle "$130", 130, "130.00"
  const priceRaw =
    data.price ??
    data.retail_price ??
    data.msrp ??
    (data.product as Record<string, unknown> | undefined)?.price ??
    (data.pricing as Record<string, unknown> | undefined)?.retail ??
    null;
  const price = normalizePrice(priceRaw);

  // Currency
  const currency = firstString(
    data.currency,
    data.currency_code,
    (data.product as Record<string, unknown> | undefined)?.currency,
    (data.pricing as Record<string, unknown> | undefined)?.currency,
  );

  // Image URL — prefer larger variants
  const imageUrl = firstString(
    data.image_url,
    data.imageUrl,
    data.image,
    data.thumbnail,
    (Array.isArray(data.images) ? data.images[0] : undefined),
    (data.product as Record<string, unknown> | undefined)?.image_url,
    (data.product as Record<string, unknown> | undefined)?.image,
  );

  // Style code / SKU
  const styleCode = firstString(
    data.style_code,
    data.sku,
    data.style_id,
    data.product_id,
    data.style_color,
    (data.product as Record<string, unknown> | undefined)?.style_code,
    (data.product as Record<string, unknown> | undefined)?.sku,
  );

  // Colorway
  const colorway = firstString(
    data.colorway,
    data.color,
    data.color_description,
    data.colour_description,
    (data.product as Record<string, unknown> | undefined)?.colorway,
    (data.product as Record<string, unknown> | undefined)?.color,
  );

  // Description
  const description = firstString(
    data.description,
    data.product_description,
    (data.product as Record<string, unknown> | undefined)?.description,
  );

  // Sizes — keep raw; structure varies widely (array of strings, array of objects, nested map)
  const sizes =
    data.sizes ??
    data.available_sizes ??
    (data.product as Record<string, unknown> | undefined)?.sizes ??
    null;

  // Availability — keep raw; may be boolean, string, or per-size map
  const availability =
    data.availability ??
    data.in_stock ??
    data.stock_status ??
    (data.product as Record<string, unknown> | undefined)?.availability ??
    null;

  return {
    source: 'nike_shoe_details',
    productUrl,
    title,
    subtitle,
    price,
    currency,
    imageUrl,
    styleCode,
    colorway,
    description,
    sizes,
    availability,
    raw: data,
  };
}

// ─── Client function ──────────────────────────────────────────────────────────

export async function fetchNikeShoeDetails(
  request: NikeShoeRequest,
): Promise<NikeShoeResult | null> {
  const { product_url } = request;

  if (!product_url || typeof product_url !== 'string') return null;

  const ac        = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), INVOKE_TIMEOUT);

  try {
    const { data, error } = await supabase.functions.invoke(EDGE_FN, {
      body:   { product_url },
      signal: ac.signal,
    });

    if (error) {
      if (__DEV__) console.warn('[nikeShoeDetails] invoke error:', error?.message);
      return null;
    }

    if (!data || typeof data !== 'object' || (data as Record<string, unknown>).error) {
      if (__DEV__) {
        const edgeErr = (data as Record<string, unknown> | null)?.error;
        if (edgeErr) console.warn('[nikeShoeDetails] edge error:', edgeErr);
      }
      return null;
    }

    return normalizeNikeResult(product_url, data as Record<string, unknown>);

  } catch (err: any) {
    if (__DEV__) {
      const isAbort = err?.name === 'AbortError';
      console.warn('[nikeShoeDetails]', isAbort ? 'invoke timed out' : err?.message);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
