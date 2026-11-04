import { assert, assertEquals, assertStrictEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  chooseVri03FallbackQuery,
  preserveModelSearchQueries,
  synonymVariantQuery,
  vri03CacheSuffix,
  vri03SynonymSubtypeKeys,
  VRI03_H1_SELECTED_ITEM_ADDENDUM,
  VRI03_MAX_SUBTYPE_KEYS,
  withVri03Instruction,
  withVri03SelectedItemSchema,
} from './vri03ScanImprovements.ts';
import { applyScannerQualityGate } from './scannerQualityGate.ts';
import { getFastCommerceResults, isWeakQuery } from './scanCommerceRouter.ts';
import { commerceCacheClear } from './commerceResultCache.ts';
import { _resetShoppingCache } from './shoppingProvider.ts';

// ── H1 ──────────────────────────────────────────────────────────────────────

Deno.test('H1: OFF returns the prompt unchanged (same string); ON appends only', () => {
  const base = 'BASE PROMPT';
  for (const mode of ['selected_item', 'legacy_single_item', 'multi_item_detection'] as const) {
    assertStrictEquals(withVri03Instruction(base, mode, false), base);
    const on = withVri03Instruction(base, mode, true);
    assert(on.startsWith(base) && on.length > base.length, mode);
  }
  assert(VRI03_H1_SELECTED_ITEM_ADDENDUM.includes('Never include a brand that is not visibly confirmed'));
  assert(VRI03_H1_SELECTED_ITEM_ADDENDUM.includes('APPEARANCE'));
  assert(!/purchase|buy now|price|in stock/i.test(VRI03_H1_SELECTED_ITEM_ADDENDUM), 'instruction must not ask Gemini for products or prices');
});

// ── H2 ──────────────────────────────────────────────────────────────────────

const baseSchema = {
  type: 'OBJECT',
  properties: {
    status: { type: 'STRING' },
    identification: {
      type: 'OBJECT',
      properties: { item_type: { type: 'STRING' }, distinctive_features: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 8 } },
      required: ['item_type'],
    },
  },
  required: ['status', 'identification'],
};

Deno.test('H2: OFF returns the same schema object; ON adds optional fields, keeps required and existing defs', () => {
  assertStrictEquals(withVri03SelectedItemSchema(baseSchema, false), baseSchema);
  const on = withVri03SelectedItemSchema(baseSchema, true) as typeof baseSchema;
  const props = on.properties.identification.properties as Record<string, { maxItems?: number }>;
  for (const k of ['secondary_colors', 'length', 'closure', 'distinctive_features', 'style_tags', 'search_queries']) assert(k in props, k);
  assertEquals(props.distinctive_features.maxItems, 8, 'existing (v124) definition wins');
  assertEquals(on.properties.identification.required, ['item_type']);
  assertEquals(on.required, ['status', 'identification']);
  assertEquals((baseSchema.properties.identification.properties as Record<string, unknown>).search_queries, undefined, 'input not mutated');
});

// ── H3: gate preservation ───────────────────────────────────────────────────

function identification(extra: Record<string, unknown> = {}) {
  return {
    item_type: 'outerwear', subtype: 'moto jacket', primary_color: 'black', material_estimate: 'leather',
    silhouette: 'cropped', pattern: 'solid', visual_observation: 'A black leather moto jacket.',
    search_queries: ['Gucci black moto jacket', 'black leather biker jacket', 'luxury designer jacket', 'cropped black moto jacket zip'],
    brand_guess: 'Gucci',
    ...extra,
  };
}

Deno.test('H3 gate: OFF overwrites search_queries with the label (unchanged behavior)', () => {
  const g = applyScannerQualityGate(identification(), undefined, {});
  assertEquals((g.identification.search_queries as string[]).length, 1);
});

Deno.test('H3 gate: ON keeps the label first plus brand-safe model phrasings; suppressed brand never returns', () => {
  const off = applyScannerQualityGate(identification(), undefined, {});
  const on = applyScannerQualityGate(identification(), undefined, { vri03PreserveModelQueries: true });
  const q = on.identification.search_queries as string[];
  assertEquals(q[0], (off.identification.search_queries as string[])[0]);
  assertEquals(on.identification.brand_guess, null, 'unsupported brand is still suppressed');
  assert(q.length >= 2 && q.length <= 3, JSON.stringify(q));
  assert(q.every((s) => !/gucci/i.test(s)), JSON.stringify(q));
  assert(q.every((s) => !/luxury|designer/i.test(s)), JSON.stringify(q));
  assert(q.includes('black leather biker jacket'));
  // Everything else about the gate result is unchanged by the flag.
  assertEquals({ ...on, identification: { ...on.identification, search_queries: null } }, { ...off, identification: { ...off.identification, search_queries: null } });
  // Survives the MODE A → client → MODE B round trip (the gate's own label may
  // legitimately change on a second pass — pre-existing behavior, flag-independent).
  const again = applyScannerQualityGate(on.identification, undefined, { vri03PreserveModelQueries: true });
  const q2 = again.identification.search_queries as string[];
  assert(q2.length <= 3 && q2.includes('black leather biker jacket') && q2.every((s) => !/gucci|luxury/i.test(s)), JSON.stringify(q2));
});

