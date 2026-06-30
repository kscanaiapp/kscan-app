/**
 * Deno-safe catalog retrieval helpers for scan-identify Edge Function.
 * No Node APIs. Uses Supabase client passed from caller.
 */

import type { NormalizedIdentification } from '../_shared/scanHelpers.ts';

// ── Types ───────────────────────────────────────────────────────────────────────

export type CatalogProductCandidate = {
  id: string;
  retailer?: string | null;
  brand?: string | null;
  product_name?: string;
  name?: string;
  title?: string;
  description?: string;
  price?: number | null;
  currency?: string | null;
  product_url?: string | null;
  purchaseUrl?: string | null;
  url?: string | null;
  image_url?: string | null;
  imageUrl?: string | null;
  availability?: string | null;
  canonical_category?: string;
  category?: string;
  color_normalized?: string | null;
  color?: string | null;
  material_tags?: string[];
  material?: string | null;
  materialEstimate?: string | null;
  silhouette_tags?: string[];
  silhouette?: string | null;
  style_tags?: string[];
  styleTags?: string[];
  tags?: string[];
  pattern_tags?: string[];
  distinctive_features?: string[];
  raw_category?: string | null;
  search_text?: string | null;
  external_product_id?: string | null;
  source?: string | null;
  last_seen_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

// ── Fetch ───────────────────────────────────────────────────────────────────────

/**
 * Query catalog candidates by canonical category.
 * Returns rows sorted by: color match, availability, last_seen_at, created_at.
 * Does not throw on query errors; logs a safe warning and returns [].
 */
export async function fetchCatalogCandidates(
  supabaseClient: unknown,
  normalizedIdentification: NormalizedIdentification | null,
  options?: { limit?: number },
): Promise<CatalogProductCandidate[]> {
  if (!supabaseClient || typeof (supabaseClient as Record<string, unknown>).from !== 'function') {
    return [];
  }

  if (!normalizedIdentification) return [];

  const canonicalCategory = normalizedIdentification.canonicalCategory;
  if (!canonicalCategory || canonicalCategory === 'unknown' || canonicalCategory === '') {
    return [];
  }

  const limit = Math.max(1, Math.min(100, options?.limit ?? 30));
  const sb = supabaseClient as { from: (table: string) => { select: (cols: string) => { eq: (col: string, val: string) => { limit: (n: number) => { order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => Promise<{ data: unknown[] | null; error: { message: string } | null }> } } } } };

  try {
    const { data, error } = await sb
      .from('product_catalog')
      .select('*')
      .eq('canonical_category', canonicalCategory)
      .limit(limit * 3)
      .order('last_seen_at', { ascending: false, nullsFirst: false });

    if (error) {
      console.warn('[catalogRetrieval] query_error category=%s message=%s', canonicalCategory, error.message);
      return [];
    }

    if (!Array.isArray(data)) return [];

    const rows = data as CatalogProductCandidate[];

    // Sort in JS: exact color match first, then availability, then last_seen_at, then created_at
    const color = normalizedIdentification.canonicalColor;
    rows.sort((a, b) => {
      const aColor = a.color_normalized || '';
      const bColor = b.color_normalized || '';
      const aColorMatch = color && aColor.toLowerCase() === color.toLowerCase() ? 1 : 0;
      const bColorMatch = color && bColor.toLowerCase() === color.toLowerCase() ? 1 : 0;
      if (aColorMatch !== bColorMatch) return bColorMatch - aColorMatch;

      const aAvail = availabilityPriority(a.availability);
      const bAvail = availabilityPriority(b.availability);
      if (aAvail !== bAvail) return bAvail - aAvail;

      const aSeen = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
      const bSeen = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
      if (aSeen !== bSeen) return bSeen - aSeen;

      const aCreated = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bCreated = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bCreated - aCreated;
    });

    return rows.slice(0, limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[catalogRetrieval] exception category=%s message=%s', canonicalCategory, msg);
    return [];
  }
}

function availabilityPriority(availability?: string | null): number {
  // Tiers: in_stock (2) > unknown/missing (1) > out_of_stock/other (0).
  // Null/empty availability is treated as "unknown" — below in_stock but above
  // an explicit out_of_stock, so sparse rows missing the field are not buried
  // beneath known-unavailable rows.
  if (!availability) return 1;
  const a = availability.toLowerCase();
  if (a === 'in_stock' || a === 'in stock' || a === 'available') return 2;
  if (a === 'unknown') return 1;
  if (a === 'out_of_stock' || a === 'out of stock' || a === 'sold_out' || a === 'sold out' || a === 'unavailable') return 0;
  return 0;
}

// ── Adapt ───────────────────────────────────────────────────────────────────────

/**
 * Add ranker-facing aliases to a catalog candidate without removing original DB fields.
 * If an alias already exists, it is preserved (the original DB field is more authoritative).
 */
export function adaptCatalogCandidate(
  candidate: CatalogProductCandidate,
): CatalogProductCandidate {
  const out = { ...candidate };

  if (!out.name && out.product_name) out.name = out.product_name;
  if (!out.title && out.product_name) out.title = out.product_name;
  if (!out.purchaseUrl && out.product_url) out.purchaseUrl = out.product_url;
  if (!out.url && out.product_url) out.url = out.product_url;
  if (!out.imageUrl && out.image_url) out.imageUrl = out.image_url;
  if (!out.category && out.canonical_category) out.category = out.canonical_category;
  if (!out.color && out.color_normalized) out.color = out.color_normalized;
  if (!out.material && out.material_tags && out.material_tags.length > 0) out.material = out.material_tags[0];
  if (!out.materialEstimate && out.material_tags && out.material_tags.length > 0) out.materialEstimate = out.material_tags[0];
  if (!out.silhouette && out.silhouette_tags && out.silhouette_tags.length > 0) out.silhouette = out.silhouette_tags[0];
  if (!out.styleTags && out.style_tags && out.style_tags.length > 0) out.styleTags = out.style_tags;
  if (!out.tags && out.style_tags && out.style_tags.length > 0) out.tags = out.style_tags;
  if (!out.tags && out.distinctive_features && out.distinctive_features.length > 0) out.tags = out.distinctive_features;

  return out;
}

// ── Merge ───────────────────────────────────────────────────────────────────────

/**
 * Merge catalog products with existing products.
 * Catalog products are primary in v1. Existing real products are appended.
 * Deduplicates by exact id, then by product_url/purchaseUrl/url.
 * Does NOT deduplicate by image_url alone.
 * Returns [] if both inputs are empty.
 */
export function mergeProductCandidates(
  existingProducts: unknown[],
  catalogProducts: CatalogProductCandidate[],
): CatalogProductCandidate[] {
  const merged: CatalogProductCandidate[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();

  function urlKey(p: CatalogProductCandidate): string | null {
    const u = p.product_url || p.purchaseUrl || p.url;
    return typeof u === 'string' && u.trim() ? u.trim() : null;
  }

  function addProduct(p: CatalogProductCandidate): void {
    if (p.id && seenIds.has(p.id)) return;
    if (p.id) seenIds.add(p.id);

    const u = urlKey(p);
    if (u) {
      if (seenUrls.has(u)) return;
      seenUrls.add(u);
    }

    merged.push(p);
  }

  // Catalog first (primary in v1)
  for (const p of catalogProducts) {
    if (p && typeof p === 'object' && p.id) {
      addProduct(p);
    }
  }

  // Existing real products appended
  for (const raw of existingProducts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const p = raw as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id : undefined;
    if (!id) continue;

    const candidate: CatalogProductCandidate = {
      id,
      name: typeof p.name === 'string' ? p.name : undefined,
      title: typeof p.title === 'string' ? p.title : undefined,
      product_name: typeof p.name === 'string' ? p.name : typeof p.title === 'string' ? p.title : undefined,
      product_url: typeof p.purchaseUrl === 'string' ? p.purchaseUrl : typeof p.url === 'string' ? p.url : undefined,
      purchaseUrl: typeof p.purchaseUrl === 'string' ? p.purchaseUrl : undefined,
      url: typeof p.url === 'string' ? p.url : undefined,
      image_url: typeof p.imageUrl === 'string' ? p.imageUrl : typeof p.image_url === 'string' ? p.image_url : undefined,
      imageUrl: typeof p.imageUrl === 'string' ? p.imageUrl : undefined,
      category: typeof p.category === 'string' ? p.category : undefined,
      color: typeof p.color === 'string' ? p.color : undefined,
      material: typeof p.material === 'string' ? p.material : typeof p.materialEstimate === 'string' ? p.materialEstimate : undefined,
      materialEstimate: typeof p.materialEstimate === 'string' ? p.materialEstimate : typeof p.material === 'string' ? p.material : undefined,
      silhouette: typeof p.silhouette === 'string' ? p.silhouette : undefined,
      styleTags: Array.isArray(p.styleTags) ? p.styleTags as string[] : undefined,
      tags: Array.isArray(p.tags) ? p.tags as string[] : undefined,
      availability: typeof p.availability === 'string' ? p.availability : undefined,
      price: typeof p.price === 'number' ? p.price : undefined,
      currency: typeof p.currency === 'string' ? p.currency : undefined,
      retailer: typeof p.retailer === 'string' ? p.retailer : undefined,
      brand: typeof p.brand === 'string' ? p.brand : undefined,
    };
    addProduct(candidate);
  }

  return merged;
}
