/**
 * Build 36 / Wardrobe Concierge V2 -- CON-PROSE-005 / CON-PROSE-006.
 *
 * These execute the REAL, unmodified production guard
 * (`supabase/functions/stylechat-generate/eliseOwnershipProseSafety.ts`) via
 * Node's TypeScript type-stripping, the same seam
 * `tools/elise-concierge-eval/context-assembly/l15ContextAssembly.js` already
 * uses. No model, no network, no fixtures standing in for the thing under test.
 *
 * WHAT THEY PIN
 * -------------
 * CON-PROSE-005 -- the BARE POSSESSIVE. Every assertion pattern the guard
 * shipped with required a verb of possession ("you own", "you have") or the
 * word closet/wardrobe. The sentence this whole lane exists to prevent needs
 * neither:
 *
 *     "Wear your black loafers with the charcoal trousers."
 *
 * Measured against the production guard before the repair: NOT DETECTED. The
 * text reached the customer unchanged for an actor who owns no black loafers.
 *
 * CON-PROSE-006 -- the QUALIFIER. The owned vocabulary was garment CLASS only,
 * so owning brown loafers licensed "you already have black loafers". Measured
 * before the repair: NOT DETECTED.
 *
 * Every case comes in BOTH directions, matching the discipline the existing
 * suite states: deleting a TRUE sentence is worse than the failure being fixed,
 * so each false claim that must go is paired with a true one that must stay.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_URL = `file://${path
  .resolve(__dirname, '..', 'supabase', 'functions', 'stylechat-generate', 'eliseOwnershipProseSafety.ts')
  .replace(/\\/g, '/')}`;

let guard;
test.before(async () => {
  guard = await import(MODULE_URL);
});

const NEUTRAL = 'Here are a few directions that would work.';

function ownedCandidate({ id, category, colors, title }) {
  return {
    candidate: {
      candidateId: `closet:${id}`,
      sourceType: 'closet',
      actorRelationship: 'owned',
      title: title ?? null,
      category: category ?? null,
      subcategory: null,
      colors: colors ?? [],
      colorFamilies: [],
      materials: [],
      textures: [],
      patterns: [],
      silhouette: null,
      fit: null,
      proportionRole: null,
      layeringRole: null,
      formality: null,
      seasons: [],
      occasions: [],
      styleAttributes: [],
      brand: null,
      confidence: null,
      canonicalResourceIds: { itemId: id },
    },
    score: { total: 10, dimensions: {}, reasons: [], warnings: [] },
    recommendationRole: 'primary',
  };
}

/** Owns: brown loafers, charcoal trousers. Owns NO black shoe of any kind. */
function brownLoaferCloset() {
  return [
    ownedCandidate({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      category: 'shoes',
      colors: ['brown'],
      title: 'Brown leather loafers',
    }),
    ownedCandidate({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      category: 'trousers',
      colors: ['charcoal'],
      title: 'Charcoal wool trousers',
    }),
  ];
}

function enforce(text, shortlist = brownLoaferCloset(), focus = null) {
  return guard.enforceOwnershipProseSafety({
    text,
    shortlist,
    focus,
    neutralFallback: NEUTRAL,
  });
}

// ── CON-PROSE-005: the bare possessive ──────────────────────────────────────

test('CON-PROSE-005: "wear your <garment>" is an ownership claim and is checked', () => {
  const verdict = enforce('Wear your black loafers with the charcoal trousers.');
  assert.equal(verdict.conflictDetected, true);
  assert.ok(
    !/black loafers/i.test(verdict.safeText),
    'the sentence claiming an unowned garment must not reach the customer',
  );
});

test('CON-PROSE-005: the possessive is caught with no verb of possession anywhere', () => {
  for (const text of [
    'Throw on your denim jacket.',
    'Your leather jacket would finish this look.',
    'Pair your red dress with something simple.',
    'Style your white sneakers down for the weekend.',
  ]) {
    const verdict = enforce(text);
    assert.equal(verdict.conflictDetected, true, `should have been caught: ${text}`);
  }
});

test('CON-PROSE-005: a possessive about a garment the actor OWNS survives intact', () => {
  const verdict = enforce('Wear your brown loafers with the charcoal trousers.');
  assert.equal(verdict.conflictDetected, false);
  assert.equal(verdict.safeText, 'Wear your brown loafers with the charcoal trousers.');
});

