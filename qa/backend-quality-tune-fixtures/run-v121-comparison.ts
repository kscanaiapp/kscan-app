#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
/**
 * Generate v120-baseline / v121-flag-off / v121-flag-on / v121-comparison fixtures.
 * Does not claim production accuracy.
 */
import { applyQualityTaxonomyTune } from '../../supabase/functions/scan-identify/qualityTuneNormalize.ts';
import { buildWeightedCommerceQueries } from '../../supabase/functions/scan-identify/qualityTuneCommerce.ts';
import {
  resolveScannerCategoryRoute,
  resolveTextScanCategoryRoute,
} from '../../supabase/functions/scan-identify/scannerCategoryRoute.ts';
import { applyScannerQualityGate } from '../../supabase/functions/scan-identify/scannerQualityGate.ts';

const root = new URL('.', import.meta.url);

type CaseIn = {
  id: string;
  requestMode?: 'multi_item_detection' | 'selected_item' | 'legacy_single_item' | 'text';
  textQuery?: string;
  selectedCandidate?: { category?: string; subtype?: string; label?: string };
  identification?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
};

const apparel: CaseIn[] = [
  'cropped moto jacket', 'wide-leg trousers', 'pleated midi skirt', 'ribbed sweater',
  'slip dress', 'vest', 'parka', 'bodysuit',
].map((id) => ({
  id,
  requestMode: 'text' as const,
  textQuery: id,
  identification: {
    item_type: id.includes('trouser') || id.includes('skirt')
      ? (id.includes('skirt') ? 'dress' : 'pants')
      : id.includes('dress')
      ? 'dress'
      : id.includes('sweater') || id.includes('bodysuit') || id.includes('vest')
      ? 'top'
      : 'outerwear',
    subtype: id,
    primary_color: 'black',
    material_estimate: id.includes('moto') ? 'faux leather' : 'cotton',
    silhouette: id.includes('cropped') || id.includes('moto') ? 'cropped' : 'tailored',
    fit: 'fitted',
    pattern: 'solid',
    logo_detected: false,
    brand_guess: null,
  },
}));

const footwear: CaseIn[] = [
  'low-profile sneaker', 'Chelsea boot', 'slingback pump', 'loafer', 'ballet flat',
].map((id) => ({
  id,
  requestMode: 'text' as const,
  textQuery: id,
  identification: {
    item_type: 'footwear',
    subtype: id,
    primary_color: 'black',
    material_estimate: 'leather',
    silhouette: 'low-top',
    logo_detected: false,
    brand_guess: null,
  },
}));

const bags: CaseIn[] = [
  'structured handbag', 'crossbody bag', 'oversized tote', 'shoulder bag', 'satchel',
].map((id) => ({
  id,
  requestMode: 'text' as const,
  textQuery: id,
  identification: {
    item_type: 'bag',
    subtype: id.replace(' bag', '').replace('structured ', ''),
    primary_color: 'black',
    material_estimate: 'leather',
    logo_detected: false,
    brand_guess: null,
  },
}));

const accessories: CaseIn[] = [
  'sunglasses', 'belt', 'scarf', 'earrings', 'brooch',
].map((id) => ({
  id,
  requestMode: 'text' as const,
  textQuery: id,
  identification: {
    item_type: 'accessory',
    subtype: id,
    primary_color: 'black',
    material_estimate: id === 'sunglasses' ? 'acetate' : 'leather',
    logo_detected: false,
    brand_guess: null,
  },
}));

const hostile: CaseIn[] = [
  {
    id: 'conflict_skirt_trousers',
    identification: { item_type: 'skirt', subtype: 'Straight-Leg Trousers', primary_color: 'black' },
  },
  {
    id: 'unsupported_brand',
    identification: {
      item_type: 'bag', subtype: 'Handbag', primary_color: 'black',
      brand_guess: 'Gucci', logo_detected: false, visible_brand_text: null,
    },
  },
  {
    id: 'unsupported_material',
    identification: {
      item_type: 'outerwear', subtype: 'Jacket', primary_color: 'black',
      material_estimate: 'possibly lambskin',
    },
  },
  {
    id: 'verbose_label',
    identification: {
      item_type: 'outerwear',
      subtype: 'Black Dark Oversized Minimalist Luxury Vintage Designer-Inspired Moto Biker Jacket',
      primary_color: 'black',
      style_tags: ['luxury', 'vintage', 'designer', 'minimalist'],
    },
  },
  {
    id: 'generic_label',
    identification: { item_type: 'Fashion Item', subtype: 'unknown', primary_color: 'unknown' },
  },
  {
    id: 'missing_subtype',
    identification: { item_type: 'outerwear', subtype: '', primary_color: 'navy' },
  },
  {
    id: 'malformed_arrays',
    identification: {
      item_type: 'blazer', subtype: 'Blazer', primary_color: 'navy',
      style_tags: 'not-an-array' as unknown as string[],
    },
  },
  {
    id: 'duplicate_descriptors',
    identification: {
      item_type: 'outerwear', subtype: 'Jacket Jacket', primary_color: 'black',
      style_tags: ['edgy', 'edgy', 'edgy'],
    },
  },
  {
    id: 'incompatible_fields',
    identification: {
      item_type: 'bag', subtype: 'Handbag', primary_color: 'black',
      neckline_or_lapel: 'crew neck', sleeve_length: 'long',
    },
  },
  {
    id: 'low_detail',
    identification: { item_type: 'top', subtype: 'Top', primary_color: '' },
  },
  {
    id: 'ambiguous_textscan',
    requestMode: 'text',
    textQuery: 'jacket boots handbag',
    identification: { item_type: 'Fashion Item', subtype: 'unknown' },
  },
];

