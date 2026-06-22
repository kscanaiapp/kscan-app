import type { SneakerReference, SneakerSearchInput, SneakerSearchOptions } from './types';
import { searchSneakerDatabase  } from './providers/sneakerDatabase';
import { searchHoseaSneakerApi  } from './providers/hoseaSneakerApi';
import { searchSneaksApi        } from './providers/sneaksApi';
import { searchKicksCrewRapidApi } from './providers/kickscrewRapidApi';

// ─── Feature flag ────────────────────────────────────────────────────────────

const ENRICHMENT_ENABLED = process.env.EXPO_PUBLIC_ENABLE_SNEAKER_ENRICHMENT !== 'false';

// ─── Detection tables ────────────────────────────────────────────────────────

const SNEAKER_CATEGORIES = new Set([
  'sneaker', 'sneakers', 'shoe', 'shoes', 'footwear',
  'trainer', 'trainers', 'running shoe', 'running shoes',
  'basketball shoe', 'basketball shoes', 'skate shoe', 'skate shoes',
  'boot', 'boots',
]);

// All lowercase.  Brand match requires a footwear signal to avoid false positives.
const SNEAKER_BRANDS = [
  'nike', 'jordan', 'air jordan', 'adidas', 'yeezy',
  'new balance', 'asics', 'puma', 'reebok', 'converse',
  'vans', 'saucony', 'hoka', 'salomon', 'on running',
];

// Model/product terms that, combined with a brand, strongly indicate footwear.
const SNEAKER_MODELS = [
  'dunk', 'samba', 'gazelle', 'air max', 'air force', 'af1',
  'jordan 1', 'aj1', '990', '550', 'gel-kayano', 'gel kayano',
];

// Categories that are never sneakers regardless of brand text in the description.
const NON_SNEAKER_CATEGORIES = new Set([
  'handbag', 'bag', 'purse', 'tote', 'jacket', 'coat', 'blazer', 'dress',
  'sunglasses', 'glasses', 'eyewear', 'jewelry', 'watch', 'necklace', 'ring',
  'earring', 'bracelet', 'hat', 'cap', 'belt', 'scarf',
]);

// ─── Detection helpers ───────────────────────────────────────────────────────

function hasBrand(text: string): boolean {
  return SNEAKER_BRANDS.some(b => text.includes(b));
}

function hasModel(text: string): boolean {
  return SNEAKER_MODELS.some(m => text.includes(m));
}

export function shouldEnrichSneakers(input: SneakerSearchInput): boolean {
  if (!ENRICHMENT_ENABLED) return false;

  // A KicksCrew product URL is a direct sneaker signal — always enrich.
  if (input.productUrl?.startsWith('https://www.kickscrew.com/')) return true;

  const category   = (input.category ?? '').toLowerCase().trim();
  const confidence = input.categoryConfidence ?? 1;
  const rawText    = (input.rawText ?? '').toLowerCase();
  const brand      = (input.brand ?? '').toLowerCase();

  // Never trigger on known non-sneaker categories.
  if (NON_SNEAKER_CATEGORIES.has(category)) return false;

  // Category is a direct sneaker type with enough confidence.
  if (SNEAKER_CATEGORIES.has(category) && confidence >= 0.7) return true;

  // Brand metadata is a sneaker brand and the category is footwear.
  if (brand && hasBrand(brand) && SNEAKER_CATEGORIES.has(category)) return true;

  // Brand + model in raw AI text (both signals required to avoid "OG/Retro" false positives).
  if (hasBrand(rawText) && hasModel(rawText)) return true;

  // Sneaker brand in brand field + model in raw text.
  if (brand && hasBrand(brand) && (input.model || hasModel(rawText))) return true;

  return false;
}

// ─── Query building ──────────────────────────────────────────────────────────