test('CON-PROSE-005: the possessive only convicts the garment it actually governs', () => {
  // "your" governs `figure`, not `dress`. A sentence-wide garment sweep would
  // delete this ordinary styling advice; the phrase-scoped scan must not.
  const verdict = enforce('That dress would suit your figure.');
  assert.equal(verdict.conflictDetected, false);
  assert.equal(verdict.safeText, 'That dress would suit your figure.');
});

test('CON-PROSE-005: the scan does not jump a clause boundary to find a garment', () => {
  // "your style" opens the phrase; `trousers` sits past a terminator and must
  // not be read as claimed, because the possessive never reached it.
  const verdict = enforce('Your style works with wide trousers.');
  assert.equal(verdict.conflictDetected, false);
});

test('CON-PROSE-005: an intervening owner breaks the possessive', () => {
  // "your friend's jacket" is not a claim the user owns a jacket.
  const verdict = enforce("Your friend's jacket would work here.");
  assert.equal(verdict.conflictDetected, false);
});

test('CON-PROSE-005: a hypothetical is not an ownership claim', () => {
  // The product truth this lane protects, stated in its own terms: suggesting a
  // brown loafer is always allowed; asserting they have one is not.
  const verdict = enforce('A brown loafer would work here.');
  assert.equal(verdict.conflictDetected, false);
  assert.equal(verdict.safeText, 'A brown loafer would work here.');
});

// ── CON-PROSE-006: the qualifier ────────────────────────────────────────────

test('CON-PROSE-006: owning brown loafers does not license "black loafers"', () => {
  const verdict = enforce('You already have black loafers.');
  assert.equal(verdict.conflictDetected, true);
  assert.ok(verdict.conflictCodes.some((code) => code.includes('loafer')));
});

test('CON-PROSE-006: the colour the actor DOES own survives', () => {
  const verdict = enforce('You already have brown loafers.');
  assert.equal(verdict.conflictDetected, false);
});

test('CON-PROSE-006: a claim naming no colour is still judged at class level only', () => {
  // No colour named -> nothing to contradict. The class check already decides,
  // and it says the actor owns loafers, so this is true and must survive.
  const verdict = enforce('You already have loafers that work here.');
  assert.equal(verdict.conflictDetected, false);
});

test('CON-PROSE-006: INCOMPLETE METADATA ABSTAINS rather than accusing', () => {
  // An owned Closet row with no colour recorded cannot disagree with any
  // colour. Deleting a true sentence for want of metadata is the mirror of the
  // failure being fixed, and a worse one.
  const colourless = [
    ownedCandidate({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      category: 'shoes',
      colors: [],
      title: 'Loafers',
    }),
  ];
  const verdict = enforce('You already have black loafers.', colourless);
  assert.equal(verdict.conflictDetected, false);
});

test('CON-PROSE-006: the colour check applies to the possessive form too', () => {
  const wrong = enforce('Wear your black loafers tonight.');
  const right = enforce('Wear your brown loafers tonight.');
  assert.equal(wrong.conflictDetected, true);
  assert.equal(right.conflictDetected, false);
});

// ── The boundary the guard must not cross ───────────────────────────────────

test('a non-owned candidate contributes no ownership vocabulary', () => {
  const savedOnly = brownLoaferCloset().map((entry) => ({
    ...entry,
    candidate: { ...entry.candidate, actorRelationship: 'saved' },
  }));
  // Saving is not owning: with nothing owned, even the right colour is a false
  // claim.
  const verdict = enforce('Wear your brown loafers tonight.', savedOnly);
  assert.equal(verdict.conflictDetected, true);
});

test('only the offending sentence is dropped; safe prose around it survives', () => {
  const verdict = enforce(
    'The charcoal trousers are a strong base. Wear your black loafers with them. A brown loafer would also work.',
  );
  assert.equal(verdict.conflictDetected, true);
  assert.ok(verdict.safeText.includes('charcoal trousers are a strong base'));
  assert.ok(verdict.safeText.includes('A brown loafer would also work'));
  assert.ok(!/black loafers/i.test(verdict.safeText));
});

test('nothing safe surviving falls back to product copy, never to a rewrite', () => {
  const verdict = enforce('Wear your black loafers.');
  assert.equal(verdict.safeText, NEUTRAL);
});

test('conflict codes carry garment class only, never item text', () => {
  const verdict = enforce('Wear your black loafers with your red dress.');
  assert.equal(verdict.conflictDetected, true);
  for (const code of verdict.conflictCodes) {
    assert.ok(
      /^unsupported_owned_(?:color_)?[a-z0-9]+$/.test(code),
      `code must be a stable class token, got: ${code}`,
    );
    assert.ok(!/brown|charcoal|leather|wool/i.test(code));
  }
});
