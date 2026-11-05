/** Ordinary source discovery. This module never reads or writes the verified catalog. */
import { normalizeCategory, normalizeColor, normalizeMaterial } from '../scan-identify/qualityTuneNormalize.ts';
import { resolveScannerCategoryRoute } from '../scan-identify/scannerCategoryRoute.ts';
import { filterAndDedupeProducts, type CommerceRelevanceOptions } from '../scan-identify/qualityTuneCommerce.ts';
import type { RecommendedProduct } from '../scan-identify/shoppingProvider.ts';
import { rest } from './deletion/common.ts';

export const EXPANSION_FLAG = 'BLACK_OWNED_BRAND_SEARCH_EXPANSION_ENABLED';
export const CATEGORIES = ['outerwear', 'blazer', 'dress', 'pants', 'top', 'footwear', 'bag', 'accessory'] as const;
export type Source = {
  id: string; brand_name: string; official_website: string; canonical_domain: string;
  alternate_domains: string[]; categories: string[]; keywords: string[];
  us_eligible: boolean; enabled: boolean; review_status: string; reviewed_at: string;
  revision: number; rotation_weight: number;
};
export type Expansion = {
  query(signal: AbortSignal): Promise<{ query: string; source: Source } | null>;
  merge(primary: RecommendedProduct[], additional: RecommendedProduct[], limit: number, relevance?: CommerceRelevanceOptions): RecommendedProduct[];
  event(source: Source, count: number, durationMs: number, calls?: number, outcome?: string): void;
};
export type Store = (path: string, init?: RequestInit) => Promise<Response>;
const safeText = (v: unknown, max = 60) => typeof v === 'string' && v.length <= max && /^[a-zA-Z0-9 &',.()/-]+$/.test(v) ? v.trim() : '';

/** Public DNS names only; no registry URL is fetched, followed or used as a network destination. */
export function safeSourceDomain(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 253 && v === v.toLowerCase() &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(v) &&
    !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)(?:\.|$)/.test(v) &&
    !/\.(?:local|internal|test|invalid|onion)$/.test(v);
}

export function validSource(raw: unknown, now = Date.now()): raw is Source {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const s = raw as Source;
  if (!safeText(s.id, 80) || !safeText(s.brand_name) || !safeSourceDomain(s.canonical_domain)) return false;
  try {
    const url = new URL(s.official_website);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== s.canonical_domain || url.search || url.hash || url.pathname !== '/') return false;
  } catch { return false; }
  const reviewed = Date.parse(s.reviewed_at);
  return s.enabled === true && s.us_eligible === true && s.review_status === 'qualified' &&
    Number.isFinite(reviewed) && reviewed <= now && now - reviewed <= 180 * 86_400_000 &&
    Array.isArray(s.categories) && s.categories.length > 0 && s.categories.every(c => CATEGORIES.includes(c as typeof CATEGORIES[number])) &&
    Array.isArray(s.alternate_domains) && s.alternate_domains.every(safeSourceDomain) &&
    Array.isArray(s.keywords) && s.keywords.length <= 20 && s.keywords.every(k => !!safeText(k)) &&
    Number.isSafeInteger(s.revision) && s.revision > 0 && Number.isInteger(s.rotation_weight) && s.rotation_weight >= 1 && s.rotation_weight <= 10;
}

export function selectSource(rows: unknown[], garment: Record<string, unknown>, now = Date.now()): Source | null {
  const category = normalizeCategory(safeText(garment.item_type));
  if (!CATEGORIES.includes(category as typeof CATEGORIES[number])) return null;
  const names = new Set<string>(), domains = new Set<string>();
  const eligible = rows.filter((s): s is Source => validSource(s, now) && s.categories.includes(category))
    .sort((a, b) => a.id.localeCompare(b.id)).filter(s => {
      const name = s.brand_name.toLowerCase();
      const collision = names.has(name) || [s.canonical_domain, ...s.alternate_domains].some(d => domains.has(d));
      names.add(name); [s.canonical_domain, ...s.alternate_domains].forEach(d => domains.add(d));
      return !collision;
    });
  // Daily deterministic weighted rotation, bounded in memory and independent of customer text.
  const total = eligible.reduce((n, s) => n + s.rotation_weight, 0);
  if (!total) return null;
  let slot = Math.floor(now / 86_400_000) % total;
  for (const s of eligible) { slot -= s.rotation_weight; if (slot < 0) return s; }
  return null;
}

export function sourceQuery(garment: Record<string, unknown>, source: Source): string {
  const category = normalizeCategory(safeText(garment.item_type));
  const subtype = safeText(garment.subtype);
  // Never include brand_guess, visible_brand_text, original customer text or registry notes.
  return [source.brand_name, normalizeColor(safeText(garment.primary_color)), normalizeMaterial(safeText(garment.material_estimate)), subtype || category]
    .filter(v => v && !['unknown', 'unclear', 'none'].includes(v)).join(' ').slice(0, 180);
}

