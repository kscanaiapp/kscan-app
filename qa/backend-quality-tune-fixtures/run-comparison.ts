#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
/**
 * Generate baseline-v119.json + comparison.json for quality-tune fixtures.
 * OFF path = passthrough metrics; ON path = applyQualityTaxonomyTune + filter.
 */
import { applyQualityTaxonomyTune, isGenericFashionLabel } from '../../supabase/functions/scan-identify/qualityTuneNormalize.ts';
import {
  buildWeightedCommerceQueries,
  filterAndDedupeProducts,
} from '../../supabase/functions/scan-identify/qualityTuneCommerce.ts';
import type { RecommendedProduct } from '../../supabase/functions/scan-identify/shoppingProvider.ts';

const root = new URL('.', import.meta.url);
const fixtures = JSON.parse(await Deno.readTextFile(new URL('./fixtures.json', root)));

type CaseMetrics = {
  id: string;
  oldNormalizedLabel: string;
  newNormalizedLabel: string;
  oldCommerceQuery: string;
  newCommerceQuery: string;
  oldValidProductCount: number;
  newValidProductCount: number;
  oldDuplicateCount: number;
  newDuplicateCount: number;
  oldMismatchCount: number;
  newMismatchCount: number;
  contractChanged: 'NO';
};

function labelOf(id: Record<string, unknown>): string {
  const subtype = typeof id.subtype === 'string' ? id.subtype.trim() : '';
  const itemType = typeof id.item_type === 'string' ? id.item_type.trim() : '';
  return subtype || itemType || 'unknown';
}

function legacyQuery(id: Record<string, unknown>): string {
  const sq = Array.isArray(id.search_queries) && typeof id.search_queries[0] === 'string'
    ? id.search_queries[0]
    : [id.brand_guess, id.item_type, id.subtype, id.primary_color, id.material_estimate, id.silhouette]
      .filter((x) => typeof x === 'string' && x.trim())
      .join(' ');
  return String(sq || '').replace(/\s+/g, ' ').trim();
}

function countDuplicates(products: RecommendedProduct[]): number {
  const seen = new Set<string>();
  let dups = 0;
  for (const p of products) {
    const key = (p.productUrl || p.id || p.title || '').toLowerCase();
    if (!key) continue;
    if (seen.has(key)) dups += 1;
    else seen.add(key);
  }
  return dups;
}

const cases: CaseMetrics[] = [];
let genericBefore = 0;
let genericAfter = 0;
let invalidBefore = 0;
let invalidAfter = 0;

for (const row of [...fixtures.garments, ...fixtures.hostile]) {
  const oldId = { ...(row.identification || {}) } as Record<string, unknown>;
  if (isGenericFashionLabel(oldId.item_type)) genericBefore += 1;
  if (
    typeof oldId.item_type === 'string' &&
    typeof oldId.subtype === 'string' &&
    /skirt/i.test(oldId.item_type) &&
    /trouser|pants/i.test(oldId.subtype)
  ) {
    invalidBefore += 1;
  }

  const tuned = applyQualityTaxonomyTune(oldId, row.attributes);
  if (isGenericFashionLabel(tuned.identification.item_type)) genericAfter += 1;
  if (
    /skirt/i.test(String(tuned.identification.item_type || '')) &&
    /trouser|pants/i.test(String(tuned.identification.subtype || ''))
  ) {
    invalidAfter += 1;
  }

  const oldQuery = legacyQuery(oldId);
  const newQuery = buildWeightedCommerceQueries({
    identification: tuned.identification,
    attributes: tuned.attributes,
  }).primary;

  const products = fixtures.products as RecommendedProduct[];
  const oldValid = products.filter((p) => p.productUrl && p.imageUrl && p.title).length;
  const filtered = filterAndDedupeProducts(products, tuned.identification);
  const oldDup = countDuplicates(products);
  const newDup = Math.max(0, filtered.stats.productsBeforeDedupe - filtered.stats.productsAfterDedupe);

  cases.push({
    id: row.id,
    oldNormalizedLabel: labelOf(oldId),
    newNormalizedLabel: labelOf(tuned.identification),
    oldCommerceQuery: oldQuery,
    newCommerceQuery: newQuery,
    oldValidProductCount: oldValid,
    newValidProductCount: filtered.stats.productsAfterDedupe,
    oldDuplicateCount: oldDup,
    newDuplicateCount: newDup,
    oldMismatchCount: 0,
    newMismatchCount: filtered.stats.categoryMismatchRemovals,
    contractChanged: 'NO',
  });
}

const baseline = {
  quality_tune: 'off',
  generic_label_occurrence: genericBefore,
  invalid_category_subtype_pairs: invalidBefore,
  note: 'Passthrough fixture labels without quality tune modules',
  cases: cases.map((c) => ({
    id: c.id,
    normalizedLabel: c.oldNormalizedLabel,
    commerceQuery: c.oldCommerceQuery,
    validProductCount: c.oldValidProductCount,
    duplicateCount: c.oldDuplicateCount,
    mismatchCount: c.oldMismatchCount,
  })),
};

const comparison = {
  quality_tune_version: 'v120',
  contractChanged: 'NO',
  genericLabels: { before: genericBefore, after: genericAfter },
  invalidPairs: { before: invalidBefore, after: invalidAfter },
  summary: {
    generic_labels_reduced_or_same: genericAfter <= genericBefore,
    invalid_pairs_reduced_or_same: invalidAfter <= invalidBefore,
  },
  cases,
};

await Deno.writeTextFile(new URL('./baseline-v119.json', root), JSON.stringify(baseline, null, 2) + '\n');
await Deno.writeTextFile(new URL('./comparison.json', root), JSON.stringify(comparison, null, 2) + '\n');
console.log(JSON.stringify({
  wrote: ['baseline-v119.json', 'comparison.json'],
  genericLabels: comparison.genericLabels,
  invalidPairs: comparison.invalidPairs,
}, null, 2));
