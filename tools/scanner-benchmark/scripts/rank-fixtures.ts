// Deterministic before/after ranking fixtures for B42-SCAN-02 (identity-aware ranking).
//
// Research tooling. Runs the real scan-identify relevance path
// (`filterAndDedupeProducts` → `annotateMatchConfidence`) over SYNTHETIC
// candidate pools built from benchmark labels, once with
// SCANNER_IDENTITY_RANKING_V1_ENABLED off and once on, and scores both with the
// benchmark's own independent judges (lib/judge.mjs, lib/metrics.mjs).
//
// What this is NOT: a live accuracy measurement. No image is analysed, no
// provider is called, and the candidate titles are generated from templates.
// The scanner identification is synthesised from the labels (correct
// category/colour; brand only where the label says it is legible). Results show
// how the ranking rules order a known pool, nothing about recognition quality
// or real provider inventories.
//
// Usage (from the repo root):
//   deno run --allow-read --allow-env --allow-write=tools/scanner-benchmark/reports \
//     tools/scanner-benchmark/scripts/rank-fixtures.ts development|holdout [--write]
import { filterAndDedupeProducts } from '../../../supabase/functions/scan-identify/qualityTuneCommerce.ts';
import { annotateMatchConfidence } from '../../../supabase/functions/scan-identify/matchConfidence.ts';
import type { RecommendedProduct } from '../../../supabase/functions/scan-identify/shoppingProvider.ts';
import type { ScannerCategoryRoute } from '../../../supabase/functions/scan-identify/scannerCategoryRoute.ts';
import { computeMetrics } from '../lib/metrics.mjs';
import { judgeExactProduct } from '../lib/judge.mjs';

type Labels = {
  nonFashion: boolean;
  category: string;
  subtypeTerms?: string[];
  colorTerms?: string[];
  brand?: { visible: boolean | null; name: string | null; aliases?: string[] };
  exactProduct?: { knowable: boolean; brand?: string; model?: string; modelAliases?: string[] };
};
type Case = { caseId: string; split: string; stratum: string; labels: Labels };

const FLAG = 'SCANNER_IDENTITY_RANKING_V1_ENABLED';
const SHELF = 3;
const UNSUPPORTED_ROLES = new Set(['replica', 'accessory', 'category_conflict']);

const ROUTE: Record<string, ScannerCategoryRoute> = {
  footwear: 'footwear', bag: 'bags', accessory: 'accessories',
  top: 'apparel', outerwear: 'apparel', pants: 'apparel', dress: 'apparel', blazer: 'apparel', skirt: 'apparel',
};
const NOUN: Record<string, string> = {
  footwear: 'Sneakers', bag: 'Backpack', accessory: 'Watch', top: 'Shirt', outerwear: 'Jacket',
  pants: 'Jeans', dress: 'Dress', blazer: 'Blazer', skirt: 'Skirt',
};
const NOUN_FROM_SUBTYPE = ['sneaker', 'clog', 'boot', 'sandal', 'loafer', 'watch', 'sunglasses', 'backpack', 'tote', 'jacket', 'coat', 'parka', 'hoodie', 'sweater', 'jeans', 'trousers', 'dress', 'blazer', 'shirt'];
const MATERIALS = ['leather', 'suede', 'canvas', 'denim', 'wool', 'nylon', 'cotton', 'knit'];
/** Other-brand look-alikes per scanned noun. First entry not in the scanned brand family is used. */
const OTHER_BRANDS: Record<string, Array<[string, string]>> = {
  sneaker: [['Nike', 'Court Legacy'], ['New Balance', '574'], ['Puma', 'Suede Classic']],
  clog: [['Birkenstock', 'Boston'], ['Skechers', 'Foamies']],
  watch: [['Timex', 'Weekender'], ['Seiko', '5 Sports'], ['Casio', 'MQ-24']],
  sunglasses: [['Oakley', 'Holbrook'], ['Persol', 'PO3019S'], ['Ray-Ban', 'Wayfarer']],
  backpack: [['Herschel', 'Little America'], ['JanSport', 'SuperBreak']],
  default: [['Uniqlo', 'Essential'], ['Zara', 'Basic']],
};
const PART: Record<string, string> = { sneaker: 'Replacement Laces', clog: 'Shoe Charms', watch: 'Replacement Band', sunglasses: 'Case', backpack: 'Keychain', default: 'Keychain' };

const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const cap = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** FNV-1a — deterministic per-case provider order. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}
function shuffle<T>(items: T[], seed: string): T[] {
  return items.map((item, i) => ({ item, k: hash(`${seed}:${i}`) })).sort((a, b) => a.k - b.k).map((x) => x.item);
}

function nounKey(L: Labels): string {
  const subtypes = (L.subtypeTerms ?? []).map(norm).join(' ');
  return NOUN_FROM_SUBTYPE.find((n) => subtypes.includes(n)) ?? '';
}

