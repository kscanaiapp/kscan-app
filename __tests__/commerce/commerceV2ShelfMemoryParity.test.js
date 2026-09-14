/**
 * Server/client parity for the duplicated Commerce V2 contracts.
 *
 * `stylechat-generate` and the app are separate bundles, so the shelf-memory
 * bounds, the identity token shape and the fashion vocabularies are declared
 * twice — the same deliberate duplication `eliseCommerceIntentTypes.ts`
 * already documents. Duplication is only safe while something mechanical keeps
 * the copies in agreement, and this is that thing. A drift here is not a style
 * problem: a bound the server enforces and the client does not is a bound that
 * does not exist.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../..');
const clientMemory = require(path.join(ROOT, 'services/style-chat/commerceShelfMemory.ts'));
const serverIntent = require(path.join(ROOT, 'supabase/functions/stylechat-generate/eliseCommerceIntent.ts'));
const activation = require(path.join(ROOT, 'services/style-chat/commerceActivation.ts'));

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const wordList = (src, name) => {
  // Tolerates a TypeScript annotation between the name and the `=`.
  const match = src.match(new RegExp(`\\b${name}\\s*(?::[^=\\n]+)?=\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `${name} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
};

test('the shelf-memory bounds agree on both sides of the wire', () => {
  const server = serverIntent.ELISE_COMMERCE_INTENT_LIMITS;
  const client = clientMemory.SHELF_MEMORY_LIMITS;
  assert.equal(server.maxShelves, client.maxShelves, 'MAX_SHELVES_REMEMBERED');
  assert.equal(server.maxProductsPerShelf, client.maxProductsPerShelf, 'MAX_PRODUCTS_PER_SHELF');
  assert.equal(server.maxTotalProductReferences, client.maxTotalProductReferences, 'MAX_TOTAL_PRODUCT_REFERENCES');
  assert.equal(server.maxActiveExclusions, client.maxActiveExclusions, 'MAX_ACTIVE_PRODUCT_EXCLUSIONS');
});

test('a shelf can never hold more cards than the shelf renders', () => {
  assert.equal(
    clientMemory.SHELF_MEMORY_LIMITS.maxProductsPerShelf,
    activation.MAX_COMMERCE_CARDS,
    'remembering a seventh card nobody could see would make "the sixth one" ambiguous',
  );
});

test('the identity token shape is the same pattern on both sides', () => {
  const serverSrc = read('supabase/functions/stylechat-generate/eliseCommerceIntent.ts');
  const clientSrc = read('services/commerce/productIdentity.ts');
  const serverRe = serverSrc.match(/SHELF_IDENTITY_RE\s*=\s*(\/[^\n;]+\/)/);
  const clientRe = clientSrc.match(/SHELF_IDENTITY_RE\s*=\s*(\/[^\n;]+\/)/);
  assert.ok(serverRe && clientRe);
  assert.equal(serverRe[1], clientRe[1], 'one token shape, validated identically at both ends');
});

test('the memory operation enum is identical in all three places', () => {
  const ops = [...serverIntent.ELISE_SHELF_MEMORY_OPS].sort();
  assert.deepEqual(wordList(read('supabase/functions/stylechat-generate/actions.ts'), 'SHOPPING_MEMORY_OPS'), ops,
    'the action validator');
  assert.deepEqual(wordList(read('services/style-chat/commerceActivation.ts'), 'MEMORY_OPS'), ops,
    'the client wire validator');
});

test('the fashion vocabularies are identical in the validator and the reducer', () => {
  const actionsSrc = read('supabase/functions/stylechat-generate/actions.ts');
  const reducerSrc = read('supabase/functions/stylechat-generate/eliseCommerceIntent.ts');
  assert.deepEqual(wordList(actionsSrc, 'SHOPPING_MATERIALS'), wordList(reducerSrc, 'MATERIAL_TOKENS'), 'materials');
  assert.deepEqual(wordList(actionsSrc, 'SHOPPING_SILHOUETTES'), wordList(reducerSrc, 'SILHOUETTE_TOKENS'), 'silhouettes');
  assert.deepEqual(wordList(actionsSrc, 'SHOPPING_FORMALITY'), wordList(reducerSrc, 'FORMALITY_LADDER'), 'formality');
  assert.deepEqual(wordList(actionsSrc, 'SHOPPING_COLORS'), wordList(reducerSrc, 'COLOR_TOKENS'), 'colours');
});

test('every vocabulary the prompt advertises is one the validator accepts', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  const block = index.slice(index.indexOf('REFINING A SHOPPING REQUEST'), index.indexOf('REFERRING TO OPTIONS ALREADY SHOWN'));
  assert.ok(block.length > 0, 'the instruction block exists');
  const actionsSrc = read('supabase/functions/stylechat-generate/actions.ts');
  for (const [label, name] of [['material', 'SHOPPING_MATERIALS'], ['silhouette', 'SHOPPING_SILHOUETTES'], ['formality', 'SHOPPING_FORMALITY']]) {
    const advertised = block.match(new RegExp(`${label} \\(([^)]+)\\)`));
    assert.ok(advertised, `${label} is advertised to the model`);
    const promised = advertised[1].split(',').map((w) => w.trim()).sort();
    assert.deepEqual(promised, wordList(actionsSrc, name),
      `the model must not be told to propose a ${label} value that will be dropped`);
  }
});

test('the prompt never invites the model to describe a remembered product', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  const block = index.slice(index.indexOf('REFERRING TO OPTIONS ALREADY SHOWN'));
  const instructions = block.slice(0, block.indexOf('`', 10));
  assert.match(instructions, /You do NOT know which products were shown/);
  assert.match(instructions, /no titles, no prices, no brands, no retailers, no availability/);
  assert.match(instructions, /referenceOrdinal is a POSITION only/);
  // And there is no field through which one could arrive.
  const actionsSrc = read('supabase/functions/stylechat-generate/actions.ts');
  const shape = actionsSrc.slice(actionsSrc.indexOf('shopping?: {'), actionsSrc.indexOf('clearColor?: boolean;'));
  for (const forbidden of ['productUrl', 'productId', 'title', 'retailer', 'price', 'availability', 'identity']) {
    assert.equal(new RegExp(`\\b${forbidden}\\??:`).test(shape), false,
      `the model must have no \`${forbidden}\` field to write a product into`);
  }
});
