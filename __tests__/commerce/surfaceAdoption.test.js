/**
 * Commerce V2 PR B — single-source-of-truth adoption (Build 35 §21, §63).
 *
 * "Commerce and Watchlist must not create separate retailer-resolution
 * logic." Structural regression guard: every commerce-displaying surface
 * this PR touched must resolve retailer identity through
 * resolveRetailerIdentity/RetailerIdentity, not a hand-rolled getter.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SURFACES = [
  'components/ProductShelf.tsx',
  'components/scan-results/PurchaseOptionsPanel.tsx',
  'components/SecondhandShelf.tsx',
  'app/watchlist/index.tsx',
  'app/watchlist/[watchId].tsx',
];

for (const rel of SURFACES) {
  test(`${rel} imports the shared RetailerIdentity component`, () => {
    const source = read(rel);
    assert.match(source, /from '.*commerce\/RetailerIdentity'/, `${rel} must render retailer identity via the shared component`);
    assert.match(source, /<RetailerIdentity\b/, `${rel} must actually use <RetailerIdentity`);
  });
}

for (const rel of ['components/ProductShelf.tsx', 'components/scan-results/PurchaseOptionsPanel.tsx', 'components/SecondhandShelf.tsx', 'app/watchlist/[watchId].tsx']) {
  test(`${rel} resolves retailer identity through the shared resolver module`, () => {
    const source = read(rel);
    assert.match(source, /from '.*commerce\/retailerIdentity'/);
    assert.match(source, /resolve(Persisted)?RetailerIdentity\(/);
  });
}

/**
 * Closure §6: the two surfaces that render REOPENED (persisted) commerce
 * must use the persisted-aware resolver, so a row written before the
 * seller-truth repair can be corrected by its own governed merchant domain.
 * The other surfaces render live/server-derived data and keep the approved
 * live resolver.
 */
for (const rel of ['components/ProductShelf.tsx', 'components/scan-results/PurchaseOptionsPanel.tsx', 'services/dressingRoomCommerceCard.ts']) {
  test(`${rel} uses the persisted-aware resolver for stored commerce snapshots`, () => {
    const source = read(rel);
    assert.match(source, /resolvePersistedRetailerIdentity\(/);
  });
}

test('Watchlist keeps the live resolver — its stored source is server-derived and was never affected by the legacy defect', () => {
  for (const rel of ['app/watchlist/index.tsx', 'app/watchlist/[watchId].tsx']) {
    const source = read(rel);
    assert.match(source, /resolveRetailerIdentity\(/);
    assert.doesNotMatch(source, /resolvePersistedRetailerIdentity\(/);
  }
});

test('app/watchlist/index.tsx resolves each row\'s identity individually (not a single shelf-wide constant)', () => {
  const source = read('app/watchlist/index.tsx');
  assert.match(source, /resolveRetailerIdentity\(\{ retailer: watch\.source \}\)/);
});

test('ProductShelf and PurchaseOptionsPanel route Shop through the shared commerce-exit contract', () => {
  for (const rel of ['components/ProductShelf.tsx', 'components/scan-results/PurchaseOptionsPanel.tsx']) {
    const source = read(rel);
    assert.match(source, /from '.*commerce\/commerceExit'/, `${rel} must import openCommerceOffer`);
    assert.match(source, /openCommerceOffer\(/, `${rel} must call openCommerceOffer`);
  }
});

test('SecondhandShelf keeps its existing guarded-open call site untouched (GP-001) rather than being forced onto a second gateway', () => {
  const source = read('components/SecondhandShelf.tsx');
  assert.match(source, /openExternalUrl/);
  assert.doesNotMatch(source, /Linking\.openURL/, 'GP-001: this file must never call Linking.openURL directly');
});

test('no touched surface reads `.brand` as a retailer candidate anywhere in its retailer-resolution call', () => {
  for (const rel of SURFACES) {
    const source = read(rel);
    // Every resolveRetailerIdentity(...) call site in these files passes an
    // object literal built from retailer/source fields only.
    const calls = source.match(/resolveRetailerIdentity\(\{[^}]*\}\)/g) || [];
    for (const call of calls) {
      assert.doesNotMatch(call, /\bbrand\s*:/, `${rel}: ${call} must not pass brand into retailer resolution`);
    }
  }
});