Deno.test('H3: preserve/synonym/fallback helpers are bounded and deterministic', () => {
  assertEquals(preserveModelSearchQueries(['a b', 'x y z', 'p q r', 's t u'], 'label', []).length, 2);
  assertEquals(preserveModelSearchQueries(['one', 'nine words is far too many for a query ok'], 'l', []), []);
  assertEquals(synonymVariantQuery('black moto jacket'), 'black biker jacket');
  assertEquals(synonymVariantQuery('white leather trainers'), 'white leather sneakers');
  assertEquals(synonymVariantQuery('red wool scarf'), '');
  const pick = (sq: unknown[], fb = 'black jacket') => chooseVri03FallbackQuery({ primary: 'black moto jacket', searchQueries: sq, computedFallback: fb, isWeak: isWeakQuery });
  assertEquals(pick(['black moto jacket', 'black leather biker jacket']), { query: 'black leather biker jacket', source: 'model_query' });
  assertEquals(pick(['black moto jacket']), { query: 'black biker jacket', source: 'synonym' });
  assertEquals(chooseVri03FallbackQuery({ primary: 'red wool scarf', searchQueries: [], computedFallback: 'red scarf', isWeak: isWeakQuery }), { query: 'red scarf', source: 'computed_fallback' });
  assertEquals(chooseVri03FallbackQuery({ primary: 'red wool scarf', searchQueries: ['red wool scarf'], computedFallback: 'red wool scarf', isWeak: isWeakQuery }), null);
  assertEquals(vri03CacheSuffix(undefined), '');
  assertEquals(vri03CacheSuffix({ h3: false, h4: false }), '');
  assertEquals(vri03CacheSuffix({ h3: true, h4: false }), '|vri03:10');
});

Deno.test('H4b keys: synonym variants are bounded and head phrases come first', () => {
  const keys = vri03SynonymSubtypeKeys(['black leather moto jacket', 'leather moto jacket', 'moto jacket', 'jacket']);
  assert(keys.length <= VRI03_MAX_SUBTYPE_KEYS);
  assert(keys.includes('biker jacket'));
  assertEquals(vri03SynonymSubtypeKeys(['bomber']), ['bomber']);
});

// ── H3/H4: fast path with stubbed providers ─────────────────────────────────

const realFetch = globalThis.fetch;
type Stub = { serper: (q: string) => unknown[]; poshmark?: (q: string) => unknown[] };
const sent = { serper: [] as string[], poshmark: [] as string[], other: 0 };
const returnedUrls = new Set<string>();

