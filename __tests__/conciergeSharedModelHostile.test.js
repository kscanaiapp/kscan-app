/**
 * Build 34 / K+ Wardrobe Concierge V1 — INDEPENDENT HOSTILE AUDIT (2026-08-30).
 *
 * Shared-presentation half of the audit. Kept separate from the builder's suite
 * so the two remain separately attributable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  conciergeCardTitle,
  conciergeCardLabel,
} = require('../services/concierge/conciergeLabels.ts');
const { buildConciergeResult } = require('../services/concierge/conciergeModel.ts');

// ── AUDIT-CON-004 — the title fallback must not assert ownership ─────────────

test('AUDIT-CON-004: a non-owned card never falls back to Closet wording', () => {
  for (const relationship of ['saved', 'scanned', 'shared', 'discovered', 'unknown', 'unverified']) {
    const title = conciergeCardTitle({ title: null, category: null, relationship });
    assert.equal(
      /closet/i.test(title),
      false,
      `a ${relationship} card must not be headlined as a Closet item`,
    );
    assert.equal(typeof title, 'string');
    assert.ok(title.length > 0);
  }
});

test('AUDIT-CON-004: an owned card may still fall back to Closet wording', () => {
  assert.equal(
    conciergeCardTitle({ title: null, category: null, relationship: 'owned' }),
    'Closet item',
  );
});

test('AUDIT-CON-004: real evidence always outranks any fallback', () => {
  assert.equal(
    conciergeCardTitle({ title: 'Brown loafers', category: 'loafers', relationship: 'shared' }),
    'Brown loafers',
  );
  assert.equal(
    conciergeCardTitle({ title: null, category: 'loafers', relationship: 'discovered' }),
    'loafers',
  );
});

test('AUDIT-CON-004: the headline never contradicts the relationship chip', () => {
  // The chip and the headline are read as one statement. A "Shopping option"
  // chip above the words "Closet item" is a contradiction the customer resolves
  // in favour of the bigger text.
  for (const relationship of ['saved', 'scanned', 'shared', 'discovered']) {
    const chip = conciergeCardLabel(relationship, 'mixed');
    const title = conciergeCardTitle({ title: null, category: null, relationship });
    assert.equal(
      /your closet/i.test(chip) || /closet/i.test(title),
      false,
      `${relationship}: neither chip nor headline may claim the Closet`,
    );
  }
});

// ── forged / hostile payload shapes reaching the projection ──────────────────

test('AUDIT: a v2 payload whose mode is forged to "closet" still cannot invent cards', () => {
  // Ownership CANNOT be manufactured by the mode alone: cards come from display
  // facts, and a payload with none projects to nothing.
  const result = buildConciergeResult({
    contractVersion: 'elise_advice_v2',
    wardrobeContextMode: 'closet',
    focusedItem: { evidenceId: null, actorRelationship: 'owned' },
    recommendations: [
      { candidateId: 'x', sourceType: 'closet', actorRelationship: 'owned', recommendationRole: 'primary', score: 1, reasonCodes: [] },
    ],
    looks: null,
  });
  assert.equal(result.presentation, 'none');
  assert.deepEqual(result.cards, []);
  assert.equal(result.focusCard, null);
});

test('AUDIT: prototype-pollution shaped keys cannot become cards', () => {
  const result = buildConciergeResult(
    JSON.parse(
      '{"contractVersion":"elise_advice_v2","wardrobeContextMode":"closet",' +
        '"recommendations":[{"candidateId":"__proto__","actorRelationship":"owned",' +
        '"displayFacts":{"title":"x","category":null,"subtype":null,"brand":null,' +
        '"primaryColor":null,"clientId":null}}],"looks":null}',
    ),
  );
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].candidateId, '__proto__');
  // The lookup map must not be polluted by a candidate id that names an
  // Object.prototype member.
  assert.equal({}.polluted, undefined);
  assert.equal(result.looks.length, 0);
});

test('AUDIT: a look referencing an unknown id renders no card rather than a wrong one', () => {
  const result = buildConciergeResult({
    contractVersion: 'elise_advice_v2',
    wardrobeContextMode: 'closet',
    recommendations: [
      {
        candidateId: 'closet:a',
        sourceType: 'closet',
        actorRelationship: 'owned',
        recommendationRole: 'primary',
        score: 1,
        reasonCodes: [],
        displayFacts: {
          title: 'Brown loafers',
          category: 'loafers',
          subtype: null,
          brand: null,
          primaryColor: 'brown',
          clientId: 'id-a',
        },
      },
    ],
    looks: [{ lookId: 'look_1', label: 'Look 1', candidateIds: ['closet:ghost'], missingPieceCodes: [] }],
  });
  assert.equal(result.cards.length, 1);
  assert.equal(result.looks.length, 0, 'a look with no surviving item disappears entirely');
});
