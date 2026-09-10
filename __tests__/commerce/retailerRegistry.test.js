/**
 * Commerce V2 retailer registry (Build 35 §17, §66, §78-80).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RETAILER_REGISTRY,
  RETAILER_REGISTRY_VERSION,
  listRetailers,
  getRetailerByKey,
  findRetailerByDomain,
  findRetailerByDeclaredName,
} = require('../../services/commerce/retailerRegistry.ts');

test('registry is versioned', () => {
  assert.equal(typeof RETAILER_REGISTRY_VERSION, 'number');
});

test('every registry entry has no logo asset without a documented rights basis', () => {
  for (const entry of listRetailers()) {
    if (entry.logoAsset) {
      assert.ok(
        typeof entry.logoRightsBasis === 'string' && entry.logoRightsBasis.trim().length > 0,
        `${entry.retailerKey} carries a logoAsset with no logoRightsBasis`,
      );
    } else {
      // No logo shipped today for any real retailer (§19) -- this is the
      // expected, honest state, not a bug.
      assert.equal(entry.logoAsset, null);
    }
    assert.ok(entry.fallbackMonogram && entry.fallbackMonogram.length > 0, `${entry.retailerKey} has no monogram fallback`);
  }
});

test('getRetailerByKey is O(1) keyed lookup, not a scan — unknown key returns null', () => {
  assert.equal(getRetailerByKey('farfetch').displayName, 'Farfetch');
  assert.equal(getRetailerByKey('not-a-real-retailer'), null);
  assert.equal(getRetailerByKey(null), null);
  assert.equal(getRetailerByKey(undefined), null);
});

test('findRetailerByDomain matches the exact apex domain', () => {
  assert.equal(findRetailerByDomain('farfetch.com').retailerKey, 'farfetch');
  assert.equal(findRetailerByDomain('nordstrom.com').retailerKey, 'nordstrom');
});

test('findRetailerByDomain matches a subdomain of a registered domain (marketplace subdomain, §78)', () => {
  assert.equal(findRetailerByDomain('shop.nordstrom.com').retailerKey, 'nordstrom');
  assert.equal(findRetailerByDomain('www.farfetch.com').retailerKey, 'farfetch');
});

test('findRetailerByDomain refuses an unmapped domain (no fabricated retailer, §16)', () => {
  assert.equal(findRetailerByDomain('unmapped-retailer.example.test'), null);
  assert.equal(findRetailerByDomain('shops.example-storefront-platform.test'), null);
});

test('findRetailerByDomain refuses a shared/unrelated host even when it shares a label with a real domain', () => {
  // "nordstrom" as a bare label under a different apex must not match.
  assert.equal(findRetailerByDomain('nordstrom.evil-lookalike.test'), null);
});

test('findRetailerByDomain handles null/empty input', () => {
  assert.equal(findRetailerByDomain(null), null);
  assert.equal(findRetailerByDomain(''), null);
  assert.equal(findRetailerByDomain('no-dots'), null);
});

test('findRetailerByDeclaredName matches display name case-insensitively', () => {
  assert.equal(findRetailerByDeclaredName('farfetch').retailerKey, 'farfetch');
  assert.equal(findRetailerByDeclaredName('FARFETCH').retailerKey, 'farfetch');
  assert.equal(findRetailerByDeclaredName('  Nordstrom  ').retailerKey, 'nordstrom');
});

test('findRetailerByDeclaredName matches a raw domain string some providers supply as "source"', () => {
  assert.equal(findRetailerByDeclaredName('kickscrew.com').retailerKey, 'kickscrew');
});

test('findRetailerByDeclaredName never matches a brand name against a retailer registry entry', () => {
  // No registry entry is keyed by a brand name, so a brand string can never
  // accidentally resolve to a retailer via this path.
  assert.equal(findRetailerByDeclaredName("Levi's"), null);
  assert.equal(findRetailerByDeclaredName('Dr. Martens'), null);
});

test('registry is a frozen, keyed object (O(1) shape, not an array to scan)', () => {
  assert.ok(!Array.isArray(RETAILER_REGISTRY));
  assert.ok(Object.isFrozen(RETAILER_REGISTRY));
  try {
    RETAILER_REGISTRY.farfetch = { retailerKey: 'tampered' };
  } catch {
    // Strict-mode modules throw on a frozen-object write; either way the
    // value below must be unchanged.
  }
  assert.equal(RETAILER_REGISTRY.farfetch.retailerKey, 'farfetch');
});
