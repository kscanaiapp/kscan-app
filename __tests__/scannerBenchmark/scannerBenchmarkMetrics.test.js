// Build 42 Scanner benchmark: scoring library (tools/scanner-benchmark/lib).
// Offline and deterministic. No network, no provider, no image bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const lib = (name) => import(pathToFileURL(path.join(__dirname, '..', '..', 'tools', 'scanner-benchmark', 'lib', name)).href);

const STAN_SMITH = {
  caseId: 'b42-x-stan', stratum: 'exact_known',
  labels: {
    nonFashion: false, category: 'footwear', subtypeTerms: ['sneaker', 'trainer'], colorTerms: ['white'],
    brand: { visible: true, name: 'adidas' },
    exactProduct: { knowable: true, brand: 'adidas', model: 'Stan Smith', modelAliases: ['Stan Smith'] },
  },
};
const HOODIE = {
  caseId: 'b42-x-hoodie', stratum: 'unknown_generic',
  labels: { nonFashion: false, category: 'top', subtypeTerms: ['hoodie', 'sweatshirt'], colorTerms: ['grey', 'gray'], brand: { visible: false, name: null }, exactProduct: { knowable: false } },
};
const MUG = { caseId: 'b42-x-mug', stratum: 'non_fashion', labels: { nonFashion: true, category: 'non_fashion', exactProduct: { knowable: false } } };

test('destination classifier is independent and conservative', async () => {
  const { classifyDestination } = await lib('destination.mjs');
  assert.equal(classifyDestination('https://www.retailer.com/p/1'), 'direct');
  assert.equal(classifyDestination('https://www.google.com/search?ibp=oshop&q=x'), 'search_handoff');
  assert.equal(classifyDestination('https://www.google.co.uk/shopping/product/1'), 'search_handoff');
  assert.equal(classifyDestination({ host: 'www.google.com', path: '/search', https: true }), 'search_handoff');
  assert.equal(classifyDestination({ host: 'poshmark.com', path: '/listing/1', https: true }), 'direct');
  for (const bad of ['http://shop.com/p', 'https://user:pw@shop.com/p', 'https://localhost/p', 'https://shop.test/p', 'not a url', null, 42]) {
    assert.equal(classifyDestination(bad), 'invalid', String(bad));
  }
});

test('exact-product judge requires brand and every model token; ancillary and dupe listings never count', async () => {
  const { judgeExactProduct } = await lib('judge.mjs');
  const ep = STAN_SMITH.labels.exactProduct;
  assert.equal(judgeExactProduct({ title: 'adidas Originals Stan Smith Shoes' }, ep), 'exact_product');
  assert.equal(judgeExactProduct({ title: 'Stan Smith Shoes', brand: 'adidas' }, ep), 'exact_product');
  assert.equal(judgeExactProduct({ title: 'adidas Superstar Shoes' }, ep), 'same_brand');
  assert.equal(judgeExactProduct({ title: 'adidas Stan Smith Socks' }, ep), 'same_brand');
  assert.equal(judgeExactProduct({ title: 'Stan Smith inspired white sneaker by adidas' }, ep), 'same_brand');
  assert.equal(judgeExactProduct({ title: 'Stan Smith Shoes', brand: 'Generic' }, ep), 'other');
  assert.equal(judgeExactProduct({ title: 'White leather sneakers' }, ep), 'other');
  assert.equal(judgeExactProduct({ title: 'anything' }, { knowable: false }), 'not_applicable');
});

test('alternative grade is title-only 0..3 with reject terms', async () => {
  const { gradeAlternative } = await lib('judge.mjs');
  const L = HOODIE.labels;
  assert.equal(gradeAlternative({ title: 'Grey Pullover Hoodie' }, L), 3);
  assert.equal(gradeAlternative({ title: 'Black Zip Hoodie' }, L), 2);
  assert.equal(gradeAlternative({ title: 'Crew Neck Sweater' }, L), 1);
  assert.equal(gradeAlternative({ title: 'Leather Boots' }, L), 0);
  assert.equal(gradeAlternative({ title: 'Grey Hoodie Dress' }, { ...L, rejectTerms: ['dress'] }), 0);
});

