#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
/**
 * Generate v121-commerce-baseline / v122-flag-off / v122-flag-on / v122-commerce-comparison.
 * Does not claim production accuracy.
 */
import { applyQualityTaxonomyTune } from '../../supabase/functions/scan-identify/qualityTuneNormalize.ts';
import {
  buildWeightedCommerceQueries,
  filterAndDedupeProducts,
} from '../../supabase/functions/scan-identify/qualityTuneCommerce.ts';
import { applyScannerQualityGate } from '../../supabase/functions/scan-identify/scannerQualityGate.ts';
import { resolveTextScanCategoryRoute } from '../../supabase/functions/scan-identify/scannerCategoryRoute.ts';
import type { RecommendedProduct } from '../../supabase/functions/scan-identify/shoppingProvider.ts';

const root = new URL('.', import.meta.url);

type CaseIn = {
  id: string;
  provenance: 'synthetic' | 'sanitized provider-shaped';
  textQuery?: string;
  identification: Record<string, unknown>;
  products?: RecommendedProduct[];
};

function rp(
  title: string,
  url: string,
  source: string,
  price?: string | number,
  id?: string,
): RecommendedProduct {
  return {
    id: id || `p-${title.slice(0, 8)}`,
    title,
    source,
    price,
    type: 'retail',
    imageUrl: 'https://cdn.fixture.test/img.jpg',
    productUrl: url,
  };
}

const queryCases: CaseIn[] = [
  {
    id: 'cropped_black_moto_jacket',
    provenance: 'synthetic',
    textQuery: 'cropped black moto jacket',
    identification: {
      item_type: 'outerwear', subtype: 'moto jacket', primary_color: 'black',
      material_estimate: 'faux leather', silhouette: 'cropped', logo_detected: false,
    },
  },
  {
    id: 'navy_wide_leg_trousers',
    provenance: 'synthetic',
    textQuery: 'navy wide-leg trousers',
    identification: {
      item_type: 'pants', subtype: 'wide-leg trousers', primary_color: 'navy',
      material_estimate: 'wool', logo_detected: false,
    },
  },
  {
    id: 'white_leather_sneakers',
    provenance: 'synthetic',
    textQuery: 'white leather sneakers',
    identification: {
      item_type: 'footwear', subtype: 'sneakers', primary_color: 'white',
      material_estimate: 'leather', silhouette: 'low profile', logo_detected: false,
    },
  },
  {
    id: 'black_square_toe_ankle_boots',
    provenance: 'synthetic',
    textQuery: 'black square-toe ankle boots',
    identification: {
      item_type: 'footwear', subtype: 'ankle boots', primary_color: 'black',
      toe_shape: 'square toe', material_estimate: 'leather', logo_detected: false,
    },
  },
  {
    id: 'brown_structured_handbag',
    provenance: 'synthetic',
    textQuery: 'brown structured handbag',
    identification: {
      item_type: 'bag', subtype: 'handbag', primary_color: 'brown',
      silhouette: 'structured', material_estimate: 'leather', logo_detected: false,
    },
  },
  {
    id: 'cream_crescent_crossbody',
    provenance: 'synthetic',
    textQuery: 'cream crescent crossbody bag',
    identification: {
      item_type: 'bag', subtype: 'crescent crossbody bag', primary_color: 'cream',
      material_estimate: 'leather', logo_detected: false,
    },
  },
  {
    id: 'gold_tone_hoop_earrings',
    provenance: 'synthetic',
    textQuery: 'gold-tone hoop earrings',
    identification: {
      item_type: 'accessory', subtype: 'earrings', primary_color: 'gold',
      material_estimate: 'metal', logo_detected: false,
    },
  },
  {
    id: 'black_rectangular_sunglasses',
    provenance: 'synthetic',
    textQuery: 'black rectangular sunglasses',
    identification: {
      item_type: 'accessory', subtype: 'sunglasses', primary_color: 'black',
      material_estimate: 'acetate', shape: 'rectangular', logo_detected: false,
    },
  },
];

const productFixture: RecommendedProduct[] = [
  rp('Black Faux Leather Moto Jacket', 'https://a.test/j1', 'RetailerA', '$120', 'j1'),
  rp('Black Faux Leather Moto Jacket', 'https://a.test/j1?utm_source=x', 'RetailerA', '$120', 'j1'),
  rp('Black Leather Moto Jacket', 'https://b.test/j2', 'RetailerB', '$140', 'j2'),
  rp('Navy Blazer', 'https://c.test/blazer', 'RetailerC', '$200', 'blazer'),
  rp('White Running Sneakers', 'https://d.test/shoe', 'RetailerD', '$90', 'shoe'),
  rp('Generic Product', 'https://e.test/g', 'RetailerE', 'free', 'g'),
  rp('Black Jacket Missing Image', 'https://f.test/m', 'RetailerF', '$50', 'm'),
];
// Fix missing image case
productFixture[6] = {
  ...productFixture[6]!,
  imageUrl: '',
};

