/**
 * DEF-CON-002 — LAYERING_BY_CATEGORY / inferLayeringRole taxonomy coverage.
 * Narrow proof that the repaired mapping table resolves the previously-missing
 * garment categories to the EXISTING role vocabulary, without changing the
 * function's contract (same signature, same return type, unknown stays null).
 */
import assert from 'node:assert/strict';

import { inferLayeringRole } from './eliseFashionFeatures.ts';

// Footwear
Deno.test('DEF-CON-002: loafers resolve to shoe (the flagship regression)', () => {
  assert.equal(inferLayeringRole('loafers', null), 'shoe');
  assert.equal(inferLayeringRole('brown loafers', null), 'shoe');
});
Deno.test('DEF-CON-002: existing and new footwear resolve to shoe', () => {
  assert.equal(inferLayeringRole('sneakers', null), 'shoe');
  assert.equal(inferLayeringRole('boots', null), 'shoe');
  assert.equal(inferLayeringRole('sandals', null), 'shoe');
  assert.equal(inferLayeringRole('oxfords', null), 'shoe');
  assert.equal(inferLayeringRole('brogues', null), 'shoe');
});

// Tops (base / mid layers)
Deno.test('DEF-CON-002: tops resolve to base or mid, unchanged', () => {
  assert.equal(inferLayeringRole('t-shirt', null), 'base');
  assert.equal(inferLayeringRole('shirt', null), 'base');
  assert.equal(inferLayeringRole('sweater', null), 'mid');
  assert.equal(inferLayeringRole('cardigan', null), 'mid');
});

// Bottoms
Deno.test('DEF-CON-002: bottoms resolve to bottom, unchanged', () => {
  assert.equal(inferLayeringRole('jeans', null), 'bottom');
  assert.equal(inferLayeringRole('trousers', null), 'bottom');
  assert.equal(inferLayeringRole('shorts', null), 'bottom');
  assert.equal(inferLayeringRole('skirt', null), 'bottom');
});

// Outerwear
Deno.test('DEF-CON-002: outerwear resolves to outer, unchanged', () => {
  assert.equal(inferLayeringRole('jacket', null), 'outer');
  assert.equal(inferLayeringRole('blazer', null), 'outer');
  assert.equal(inferLayeringRole('coat', null), 'outer');
});

// One-piece
Deno.test('DEF-CON-002: dress resolves to the existing one_piece role', () => {
  assert.equal(inferLayeringRole('dress', null), 'one_piece');
});

// Accessories
Deno.test('DEF-CON-002: accessories resolve to accessory, including new tokens', () => {
  assert.equal(inferLayeringRole('bag', null), 'accessory');
  assert.equal(inferLayeringRole('watch', null), 'accessory');
  assert.equal(inferLayeringRole('sunglasses', null), 'accessory');
});

// Negative control — the repair must not force arbitrary strings into a role.
Deno.test('DEF-CON-002: unrecognized categories remain null, not guessed', () => {
  assert.equal(inferLayeringRole('gadget', null), null);
  assert.equal(inferLayeringRole(null, null), null);
  assert.equal(inferLayeringRole('spaceship', 'orbital'), null);
});

// Contract: subcategory fallback still works, matching the pre-repair behavior.
Deno.test('DEF-CON-002: category/subcategory fallback contract is unchanged', () => {
  assert.equal(inferLayeringRole(null, 'loafers'), 'shoe');
  assert.equal(inferLayeringRole('unknown-thing', 'jeans'), 'bottom');
});

// Cross-category collision guard. The table is matched by substring in
// insertion order, so a newly-added token can out-rank the true head noun of a
// two-word category and produce a CONFIDENTLY WRONG role. That is strictly
// worse than null: a null role disables the section 29 guardrails, but a wrong
// one arms them with a false fact. `derby hat` is the case that actually
// regressed while this repair was being written -- the pre-repair table got it
// right via `hat`, and a bare `derby: 'shoe'` token broke it.
Deno.test('DEF-CON-002: an added footwear token never out-ranks the true head noun', () => {
  assert.equal(inferLayeringRole('derby hat', null), 'accessory');
  assert.equal(inferLayeringRole('bowler hat', null), 'accessory');
  assert.equal(inferLayeringRole('oxford shirt', null), 'base');
  assert.equal(inferLayeringRole('polo coat', null), 'outer');
  assert.equal(inferLayeringRole('tank top', null), 'base');
  assert.equal(inferLayeringRole('bootcut jeans', null), 'bottom');
  assert.equal(inferLayeringRole('capris', null), null);
});

// The repair must not silently reclassify garments the old table already
// answered. `sweatshirt` is the one deliberate exception: it previously
// resolved to 'base' only by an accidental substring hit on `shirt`, and a
// sweatshirt is a mid layer.
Deno.test('DEF-CON-002: pre-existing classifications are unchanged, except sweatshirt', () => {
  assert.equal(inferLayeringRole('sweatshirt', null), 'mid');
  for (const [token, role] of [
    ['coat', 'outer'], ['jacket', 'outer'], ['blazer', 'outer'],
    ['sweater', 'mid'], ['hoodie', 'mid'], ['cardigan', 'mid'],
    ['shirt', 'base'], ['blouse', 'base'], ['top', 'base'], ['tee', 'base'], ['tshirt', 'base'],
    ['dress', 'one_piece'], ['jumpsuit', 'one_piece'],
    ['pants', 'bottom'], ['trousers', 'bottom'], ['jeans', 'bottom'], ['skirt', 'bottom'], ['shorts', 'bottom'],
    ['shoes', 'shoe'], ['sneakers', 'shoe'], ['boots', 'shoe'], ['heels', 'shoe'],
    ['bag', 'accessory'], ['belt', 'accessory'], ['hat', 'accessory'], ['scarf', 'accessory'],
  ] as Array<[string, string]>) {
    assert.equal(inferLayeringRole(token, null), role, `${token} must still resolve to ${role}`);
  }
});
