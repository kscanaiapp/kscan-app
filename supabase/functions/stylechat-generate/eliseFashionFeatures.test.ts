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
