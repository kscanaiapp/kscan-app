/**
 * RetailerIdentity component (Build 35 §21, §69-70).
 *
 * Repo convention for RN component source (see
 * __tests__/createRoomModalLayout.test.js): no Jest/React Testing Library
 * is installed, so this is a structural assertion against the actual
 * composed source, not a render test.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'components/commerce/RetailerIdentity.tsx'), 'utf8');

test('component file is found and non-trivial', () => {
  assert.ok(SOURCE.length > 500);
});

test('renders nothing when the retailer is unknown (no fabricated placeholder, §70)', () => {
  assert.match(SOURCE, /if \(!identity \|\| !identity\.displayName\) return null;/);
});

test('does not import or reference `brand` anywhere in its rendering logic', () => {
  assert.doesNotMatch(SOURCE, /identity\.brand/);
  assert.doesNotMatch(SOURCE, /\.brand\b/);
});

test('falls back to the monogram only when no logo source is resolved', () => {
  assert.match(SOURCE, /logoSource \? \(/);
  assert.match(SOURCE, /identity\.fallbackMonogram \? \(/);
});

test('logo lookup is keyed by retailerKey against a static per-retailer asset map (no dynamic require from a string)', () => {
  assert.match(SOURCE, /RETAILER_LOGO_ASSETS\[identity\.retailerKey\]/);
  assert.doesNotMatch(SOURCE, /require\(\s*[a-zA-Z_]/); // no dynamic require(variable)
});

test('the static logo asset map starts empty (no shipped logo has a documented rights basis yet, §19)', () => {
  assert.match(SOURCE, /const RETAILER_LOGO_ASSETS[^=]*=\s*\{\};/);
});

test('a rendered logo image is marked decorative to avoid a duplicate accessibility announcement (§69)', () => {
  assert.match(SOURCE, /accessibilityElementsHidden/);
  assert.match(SOURCE, /importantForAccessibility="no"/);
});

test('watchlist mode uppercases the display name, matching the existing Watchlist row presentation', () => {
  assert.match(SOURCE, /mode === 'watchlist' \? identity\.displayName\.toUpperCase\(\) : identity\.displayName/);
});

test('accessibility label combines display name and commerce type when both are known', () => {
  assert.match(SOURCE, /retailerAccessibilityLabel/);
  assert.match(SOURCE, /identity\.commerceType \? `\$\{identity\.displayName\}, \$\{identity\.commerceType\}` : identity\.displayName/);
});

test('exposes all five presentation modes named in the Build 35 plan (§21)', () => {
  for (const mode of ['card', 'row', 'compact', 'watchlist', 'text-only']) {
    assert.ok(SOURCE.includes(`'${mode}'`), `mode "${mode}" not found in component source`);
  }
});