const allCases = [...apparel, ...footwear, ...bags, ...accessories, ...hostile];

function runCase(row: CaseIn, mode: 'v120' | 'intel_off' | 'intel_on') {
  const started = Date.now();
  const route = row.requestMode === 'text'
    ? resolveTextScanCategoryRoute(row.textQuery)
    : resolveScannerCategoryRoute({
      requestMode: row.requestMode || 'legacy_single_item',
      selectedCandidate: row.selectedCandidate,
      textQuery: row.textQuery,
    });

  const tuned = applyQualityTaxonomyTune(row.identification || {}, row.attributes);

  if (mode === 'v120' || mode === 'intel_off') {
    const q = buildWeightedCommerceQueries({
      identification: tuned.identification,
      attributes: tuned.attributes,
    });
    return {
      id: row.id,
      mode,
      route: mode === 'intel_off' ? route : undefined,
      normalizedCategory: tuned.identification.item_type,
      normalizedSubtype: tuned.identification.subtype,
      qualityScore: null,
      qualityBand: null,
      consistencyConflicts: [],
      suppressedAttributes: [],
      label: String(tuned.identification.subtype || tuned.identification.item_type || ''),
      queryDetailLevel: null,
      primaryQuery: q.primary,
      fallbackQuery: q.fallback,
      responseContract: 'unchanged',
      processingDurationMs: Date.now() - started,
    };
  }

  const gated = applyScannerQualityGate(tuned.identification, tuned.attributes);
  const q = buildWeightedCommerceQueries({
    identification: gated.identification,
    attributes: gated.attributes,
    detailLevel: gated.commerceQueryDetailLevel,
    materialAllowed: !gated.materialSuppressed && gated.qualityBand !== 'low',
    brandAllowed: !gated.brandSuppressed,
  });
  return {
    id: row.id,
    mode,
    route,
    normalizedCategory: gated.identification.item_type,
    normalizedSubtype: gated.identification.subtype,
    qualityScore: gated.qualityScore,
    qualityBand: gated.qualityBand,
    consistencyConflicts: gated.consistencyConflicts.map((c) => c.code),
    suppressedAttributes: gated.suppressedAttributes,
    label: gated.label,
    queryDetailLevel: gated.commerceQueryDetailLevel,
    primaryQuery: q.primary,
    fallbackQuery: q.fallback,
    responseContract: 'unchanged',
    processingDurationMs: Date.now() - started,
  };
}

const v120 = allCases.map((c) => runCase(c, 'v120'));
const off = allCases.map((c) => runCase(c, 'intel_off'));
const on = allCases.map((c) => runCase(c, 'intel_on'));

// Equivalence: primary/fallback queries for v120 vs intel_off must match
let equivalent = 0;
let differing = 0;
const diffs: Array<{ id: string; v120: string; off: string }> = [];
for (let i = 0; i < v120.length; i++) {
  if (v120[i].primaryQuery === off[i].primaryQuery && v120[i].fallbackQuery === off[i].fallbackQuery) {
    equivalent += 1;
  } else {
    differing += 1;
    diffs.push({ id: v120[i].id, v120: v120[i].primaryQuery, off: off[i].primaryQuery });
  }
}

const summary = {
  version: 'v121',
  fixtureCount: allCases.length,
  v120IntelOffEquivalent: differing === 0,
  equivalentCases: equivalent,
  differingCases: differing,
  diffs,
  routingOnSample: on.slice(0, 5).map((r) => ({ id: r.id, route: r.route, band: r.qualityBand })),
  note: 'Fixture harness only — not production accuracy.',
};

await Deno.writeTextFile(new URL('./v120-baseline.json', root), JSON.stringify({ cases: v120 }, null, 2));
await Deno.writeTextFile(new URL('./v121-flag-off.json', root), JSON.stringify({ cases: off }, null, 2));
await Deno.writeTextFile(new URL('./v121-flag-on.json', root), JSON.stringify({ cases: on }, null, 2));
await Deno.writeTextFile(new URL('./v121-comparison.json', root), JSON.stringify(summary, null, 2));

console.log(JSON.stringify(summary, null, 2));
