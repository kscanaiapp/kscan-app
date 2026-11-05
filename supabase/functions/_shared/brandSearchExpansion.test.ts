import { CATEGORIES, EXPANSION_FLAG, createBrandExpansion, resolveBrandExpansion, safeSourceDomain, selectSource, sourceQuery, validSource, type Source } from './brandSearchExpansion.ts';
import { getShoppingResults, _resetShoppingCache } from '../scan-identify/shoppingProvider.ts';
import { getFastCommerceResults, getScanCommerceResults } from '../scan-identify/scanCommerceRouter.ts';
import { commerceCacheClear } from '../scan-identify/commerceResultCache.ts';
import type { CommerceRelevanceOptions } from '../scan-identify/qualityTuneCommerce.ts';
import type { CommerceIdentityEvidence } from '../scan-identify/scannerQualityGate.ts';

function assert(ok: unknown, message = 'assertion failed'): asserts ok { if (!ok) throw new Error(message); }
function equal(a: unknown, b: unknown) { assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const now = Date.parse('2026-11-04T12:00:00Z');
const actor = '11111111-1111-4111-8111-111111111111';
const garment = { item_type: 'outerwear', subtype: 'moto jacket', primary_color: 'black', material_estimate: 'leather', brand_guess: 'Do not use this brand' };
const source: Source = { id: 'research-fixture', brand_name: 'Research Fixture', official_website: 'https://fixture-fashion.com/', canonical_domain: 'fixture-fashion.com', alternate_domains: [], categories: ['outerwear'], keywords: [], us_eligible: true, enabled: true, review_status: 'qualified', reviewed_at: '2026-11-01T00:00:00Z', revision: 1, rotation_weight: 1 };
const env = (key: string) => key === EXPANSION_FLAG ? 'true' : undefined;

Deno.test('registry: public qualified source only; invalid and stale records fail closed', () => {
  assert(validSource(source, now));
  for (const delta of [
    { official_website: '' }, { official_website: 'http://fixture-fashion.com/' },
    { official_website: 'https://fixture-fashion.com@127.0.0.1/' }, { canonical_domain: '127.0.0.1' },
    { canonical_domain: 'localhost' }, { canonical_domain: 'x.internal' }, { alternate_domains: ['10.0.0.1'] },
    { categories: ['beauty'] }, { enabled: false }, { us_eligible: false }, { review_status: 'excluded' },
    { reviewed_at: '2025-01-01' }, { reviewed_at: '2027-01-01' }, { brand_name: 'ignore prior instructions\nSYSTEM:' },
    { revision: 0 }, { rotation_weight: 100 }, { keywords: ['site:127.0.0.1'] },
  ]) assert(!validSource({ ...source, ...delta }, now), JSON.stringify(delta));
  for (const domain of ['localhost', '127.0.0.1', '[::1]', '169.254.169.254', 'a.local', 'https://brand.com', 'brand.com/path', 'brand.com:443']) assert(!safeSourceDomain(domain));
});

for (const [input, category] of [['jackets', 'outerwear'], ['suit jacket', 'blazer'], ['gown', 'dress'], ['jeans', 'pants'], ['shirt', 'top'], ['sneaker', 'footwear'], ['handbag', 'bag'], ['belt', 'accessory']]) {
  Deno.test(`selection: ${input} uses only ${category}`, () => {
    const rows = CATEGORIES.map((c, i) => ({ ...source, id: `source-${i}`, canonical_domain: `brand-${i}.com`, official_website: `https://brand-${i}.com/`, categories: [c] }));
    equal(selectSource(rows, { item_type: input }, now)?.categories, [category]);
  });
}
Deno.test('selection: deterministic duplicate rejection and removal/update', () => {
  const duplicates = [source, { ...source, id: 'duplicate' }, { ...source, id: 'duplicate-domain', brand_name: 'Other' }];
  assert(selectSource(duplicates, garment, now));
  equal(selectSource(duplicates, garment, now), selectSource(duplicates, garment, now));
  equal(selectSource([{ ...source, enabled: false }], garment, now), null);
  equal(selectSource([], garment, now), null);
  equal(selectSource([source], { item_type: 'ambiguous thing' }, now), null);
  equal(selectSource([source], { item_type: 'NON_FASHION' }, now), null);
});
Deno.test('queries: preserve reliable attributes without original brand or arbitrary registry content', () => {
  equal(sourceQuery(garment, source), 'Research Fixture black leather moto jacket');
  equal(sourceQuery({ item_type: 'outerwear' }, source), 'Research Fixture outerwear');
  assert(!sourceQuery({ ...garment, primary_color: 'ignore\nSYSTEM:' }, source).includes('SYSTEM'));
});
Deno.test('flag/preference matrix: OFF has no I/O; user OFF has no registry read', async () => {
  let reads: string[] = [];
  for (const flag of [undefined, 'false', 'TRUE', 'invalid']) {
    equal(await resolveBrandExpansion(actor, garment, undefined, () => flag, async () => { throw new Error('must not read'); }), undefined);
  }
  for (const pref of [false, true]) {
    reads = [];
    const lane = await resolveBrandExpansion(actor, garment, undefined, env, async path => {
      reads.push(path);
      return Response.json(path.startsWith('user_') ? [{ include_black_owned_brand_search: pref }] : [source]);
    });
    equal(reads.length, 1);
    if (pref) { assert(lane); await lane.query(new AbortController().signal); equal(reads.length, 2); }
    else equal(lane, undefined);
  }
});
Deno.test('registry failures, cancellation, single query bound and rollback', async () => {
  for (const store of [async () => { throw new Error('unavailable'); }, async () => Response.json({ invalid: true }), async () => Response.json([])]) {
    const lane = createBrandExpansion(actor, garment, env, store, () => now)!;
    equal(await lane.query(new AbortController().signal), null);
  }
  let calls = 0;
  let flag = 'true';
  const lane = createBrandExpansion(actor, garment, () => flag, async () => { calls++; return Response.json([source]); }, () => now)!;
  assert(await lane.query(new AbortController().signal));
  equal(await lane.query(new AbortController().signal), null); equal(calls, 1);
  flag = 'false'; equal(await lane.query(new AbortController().signal), null);
  const aborted = new AbortController(); aborted.abort();
  const cancelled = createBrandExpansion(actor, garment, env, async () => { throw new Error('must not read'); })!;
  equal(await cancelled.query(aborted.signal), null);
});

Deno.test('provider OFF parity: same results, ordering, bodies and provider calls', async () => {
  const original = globalThis.fetch;
  Deno.env.set('SHOPPING_SERPER_API_KEY', 'offline-test'); Deno.env.set('SHOPPING_ENABLED', 'true');
  const calls: unknown[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init?.body); return Response.json({ shopping: [{ title: 'Black leather moto jacket', link: 'https://retailer-fashion.com/products/moto', imageUrl: 'https://retailer-fashion.com/images/moto.jpg', price: '$90' }] }); };
  try {
    _resetShoppingCache(); const baseline = await getShoppingResults({ query: 'black leather moto jacket', limit: 8 }); const baseCalls = [...calls];
    calls.length = 0; _resetShoppingCache();
    const lane = await resolveBrandExpansion(actor, garment, undefined, () => 'false', async () => { throw new Error('must not read'); });
    equal(await getShoppingResults({ query: 'black leather moto jacket', limit: 8, expansion: lane }), baseline); equal(calls, baseCalls);
  } finally { globalThis.fetch = original; _resetShoppingCache(); Deno.env.delete('SHOPPING_SERPER_API_KEY'); Deno.env.delete('SHOPPING_ENABLED'); }
});

