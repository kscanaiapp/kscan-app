// B42 Scanner Match Confidence v1. Pure classifier cases plus the actual serve
// handler (MODE B) with synthetic Auth, quota and Serper boundaries. No network
// permission, real JWT, customer data or paid provider call is used.
import assert from 'node:assert/strict';
import {
  annotateMatchConfidence,
  classifyMatchConfidence,
  collectOfferEvidence,
  listingBrandAgreement,
  MATCH_CONFIDENCE_CLASSES,
  type MatchConfidence,
  modelHypothesisAgreement,
  type OfferEvidence,
  summarizeMatchConfidence,
} from './matchConfidence.ts';
import { isMatchConfidenceEnabled, MATCH_CONFIDENCE_DEFAULT_ENABLED } from './matchConfidenceConfig.ts';
import { classifyCommerceMatch } from './matchTier.ts';

const STAN_SMITH_SCAN = {
  item_type: 'footwear',
  subtype: 'sneakers',
  primary_color: 'white',
  material_estimate: 'leather',
  silhouette: 'low-top',
  pattern: 'solid',
  visible_brand_text: 'adidas',
  exact_item_hypothesis: 'Stan Smith',
  exact_match_confidence: 'medium',
};
const DIRECT = 'https://www.retailer-one.com/p/stan-smith';
const HANDOFF = 'https://www.google.com/search?ibp=oshop&q=stan+smith&prds=pid:1';
const offer = (title: string, productUrl = DIRECT, extra: Record<string, unknown> = {}) => ({
  id: `o-${title.length}-${productUrl.length}`,
  title,
  productUrl,
  imageUrl: 'https://img.retailer-one.com/a.jpg',
  price: '$100',
  ...extra,
});
const classify = (product: Record<string, unknown>, identification: Record<string, unknown> = STAN_SMITH_SCAN) =>
  classifyMatchConfidence(collectOfferEvidence(product, { identification }));

const EVIDENCE: OfferEvidence = {
  destination: 'direct',
  agreementScore: 85,
  agreementBand: 'strong',
  clearCategoryConflict: false,
  category: 'compatible',
  subtypeCompatible: true,
  brand: 'agrees',
  model: 'agrees',
  verifiedProductIdentity: false,
};

Deno.test('match confidence: flag defaults OFF and parses the documented values', () => {
  assert.equal(MATCH_CONFIDENCE_DEFAULT_ENABLED, false);
  assert.equal(isMatchConfidenceEnabled(() => undefined), false);
  for (const on of ['true', 'TRUE', '1', 'on', 'yes', ' true ']) assert.equal(isMatchConfidenceEnabled(() => on), true);
  for (const off of ['false', '0', 'off', 'no', 'garbage', '']) assert.equal(isMatchConfidenceEnabled(() => off), false);
});

Deno.test('match confidence: verified brand + full model agreement is probable, never verified_exact', () => {
  for (const url of [DIRECT, HANDOFF]) {
    const c = classify(offer('adidas Originals Stan Smith Sneakers White Leather', url));
    assert.equal(c.class, 'probable');
    assert.ok(c.reasons.includes('exact_identity_unverified'));
    assert.ok(c.reasons.includes(url === DIRECT ? 'direct_merchant_listing' : 'search_handoff_destination'));
  }
});

Deno.test('match confidence: identity-shaped title is probable even though the attribute scorer calls it weak', () => {
  // B42 finding: the v122 attribute scorer gives the real product title almost no
  // credit, so the band alone would have called the actual product a padding fill.
  const e = collectOfferEvidence(offer('adidas Stan Smith'), { identification: STAN_SMITH_SCAN });
  assert.equal(e.agreementBand, 'weak');
  assert.equal(e.category, 'absent');
  const c = classifyMatchConfidence(e);
  assert.equal(c.class, 'probable');
  assert.ok(c.reasons.includes('agreement_below_usable'));
});

Deno.test('match confidence: below-usable coverage fills are unsupported', () => {
  const c = classify(offer('Black Running Shoes Mesh'));
  assert.equal(c.agreementBand, 'weak');
  assert.equal(c.class, 'unsupported');
  assert.equal(classifyMatchConfidence({ ...EVIDENCE, brand: 'unknown', model: 'absent', agreementBand: 'weak', agreementScore: 20 }).class, 'unsupported');
});

