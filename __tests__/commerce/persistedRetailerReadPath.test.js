/**
 * Commerce V2 closure §6 — persisted read-path retailer remediation.
 *
 * The historical defect: `normalizePurchaseOptions` used to fall back to
 * `record.brand` for `retailer`, and that value was PERSISTED into
 * `saved_scans.purchase_options` and Dressing Room snapshots. The PR A repair
 * only changed what NEW writes produce -- rows written before it still carry
 * a brand where a seller belongs, and `savedScansCloud` reads them back
 * verbatim.
 *
 * `resolvePersistedRetailerIdentity` is the read-time correction. It is
 * deliberately narrow: only a governed, non-aggregator, REGISTERED merchant
 * domain may override a stored label. No brand comparison, no fuzzy matching,
 * no LLM. These tests pin both halves -- that it corrects what it can, and
 * that it refuses to correct what it cannot prove.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveRetailerIdentity,
  resolvePersistedRetailerIdentity,
} = require('../../services/commerce/retailerIdentity.ts');

// ---- The legacy defect, as stored -----------------------------------------

/** A row written before the repair: brand landed in the retailer field. */
const LEGACY_BRAND_AS_RETAILER = {
  title: 'Wool Blazer',
  retailer: 'Ganni', // actually the BRAND — the pre-repair fallback wrote this
  productUrl: 'https://shop.nordstrom.com/s/ganni-wool-blazer/9911',
};

test('the stored row still reads brand-as-retailer under the approved live resolver (defect is real, not theoretical)', () => {
  const live = resolveRetailerIdentity(LEGACY_BRAND_AS_RETAILER);
  assert.equal(live.displayName, 'Ganni');
  assert.equal(live.sourceAuthority, 'declared');
});

test('the persisted read path corrects it from the row own governed merchant domain', () => {
  const persisted = resolvePersistedRetailerIdentity(LEGACY_BRAND_AS_RETAILER);
  assert.equal(persisted.retailerKey, 'nordstrom');
  assert.equal(persisted.displayName, 'Nordstrom');
  assert.equal(persisted.sourceAuthority, 'domain');
});

// ---- Refusals: everything it must NOT "correct" ---------------------------

test('REFUSAL: an unregistered merchant domain never overrides the stored label', () => {
  const row = { retailer: 'Ganni', productUrl: 'https://some-unregistered-store.example.test/p/1' };
  const persisted = resolvePersistedRetailerIdentity(row);
  assert.equal(persisted.displayName, 'Ganni', 'nothing deterministic contradicts the stored label');
  assert.equal(persisted.sourceAuthority, 'declared');
});

test('REFUSAL: an aggregator destination never overrides the stored label', () => {
  // Matches the measured reality that most destinations are Google Shopping
  // links while the stored label is the real merchant — correcting here would
  // replace a true label with "Google".
  const row = { retailer: 'H&M', productUrl: 'https://www.google.com/shopping/product/1' };
  const persisted = resolvePersistedRetailerIdentity(row);
  assert.equal(persisted.displayName, 'H&M');
  assert.notEqual(persisted.displayName, 'Google');
});

test('REFUSAL: an unsafe/credentialed URL is never used to correct anything', () => {
  const row = { retailer: 'Ganni', productUrl: 'https://user:pass@shop.nordstrom.com/s/x/1' };
  const persisted = resolvePersistedRetailerIdentity(row);
  assert.equal(persisted.displayName, 'Ganni');
  assert.equal(persisted.sourceAuthority, 'declared');
});

test('REFUSAL: a stored label that already agrees with the domain is left untouched', () => {
  const row = { retailer: 'Nordstrom', productUrl: 'https://shop.nordstrom.com/s/x/1' };
  const persisted = resolvePersistedRetailerIdentity(row);
  assert.equal(persisted.retailerKey, 'nordstrom');
  assert.equal(persisted.sourceAuthority, 'declared', 'no correction was needed, so none was claimed');
});

test('REFUSAL: brand is never read, even by the persisted path', () => {
  const row = { brand: 'Nordstrom', productUrl: null };
  const persisted = resolvePersistedRetailerIdentity(row);
  assert.equal(persisted.retailerKey, null);
  assert.equal(persisted.displayName, null);
  assert.equal(persisted.sourceAuthority, 'unknown');
});

test('REFUSAL: a row with no URL at all keeps its stored label (nothing to derive from)', () => {
  const row = { retailer: 'Ganni' };
  const persisted = resolvePersistedRetailerIdentity(row);
  assert.equal(persisted.displayName, 'Ganni');
});

// ---- Contract preservation -------------------------------------------------

test('the approved live resolver contract is unchanged (declared still wins there)', () => {
  const row = { retailer: 'Ganni', productUrl: 'https://shop.nordstrom.com/s/x/1' };
  assert.equal(resolveRetailerIdentity(row).displayName, 'Ganni');
  assert.equal(resolveRetailerIdentity(row).sourceAuthority, 'declared');
});

test('remediation changes presentation only — it never rewrites the offer, its URL, or its identity', () => {
  const row = { ...LEGACY_BRAND_AS_RETAILER };
  const before = JSON.stringify(row);
  resolvePersistedRetailerIdentity(row);
  assert.equal(JSON.stringify(row), before, 'the stored record must be untouched');
});

test('null/garbage input degrades to unknown rather than throwing', () => {
  for (const bad of [null, undefined, 'string', 7, []]) {
    const identity = resolvePersistedRetailerIdentity(bad);
    assert.equal(identity.retailerKey, null);
  }
});