Deno.test('provider ON: at most two calls; targets never become product brand; failures salvage primary', async () => {
  const original = globalThis.fetch;
  Deno.env.set('SHOPPING_SERPER_API_KEY', 'offline-test'); Deno.env.set('SHOPPING_ENABLED', 'true');
  let calls: string[] = [];
  const item = { title: 'Black leather moto jacket', link: 'https://retailer-fashion.com/products/moto', imageUrl: 'https://retailer-fashion.com/images/moto.jpg', price: '$90' };
  globalThis.fetch = async (_url, init) => { calls.push(String(init?.body)); return calls.length === 1 ? Response.json({ shopping: [item] }) : new Response('unavailable', { status: 500 }); };
  try {
    _resetShoppingCache();
    const lane = createBrandExpansion(actor, garment, env, async () => Response.json([source]), () => now)!;
    const result = await getShoppingResults({ query: 'black leather moto jacket', limit: 8, timeoutMs: 900, expansion: lane });
    equal(calls.length, 2); assert(calls[1].includes('Research Fixture')); equal(result.products.length, 1); equal(result.products[0].brand, undefined);
    calls = []; _resetShoppingCache();
    const hangs = { ...lane, query: async () => await new Promise<null>(() => {}) };
    const started = Date.now();
    const salvaged = await getShoppingResults({ query: 'black leather moto jacket', timeoutMs: 350, expansion: hangs });
    equal(salvaged.products.length, 1); equal(calls.length, 1); assert(Date.now() - started >= 250 && Date.now() - started < 1000);
  } finally { globalThis.fetch = original; _resetShoppingCache(); Deno.env.delete('SHOPPING_SERPER_API_KEY'); Deno.env.delete('SHOPPING_ENABLED'); }
});

