'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getFixtures, validateAndCollect, assertNoDuplicateIds } = require('../fixtures');
const { validateCloset } = require('../schema/fixtureSchema');
const { checkPrivacy } = require('../schema/privacyGuard');

test('required test 1: fixture schemas validate', () => {
  const fixtures = getFixtures();
  assert.ok(fixtures.closets.length >= 8 && fixtures.closets.length <= 12);
  assert.ok(fixtures.signatureStyles.length >= 6 && fixtures.signatureStyles.length <= 8);
  assert.ok(fixtures.scenarios.length >= 15 && fixtures.scenarios.length <= 20);
  assert.ok(fixtures.multiTurnTraces.length >= 4 && fixtures.multiTurnTraces.length <= 6);
  assert.ok(fixtures.commerceCatalog.products.length <= 100);
});

test('required test 3: duplicate fixture ids fail', () => {
  const dupClosets = [
    { id: 'closet_a', kind: 'k', kPlusActive: true, items: [], doesNotOwn: [] },
    { id: 'closet_a', kind: 'k', kPlusActive: true, items: [], doesNotOwn: [] },
  ];
  assert.throws(() => validateAndCollect(dupClosets, validateCloset, 'closets_dup_test'), /Duplicate fixture id/);
  assert.throws(() => assertNoDuplicateIds([{ id: 'x' }, { id: 'x' }], 'test'), /Duplicate fixture id/);
});

test('malformed fixture fails validation (missing required field)', () => {
  const bad = { id: 'closet_bad', kind: 'k', kPlusActive: true, items: [{ category: 'tops' }], doesNotOwn: [] };
  const result = validateCloset(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('missing required field')));
});

test('required test 24: nested privacy violation fails', () => {
  const nested = {
    id: 'closet_nested_pii',
    kind: 'k',
    kPlusActive: true,
    doesNotOwn: [],
    items: [
      {
        id: 'item_1',
        category: 'tops',
        colors: ['blue'],
        colorFamilies: ['blue'],
        title: 'shirt',
        metadata: { nested: { deeplyNested: 'contact me at real.user@example.com' } },
      },
    ],
  };
  const privacy = checkPrivacy(nested);
  assert.equal(privacy.safe, false);
  assert.ok(privacy.violations.some((v) => v.patternId === 'EMAIL'));
});

test('privacy guard rejects forbidden key names at any depth', () => {
  const withToken = { a: { b: { c: { authToken: 'whatever' } } } };
  const result = checkPrivacy(withToken);
  assert.equal(result.safe, false);
  assert.ok(result.violations.some((v) => v.reason && v.reason.includes('authToken')));
});

test('fixture cross-reference integrity: scenarios/traces point at real closets and styles', () => {
  const fixtures = getFixtures();
  for (const scenario of fixtures.scenarios) {
    assert.ok(fixtures.closetsById[scenario.closetId], `scenario ${scenario.id} closetId`);
    assert.ok(fixtures.signatureStylesById[scenario.signatureStyleId], `scenario ${scenario.id} signatureStyleId`);
  }
});