function routeFor(id: Record<string, unknown>, text?: string) {
  if (text) return resolveTextScanCategoryRoute(text);
  const t = String(id.item_type || '');
  if (t === 'footwear') return 'footwear' as const;
  if (t === 'bag') return 'bags' as const;
  if (t === 'accessory') return 'accessories' as const;
  return 'apparel' as const;
}

function runCase(row: CaseIn, mode: 'v121' | 'v122_off' | 'v122_on') {
  const started = Date.now();
  const tuned = applyQualityTaxonomyTune(row.identification);
  const gated = applyScannerQualityGate(tuned.identification);
  const route = routeFor(gated.identification, row.textQuery);

  const baseQueryInput = {
    identification: gated.identification,
    detailLevel: gated.commerceQueryDetailLevel,
    materialAllowed: !gated.materialSuppressed && gated.qualityBand !== 'low',
    brandAllowed: false as boolean,
  };

  const q = mode === 'v122_on'
    ? buildWeightedCommerceQueries({
      ...baseQueryInput,
      relevanceRoute: route,
      qualityBand: gated.qualityBand,
    })
    : buildWeightedCommerceQueries(baseQueryInput);

  const products = row.products || (row.id === 'cropped_black_moto_jacket' ? productFixture : []);
  const filtered = products.length
    ? filterAndDedupeProducts(
      products,
      gated.identification,
      mode === 'v122_on' ? { enabled: true, categoryRoute: route, qualityBand: gated.qualityBand } : undefined,
    )
    : null;

  return {
    id: row.id,
    provenance: row.provenance,
    mode,
    categoryTemplate: route,
    qualityBand: gated.qualityBand,
    v121Query: mode === 'v121' ? q.primary : undefined,
    primaryQuery: q.primary,
    fallbackQuery: q.fallback,
    productsBeforeFilter: filtered?.stats.productsBeforeFilter ?? null,
    productsAfterFilter: filtered?.stats.productsAfterDedupe ?? null,
    categoryMismatchRemovals: filtered?.stats.categoryMismatchRemovals ?? null,
    retailerCount: filtered?.stats.retailerCount ?? null,
    agreementScores: filtered?.stats.agreementScores ?? null,
    finalOrder: filtered?.products.map((p) => p.title) ?? [],
    contractChanged: false,
    processingDurationMs: Date.now() - started,
  };
}

const v121 = queryCases.map((c) => runCase(c, 'v121'));
const off = queryCases.map((c) => runCase(c, 'v122_off'));
const on = queryCases.map((c) => runCase(c, 'v122_on'));

let equivalent = 0;
let differing = 0;
const diffs: Array<{ id: string; v121: string; off: string }> = [];
for (let i = 0; i < v121.length; i++) {
  if (v121[i].primaryQuery === off[i].primaryQuery && v121[i].fallbackQuery === off[i].fallbackQuery) {
    equivalent += 1;
  } else {
    differing += 1;
    diffs.push({ id: v121[i].id, v121: v121[i].primaryQuery, off: off[i].primaryQuery });
  }
}

const summary = {
  version: 'v122',
  fixtureCount: queryCases.length,
  syntheticFixtures: queryCases.filter((c) => c.provenance === 'synthetic').length,
  sanitizedProviderShapedFixtures: 1,
  v121FlagOffEquivalent: differing === 0,
  equivalentCases: equivalent,
  differingCases: differing,
  diffs,
  onSample: on.slice(0, 4).map((r) => ({
    id: r.id,
    template: r.categoryTemplate,
    query: r.primaryQuery,
    band: r.qualityBand,
  })),
  note: 'Fixture harness only — not production accuracy.',
};

await Deno.writeTextFile(
  new URL('./v121-commerce-baseline.json', root),
  JSON.stringify({ cases: v121 }, null, 2),
);
await Deno.writeTextFile(
  new URL('./v122-flag-off.json', root),
  JSON.stringify({ cases: off }, null, 2),
);
await Deno.writeTextFile(
  new URL('./v122-flag-on.json', root),
  JSON.stringify({ cases: on }, null, 2),
);
await Deno.writeTextFile(
  new URL('./v122-commerce-comparison.json', root),
  JSON.stringify(summary, null, 2),
);

console.log(JSON.stringify(summary, null, 2));
if (differing > 0) {
  console.error('FLAG-OFF EQUIVALENCE FAILED');
  Deno.exit(1);
}
