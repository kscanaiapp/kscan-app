/**
 * Structured shopping intent — provenance, precedence, and bounds (§5).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Edge-function modules are Deno TypeScript. They run fine under `node --test`
 * (type stripping), but a STATIC `require('../../supabase/functions/...')`
 * makes the root `tsc` follow the specifier into a tree its tsconfig
 * deliberately excludes, and the Deno globals there then fail the root
 * typecheck. Resolving through a computed path keeps the runtime behaviour
 * identical and the static graph honest — the same approach
 * `__tests__/multiItemCommerceV127Rollback.test.js` and the Curiosity Gap
 * suite already use.
 */
const ROOT = path.resolve(__dirname, '../..');
const edge = (name) => require(path.join(ROOT, 'supabase/functions/scan-identify', name));
const client = (name) => require(path.join(ROOT, 'services/commerce', name));


const {
  SHOPPING_INTENT_CONTRACT_VERSION,
  buildShoppingIntent,
  emptyShoppingIntent,
  extractExplicitContribution,
  hasUsableContext,
  intentMatchesActor,
  parseContextContributions,
} = edge('commerceShoppingIntent.ts');

test('an empty intent asserts nothing at all', () => {
  const intent = emptyShoppingIntent();
  assert.equal(intent.contractVersion, SHOPPING_INTENT_CONTRACT_VERSION);
  assert.equal(intent.category, undefined);
  assert.equal(intent.budgetCeiling, undefined);
  assert.deepEqual(intent.exclusions, []);
  assert.deepEqual(intent.relevantOwned, []);
  assert.equal(hasUsableContext(intent), false);
});

test('every field carries its own provenance', () => {
  const intent = buildShoppingIntent([
    { provenance: 'SCANNER', color: 'black', subtype: 'moto jacket' },
    { provenance: 'PACKING', occasion: 'travel' },
    { provenance: 'USER_EXPLICIT', color: 'red' },
  ]);
  assert.equal(intent.color.provenance, 'USER_EXPLICIT');
  assert.equal(intent.subtype.provenance, 'SCANNER');
  assert.equal(intent.occasion.provenance, 'PACKING');
});

test('UNKNOWN stays UNKNOWN — nothing is inferred from a neighbouring field', () => {
  const intent = buildShoppingIntent([{ provenance: 'USER_EXPLICIT', color: 'red' }]);
  assert.equal(intent.material, undefined);
  assert.equal(intent.formality, undefined);
  assert.equal(intent.occasion, undefined);
  assert.equal(intent.budgetCeiling, undefined);
  assert.equal(intent.matchIntent, undefined);
});

test('an explicit user constraint outranks everything inferred for the user', () => {
  const intent = buildShoppingIntent([
    { provenance: 'SIGNATURE_STYLE', color: 'beige' },
    { provenance: 'CLOSET', color: 'navy' },
    { provenance: 'SCANNER', color: 'black' },
    { provenance: 'USER_EXPLICIT', color: 'red' },
  ]);
  assert.equal(intent.color.value, 'red');
});

test('a LATER explicit instruction replaces an earlier explicit one', () => {
  const intent = buildShoppingIntent([
    { provenance: 'USER_EXPLICIT', color: 'red' },
    { provenance: 'USER_EXPLICIT', color: 'green' },
  ]);
  assert.equal(intent.color.value, 'green', 'people are allowed to change their minds');
});

test('an inferred signal never overwrites an explicit one, whatever the order', () => {
  const intent = buildShoppingIntent([
    { provenance: 'USER_EXPLICIT', color: 'red' },
    { provenance: 'SIGNATURE_STYLE', color: 'beige' },
  ]);
  assert.equal(intent.color.value, 'red');
});

test('a provider/commercial fact cannot be overridden by a user preference', () => {
  const intent = buildShoppingIntent([
    { provenance: 'COMMERCIAL_FACT', material: 'polyester' },
    { provenance: 'USER_EXPLICIT', material: 'cashmere' },
  ]);
  assert.equal(intent.material.value, 'polyester', 'wanting cashmere does not make it cashmere');
  assert.equal(intent.material.provenance, 'COMMERCIAL_FACT');
});

test('a budget ceiling is accepted only as an EXPLICIT statement with a stated currency', () => {
  assert.equal(
    buildShoppingIntent([{ provenance: 'PACKING', budgetCeiling: { amount: 100, currency: 'USD' } }]).budgetCeiling,
    undefined,
    'nothing may set a hard ceiling on the user’s behalf',
  );
  assert.equal(
    buildShoppingIntent([{ provenance: 'USER_EXPLICIT', budgetCeiling: { amount: 100, currency: null } }]).budgetCeiling,
    undefined,
    'a ceiling with no currency cannot be compared truthfully, so it is not a ceiling',
  );
  assert.equal(
    buildShoppingIntent([{ provenance: 'USER_EXPLICIT', budgetCeiling: { amount: -5, currency: 'USD' } }]).budgetCeiling,
    undefined,
  );
  const ok = buildShoppingIntent([{ provenance: 'USER_EXPLICIT', budgetCeiling: { amount: 100, currency: 'usd' } }]);
  assert.deepEqual(ok.budgetCeiling.value, { amount: 100, currency: 'USD' });
});