export function buildQueryCandidates(input: SneakerSearchInput): string[] {
  const raw: string[] = [];

  // a. Exact SKU / style code
  if (input.sku?.trim()) raw.push(input.sku.trim());

  // b. Brand + model
  const brand = input.brand?.trim();
  const model = input.model?.trim();
  if (brand && model) raw.push(`${brand} ${model}`);

  // c. Brand + model + colorway
  if (brand && model && input.colorway?.trim()) {
    raw.push(`${brand} ${model} ${input.colorway.trim()}`);
  }

  // d. Raw AI text (first 80 chars only)
  if (input.rawText?.trim()) {
    const truncated = input.rawText.trim().slice(0, 80);
    raw.push(truncated);
  }

  // Deduplicate while preserving order (case-insensitive key).
  return [...new Map(raw.map(c => [c.toLowerCase(), c])).values()];
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicateRefs(refs: SneakerReference[]): SneakerReference[] {
  const seenSku  = new Set<string>();
  const seenName = new Set<string>();
  const out: SneakerReference[] = [];

  for (const ref of refs) {
    if (ref.sku) {
      const skuKey = ref.sku.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seenSku.has(skuKey)) continue;
      seenSku.add(skuKey);
    }
    const nameKey = `${(ref.name ?? '').toLowerCase().replace(/\s+/g, ' ')}|${(ref.brand ?? '').toLowerCase()}`;
    if (seenName.has(nameKey)) continue;
    seenName.add(nameKey);
    out.push(ref);
  }

  return out;
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

function rankRefs(refs: SneakerReference[], primaryQuery: string): SneakerReference[] {
  const pLower = primaryQuery.toLowerCase();
  return [...refs].sort((a, b) => {
    // Exact SKU match first
    const aSkuMatch = a.sku?.toLowerCase() === pLower ? 1 : 0;
    const bSkuMatch = b.sku?.toLowerCase() === pLower ? 1 : 0;
    if (aSkuMatch !== bSkuMatch) return bSkuMatch - aSkuMatch;

    // Image present > image missing
    const aImg = a.imageUrl ? 1 : 0;
    const bImg = b.imageUrl ? 1 : 0;
    if (aImg !== bImg) return bImg - aImg;

    // Retail or market price present > missing
    const aPrice = a.retailPrice != null || a.estimatedMarketValue != null ? 1 : 0;
    const bPrice = b.retailPrice != null || b.estimatedMarketValue != null ? 1 : 0;
    if (aPrice !== bPrice) return bPrice - aPrice;

    // Provider confidence
    return b.confidence - a.confidence;
  });
}

// ─── Main orchestrator ───────────────────────────────────────────────────────

const HIGH_CONFIDENCE = 0.85;

export async function searchSneakers(
  input: SneakerSearchInput,
  options: SneakerSearchOptions = {},
): Promise<SneakerReference[] | null> {
  if (!shouldEnrichSneakers(input)) return null;

  const maxResults = options.maxResults ?? 3;
  const collected: SneakerReference[] = [];

  // ── KicksCrew (URL-based) ─────────────────────────────────────────────────
  // Runs independently of text search; does NOT require query candidates.
  // Results merge into the shared pool so dedup + ranking apply uniformly.
  if (input.productUrl) {
    const kcResults = await searchKicksCrewRapidApi(input.productUrl);
    collected.push(...kcResults);
  }

  // ── Text-search providers ─────────────────────────────────────────────────
  // Only run when we have concrete query candidates.
  const candidates = buildQueryCandidates(input);
  for (const query of candidates) {
    // Stop early once we have enough high-confidence results.
    if (
      collected.length >= maxResults &&
      collected.every(r => r.confidence >= HIGH_CONFIDENCE)
    ) break;

    const batches = await Promise.all([
      searchSneakerDatabase(query),
      searchHoseaSneakerApi(query),
      searchSneaksApi(query),
    ]);

    for (const batch of batches) collected.push(...batch);
  }

  if (collected.length === 0) return null;

  const deduped = deduplicateRefs(collected);
  const ranked  = rankRefs(deduped, candidates[0] ?? input.productUrl ?? '');
  return ranked.slice(0, maxResults);
}

// ─── Dev test helper ─────────────────────────────────────────────────────────

export async function testSneakerProviders(): Promise<void> {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;

  const cases: Array<{ label: string; input: SneakerSearchInput }> = [
    {
      label: 'Jordan 1 (brand+model)',
      input: { brand: 'Jordan', model: 'Air Jordan 1', category: 'sneaker', categoryConfidence: 0.95 },
    },
    {
      label: 'Nike Dunk Low',
      input: { brand: 'Nike', model: 'Dunk Low', category: 'sneaker', categoryConfidence: 0.9 },
    },
    {
      label: 'Adidas Samba',
      input: { brand: 'Adidas', model: 'Samba OG', category: 'sneaker', categoryConfidence: 0.9 },
    },
    {
      label: 'SKU 555088-063',
      input: { sku: '555088-063', category: 'sneaker', categoryConfidence: 0.95 },
    },
    {
      label: 'fake query (expect [])',
      input: { rawText: 'xyzzy-not-a-shoe-000', category: 'sneaker', categoryConfidence: 0.9 },
    },
    {
      label: 'handbag (expect skip)',
      input: { category: 'handbag', categoryConfidence: 0.95 },
    },
    {
      label: 'provider failure sim (empty brand)',
      input: { category: 'sneaker', categoryConfidence: 0.9 },
    },
  ];

  console.log('[sneakers/test] ── Starting provider tests ──');
  for (const { label, input } of cases) {
    const willRun = shouldEnrichSneakers(input);
    if (!willRun) {
      console.log(`[sneakers/test] "${label}" — skipped (not sneaker-related) ✓`);
      continue;
    }
    try {
      const start   = Date.now();
      const results = await searchSneakers(input);
      const ms      = Date.now() - start;
      console.log(
        `[sneakers/test] "${label}" — ${results?.length ?? 0} results in ${ms}ms`,
        results?.map(r => `${r.source}: ${r.name} [${r.sku ?? 'no-sku'}]`) ?? [],
      );
    } catch (err: any) {
      console.error(`[sneakers/test] "${label}" — ERROR: ${err?.message}`);
    }
  }
  console.log('[sneakers/test] ── Done ──');
}

export type { SneakerReference, SneakerSearchInput, SneakerSearchOptions } from './types';
