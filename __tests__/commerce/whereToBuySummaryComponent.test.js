/**
 * WhereToBuySummary component (Build 35 §54).
 * Structural assertion, matching this repo's RN-component test convention
 * (see __tests__/createRoomModalLayout.test.js).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'components/commerce/WhereToBuySummary.tsx'), 'utf8');

test('component file is found and non-trivial', () => {
  assert.ok(SOURCE.length > 300);
});

test('renders nothing for fewer than two rows (a single offer already shows its retailer above)', () => {
  assert.match(SOURCE, /if \(!rows \|\| rows\.length < 2\) return null;/);
});

test('renders through the shared RetailerIdentity component, not its own retailer text', () => {
  assert.match(SOURCE, /from '\.\/RetailerIdentity'/);
  assert.match(SOURCE, /<RetailerIdentity\b/);
  assert.doesNotMatch(SOURCE, /<Text[^>]*>\{row\.displayName\}/);
});

test('never renders a "Best Deal"/"Cheapest" claim, only an exact count via whereToBuyRowLabel', () => {
  assert.doesNotMatch(SOURCE, /Best Deal|Cheapest|Lowest Price/i);
  assert.match(SOURCE, /whereToBuyRowLabel/);
});

test('each row is independently accessible with retailer + count', () => {
  assert.match(SOURCE, /accessibilityLabel=\{`\$\{row\.displayName\}, \$\{whereToBuyRowLabel\(row\)\}`\}/);
});