Deno.test('match confidence: attribute agreement without identity is similar', () => {
  const c = classify(offer('White Leather Low-Top Sneakers'));
  assert.equal(c.class, 'similar');
  assert.ok(c.reasons.includes('listing_brand_unknown'));
  assert.ok(c.reasons.includes('model_hypothesis_absent'));
});

Deno.test('match confidence: invalid destinations, category conflicts and ancillary listings are unsupported', () => {
  assert.equal(classify(offer('adidas Originals Stan Smith Sneakers White Leather', 'http://www.retailer-one.com/p/1')).class, 'unsupported');
  assert.equal(classify(offer('Canvas Tote Bag')).class, 'unsupported');
  for (const title of ['adidas Stan Smith Socks 3 Pack', 'Replacement Laces for adidas Stan Smith', 'adidas Stan Smith Shoe Cleaner']) {
    const c = classify(offer(title));
    assert.equal(c.class, 'unsupported', title);
    assert.ok(c.reasons.includes('ancillary_listing'), title);
  }
  // An item the scan itself classifies as a strap/band is not an ancillary listing of itself.
  const strap = { ...STAN_SMITH_SCAN, item_type: 'accessory', subtype: 'watch strap', exact_item_hypothesis: 'NATO' };
  assert.notEqual(classify(offer('adidas NATO Watch Strap'), strap).reasons.includes('ancillary_listing'), true);
});

Deno.test('match confidence: dupes, replicas and inspired listings never earn brand agreement', () => {
  for (const title of ['Stan Smith Inspired White Sneakers by adidas', 'adidas Stan Smith Replica Sneakers', 'Alternative to adidas Stan Smith Sneakers', 'adidas Stan Smith dupe']) {
    assert.equal(listingBrandAgreement(offer(title), STAN_SMITH_SCAN), 'unknown', title);
    assert.notEqual(classify(offer(title)).class, 'probable', title);
  }
});

Deno.test('match confidence: provider brand wins over title, and a contradiction blocks probable', () => {
  assert.equal(listingBrandAgreement(offer('Stan Smith Sneakers', DIRECT, { brand: 'adidas' }), STAN_SMITH_SCAN), 'agrees');
  assert.equal(listingBrandAgreement(offer('adidas Stan Smith Sneakers', DIRECT, { brand: 'Generic Shoe Co' }), STAN_SMITH_SCAN), 'contradicts');
  assert.notEqual(classify(offer('adidas Stan Smith Sneakers White', DIRECT, { brand: 'Generic Shoe Co' })).class, 'probable');
});

Deno.test('match confidence: unverified scan brand (hypothesis only) never earns probable', () => {
  const guessOnly = { ...STAN_SMITH_SCAN, visible_brand_text: undefined, brand_guess: 'adidas' };
  assert.equal(listingBrandAgreement(offer('adidas Stan Smith Sneakers'), guessOnly), 'scanned_unverified');
  assert.equal(classify(offer('adidas Originals Stan Smith Sneakers White Leather'), guessOnly).class, 'similar');
  // A logo counts only when the model classified it with high confidence.
  const mediumLogo = { ...guessOnly, logo_detected: true, logo_brand: 'adidas', logo_confidence: 'medium' };
  assert.equal(listingBrandAgreement(offer('adidas Stan Smith Sneakers'), mediumLogo), 'scanned_unverified');
  const highLogo = { ...mediumLogo, logo_confidence: 'high' };
  assert.equal(listingBrandAgreement(offer('adidas Stan Smith Sneakers'), highLogo), 'agrees');
});

Deno.test('match confidence: model agreement needs every distinctive token; low confidence is ignored', () => {
  const aj = { ...STAN_SMITH_SCAN, visible_brand_text: 'Nike', exact_item_hypothesis: 'Air Jordan 1 High', exact_match_confidence: 'high' };
  assert.equal(modelHypothesisAgreement(offer('Nike Air Jordan 1 High OG Sneakers'), aj), 'agrees');
  assert.equal(modelHypothesisAgreement(offer('Nike Air Jordan 1 Mid Sneakers'), aj), 'partial');
  assert.equal(modelHypothesisAgreement(offer('Nike Air Force 1 Sneakers'), aj), 'partial');
  assert.notEqual(classify(offer('Nike Air Jordan 1 Mid Sneakers White Leather'), aj).class, 'probable');
  // Generic hypotheses carry no identity.
  assert.equal(modelHypothesisAgreement(offer('adidas White Leather Sneakers'), { ...STAN_SMITH_SCAN, exact_item_hypothesis: 'white leather sneakers' }), 'absent');
  assert.equal(modelHypothesisAgreement(offer('adidas Stan Smith Sneakers'), { ...STAN_SMITH_SCAN, exact_match_confidence: 'low' }), 'absent');
  assert.equal(modelHypothesisAgreement(offer('adidas Stan Smith Sneakers'), { ...STAN_SMITH_SCAN, exact_item_hypothesis: undefined }), 'absent');
});