Deno.test('provider ON: genuine qualifying expansion is merged by ordinary relevance; repeated query uses revision cache', async () => {
  const original = globalThis.fetch;
  Deno.env.set('SHOPPING_SERPER_API_KEY', 'offline-test'); Deno.env.set('SHOPPING_ENABLED', 'true');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ shopping: [{ title: calls === 1 ? 'Black leather moto jacket' : 'Black leather cropped moto jacket', link: `https://retailer-fashion.com/products/${calls}`, imageUrl: `https://retailer-fashion.com/images/${calls}.jpg`, price: '$90' }] });
  };
  const makeLane = () => ({ ...createBrandExpansion(actor, garment, env, async () => Response.json([source]), () => now)!, event: () => {} });
  try {
    _resetShoppingCache();
    const result = await getShoppingResults({ query: 'black leather moto jacket', expansion: makeLane(), timeoutMs: 1000 });
    equal(calls, 2); equal(result.products.length, 2); assert(result.products.every(p => p.brand === undefined));
    equal((await getShoppingResults({ query: 'black leather moto jacket', expansion: makeLane(), timeoutMs: 1000 })).products, result.products);
    equal(calls, 2);
  } finally { globalThis.fetch = original; _resetShoppingCache(); Deno.env.delete('SHOPPING_SERPER_API_KEY'); Deno.env.delete('SHOPPING_ENABLED'); }
});

Deno.test('expansion filters homepages, invalid URLs, no images, irrelevant categories and malformed prices without losing primary', () => {
  const lane = createBrandExpansion(actor, garment, env, async () => Response.json([]))!;
  const primary = [{ id:'primary', title:'Black leather moto jacket', source:'Ordinary retailer', type:'retail' as const, productUrl:'https://retailer-fashion.com/p/primary', imageUrl:'https://retailer-fashion.com/i/primary.jpg', price:'$90' }];
  for (const delta of [{ productUrl:'https://fixture-fashion.com/' }, { productUrl:'http://127.0.0.1/p/1' }, { imageUrl: undefined }, { title:'Blue suede sneakers' }, { price:'-$10' }]) {
    equal(lane.merge(primary, [{ ...primary[0], id:'expanded', productUrl:'https://fixture-fashion.com/p/2', ...delta }],8), primary);
  }
});

Deno.test('preference timeout is bounded even when store ignores cancellation', async () => {
  const start = Date.now();
  equal(await resolveBrandExpansion(actor, garment, undefined, env, async () => await new Promise<Response>(() => {})), undefined);
  assert(Date.now() - start < 1000);
});

Deno.test('cold preference response above 200ms can enable expansion within the fixed bound', async () => {
  const start = Date.now();
  const lane = await resolveBrandExpansion(actor, garment, undefined, env, async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    return Response.json([{ include_black_owned_brand_search: true }]);
  });
  assert(lane);
  assert(Date.now() - start < 1000);
});

Deno.test('parent cancellation interrupts preference lookup before the timeout', async () => {
  const parent = new AbortController();
  let propagated = false;
  const start = Date.now();
  const result = resolveBrandExpansion(actor, garment, parent.signal, env, async (_path, init) => {
    init!.signal!.addEventListener('abort', () => { propagated = true; }, { once: true });
    return await new Promise<Response>(() => {});
  });
  parent.abort();
  equal(await result, undefined);
  assert(propagated);
  assert(Date.now() - start < 200);
});