function nounOf(L: Labels): string {
  const k = nounKey(L);
  if (k === 'sneaker') return 'Sneakers';
  if (k === 'clog') return 'Clogs';
  if (k === 'boot') return 'Boots';
  if (k) return cap(k);
  return NOUN[L.category] ?? 'Item';
}

function otherBrand(L: Labels, brand: string | null): [string, string] {
  const list = OTHER_BRANDS[nounKey(L)] ?? OTHER_BRANDS.default;
  const b = norm(brand);
  return list.find(([o]) => !b || !(norm(o) === b || (b.includes('nike') && norm(o).includes('jordan')))) ?? list[0];
}

type FixtureOffer = RecommendedProduct & { fixtureRole: string };

export function buildFixture(c: Case, withHypothesis: boolean) {
  const L = c.labels;
  const ep = L.exactProduct?.knowable ? L.exactProduct : null;
  const brand = ep?.brand ?? L.brand?.name ?? null;
  const model = ep?.model ?? null;
  const noun = nounOf(L);
  const color = cap(L.colorTerms?.[0] ?? '');
  const material = cap((L.subtypeTerms ?? []).map(norm).find((t) => MATERIALS.some((m) => t.includes(m)))?.split(' ').find((t) => MATERIALS.includes(t)) ?? '');
  const [oBrand, oModel] = otherBrand(L, brand);
  const part = PART[nounKey(L)] ?? PART.default;
  const conflict = L.category === 'top' ? 'Sneakers' : 'Graphic T-Shirt';

  const identification: Record<string, unknown> = {
    item_type: L.category,
    subtype: noun.toLowerCase(),
    primary_color: (L.colorTerms?.[0] ?? '').toLowerCase() || undefined,
    material_estimate: material.toLowerCase() || undefined,
    pattern: 'solid',
  };
  // Brand only where the label says it is legible (the Scanner's verified path).
  if (L.brand?.visible === true && brand) identification.visible_brand_text = brand;
  if (withHypothesis && model) {
    identification.exact_item_hypothesis = model;
    identification.exact_match_confidence = 'medium';
  }

  const pool: Array<[string, string, Record<string, unknown>?]> = [];
  const t = (...parts: string[]) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (brand && model) {
    pool.push(['genuine_identity', t(brand, model)]);
    pool.push(['genuine_verbose', t(brand, ep?.modelAliases?.[0] && ep.modelAliases[0].split(' ').length > 1 ? ep.modelAliases[0] : model, noun)]);
  }
  if (brand) pool.push(['same_brand', t(brand, color, noun)]);
  pool.push(['generic_lookalike', t(color, material, noun)]);
  pool.push(['generic_partial', t(color, noun)]);
  pool.push(['cross_brand_title', t(oBrand, oModel, color, material, noun)]);
  pool.push(['cross_brand_declared', t(oModel, color, noun), { brand: oBrand }]);
  if (brand) {
    pool.push(['replica', t(model ?? brand, 'Inspired', color, noun)]);
    pool.push(['accessory', t(brand, model ?? '', part)]);
    pool.push(['category_conflict', t(brand, model ?? '', conflict)]);
  }

  const offers: FixtureOffer[] = shuffle(pool, c.caseId).map(([role, title, extra], i) => ({
    id: `${c.caseId}-${role}`,
    title,
    productUrl: i % 4 === 0
      ? `https://shop.retailer-${i}.com/products/${role}-${i}`
      : `https://www.google.com/search?ibp=oshop&q=item&prds=pid:${hash(c.caseId + role)}`,
    imageUrl: `https://img.fixture-cdn.com/${c.caseId}/${i}.jpg`,
    price: `$${40 + (hash(role) % 120)}`,
    source: `Retailer ${i % 3}`,
    fixtureRole: role,
    ...(extra ?? {}),
  }) as unknown as FixtureOffer);
  return { identification, offers };
}

function runOnce(c: Case, withHypothesis: boolean, flag: 'off' | 'on') {
  const { identification, offers } = buildFixture(c, withHypothesis);
  const prior = Deno.env.get(FLAG);
  Deno.env.set(FLAG, flag === 'on' ? 'true' : 'false');
  try {
    const ranked = filterAndDedupeProducts(offers, identification, { enabled: true, categoryRoute: ROUTE[c.labels.category] ?? 'general' }).products;
    const annotated = annotateMatchConfidence(ranked, { identification }) as unknown as FixtureOffer[];
    return { identification, shelf: annotated.slice(0, SHELF) };
  } finally {
    if (prior === undefined) Deno.env.delete(FLAG); else Deno.env.set(FLAG, prior);
  }
}

const ratio = (n: number, d: number) => ({ value: d > 0 ? n / d : null, numerator: n, denominator: d });