function install(stub: Stub) {
  sent.serper = []; sent.poshmark = []; sent.other = 0; returnedUrls.clear();
  _resetShoppingCache();
  commerceCacheClear();
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('google.serper.dev')) {
      const q = JSON.parse(String(init?.body ?? '{}')).q as string;
      sent.serper.push(q);
      const items = stub.serper(q);
      for (const it of items as { productLink: string }[]) returnedUrls.add(it.productLink);
      return Promise.resolve(new Response(JSON.stringify({ shopping: items }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('poshmark')) {
      const q = new URL(url).searchParams.get('query') ?? new URL(url).searchParams.get('q') ?? '';
      sent.poshmark.push(q);
      const results = stub.poshmark ? stub.poshmark(q) : [];
      for (const it of results as { url: string }[]) returnedUrls.add(it.url);
      return Promise.resolve(new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    sent.other++;
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;
}

const serperItem = (title: string, slug: string) => ({
  title, productLink: `https://shop-${slug}.example-retail.test/p/${slug}`, source: `Shop ${slug}`, price: '$120.00', imageUrl: `https://cdn.example-retail.test/${slug}.jpg`,
});
const poshItem = (title: string, slug: string) => ({
  title, url: `https://poshmark.com/listing/${slug}`, listingId: slug, brand: 'Unbranded', price: 80, currency: 'USD',
  imageUrl: `https://cdn.poshmark.test/${slug}.jpg`, condition: 'Excellent', size: 'M', status: 'available',
});

function env(poshmark: boolean) {
  Deno.env.set('SHOPPING_SERPER_API_KEY', 'test-serper');
  Deno.env.delete('SHOPPING_BRAVE_API_KEY');
  Deno.env.set('BACKEND_QUALITY_TUNE_ENABLED', 'true');
  Deno.env.set('POSHMARK_ENABLED', poshmark ? 'true' : 'false');
  if (poshmark) Deno.env.set('POSHMARK_RAPIDAPI_KEY', 'test-poshmark'); else Deno.env.delete('POSHMARK_RAPIDAPI_KEY');
}

const gated = () => applyScannerQualityGate(identification(), undefined, { vri03PreserveModelQueries: true });
function fastInput(vri03?: { h3: boolean; h4: boolean }) {
  const g = gated();
  return {
    mode: 'image' as const, identification: g.identification, attributes: g.attributes, limit: 10,
    qualityDetailLevel: g.commerceQueryDetailLevel, materialAllowed: true, brandAllowed: false,
    relevanceEnabled: true, relevanceRoute: 'apparel' as const, qualityBand: g.qualityBand,
    ...(vri03 ? { vri03 } : {}),
  };
}

const jacket = (n: number, slug: string) => serperItem(`Black Leather Cropped Moto Jacket ${n}`, slug);

Deno.test('H3 fast path: thin shelf sends exactly ONE fallback query; products only from providers', async () => {
  env(false);
  try {
    commerceCacheClear();
    install({ serper: (q) => (q.includes('biker') ? [jacket(2, 'b2'), jacket(3, 'b3'), jacket(4, 'b4')] : [jacket(1, 'p1')]) });
    const on = await getFastCommerceResults(fastInput({ h3: true, h4: false }));
    assertEquals(sent.serper.length, 2, JSON.stringify(sent.serper));
    assert(sent.serper[1].includes('biker'), sent.serper[1]);
    assertEquals(sent.other, 0);
    assertEquals(on.qualityTune?.fallbackUsed, true);
    assert(on.products.length >= 3, String(on.products.length));
    assert(on.products.every((p) => returnedUrls.has(p.productUrl as string)), 'fabricated product');
    assert(on.funnel.cacheKey.endsWith('|vri03:10'));

    commerceCacheClear();
    install({ serper: (q) => (q.includes('biker') ? [jacket(2, 'b2')] : [jacket(1, 'p1')]) });
    const off = await getFastCommerceResults(fastInput());
    assertEquals(sent.serper.length, 1, 'flag OFF: fallback is never sent ' + JSON.stringify(sent.serper));
    assertEquals(off.qualityTune?.fallbackUsed, false);
    assert(!off.funnel.cacheKey.includes('vri03'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test('H3 fast path: a sufficient primary shelf sends no fallback', async () => {
  env(false);
  try {
    commerceCacheClear();
    install({ serper: () => [jacket(1, 'a'), jacket(2, 'b'), jacket(3, 'c'), jacket(4, 'd')] });
    const r = await getFastCommerceResults(fastInput({ h3: true, h4: false }));
    assertEquals(sent.serper.length, 1, JSON.stringify(sent.serper));
    assertEquals(r.qualityTune?.fallbackUsed, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test('H4 fast path: the full pool is scored before truncation; OFF keeps provider-order cut', async () => {
  env(true);
  // Serper caps at 8 results, so the pool exceeds the 10-cut only with
  // Poshmark's 3: the strongly matching target is the 11th candidate.
  const serperFill = () => Array.from({ length: 8 }, (_, i) => serperItem(`Black Jacket Style ${i}`, `s${i}`));
  const poshTarget = () => [poshItem('Black Jacket Posh A', 'filler-a'), poshItem('Black Jacket Posh B', 'filler-b'), poshItem('Black Leather Cropped Moto Jacket', 'target')];
  try {
    commerceCacheClear();
    install({ serper: serperFill, poshmark: poshTarget });
    const off = await getFastCommerceResults(fastInput());
    const offUrls = off.products.map((p) => p.productUrl);
    commerceCacheClear();
    install({ serper: serperFill, poshmark: poshTarget });
    const on = await getFastCommerceResults(fastInput({ h3: false, h4: true }));
    const onUrls = on.products.map((p) => p.productUrl);
    assert(!offUrls.some((u) => String(u).includes('target')), 'OFF: provider-order cut drops the 11th candidate');
    assert(onUrls.some((u) => String(u).includes('target')), 'ON: scored before truncation');
    assert(on.products.length <= 10);
    assert(on.products.every((p) => returnedUrls.has(p.productUrl as string)), 'fabricated product');
    assertEquals(sent.serper.length, 1, 'H4 adds no provider call');
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test('flag-OFF equivalence: vri03 omitted vs all-false give identical results and calls', async () => {
  env(true);
  const stub: Stub = { serper: () => [jacket(1, 'x1'), jacket(2, 'x2')], poshmark: () => [poshItem('Black Moto Jacket', 'pm1')] };
  try {
    commerceCacheClear();
    install(stub);
    const a = await getFastCommerceResults(fastInput());
    const callsA = [...sent.serper, '|', ...sent.poshmark];
    commerceCacheClear();
    install(stub);
    const b = await getFastCommerceResults(fastInput({ h3: false, h4: false }));
    const callsB = [...sent.serper, '|', ...sent.poshmark];
    assertEquals(b.products, a.products);
    assertEquals(callsB, callsA);
    assertEquals(b.funnel.cacheKey, a.funnel.cacheKey);
    assertEquals(b.qualityTune, a.qualityTune);
  } finally {
    globalThis.fetch = realFetch;
  }
});