test('metrics: exact precision is null, not zero, when nothing is claimed exact', async () => {
  const { computeMetrics } = await lib('metrics.mjs');
  const m = computeMetrics([STAN_SMITH, HOODIE, MUG], [
    { caseId: 'b42-x-stan', identification: { status: 'completed', category: 'footwear', brand: { value: 'adidas' } },
      offers: [{ title: 'White Leather Low-Top Sneakers', productUrl: 'https://www.google.com/search?q=a' }, { title: 'adidas Stan Smith Shoes', productUrl: 'https://shop.example-retailer.com/p/2' }],
      timings: { detectionMs: 7000, selectedMs: 6000, commerceMs: 1500 } },
    { caseId: 'b42-x-hoodie', identification: { status: 'completed', category: 'top', brand: { value: 'Supreme' } },
      offers: [{ title: 'Grey Pullover Hoodie', productUrl: 'https://www.google.com/search?q=b' }], timings: { detectionMs: 8000, selectedMs: 6000, commerceMs: 2000 } },
    { caseId: 'b42-x-mug', identification: { status: 'non_fashion' }, offers: [], commerceAttempted: false },
  ]);
  assert.equal(m.casesScored, 3);
  assert.equal(m.exactMatchPrecision.value, null);
  assert.match(m.exactMatchPrecision.note, /no exact-match claims/);
  assert.equal(m.falseExactMatchRate.value, 0);
  assert.equal(m.exactProductRecall.top1.value, 0);
  assert.equal(m.exactProductRecall.top3.value, 1);
  assert.deepEqual([m.merchantLinkValidity.direct.numerator, m.merchantLinkValidity.searchHandoff.numerator, m.merchantLinkValidity.offers], [1, 2, 3]);
  assert.equal(m.actionableLatencyMs.n, 2);
  assert.equal(m.actionableLatencyMs.p50, 14500);
  assert.equal(m.actionableLatencyMs.p95, 16000);
  assert.equal(m.identification.nonFashionRejection.value, 1);
  assert.equal(m.identification.unsupportedBrandClaimRate.value, 0.5, 'Supreme claimed on an unbranded hoodie');
});

test('metrics: a wrong exact claim counts against precision and the case-level false-exact rate', async () => {
  const { computeMetrics } = await lib('metrics.mjs');
  const offers = [
    { title: 'adidas Superstar Shoes', productUrl: 'https://shop.example-retailer.com/p/1', matchConfidence: { class: 'verified_exact' } },
    { title: 'adidas Stan Smith Shoes', productUrl: 'https://shop.example-retailer.com/p/2', matchConfidence: { class: 'verified_exact' } },
    { title: 'adidas Stan Smith Shoes White', productUrl: 'https://shop.example-retailer.com/p/3', matchConfidence: { class: 'probable' } },
  ];
  const m = computeMetrics([STAN_SMITH, HOODIE], [
    { caseId: 'b42-x-stan', offers, timings: {} },
    { caseId: 'b42-x-hoodie', offers: [{ title: 'Grey Hoodie', productUrl: 'https://shop.example-retailer.com/p/4', matchMetadata: { tier: 'exact' } }], timings: {} },
  ]);
  assert.equal(m.exactMatchPrecision.numerator, 1);
  assert.equal(m.exactMatchPrecision.denominator, 3);
  assert.equal(m.falseExactMatchRate.numerator, 2);
  assert.equal(m.falseExactMatchRate.denominator, 2);
  assert.equal(m.probablePrecision.value, 1);
});

test('metrics: unknown case ids are reported, never scored', async () => {
  const { computeMetrics } = await lib('metrics.mjs');
  const m = computeMetrics([HOODIE], [{ caseId: 'not-in-manifest', offers: [] }]);
  assert.equal(m.casesScored, 0);
  assert.deepEqual(m.unknownCaseIds, ['not-in-manifest']);
});

test('metrics: provider cost is null without pricing and labelled when estimates are mixed in', async () => {
  const { computeMetrics } = await lib('metrics.mjs');
  const results = [{ caseId: 'b42-x-hoodie', offers: [], timings: {}, cost: { source: 'estimated', geminiInputTokens: 3000, geminiOutputTokens: 1000, commerceCalls: { serper: 2 } } }];
  assert.equal(computeMetrics([HOODIE], results).providerCost.usd, null);
  const priced = computeMetrics([HOODIE], results, { geminiInputPerMTok: 1.5, geminiOutputPerMTok: 7.5, commercePerCall: { serper: 0.001 } }).providerCost.usd;
  assert.equal(priced.basis, 'includes_estimates');
  assert.ok(Math.abs(priced.total - (0.0045 + 0.0075 + 0.002)) < 1e-9);
});