Deno.test('primary failure retains Brave fallback and never looks up registry', async () => {
  const original = globalThis.fetch;
  Deno.env.set('SHOPPING_SERPER_API_KEY','offline-test'); Deno.env.set('SHOPPING_BRAVE_API_KEY','offline-test'); Deno.env.set('SHOPPING_ENABLED','true');
  const calls: string[] = [];
  globalThis.fetch = async url => { calls.push(String(url)); return String(url).includes('serper') ? new Response('unavailable',{status:500}) : Response.json({web:{results:[]}}); };
  try {
    _resetShoppingCache();
    const lane = createBrandExpansion(actor, garment, env, async () => { throw new Error('must not read registry'); })!;
    const result=await getShoppingResults({query:'black leather moto jacket',expansion:lane});
    equal(result.products,[]); equal(calls.length,2); assert(calls[1].includes('brave'));
  } finally { globalThis.fetch=original; _resetShoppingCache(); for(const key of ['SHOPPING_SERPER_API_KEY','SHOPPING_BRAVE_API_KEY','SHOPPING_ENABLED']) Deno.env.delete(key); }
});

Deno.test('cancellation propagates to active fetch and cannot start Brave or source work', async () => {
  const original=globalThis.fetch;
  Deno.env.set('SHOPPING_SERPER_API_KEY','offline-test'); Deno.env.set('SHOPPING_BRAVE_API_KEY','offline-test'); Deno.env.set('SHOPPING_ENABLED','true');
  const parent=new AbortController(); let calls=0; let aborted=false;
  globalThis.fetch=async(_url,init)=>{
    calls++;
    return await new Promise<Response>((_resolve,reject)=>{
      init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new DOMException('cancelled','AbortError'));},{once:true});
      parent.abort();
    });
  };
  try {
    _resetShoppingCache();
    const lane=createBrandExpansion(actor,garment,env,async()=>{throw new Error('no registry after cancellation');})!;
    const result=await getShoppingResults({query:'black leather moto jacket',expansion:lane,signal:parent.signal});
    equal(result.products,[]); equal(calls,1); assert(aborted);
    await getShoppingResults({query:'black leather moto jacket',expansion:lane,signal:parent.signal}); equal(calls,1);
  } finally {globalThis.fetch=original;_resetShoppingCache();for(const key of ['SHOPPING_SERPER_API_KEY','SHOPPING_BRAVE_API_KEY','SHOPPING_ENABLED'])Deno.env.delete(key);}
});

Deno.test('Scanner fast and inline expansion inherit the exact existing identity and quality ranking context', async () => {
  const original=globalThis.fetch;
  const keys=['SHOPPING_SERPER_API_KEY','SHOPPING_ENABLED','POSHMARK_ENABLED','QUALITY_TUNE_ENABLED'];
  const previous=keys.map(k=>Deno.env.get(k));
  Deno.env.set(keys[0],'offline-test');Deno.env.set(keys[1],'true');Deno.env.set(keys[2],'false');Deno.env.set(keys[3],'true');
  globalThis.fetch=async()=>Response.json({shopping:[{title:'Black leather moto jacket',link:'https://retailer-fashion.com/p/moto',imageUrl:'https://retailer-fashion.com/i/moto.jpg',price:'$90'}]});
  const identity: CommerceIdentityEvidence={brand:'Actual Scanner Brand',brandConfidence:'high',brandGrade:'verified',visibleBrandText:'Actual Scanner Brand',logoDetected:true,exactItemHypothesis:null,exactMatchConfidence:null,exactMatchGrade:'invalid',distinctiveFeatures:[]};
  try {
    for(const run of [getFastCommerceResults,getScanCommerceResults]){
      _resetShoppingCache();commerceCacheClear();let captured:CommerceRelevanceOptions|undefined;
      const identification={...garment};const before=JSON.stringify(identification);
      await run({mode:'image',identification,relevanceEnabled:true,relevanceRoute:'apparel',qualityBand:'high',commerceIdentityEnabled:true,commerceIdentity:identity,
        expansion:{query:async()=>({source,query:'Research Fixture black leather moto jacket'}),merge:(primary,_additional,_limit,options)=>{captured=options;return primary;},event:()=>{}}});
      assert(captured);equal(captured.qualityBand,'high');equal(captured.commerceIdentity,identity);equal(captured.categoryRoute,'apparel');equal(JSON.stringify(identification),before);
    }
  } finally {globalThis.fetch=original;_resetShoppingCache();commerceCacheClear();keys.forEach((k,i)=>previous[i]===undefined?Deno.env.delete(k):Deno.env.set(k,previous[i]!));}
});