export function evaluate(cases: Case[], withHypothesis: boolean, flag: 'off' | 'on') {
  const results = [];
  let shownTop3 = 0, unsupportedShown = 0, emptyShelves = 0, crossBrandFirst = 0, verifiedBrandCases = 0;
  let falseProbable = 0, probable = 0, verifiedExact = 0, knowable = 0, genuineTop3 = 0, judgeAcceptedNonGenuine = 0;
  const classCounts: Record<string, number> = {};
  for (const c of cases) {
    const { shelf } = runOnce(c, withHypothesis, flag);
    results.push({ caseId: c.caseId, offers: shelf, commerceAttempted: true });
    shownTop3 += shelf.length;
    if (shelf.length === 0) emptyShelves++;
    for (const o of shelf) {
      if (UNSUPPORTED_ROLES.has(o.fixtureRole)) unsupportedShown++;
      const cls = (o as unknown as { matchConfidence?: { class: string } }).matchConfidence?.class ?? 'none';
      classCounts[cls] = (classCounts[cls] ?? 0) + 1;
      if (cls === 'verified_exact') verifiedExact++;
      if (cls === 'probable') {
        probable++;
        if (judgeExactProduct(o, c.labels.exactProduct) !== 'exact_product') falseProbable++;
      }
    }
    if (c.labels.exactProduct?.knowable) {
      knowable++;
      // Role-checked: the title judge also accepts e.g. "Crocs Classic Clog Shoe Charms";
      // count only listings the fixture generated as the genuine product.
      if (shelf.some((o) => o.fixtureRole.startsWith('genuine') && judgeExactProduct(o, c.labels.exactProduct) === 'exact_product')) genuineTop3++;
      judgeAcceptedNonGenuine += shelf.filter((o) => !o.fixtureRole.startsWith('genuine') && judgeExactProduct(o, c.labels.exactProduct) === 'exact_product').length;
    }
    if (c.labels.brand?.visible === true) {
      verifiedBrandCases++;
      if (shelf.some((o) => o.fixtureRole.startsWith('cross_brand'))) crossBrandFirst++;
    }
  }
  const m = computeMetrics(cases, results);
  return {
    flag,
    withHypothesis,
    cases: cases.length,
    exactProductRecallAt3: m.exactProductRecall.top3,
    exactProductRecallAt1: m.exactProductRecall.top1,
    genuineListingRecallAt3RoleChecked: ratio(genuineTop3, knowable),
    judgeAcceptedNonGenuineOffers: judgeAcceptedNonGenuine,
    alternativeRelevance: { meanGradeTop3: m.alternativeRelevance.meanGradeTop3, hitAt3: m.alternativeRelevance.hitAt3, gradeCounts: m.alternativeRelevance.gradeCounts },
    unsupportedResultFrequency: ratio(unsupportedShown, shownTop3),
    falseExactMatchClaims: { verifiedExact, falseExactMatchRate: m.falseExactMatchRate },
    probableClaims: { probable, wrong: falseProbable, precision: m.probablePrecision },
    /** Brand-legible cases whose top 3 shows a listing that names a different brand. */
    crossBrandInTop3WhenBrandLegible: ratio(crossBrandFirst, verifiedBrandCases),
    emptyShelves: ratio(emptyShelves, cases.length),
    offersShown: shownTop3,
    matchConfidenceClasses: classCounts,
  };
}

if (import.meta.main) {
  const split = Deno.args[0];
  if (split !== 'development' && split !== 'holdout') {
    console.error('usage: rank-fixtures.ts development|holdout [--write]');
    Deno.exit(2);
  }
  const manifest = JSON.parse(await Deno.readTextFile(new URL('../manifest/cases.v1.json', import.meta.url)));
  const all: Case[] = manifest.cases.filter((c: Case) => c.split === split);
  const cases = all.filter((c) => !c.labels.nonFashion);
  const report = {
    schema: 'b42-scan-02-ranking-fixtures-v1',
    split,
    manifestVersion: manifest.version,
    casesInSplit: all.length,
    nonFashionExcluded: all.length - cases.length,
    knowableCases: cases.filter((c) => c.labels.exactProduct?.knowable).length,
    brandLegibleCases: cases.filter((c) => c.labels.brand?.visible === true).length,
    shelfSize: SHELF,
    limitations: [
      'Synthetic candidate pools generated from labels; no provider was called and no image was analysed.',
      'Scanner identification synthesised from labels (correct category/colour; brand only when labelled legible).',
      'withHypothesis=true approximates a v124-style exact_item_hypothesis at medium confidence via identification fields; the v124 commerceIdentity ranking delta is not applied.',
      'Judges are title-only (lib/judge.mjs). Not a measurement of live Scanner accuracy.',
    ],
    runs: [false, true].flatMap((h) => (['off', 'on'] as const).map((f) => evaluate(cases, h, f))),
  };
  const out = JSON.stringify(report, null, 2) + '\n';
  if (Deno.args.includes('--write')) {
    await Deno.writeTextFile(new URL(`../reports/ranking-b42-scan-02.${split}.json`, import.meta.url), out);
  }
  console.log(out);
}
