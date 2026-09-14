/**
 * Shelf memory: the contract, the bounds, and the boundaries (Commerce V2
 * §16-§22, §28-§31, §44).
 *
 * Unit-level and deliberately hostile. The journey suite proves the feature
 * works; this proves it cannot be made to do something it must not.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../..');
const m = require(path.join(ROOT, 'services/style-chat/commerceShelfMemory.ts'));
const identity = require(path.join(ROOT, 'services/commerce/productIdentity.ts'));
const intent = require(path.join(ROOT, 'supabase/functions/stylechat-generate/eliseCommerceIntent.ts'));

const offer = (n, o = {}) => ({
  productUrl: o.productUrl ?? `https://www.retailer.com/p/${n}`,
  title: o.title ?? `Offer ${n}`,
  type: 'retail',
  price: '$100.00',
  currency: 'USD',
  ...o,
});
const idOf = (p) => identity.productShelfIdentity(p);

// ── §7 / §8: identity ──────────────────────────────────────────────────────

test('identity is stable across the decorations a second retrieval adds', () => {
  const bare = offer(1, { productUrl: 'https://www.shop.com/item/42' });
  for (const decorated of [
    'https://www.shop.com/item/42?utm_source=newsletter&utm_campaign=spring',
    'https://www.shop.com/item/42/',
    'https://WWW.SHOP.COM/item/42#reviews',
    'https://www.shop.com/item/42?gclid=abc&fbclid=def',
  ]) {
    assert.equal(idOf(offer(1, { productUrl: decorated })), idOf(bare), decorated);
  }
  assert.notEqual(idOf(offer(2, { productUrl: 'https://www.shop.com/item/43' })), idOf(bare));
});

test('identity mirrors the server dedup contract exactly', () => {
  const server = require(path.join(ROOT, 'supabase/functions/scan-identify/qualityTuneCommerce.ts'));
  for (const url of [
    'https://www.shop.com/item/42?utm_source=x&ref=y',
    'https://www.shop.com/item/42/',
    'https://www.shop.com/a/b?size=10&utm_medium=cpc',
    'https://sub.domain.co.uk/p?a=1&b=2',
  ]) {
    assert.equal(
      identity.canonicalCommerceUrl(url),
      server.canonicalizeUrlForIdentity(url),
      `client and server must canonicalize ${url} identically`,
    );
  }
});

test('an offer with no usable destination has no identity, and cannot be remembered', () => {
  assert.equal(idOf({ productUrl: '' }), null);
  assert.equal(idOf({}), null);
  assert.equal(idOf(null), null);
  assert.deepEqual(identity.shelfIdentities([{ productUrl: '' }, offer(1)]), [idOf(offer(1))]);
});

// ── §9: offer collapse, and the limit stated honestly ──────────────────────

test('duplicate OFFERS collapse; similar PRODUCTS at two retailers do not', () => {
  const a = offer(1, { productUrl: 'https://shop.com/loafer/7' });
  const sameOffer = offer(1, { productUrl: 'https://shop.com/loafer/7?utm_source=x' });
  const otherRetailer = offer(1, { productUrl: 'https://other.com/loafer/7', title: 'Offer 1' });

  const collapsed = identity.collapseDuplicateOffers([a, sameOffer, otherRetailer]);
  assert.equal(collapsed.length, 2, 'the same listing twice collapses to one');
  assert.equal(collapsed[1].productUrl, 'https://other.com/loafer/7',
    'an identical title at a different retailer is a DIFFERENT offer and survives — ' +
    'K Scan cannot prove two listings are the same physical product');
});

// ── §16 / §20: the contract and its bounds ─────────────────────────────────

test('restore rebuilds field by field and drops anything that is not an identity', () => {
  const restored = m.parseShelfMemory({
    actorId: 'a'.repeat(200),
    shelves: [
      { turn: 1, items: ['not-an-identity', 'u:0123456789abcdef', 42, null, 'u:0123456789abcdef'] },
      'not-a-shelf',
      { turn: 'x', items: ['u:fedcba9876543210'] },
    ],
    rejected: ['u:1111111111111111', '<script>', { evil: true }],
    extraneous: 'dropped',
  });
  assert.deepEqual(restored.shelves[0].items, ['u:0123456789abcdef'], 'junk dropped, duplicates collapsed');
  assert.equal(restored.shelves[0].turn, 1);
  assert.equal(restored.shelves[1].turn, 0, 'a non-numeric turn degrades, it does not throw');
  assert.deepEqual(restored.rejected, ['u:1111111111111111']);
  assert.equal(restored.actorId.length, 80, 'bounded');
  assert.equal(restored.extraneous, undefined, 'unknown keys never pass through');
});

test('every bound holds against oversized persisted state', () => {
  const big = (n, prefix) => Array.from({ length: n }, (_, i) => `u:${prefix}${String(i).padStart(10, '0')}`);
  const restored = m.parseShelfMemory({
    shelves: Array.from({ length: 12 }, (_, s) => ({ turn: s, items: big(20, `${s}aaaaa`) })),
    rejected: big(100, 'bbbbbb'),
  });
  assert.ok(restored.shelves.length <= m.SHELF_MEMORY_LIMITS.maxShelves);
  const total = restored.shelves.reduce((n, s) => n + s.items.length, 0);
  assert.ok(total <= m.SHELF_MEMORY_LIMITS.maxTotalProductReferences, `total refs ${total}`);
  for (const shelf of restored.shelves) {
    assert.ok(shelf.items.length <= m.SHELF_MEMORY_LIMITS.maxProductsPerShelf);
  }
  assert.ok(restored.rejected.length <= m.SHELF_MEMORY_LIMITS.maxActiveExclusions);
});

test('recording shelves drops the oldest and MARKS that it did', () => {
  let memory = m.emptyShelfMemory();
  for (let turn = 1; turn <= 5; turn += 1) {
    memory = m.recordShelf(memory, {
      turn,
      products: [offer(`t${turn}a`), offer(`t${turn}b`)],
      actorId: 'actor-1',
    });
  }
  assert.equal(memory.shelves.length, m.SHELF_MEMORY_LIMITS.maxShelves);
  assert.equal(memory.shelves[0].turn, 5, 'newest first');
  assert.equal(memory.truncated, true, 'and the loss is recorded, not hidden');
});

test('exceeding the rejection bound drops the OLDEST and reports it', () => {
  let memory = m.emptyShelfMemory();
  memory.rejected = Array.from({ length: m.SHELF_MEMORY_LIMITS.maxActiveExclusions }, (_, i) => `u:${String(i).padStart(16, '0')}`);
  memory = m.recordShelf(memory, { turn: 1, products: [offer('new1'), offer('new2')], actorId: null });
  const result = m.rejectLatestShelf(memory);
  assert.equal(result.memory.rejected.length, m.SHELF_MEMORY_LIMITS.maxActiveExclusions, 'bounded');
  assert.equal(result.dropped, 2, 'and the caller is told, so the customer can be');
  assert.ok(result.memory.rejected.includes(idOf(offer('new1'))), 'the newest instruction survives');
  assert.equal(result.memory.rejected.includes('u:0000000000000000'), false, 'the oldest gives way');
});

// ── §28: reference resolution ──────────────────────────────────────────────

test('a backward reference after truncation fails honestly instead of guessing', () => {
  let memory = m.emptyShelfMemory();
  const first = offer('the-real-first');
  memory = m.recordShelf(memory, { turn: 1, products: [first], actorId: null });
  for (let turn = 2; turn <= 5; turn += 1) {
    memory = m.recordShelf(memory, { turn, products: [offer(`t${turn}`)], actorId: null });
  }
  const outcome = m.resolveShelfReference({
    memory, ordinal: 1, scope: 'earliest', verifiedProducts: [first], actorId: null,
  });
  assert.equal(outcome.reason, 'expired', 'the first shelf is gone; the oldest held one must not impersonate it');
  assert.equal(outcome.product, null);
});

test('"latest" and "earliest" resolve to different products', () => {
  let memory = m.emptyShelfMemory();
  const a = offer('shelf-a-1');
  const b = offer('shelf-b-1');
  memory = m.recordShelf(memory, { turn: 1, products: [a], actorId: null });
  memory = m.recordShelf(memory, { turn: 2, products: [b], actorId: null });
  const verified = [a, b];
  assert.equal(m.resolveShelfReference({ memory, ordinal: 1, scope: 'latest', verifiedProducts: verified, actorId: null }).product, b);
  assert.equal(m.resolveShelfReference({ memory, ordinal: 1, scope: 'earliest', verifiedProducts: verified, actorId: null }).product, a);
});

test('an ordinal outside the shelf is refused rather than clamped', () => {
  const memory = m.recordShelf(m.emptyShelfMemory(), { turn: 1, products: [offer(1), offer(2)], actorId: null });
  for (const ordinal of [0, -1, 3, 99, NaN]) {
    const outcome = m.resolveShelfReference({ memory, ordinal, verifiedProducts: [offer(1), offer(2)], actorId: null });
    assert.equal(outcome.product, null, `ordinal ${ordinal}`);
    assert.notEqual(outcome.reason, 'resolved');
  }
});

test('a product without Commerce provenance can never resolve a reference', () => {
  const fabricated = { productUrl: 'https://shop.com/p/1', title: '' };
  const memory = m.recordShelf(m.emptyShelfMemory(), { turn: 1, products: [offer(1, { productUrl: 'https://shop.com/p/1' })], actorId: null });
  const outcome = m.resolveShelfReference({ memory, ordinal: 1, verifiedProducts: [fabricated], actorId: null });
  assert.equal(outcome.reason, 'expired', 'a title-less row is not evidence a real listing existed');
});

// ── §12 / §13: the candidate universe ──────────────────────────────────────

test('the universe key ignores product exclusions and tracks only the retrieval', () => {
  const base = {
    actorId: 'a', category: 'footwear', color: 'black', material: null, silhouette: null,
    formality: null, budget: { amount: 150, currency: 'USD' }, exclusions: [], functionalRequirements: [],
  };
  assert.equal(m.candidateUniverseKey(base), m.candidateUniverseKey({ ...base }), 'deterministic');
  assert.notEqual(m.candidateUniverseKey(base), m.candidateUniverseKey({ ...base, material: 'suede' }),
    'a real ranking constraint is part of the key');
  assert.notEqual(m.candidateUniverseKey(base), m.candidateUniverseKey({ ...base, actorId: 'b' }),
    'and one actor never reads another actor\'s retained candidates');
  // Order-insensitive for sets.
  assert.equal(
    m.candidateUniverseKey({ ...base, functionalRequirements: ['warm', 'waterproof'] }),
    m.candidateUniverseKey({ ...base, functionalRequirements: ['waterproof', 'warm'] }),
  );
});

test('the universe store is bounded and expires', () => {
  m.clearCandidateUniverses();
  const t0 = 1_000_000;
  for (let i = 0; i < m.CANDIDATE_UNIVERSE_MAX_ENTRIES + 4; i += 1) {
    m.writeCandidateUniverse(`key-${i}`, [offer(i)], t0);
  }
  assert.ok(m.candidateUniverseSize() <= m.CANDIDATE_UNIVERSE_MAX_ENTRIES, 'capped');
  m.clearCandidateUniverses();
  m.writeCandidateUniverse('k', [offer(1)], t0);
  assert.ok(m.readCandidateUniverse('k', t0 + 1000));
  assert.equal(m.readCandidateUniverse('k', t0 + m.CANDIDATE_UNIVERSE_TTL_MS), null, 'expires');
  m.clearCandidateUniverses();
});

// ── §22 / §31 / §41: firewalls ─────────────────────────────────────────────

test('a new garment category empties the memory in the same statement as the intent', () => {
  const boots = intent.reduceShoppingIntent({ previous: null, message: 'show me boots', payload: { category: 'boots' } });
  boots.state.shelfMemory = { actorId: null, shelves: [{ turn: 1, items: ['u:0123456789abcdef'] }], rejected: ['u:0123456789abcdef'] };
  const dress = intent.reduceShoppingIntent({ previous: boots.state, message: 'now a wedding dress', payload: { category: 'dress' } });
  assert.equal(dress.reset, true);
  assert.equal(dress.state.shelfMemory, null, 'structurally impossible for a boot rejection to reach dress ranking');
  assert.equal(dress.memory, null, 'and a memory op in the same breath as a reset does not apply to the new task');
});

test('the shelf-memory modules contain no ownership write of any kind', () => {
  for (const file of [
    'services/style-chat/commerceShelfMemory.ts',
    'services/commerce/productIdentity.ts',
  ]) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(/\bowned\s*[:=]\s*true|inCloset\s*[:=]\s*true|isOwned\s*[:=]\s*true/.test(src), false, file);
    assert.equal(/closet|watchlist/i.test(src.replace(/\/\*[\s\S]*?\*\//g, ' ')), false, `${file}: no Closet or Watchlist reach`);
  }
});

// ── §44: deletion lifecycle ────────────────────────────────────────────────

test('SHELF_MEMORY_DELETION_INHERITED: the state lives only in style_chat_messages', () => {
  // It is persisted inside the existing `commerce_shopping_intent` ui_block,
  // so it is deleted by the row that carries it and nothing else is needed.
  const activation = fs.readFileSync(path.join(ROOT, 'services/style-chat/commerceActivation.ts'), 'utf8');
  assert.match(activation, /shelfMemory: shelfMemory === undefined/, 'written into the intent block, not a new store');

  const registry = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/deletion/userDataResources.ts'), 'utf8');
  assert.match(registry, /table: 'style_chat_messages'.*action: 'auth_delete_cascade'/,
    'and that table is already covered by the account-deletion registry');

  // Nothing persistent was introduced anywhere else.
  const memorySrc = fs.readFileSync(path.join(ROOT, 'services/style-chat/commerceShelfMemory.ts'), 'utf8');
  assert.equal(/AsyncStorage|SecureStore|localStorage|\.from\(['"]/.test(memorySrc), false,
    'no table, no device store, no orphan');
});
