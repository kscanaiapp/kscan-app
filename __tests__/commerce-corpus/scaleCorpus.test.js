/**
 * Scale corpus determinism + order preservation (spec sections 36-38).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildFixtureFile, serializeFixtureFile, SIZES, SEED } = require('../../tools/commerce-corpus/generateScaleCorpus');
const { loadCorpus } = require('../../tools/commerce-corpus/lib/loadCorpus');

const SCALE_DIR = path.resolve(__dirname, '../fixtures/commerce/scale');

for (const size of SIZES) {
  test(`scale-${size}: regenerating from the fixed seed reproduces the committed fixture byte-for-byte`, () => {
    const committedPath = path.join(SCALE_DIR, `scale-${size}.json`);
    const committed = fs.readFileSync(committedPath, 'utf8');
    const regenerated = serializeFixtureFile(buildFixtureFile(size));
    assert.equal(regenerated, committed, `scale-${size}.json is not reproducible from generateScaleCorpus.js under seed '${SEED}:${size}' - regenerate and commit it`);
  });

  test(`scale-${size}: source order is preserved via sourceIndex, and a realistic mix of every required dimension is present`, () => {
    const fixture = buildFixtureFile(size);
    const offers = fixture.records[0].input.offers;
    assert.equal(offers.length, size);
    offers.forEach((offer, i) => assert.equal(offer.sourceIndex, i, `offer at position ${i} has sourceIndex ${offer.sourceIndex}`));

    const composition = fixture.records[0].expected.composition;
    assert.ok(composition.knownRetailer > 0 && composition.unknownRetailer > 0, 'expected both known and unknown retailers');
    assert.ok(composition.retail > 0 && composition.resale > 0, 'expected both Retail and Resale');
    assert.ok(composition.watchable > 0 && composition.notWatchable > 0, 'expected both watchable and not-watchable');
    assert.ok(composition.knownCurrency > 0 && composition.unknownCurrency > 0, 'expected both known and unknown currency');
    assert.ok(composition.logoAuthority > 0 && composition.noLogoAuthority > 0, 'expected both logo authority and no logo authority');
  });
}

test('no unseeded Math.random() drives scale generation: two in-memory builds of the same size are identical', () => {
  const a = buildFixtureFile(25);
  const b = buildFixtureFile(25);
  assert.deepEqual(a, b);
});

test('Where-to-Buy order-preservation scenario matches its own stated input order', () => {
  const { scenarios } = loadCorpus();
  const scenario = scenarios.find((s) => s.manifestEntry.scenarioId === 'wtb-multiple-retailers-order-preserved');
  const actualOrder = scenario.record.input.offers.map((o) => o.retailer);
  assert.deepEqual(actualOrder, scenario.record.expected.expectedOrder);
  assert.equal(scenario.record.expected.orderPreserved, true);
});