/** Resolve the account preference before any cache/provider decision. Never cache across actors. */
export async function resolveBrandExpansion(actorId: string | null, garment: Record<string, unknown>, signal?: AbortSignal, envGet: (k: string) => string | undefined = k => Deno.env.get(k), store: Store = rest): Promise<Expansion | undefined> {
  if (envGet(EXPANSION_FLAG) !== 'true') return undefined;
  if (!actorId || !/^[0-9a-f-]{36}$/i.test(actorId) || signal?.aborted) {
    console.log('[brand-search-preference]', JSON.stringify({ outcome: signal?.aborted ? 'cancelled' : 'ineligible_actor', durationMs: 0, status: null }));
    return undefined;
  }
  const started = Date.now();
  let status: number | null = null;
  let bounded: AbortSignal | undefined;
  try {
    // The first authenticated gateway round trip can exceed 200ms on a cold
    // worker. Keep a fixed sub-second bound; never spend provider capacity here.
    bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(500)]) : AbortSignal.timeout(500);
    const preferenceSignal = bounded;
    const enabled = await Promise.race([
      (async () => {
        const pref = await store(`user_stylist_preferences?select=include_black_owned_brand_search&user_id=eq.${actorId}&limit=1`, { signal: preferenceSignal });
        status = pref.status;
        return pref.ok && (await pref.json())?.[0]?.include_black_owned_brand_search === true;
      })(),
      new Promise<never>((_, reject) => preferenceSignal.addEventListener('abort', () => reject(new Error('preference_timeout')), { once: true })),
    ]);
    console.log('[brand-search-preference]', JSON.stringify({ outcome: bounded.aborted ? 'timeout' : status !== 200 ? 'unavailable' : enabled ? 'eligible' : 'disabled', durationMs: Date.now() - started, status }));
    if (!enabled || bounded.aborted) return undefined;
    return createBrandExpansion(actorId, garment, envGet, store);
  } catch {
    // No identity, account values, query, URL, credentials or raw error content.
    console.log('[brand-search-preference]', JSON.stringify({ outcome: signal?.aborted ? 'cancelled' : bounded?.aborted ? 'timeout' : 'unavailable', durationMs: Date.now() - started, status }));
    return undefined;
  }
}

/** Lazy, per-request, single-use lane. OFF performs no I/O, including no preference or registry read. */
export function createBrandExpansion(
  actorId: string | null,
  garment: Record<string, unknown>,
  envGet: (k: string) => string | undefined = k => Deno.env.get(k),
  store: Store = rest,
  now: () => number = Date.now,
): Expansion | undefined {
  if (envGet(EXPANSION_FLAG) !== 'true' || !actorId || !/^[0-9a-f-]{36}$/i.test(actorId)) return undefined;
  let used = false;
  return {
    query: async signal => {
      if (used || signal.aborted || envGet(EXPANSION_FLAG) !== 'true') return null;
      used = true;
      const category = normalizeCategory(safeText(garment.item_type));
      if (!CATEGORIES.includes(category as typeof CATEGORIES[number])) return null;
      try {
        const res = await store(`black_owned_brand_search_sources?select=id,brand_name,official_website,canonical_domain,alternate_domains,categories,keywords,us_eligible,enabled,review_status,reviewed_at,revision,rotation_weight&enabled=eq.true&us_eligible=eq.true&review_status=eq.qualified&categories=cs.${encodeURIComponent(`{${category}}`)}&order=id&limit=500`, { signal });
        if (!res.ok) return null;
        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length > 500 || signal.aborted) return null;
        const source = selectSource(rows, garment, now());
        return source && envGet(EXPANSION_FLAG) === 'true' ? { query: sourceQuery(garment, source), source } : null;
      } catch { return null; }
    },
    merge: (primary, additional, limit, relevance) => {
      if (envGet(EXPANSION_FLAG) !== 'true') return primary;
      const route = resolveScannerCategoryRoute({ requestMode: 'legacy_single_item', knownCategory: String(garment.item_type ?? ''), knownSubtype: String(garment.subtype ?? '') });
      const options = relevance ?? { enabled: true as const, categoryRoute: route };
      const qualified = filterAndDedupeProducts(additional.filter(p => {
        try { return !!p.productUrl && new URL(p.productUrl).pathname !== '/'; } catch { return false; }
      }), garment, options).products;
      if (!qualified.length) return primary;
      return filterAndDedupeProducts([...primary, ...qualified], garment, options).products.slice(0, limit);
    },
    event: (source, count, durationMs, calls = 1, outcome = 'ok') => {
      // Aggregate counts only; no user, query, title, image or URL.
      console.log('[brand-search-expansion]', JSON.stringify({ revision: source.revision, validProducts: count, expansionMs: durationMs, providerCalls: calls, outcome, costUsd: null }));
      const write = store('rpc/record_brand_search_coverage', { method: 'POST', signal: AbortSignal.timeout(150), body: JSON.stringify({ p_source_id: source.id, p_revision: source.revision, p_valid_count: count }) }).catch(() => undefined);
      const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
      runtime?.waitUntil(write);
    },
  };
}
