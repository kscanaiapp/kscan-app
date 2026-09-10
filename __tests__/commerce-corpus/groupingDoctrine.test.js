/**
 * Safe grouping / must-not-group doctrine (spec sections 27-28), wired to
 * REAL production functions wherever a real mechanism exists.
 *
 * Two real mechanisms exist and are both exercised here:
 *   1. normalizePurchaseOptions()'s exact-fingerprint dedup (services/
 *      dressingRoomCommerce.ts) - the one SAFE, shipped grouping mechanism.
 *   2. canonicalProductKey() (supabase/functions/scan-identify/
 *      canonicalCommerce.ts) - the one mechanism that attempts CROSS-RETAILER
 *      grouping. It is dormant/unconsumed by any client (Finding F2), but it
 *      is real, callable code, and this suite calls it directly on the
 *      corpus's must-not-group fixtures to PROVE, empirically, that it would
 *      incorrectly merge them - not just assert that it would from reading
 *      the source.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createModuleLoader } = require('../../tools/commerce-corpus/lib/loadProductionModule');
const { loadCorpus } = require('../../tools/commerce-corpus/lib/loadCorpus');

const loadClient = createModuleLoader();
const { normalizePurchaseOptions } = loadClient('services/dressingRoomCommerce.ts');
const { canonicalProductKey } = loadClient('supabase/functions/scan-identify/canonicalCommerce.ts');

const { scenarios } = loadCorpus();
const safeGroupingScenarios = scenarios.filter((s) => s.manifestEntry.category === 'safe-grouping');
const mustNotGroupScenarios = scenarios.filter((s) => s.manifestEntry.category === 'must-not-group');

test('safe-grouping: real exact-fingerprint dedup collapses two identical listings into one', () => {
  const scenario = safeGroupingScenarios.find((s) => s.manifestEntry.scenarioId === 'group-safe-same-url-exact-dedup');
  assert.ok(scenario, 'fixture missing');
  const result = normalizePurchaseOptions(scenario.record.input.rawEntries);
  assert.equal(result.length, scenario.record.expected.outputOptionCount);
});

test('safe-grouping: two DIFFERENT listings (different URL/price/size) are never collapsed', () => {
  const distinctRaw = [
    { retailer: 'Farfetch', productUrl: 'https://www.farfetch.com/shopping/item/1.aspx', price: '340', size: 'M' },
    { retailer: 'SSENSE', productUrl: 'https://www.ssense.com/en-us/product/2', price: '355', size: 'M' },
  ];
  const result = normalizePurchaseOptions(distinctRaw);
  assert.equal(result.length, 2, 'distinct offers must never collapse into one');
});

test('FINDING F2, empirically proven: the real (dormant) canonicalProductKey merges every must-not-group pair that shares brand + similar title', () => {
  const scenario = mustNotGroupScenarios.find((s) => s.manifestEntry.scenarioId === 'mng-same-brand-similar-title');
  assert.ok(scenario, 'fixture missing');
  const [offerA, offerB] = scenario.record.input.offers;

  const keyA = canonicalProductKey({ id: 'a', source: offerA.retailer, title: offerA.title, brand: offerA.brand });
  const keyB = canonicalProductKey({ id: 'b', source: offerB.retailer, title: offerB.title, brand: offerB.brand });

  // This assertion is the empirical proof behind docs/commerce-corpus/
  // 01-commerce-shape-census.md Finding F2: the real production function, run
  // on this corpus's own must-not-group fixture, produces the SAME key for
  // two offers the corpus's doctrine says must stay separate. This is not a
  // corpus bug - it is the exact gap the corpus exists to surface, and it is
  // why EXACT_GROUPING_READINESS is NOT_YET rather than SUPPORTED.
  assert.equal(
    keyA,
    keyB,
    'expected canonicalProductKey to (incorrectly, per this corpus doctrine) merge these two offers - if this now fails, canonicalProductKey has changed and Finding F2 / the grouping readiness verdict need to be re-reviewed, not this test loosened',
  );
});

test('must-not-group doctrine: every must-not-group scenario expects mustGroup: false', () => {
  for (const { manifestEntry, record } of mustNotGroupScenarios) {
    assert.equal(record.expected.mustGroup, false, `${manifestEntry.scenarioId} must encode mustGroup: false`);
  }
});

test('NEGATIVE CONTROL: mut-fuzzy-grouping-introduced must disagree with the doctrine (mustGroup can never legitimately flip to true from title similarity alone)', () => {
  const mutations = require('../../__tests__/fixtures/commerce/mutations/mutation-negative-controls.json');
  const mutation = mutations.records.find((r) => r.scenarioId === 'mut-fuzzy-grouping-introduced');
  const original = mustNotGroupScenarios.find((s) => s.manifestEntry.scenarioId === mutation.mutationOf);

  assert.equal(original.record.expected.mustGroup, false);
  assert.equal(mutation.mutatedValue, true);
  assert.notEqual(original.record.expected.mustGroup, mutation.mutatedValue);
});

test('safe-grouping hypothetical exact-cross-retailer-id scenario is explicitly labeled SYNTHETIC (no real field exists)', () => {
  const scenario = safeGroupingScenarios.find((s) => s.manifestEntry.scenarioId === 'group-safe-hypothetical-cross-retailer-exact-id');
  assert.equal(scenario.manifestEntry.evidenceClass, 'SYNTHETIC');
  assert.ok(/hypothetical/i.test(scenario.record.notes || ''));
});