Deno.test('match confidence: a different canonical category caps identity agreement at similar', () => {
  const e = { ...EVIDENCE, category: 'different' as const };
  assert.equal(classifyMatchConfidence(e).class, 'similar');
  assert.ok(classifyMatchConfidence(e).reasons.includes('category_different'));
});

Deno.test('match confidence: verified_exact only from a listing-bound exact tier on a direct merchant listing', () => {
  // The model hypothesis, a model confidence, a title or a score can never produce it.
  assert.equal(classifyMatchConfidence({ ...EVIDENCE, verifiedProductIdentity: false }).class, 'probable');
  assert.equal(classifyMatchConfidence({ ...EVIDENCE, verifiedProductIdentity: true }).class, 'verified_exact');
  assert.equal(classifyMatchConfidence({ ...EVIDENCE, verifiedProductIdentity: true, destination: 'search_handoff' }).class, 'probable');
  assert.equal(classifyMatchConfidence({ ...EVIDENCE, verifiedProductIdentity: true, agreementBand: 'weak', agreementScore: 10 }).class, 'probable');
  // End to end through the real listing-bound tier contract.
  const product = offer('adidas Stan Smith Sneakers White Leather', DIRECT, { brand: 'adidas' });
  const proof = { source: 'verified_product_identity' as const, scanModel: 'Stan Smith', productModel: 'Stan Smith', scanVariant: 'White Green', productVariant: 'White Green' };
  const exact = classifyCommerceMatch(product, { brandEvidence: { brand: 'adidas', verified: true, source: 'wordmark' }, categoryCompatible: true, subtypeCompatible: true, exactIdentity: proof });
  assert.equal(exact?.tier, 'exact');
  assert.equal(classify({ ...product, matchMetadata: exact }).class, 'verified_exact');
  assert.equal(classify(product).class, 'probable');
});

Deno.test('match confidence: annotation is additive — order, count and every existing field preserved', () => {
  const products = [
    offer('adidas Originals Stan Smith Sneakers White Leather', HANDOFF, { watch: { capable: true } }),
    offer('Black Running Shoes Mesh'),
    offer('White Leather Low-Top Sneakers'),
  ];
  const snapshot = structuredClone(products);
  const out = annotateMatchConfidence(products, { identification: STAN_SMITH_SCAN });
  assert.deepEqual(products, snapshot, 'input must not be mutated');
  assert.equal(out.length, products.length);
  out.forEach((p, i) => {
    const { matchConfidence, ...rest } = p as typeof p & { matchConfidence: MatchConfidence };
    assert.deepEqual(rest, snapshot[i]);
    assert.equal(matchConfidence.version, 1);
    assert.ok(MATCH_CONFIDENCE_CLASSES.includes(matchConfidence.class));
    assert.ok(matchConfidence.agreementScore >= 0 && matchConfidence.agreementScore <= 100);
  });
  assert.deepEqual(out.map(p => (p as unknown as { matchConfidence: MatchConfidence }).matchConfidence.class), ['probable', 'unsupported', 'similar']);
  assert.deepEqual(annotateMatchConfidence([null, 7] as unknown[], { identification: STAN_SMITH_SCAN }), [null, 7]);
});

Deno.test('match confidence: summary is counts only', () => {
  const out = annotateMatchConfidence([
    offer('adidas Originals Stan Smith Sneakers White Leather', HANDOFF),
    offer('Black Running Shoes Mesh'),
    offer('White Leather Low-Top Sneakers'),
    { title: 'no confidence attached' },
  ], { identification: STAN_SMITH_SCAN }).slice(0, 3);
  const s = summarizeMatchConfidence([...out, { title: 'unannotated' }]);
  assert.deepEqual(s, {
    offers: 3,
    classes: { verified_exact: 0, probable: 1, similar: 1, unsupported: 1 },
    destinations: { direct: 2, search_handoff: 1, invalid: 0 },
  });
  assert.doesNotMatch(JSON.stringify(s), /stan|smith|https?:|adidas/i);
});

// ── Actual serve handler, MODE B ────────────────────────────────────────────

