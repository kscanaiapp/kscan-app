/**
 * Build 34 Scanner audit — SCAN-006.
 *
 * `isWeakQuery` stops a commerce request before ANY provider call, and the
 * client renders that outcome as "No strong shopping match found." So every
 * query it rejects is a garment the user is told has no match, for a search
 * that never ran.
 *
 * The two-meaningful-word branch decided this with a seven-token allowlist
 * (polo / blazer / handbag / sneakers / coat / dress / trench). Every other
 * category — hoodie, jeans, t-shirt, bag, boots, skirt, scarf, sunglasses —
 * was rejected. Measured live on App Staging over the repo's own QA fixtures:
 * 6 of 13 detected garments (46%) returned `errorType: 'weak_query'` with
 * `providersTried: []`.
 *
 * The bar is widened to the project's own taxonomy (`normalizeCategory`),
 * not to "anything goes": an all-generic query is still weak, and a query
 * that names no garment at all is still weak.
 */
import assert from 'node:assert/strict';
import { isWeakQuery } from './scanCommerceRouter.ts';

/** Real two-term queries the detection path produces for a detected garment. */
const RETRIEVABLE_TWO_TERM = [
  'white hoodie',
  'blue jeans',
  'white t-shirt',
  'blue crossbody bag',
  'black boots',
  'denim skirt',
  'gold sunglasses',
  'red scarf',
  'black beanie',
  'brown loafers',
  'navy cardigan',
  'grey sweatpants',
  'black tote',
  'white sneakers',
  'camel coat',
];

for (const query of RETRIEVABLE_TWO_TERM) {
  Deno.test(`"${query}" is a retrievable commerce query, not a weak one`, () => {
    assert.equal(
      isWeakQuery(query),
      false,
      `"${query}" names a garment and a colour — rejecting it means the user is told ` +
        '"No strong shopping match found." for a search that never ran',
    );
  });
}

/** Regressions: the gate must still reject what it was built to reject. */
const STILL_WEAK = [
  ['', 'an empty query'],
  ['ab', 'a query under three characters'],
  ['thing', 'a single generic noun (pinned by commerceFunnel.v127.test.ts)'],
  ['stylish outfit', 'an all-generic phrase naming no garment'],
  ['cute nice lovely', 'pure adjectives'],
  ['beautiful gorgeous', 'pure adjectives'],
  ['black navy', 'two colours and no garment'],
  ['fashion item', 'placeholder nouns only'],
];

for (const [query, why] of STILL_WEAK) {
  Deno.test(`weak: ${why} ("${query}")`, () => {
    assert.equal(isWeakQuery(query), true, `${why} must still be rejected before any provider call`);
  });
}

Deno.test('three or more meaningful words were never gated and still are not', () => {
  for (const q of [
    'black turtleneck sweater',
    'red low-top sneakers',
    'blue denim mini skirt',
    'black leather jacket fitted',
  ]) {
    assert.equal(isWeakQuery(q), false, `"${q}" must reach a provider`);
  }
});

Deno.test('the seven-token allowlist cases keep working', () => {
  for (const q of ['navy blazer', 'white polo', 'black handbag', 'beige trench', 'white sneakers']) {
    assert.equal(isWeakQuery(q), false, `"${q}" was accepted before and must stay accepted`);
  }
});

Deno.test('a colour alone is still weak — widening the vocabulary is not removing the gate', () => {
  assert.equal(isWeakQuery('black'), true);
  assert.equal(isWeakQuery('white'), true);
});
