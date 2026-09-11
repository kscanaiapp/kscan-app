/**
 * Price/currency truth (spec sections 18-20), wired to the REAL production
 * formatter so the corpus's `expected.formatted` values are proven against
 * shipping code, not merely asserted against themselves.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createModuleLoader } = require('../../tools/commerce-corpus/lib/loadProductionModule');
const { loadCorpus } = require('../../tools/commerce-corpus/lib/loadCorpus');

const loadClient = createModuleLoader();
const { formatCommercePrice } = loadClient('services/dressingRoomCommerce.ts');

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

const { scenarios } = loadCorpus();
const priceCurrencyScenarios = scenarios.filter((s) => s.manifestEntry.category === 'price-currency');

test('every price-currency scenario in the corpus is wired to the real formatter', () => {
  assert.ok(priceCurrencyScenarios.length >= 10, 'expected the corpus to carry at least 10 price-currency scenarios');
});

for (const { manifestEntry, record } of priceCurrencyScenarios) {
  test(`price-currency: ${manifestEntry.scenarioId}`, () => {
    const inputs = asArray(record.input);
    const expecteds = asArray(record.expected);
    assert.equal(inputs.length, expecteds.length, 'input/expected array length mismatch');

    inputs.forEach((input, i) => {
      const actual = formatCommercePrice(input.price, input.currency);
      assert.equal(
        actual,
        expecteds[i].formatted,
        `${manifestEntry.scenarioId}[${i}]: formatCommercePrice(${JSON.stringify(input.price)}, ${JSON.stringify(input.currency)}) => ${JSON.stringify(actual)}, expected ${JSON.stringify(expecteds[i].formatted)}`,
      );
    });
  });
}

test('RP-110 doctrine: an unknown currency is never rendered with a literal "$" or the string "USD"', () => {
  const unknownCurrencyCase = priceCurrencyScenarios.find((s) => s.manifestEntry.scenarioId === 'price-missing-currency');
  assert.ok(unknownCurrencyCase, 'fixture missing');
  const actual = formatCommercePrice(unknownCurrencyCase.record.input.price, unknownCurrencyCase.record.input.currency);
  assert.ok(!String(actual).includes('$'));
  assert.ok(!/USD/i.test(String(actual)));
});

test('NEGATIVE CONTROL: the mut-currency-fabricated mutation is inconsistent with the real formatter', () => {
  const mutations = require('../../__tests__/fixtures/commerce/mutations/mutation-negative-controls.json');
  const mutation = mutations.records.find((r) => r.scenarioId === 'mut-currency-fabricated');
  assert.ok(mutation, 'mutation fixture missing');

  const original = priceCurrencyScenarios.find((s) => s.manifestEntry.scenarioId === mutation.mutationOf);
  const realOutput = formatCommercePrice(original.record.input.price, original.record.input.currency);

  // The mutation's mutatedValue claims the formatter would produce a
  // dollar-prefixed guess. The real formatter must disagree - proving this
  // mutation really would be caught, not just asserted to be wrong.
  assert.notEqual(realOutput, '$40.00', 'the real formatter must never produce the mutated (fabricated-currency) output');
  assert.equal(realOutput, original.record.expected.formatted);
});
