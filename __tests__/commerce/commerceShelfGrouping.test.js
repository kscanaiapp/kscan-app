/**
 * BEST MATCHES / OTHER OPTIONS (continuation brief §17).
 *
 * When someone says "only black" and a brown boot is still on the shelf, the
 * shelf has to say why it is there. Showing it silently alongside the black
 * ones presents it as though it answered the request, which it did not.
 *
 * The split is PRESENTATION. It reads the rationale facts #409 already produced
 * during ranking and partitions the list; it never re-ranks, never compares a
 * colour itself, and never changes relative order inside a group.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'components/style-chat/CommerceProductsBlock.tsx'),
  'utf8',
);
const { matchedRequestedAttribute } = require(
  path.join(ROOT, 'services/commerce/commerceRationale.ts'),
);
const RATIONALE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'services/commerce/commerceRationale.ts'),
  'utf8',
);

const withFacts = (id, factCodes) => ({ id, commerceRationale: { factCodes } });

// ── The partition reads an existing decision ───────────────────────────────

test('a candidate is a best match only when the ranker said so', () => {
  assert.equal(matchedRequestedAttribute(withFacts('a', ['explicit_color_match'])), true);
  assert.equal(matchedRequestedAttribute(withFacts('b', ['budget_within'])), false);
  assert.equal(matchedRequestedAttribute(withFacts('c', [])), false);
});

test('a product with no rationale is never presented as a match', () => {
  // Zero-context products carry no rationale at all. Absent evidence must read
  // as "not a stated match", never as one.
  for (const product of [{ id: 'x' }, { id: 'y', commerceRationale: {} }, { id: 'z', commerceRationale: { factCodes: 'nope' } }]) {
    assert.equal(matchedRequestedAttribute(product), false);
  }
});

test('the partition never inspects a title or a colour itself', () => {
  const fn = RATIONALE_SOURCE.slice(RATIONALE_SOURCE.indexOf('export function matchedRequestedAttribute'));
  assert.doesNotMatch(fn, /title|toLowerCase|includes\(requestedColor|color\b/i);
  assert.match(fn, /explicit_color_match/, 'it reads the ranker fact and nothing else');
});

// ── When the split applies ─────────────────────────────────────────────────

test('only a STRONG request splits the shelf', () => {
  assert.match(
    SOURCE,
    /colorStrength === 'STRONG_EXPLICIT_PREFERENCE' &&/,
    'an ordinary preference renders one shelf',
  );
  assert.match(SOURCE, /if \(!shouldGroup\) \{/);
  assert.match(SOURCE, /label="OPTIONS"/, 'the unsplit shelf keeps its existing label');
});

test('both groups render, and only through ProductShelf', () => {
  assert.match(SOURCE, /label="BEST MATCHES"/);
  assert.match(SOURCE, /label="OTHER OPTIONS"/);
  // Four renders, one per branch: the unsplit shelf, the alternatives-only
  // shelf when nothing matched the colour, and BEST MATCHES + OTHER OPTIONS.
  const shelves = SOURCE.match(/<ProductShelf/g) ?? [];
  assert.equal(shelves.length, 4);
  // No second card system: the component imports nothing else that renders a product.
  assert.doesNotMatch(SOURCE, /ProductCard|CommerceCard|renderProduct/);
});

test('alternatives are ranked down, never dropped', () => {
  assert.match(
    SOURCE,
    /const other = verified\.filter\(\(product\) => !matchedRequestedAttribute\(product\)\)/,
    'every non-matching candidate goes into OTHER OPTIONS',
  );
  assert.doesNotMatch(SOURCE, /\.slice\(0,|\.sort\(/, 'nothing is truncated or reordered here');
});

test('no matching candidate is an explained state, not a no-results state', () => {
  assert.match(SOURCE, /if \(best\.length === 0\) \{/);
  assert.match(SOURCE, /noPreferredMatchCopy\(requestedColor\)/);
  assert.match(
    SOURCE,
    /I couldn't find a strong \$\{color\} match right now, but these are the closest alternatives/,
  );
  // And it still shows the alternatives rather than an empty state.
  const branch = SOURCE.slice(SOURCE.indexOf('if (best.length === 0)'), SOURCE.indexOf('return (\n    <View testID={testID}>\n      <ProductShelf\n        products={best}'));
  assert.match(branch, /label="OTHER OPTIONS"/);
});

test('the three non-result states stay distinct', () => {
  // A provider failure is not "nothing matched", and neither is "nothing in
  // the colour you asked for".
  assert.match(SOURCE, /const NO_MATCHES_COPY = /);
  assert.match(SOURCE, /const ERROR_COPY = /);
  assert.match(SOURCE, /const noPreferredMatchCopy = /);
  assert.notEqual(
    SOURCE.match(/const NO_MATCHES_COPY = (.*);/)[1],
    SOURCE.match(/const ERROR_COPY = (.*);/)[1],
  );
});

test('a card still cannot render without Commerce provenance', () => {
  // The grouping must not have introduced a path around the render-time check.
  assert.match(SOURCE, /\.filter\(hasCommerceProvenance\)/);
  const afterFilter = SOURCE.slice(SOURCE.indexOf('filter(hasCommerceProvenance)'));
  const shelves = afterFilter.match(/products=\{([a-zA-Z]+)\}/g) ?? [];
  for (const binding of shelves) {
    assert.match(
      binding,
      /products=\{(verified|best|other)\}/,
      'every shelf renders from the verified list or a partition of it',
    );
  }
});

// ── The block carries what presentation needs ──────────────────────────────

test('the strength is echoed on the block so the shelf can explain itself', () => {
  const activation = fs.readFileSync(
    path.join(ROOT, 'services/style-chat/commerceActivation.ts'),
    'utf8',
  );
  // Commerce V2 lifted this expression into `buildIntentSummary(state)` so the
  // memory-selected and provider-selected shelves cannot disagree about the
  // summary they echo. The RULE is unchanged and is asserted twice: once
  // against the source, and once against the built block below.
  assert.match(
    activation,
    /colorStrength: state\?\.color \? \(state\.colorStrength \?\? 'EXPLICIT_PREFERENCE'\) : null/,
    'no colour means no strength',
  );
  const activationModule = require(path.join(ROOT, 'services/style-chat/commerceActivation.ts'));
  const noColour = activationModule.buildCommerceProductsBlock({
    result: null,
    state: { category: 'footwear', color: null, colorStrength: 'STRONG_EXPLICIT_PREFERENCE', budget: null, exclusions: [], functionalRequirements: [] },
  });
  assert.equal(noColour.intentSummary.colorStrength, null, 'a strength without a colour is not a strength');
  const bubble = fs.readFileSync(
    path.join(ROOT, 'components/style-chat/StyleChatBubble.tsx'),
    'utf8',
  );
  assert.match(bubble, /requestedColor=\{commerceBlock\.intentSummary\?\.color \?\? null\}/);
  assert.match(bubble, /colorStrength=\{commerceBlock\.intentSummary\?\.colorStrength \?\? null\}/);
});

test('a block persisted by an older build still renders as one shelf', () => {
  const bubble = fs.readFileSync(
    path.join(ROOT, 'components/style-chat/StyleChatBubble.tsx'),
    'utf8',
  );
  // Optional chaining plus a null default: an absent intentSummary is the
  // pre-activation shape and must not throw or split.
  assert.match(bubble, /intentSummary\?: \{/);
  assert.equal(matchedRequestedAttribute({ id: 'legacy' }), false);
});