Deno.test({
  name: 'match confidence: MODE B handler is byte-identical with the flag OFF and additive with it ON',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const actor = '00000000-0000-4000-8000-000000000042';
    const origin = 'https://match-confidence-fixture.invalid';
    const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY',
      'BACKEND_COMMERCE_FUNNEL_V127_ENABLED', 'BACKEND_COMMERCE_IDENTITY_ENABLED', 'SHOPPING_SERPER_API_KEY',
      'SCANNER_MATCH_CONFIDENCE_V1_ENABLED'];
    const CLEARED = ['POSHMARK_ENABLED', 'POSHMARK_RAPIDAPI_KEY', 'FARFETCH3_ENABLED', 'KICKSCREW_ENABLED',
      'SHOPPING_BRAVE_API_KEY', 'BACKEND_QUALITY_TUNE_ENABLED', 'VRI03_SCAN_IMPROVEMENTS_ENABLED',
      'BLACK_OWNED_BRAND_SEARCH_EXPANSION_ENABLED'];
    const saved = [...names, ...CLEARED].map(n => [n, Deno.env.get(n)] as const);
    const fetchSaved = globalThis.fetch;
    const serveSaved = Object.getOwnPropertyDescriptor(Deno, 'serve')!;
    const logSaved = console.log;
    let handler: ((r: Request) => Promise<Response>) | undefined;
    let serperCalls = 0, geminiCalls = 0, otherExternal = 0;
    const externalHosts: string[] = [];
    const logs: string[] = [];
    const serperItems = [
      { title: 'adidas Originals Stan Smith Sneakers White Leather', link: 'https://www.google.com/search?ibp=oshop&q=a&prds=pid:1', source: 'Store A', price: '$100.00', imageUrl: 'https://img.store-a.com/1.jpg' },
      { title: 'White Leather Low-Top Sneakers', link: 'https://www.google.com/search?ibp=oshop&q=b&prds=pid:2', source: 'Store B', price: '$60.00', imageUrl: 'https://img.store-b.com/2.jpg' },
      { title: 'adidas Stan Smith', productLink: 'https://www.store-c.com/p/stan-smith', link: 'https://www.google.com/search?ibp=oshop&q=c&prds=pid:3', source: 'Store C', price: '$95.00', imageUrl: 'https://img.store-c.com/3.jpg' },
      { title: 'Classic White Court Sneakers Leather', link: 'https://www.google.com/search?ibp=oshop&q=d&prds=pid:4', source: 'Store D', price: '$70.00', imageUrl: 'https://img.store-d.com/4.jpg' },
      { title: 'adidas Stan Smith Socks 3 Pack', link: 'https://www.google.com/search?ibp=oshop&q=e&prds=pid:5', source: 'Store E', price: '$20.00', imageUrl: 'https://img.store-e.com/5.jpg' },
    ];
    try {
      for (const n of names) Deno.env.set(n, n === 'SUPABASE_URL' ? origin
        : n === 'BACKEND_COMMERCE_FUNNEL_V127_ENABLED' || n === 'BACKEND_COMMERCE_IDENTITY_ENABLED' ? 'true'
        : 'synthetic-fixture-only');
      Deno.env.delete('SCANNER_MATCH_CONFIDENCE_V1_ENABLED');
      // Serper-only provider mix, pinned: other suites in the same run can leave
      // optional provider and VRI-03 flags set.
      for (const n of CLEARED) Deno.env.delete(n);
      globalThis.fetch = async (input, init) => {
        const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (u.hostname === 'google.serper.dev') {
          serperCalls++;
          return Response.json({ shopping: serperItems });
        }
        if (u.hostname.includes('generativelanguage')) { geminiCalls++; return Response.json({}, { status: 503 }); }
        if (u.origin !== origin) { otherExternal++; externalHosts.push(u.hostname); return Response.json({ error: 'external_call_denied' }, { status: 503 }); }
        if (u.pathname === '/auth/v1/user') return Response.json({ id: actor, aud: 'authenticated', role: 'authenticated', is_anonymous: false });
        if (u.pathname === '/rest/v1/profiles') return Response.json([{ id: actor, account_status: 'active', account_locked_at: null }]);
        if (u.pathname === '/rest/v1/rpc/check_and_increment_scan_identify_daily_usage') return Response.json([{ allowed: true, count: 1, limit: 60 }]);
        return Response.json({ error: 'unconfigured_fixture_boundary' }, { status: 503 });
      };
      Object.defineProperty(Deno, 'serve', { configurable: true, value: (a: unknown, b: unknown) => {
        handler = (typeof a === 'function' ? a : b) as typeof handler;
        return { finished: Promise.resolve(), shutdown: async () => {} };
      } });
      // Apply printf-style substitution the way the runtime console does.
      console.log = (...args: unknown[]) => {
        const [fmt, ...rest] = args;
        logs.push(typeof fmt === 'string' ? fmt.replace(/%[sdi]/g, () => String(rest.shift())) + (rest.length ? ' ' + rest.map(String).join(' ') : '') : args.map(String).join(' '));
      };
      await import('./index.ts?b42-match-confidence');
      assert.ok(handler);
      const { _resetShoppingCache } = await import('./shoppingProvider.ts');
      const { commerceCacheClear } = await import('./commerceResultCache.ts');

      async function commerceOnly() {
        _resetShoppingCache(); commerceCacheClear(); logs.length = 0;
        const response = await handler!(new Request(origin + '/functions/v1/scan-identify', {
          method: 'POST',
          headers: { apikey: 'synthetic-fixture-only', Authorization: 'Bearer synthetic-verified-user', 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestMode: 'commerce_only', identification: STAN_SMITH_SCAN, attributes: { category: 'footwear', itemType: 'sneakers', colorPalette: ['white'] } }),
        }));
        assert.equal(response.status, 200);
        return await response.json() as { status: string; recommendedProducts: Record<string, unknown>[]; purchaseOptions: Record<string, unknown>[] };
      }

      const off = await commerceOnly();
      await t.step('flag OFF: no matchConfidence and no summary log', () => {
        assert.equal(off.status, 'completed');
        assert.ok(off.recommendedProducts.length > 0);
        assert.ok(off.recommendedProducts.every(p => !('matchConfidence' in p)));
        assert.ok(!logs.some(l => l.includes('match_confidence_v1')));
      });

      Deno.env.set('SCANNER_MATCH_CONFIDENCE_V1_ENABLED', 'true');
      const on = await commerceOnly();
      await t.step('flag ON: same offers, same order, same fields plus matchConfidence', () => {
        assert.equal(on.recommendedProducts.length, off.recommendedProducts.length);
        on.recommendedProducts.forEach((p, i) => {
          const { matchConfidence, ...rest } = p;
          assert.deepEqual(rest, off.recommendedProducts[i]);
          assert.ok(MATCH_CONFIDENCE_CLASSES.includes((matchConfidence as MatchConfidence).class));
        });
      });
      await t.step('flag ON: classes reflect the evidence', () => {
        const byTitle = new Map(on.recommendedProducts.map(p => [p.title, (p.matchConfidence as MatchConfidence)]));
        const identityShaped = byTitle.get('adidas Stan Smith');
        if (identityShaped) {
          assert.equal(identityShaped.class, 'probable');
          assert.equal(identityShaped.destination, 'direct');
        }
        assert.equal(byTitle.get('adidas Originals Stan Smith Sneakers White Leather')?.class, 'probable');
        assert.equal(byTitle.get('adidas Originals Stan Smith Sneakers White Leather')?.destination, 'search_handoff');
        const socks = byTitle.get('adidas Stan Smith Socks 3 Pack');
        if (socks) assert.equal(socks.class, 'unsupported');
        for (const mc of byTitle.values()) assert.notEqual(mc.class, 'verified_exact');
      });
      await t.step('flag ON: one privacy-safe counts-only summary line', () => {
        const lines = logs.filter(l => l.includes('match_confidence_v1'));
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^\[scan-identify\] match_confidence_v1 request_mode=commerce_only offers=\d+ verified_exact=0 probable=\d+ similar=\d+ unsupported=\d+ direct=\d+ search_handoff=\d+ invalid=\d+$/);
        assert.doesNotMatch(lines[0], /stan|smith|adidas|https?:|00000000/i);
      });
      await t.step('no Gemini call and no unexpected external call on MODE B', () => {
        assert.equal(geminiCalls, 0);
        assert.equal(otherExternal, 0, externalHosts.join(','));
        assert.equal(serperCalls >= 2, true);
      });
    } finally {
      console.log = logSaved;
      globalThis.fetch = fetchSaved; Object.defineProperty(Deno, 'serve', serveSaved);
      for (const [n, v] of saved) v === undefined ? Deno.env.delete(n) : Deno.env.set(n, v);
    }
  },
});