test('deterministic extraction reads budgets in several honest shapes', () => {
  const cases = [
    ['under $100', { amount: 100, currency: 'USD' }],
    ['no more than £80', { amount: 80, currency: 'GBP' }],
    ['up to €1,250.50', { amount: 1250.5, currency: 'EUR' }],
    ['less than 60 dollars', { amount: 60, currency: 'USD' }],
    ['max 45 eur', { amount: 45, currency: 'EUR' }],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(extractExplicitContribution(text).budgetCeiling, expected, text);
  }
});

test('a sentence with no budget in it yields no budget', () => {
  for (const text of ['find me a jacket', 'something around the usual', '', null, undefined, 42]) {
    assert.equal(extractExplicitContribution(text).budgetCeiling, undefined, String(text));
  }
});

test('exclusions are extracted only for tokens the vocabulary actually knows', () => {
  const c = extractExplicitContribution('not leather and no red, without unicorn');
  const tokens = c.exclusions.map((e) => `${e.axis}:${e.token}`);
  assert.ok(tokens.includes('material:leather'));
  assert.ok(tokens.includes('color:red'));
  assert.equal(tokens.some((t) => t.includes('unicorn')), false, 'an unrecognised word is not a guess');
});

test('an exclusion and an attribute are kept on separate axes', () => {
  const intent = buildShoppingIntent([extractExplicitContribution('in red instead, not leather')]);
  assert.equal(intent.color.value, 'red');
  assert.deepEqual(intent.exclusions, [{ axis: 'material', token: 'leather', provenance: 'USER_EXPLICIT' }]);
});

test('match intent distinguishes exact from substitute, and stays absent otherwise', () => {
  assert.equal(extractExplicitContribution('find this exact jacket').matchIntent, 'exact');
  assert.equal(extractExplicitContribution('something like this').matchIntent, 'substitute');
  assert.equal(extractExplicitContribution('a jacket please').matchIntent, undefined);
});

test('lists are bounded so a hostile or runaway context cannot grow unbounded', () => {
  const many = Array.from({ length: 50 }, (_, i) => `token${i}`);
  const intent = buildShoppingIntent([
    { provenance: 'USER_EXPLICIT', functionalRequirements: many },
    { provenance: 'SIGNATURE_STYLE', signatureStyleTokens: many },
    { provenance: 'CLOSET', relevantOwned: many.map((t) => ({ descriptor: t })) },
  ]);
  assert.ok(intent.functionalRequirements.length <= 6);
  assert.ok(intent.signatureStyleTokens.length <= 6);
  assert.ok(intent.relevantOwned.length <= 6);
});

test('an unrecognised provenance is dropped rather than ranked', () => {
  const intent = buildShoppingIntent([{ provenance: 'TOTALLY_MADE_UP', color: 'red' }]);
  assert.equal(intent.color, undefined);
});

test('intentMatchesActor is a check, not a stamp', () => {
  const bound = buildShoppingIntent([{ provenance: 'CLOSET', actorId: 'a', relevantOwned: [{ descriptor: 'boot' }] }], 'a');
  assert.equal(intentMatchesActor(bound, 'a'), true);
  assert.equal(intentMatchesActor(bound, 'b'), false);
  assert.equal(intentMatchesActor(bound, null), false);
  assert.equal(intentMatchesActor(null, 'a'), false);
});

test('client input cannot claim COMMERCIAL_FACT precedence', () => {
  const parsed = parseContextContributions([
    { provenance: 'COMMERCIAL_FACT', material: 'cashmere', color: 'red' },
  ]);
  assert.deepEqual(parsed, [], 'only a provider response reaches that rank');
});

test('client input is rebuilt field by field, never spread', () => {
  const parsed = parseContextContributions([
    { provenance: 'CLOSET', color: 'red', __proto__: { polluted: true }, unknownKey: 'x', constructor: 'y' },
  ]);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['color', 'provenance']);
});

test('client input is bounded in count and length', () => {
  const parsed = parseContextContributions(
    Array.from({ length: 40 }, () => ({ provenance: 'CLOSET', color: 'r'.repeat(500) })),
  );
  assert.ok(parsed.length <= 8);
  assert.ok(parsed[0].color.length <= 60);
});

test('a non-array or junk payload yields no contributions', () => {
  for (const junk of [null, undefined, 'x', 42, {}, [null, 'x', 7]]) {
    assert.deepEqual(parseContextContributions(junk), []);
  }
});