test('percentile uses nearest rank and ignores non-numbers', async () => {
  const { percentile } = await lib('metrics.mjs');
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, null, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test('manifest validator enforces licence, provenance, strata and derived-case parentage', async () => {
  const { validateManifest } = await lib('manifest.mjs');
  const src = (over = {}) => ({
    caseId: 'b42-ex-001', stratum: 'exact_known', split: 'development', labelSources: ['commons_category'],
    labels: { nonFashion: false, category: 'accessory', brand: { visible: true, name: 'Casio' }, exactProduct: { knowable: true, brand: 'Casio', modelAliases: ['F-91W'] } },
    source: { kind: 'commons', licence: 'CC BY-SA 4.0', author: 'Example', filePage: 'https://commons.wikimedia.org/wiki/File:X.jpg', fetchUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/960px-X.jpg', sha256: 'a'.repeat(64) },
    ...over,
  });
  assert.deepEqual(validateManifest({ cases: [src()] }), []);
  const derived = { caseId: 'b42-dif-001', stratum: 'difficult', split: 'development', labelSources: ['inherited'], labels: src().labels, source: { kind: 'derived', derivedFrom: 'b42-ex-001', transform: 'low_light' } };
  assert.deepEqual(validateManifest({ cases: [src(), derived] }), []);
  const bad = (over) => validateManifest({ cases: [src(over)] }).join('\n');
  assert.match(bad({ source: { ...src().source, licence: 'CC BY-NC 4.0' } }), /licence not admitted/);
  assert.match(bad({ source: { ...src().source, licence: 'CC BY-ND 4.0' } }), /licence not admitted/);
  assert.deepEqual(validateManifest({ cases: [src({ source: { ...src().source, licence: 'CC BY-SA 2.5 si' } })] }), []);
  assert.match(bad({ source: { ...src().source, licence: 'CC BY-NC-SA 2.5 si' } }), /licence not admitted/);
  assert.match(bad({ source: { ...src().source, sha256: 'xyz' } }), /sha256 required/);
  assert.match(bad({ labels: { ...src().labels, exactProduct: { knowable: false } } }), /exact_known requires/);
  assert.match(bad({ stratum: 'unknown_stratum' }), /unknown stratum/);
  assert.match(bad({ labelSources: [] }), /labelSources required/);
  assert.match(validateManifest({ cases: [src(), { ...derived, split: 'holdout' }] }).join('\n'), /share its parent split/);
  assert.match(validateManifest({ cases: [{ ...derived, source: { kind: 'derived', derivedFrom: 'nope', transform: 'blur' } }] }).join('\n'), /derivedFrom must name/);
});

test('archived adapter maps live-certification items to scored cases', async () => {
  const { adaptArchivedReport } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'tools', 'scanner-benchmark', 'adapters', 'archivedLiveCertification.mjs')).href);
  const corpus = { images: [{ id: 'J', expectedGarments: [{ key: 'jeans', categoryAny: ['pants', 'jeans'], subtypeAny: ['jeans'], colorAny: ['blue'], offerTitleReject: ['dress'], brandGrounded: [] }] }, { id: 'N', expectedGarments: [] }] };
  const report = { phase: 'PX', results: [
    { detection: { perPhoto: [{ imageId: 'J', latencyMs: 7000 }] }, items: [
      { imageId: 'J', boundGarmentKey: 'jeans', selected: { latencyMs: 6000, response: { status: 'completed', identification: { item_type: 'pants', subtype: 'jeans' } } }, commerce: { latencyMs: 2000 }, offers: [{ rank: 1, title: 'Blue Straight Jeans', destination: { host: 'www.google.com', path: '/search', https: true } }] },
      { imageId: 'J', boundGarmentKey: null, offers: [] },
    ] },
    { detection: { perPhoto: [{ imageId: 'N', responseStatus: 'non_fashion' }] }, items: [] },
  ] };
  const { cases, results } = adaptArchivedReport(report, corpus);
  assert.deepEqual(cases.map((c) => c.caseId), ['archived:J:jeans', 'archived:N:__non_fashion__']);
  assert.equal(results[0].timings.detectionMs + results[0].timings.selectedMs + results[0].timings.commerceMs, 15000);
  assert.equal(results[1].identification.status, 'non_fashion');
  const { computeMetrics } = await lib('metrics.mjs');
  const m = computeMetrics(cases, results);
  assert.equal(m.merchantLinkValidity.searchHandoff.numerator, 1);
  assert.equal(m.alternativeRelevance.hitAt3.value, 1);
  assert.equal(m.identification.nonFashionRejection.value, 1);
});

test('brand claims on cases with unknown legibility (derived variants) are not scored', async () => {
  const { computeMetrics } = await lib('metrics.mjs');
  const derived = { ...STAN_SMITH, caseId: 'b42-dif-x', stratum: 'difficult', labels: { ...STAN_SMITH.labels, brand: { ...STAN_SMITH.labels.brand, visible: null } } };
  const m = computeMetrics([derived], [{ caseId: 'b42-dif-x', identification: { status: 'completed', category: 'footwear', brand: { value: 'adidas' } }, offers: [], timings: {} }]);
  assert.equal(m.identification.unsupportedBrandClaimRate.denominator, 0);
});

test('committed benchmark manifest validates and meets its documented composition', async () => {
  const fs = require('node:fs');
  const { validateManifest, summarizeManifest } = await lib('manifest.mjs');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'scanner-benchmark', 'manifest', 'cases.v1.json'), 'utf8'));
  assert.deepEqual(validateManifest(manifest), []);
  const s = summarizeManifest(manifest);
  assert.ok(s.cases >= 100, 'at least 100 cases');
  for (const stratum of ['exact_known', 'unknown_generic', 'logo_visible', 'texture_pattern', 'multi_item', 'difficult', 'non_fashion']) {
    assert.ok((s.byStratum[stratum] ?? 0) > 0, `stratum ${stratum} present`);
  }
  assert.ok(s.bySplit.holdout > 0 && s.bySplit.development > 0);
  // Holdout families never leak into development.
  const fam = (split) => new Set(manifest.cases.filter((c) => c.split === split).map((c) => c.labels.exactProduct?.family).filter(Boolean));
  for (const f of fam('holdout')) assert.ok(!fam('development').has(f), `family ${f} leaks across splits`);
});
