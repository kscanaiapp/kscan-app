/**
 * CON-PROSE-001 / CON-PROSE-002 -- ownership prose safety, hostile controls.
 *
 * Found by the Build 34 targeted K3/K4 hostile pass against candidate 7475066,
 * empirically (the guard was run against crafted prose), not by reading.
 *
 * CON-PROSE-001. The guard's assertion list contained "in your closet" and
 * "from your closet" but nothing at all for WARDROBE -- the word a person is at
 * least as likely to use for the same idea. "The navy blazer is already in your
 * wardrobe" was therefore never even examined, and reached the customer intact
 * for someone who owns no blazer.
 *
 * CON-PROSE-002. The owned vocabulary was built from EVERY word of an owned
 * item's title, so an owned "Leather Shoe Bag" licensed the token `shoe` and
 * "you already have brown shoes" passed for a customer who owns no shoes. A
 * title is a NAME, not a taxonomy.
 *
 * Section 34 scopes this guard to removing FALSE claims. Deleting a TRUE one is
 * strictly worse than the failure it was built to prevent, so every test below
 * comes in both directions: the true claim must survive, the false one must go.
 */
import assert from 'node:assert/strict';

import { enforceOwnershipProseSafety } from './eliseOwnershipProseSafety.ts';
import { normalizeWardrobeCandidate } from './eliseFashionFeatures.ts';
import type { EliseScoredCandidate, EliseWardrobeCandidate } from './eliseAdviceTypes.ts';

const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const NEUTRAL = 'Here is a neutral suggestion.';

function ownedCandidate(input: {
  id: string;
  title: string;
  category: string;
}): EliseWardrobeCandidate {
  return normalizeWardrobeCandidate({
    candidateId: `closet:${input.id}`,
    sourceType: 'closet',
    actorRelationship: 'owned',
    row: { id: input.id, user_id: ACTOR, title: input.title, category: input.category, color: [] },
    canonicalResourceIds: { itemId: input.id },
  });
}

/** A candidate the actor merely SCANNED. Contributes no ownership vocabulary. */
function scannedCandidate(input: {
  id: string;
  title: string;
  category: string;
}): EliseWardrobeCandidate {
  return normalizeWardrobeCandidate({
    candidateId: `saved_scan:${input.id}`,
    sourceType: 'saved_scan',
    actorRelationship: 'scanned',
    row: { id: input.id, user_id: ACTOR, title: input.title, category: input.category, color: [] },
    canonicalResourceIds: { itemId: input.id },
  });
}

const scored = (candidate: EliseWardrobeCandidate): EliseScoredCandidate =>
  ({ candidate, score: 1 } as unknown as EliseScoredCandidate);

function verdict(text: string, shortlist: EliseWardrobeCandidate[]) {
  return enforceOwnershipProseSafety({
    text,
    shortlist: shortlist.map(scored),
    neutralFallback: NEUTRAL,
  });
}

// ── CON-PROSE-002: a title is a name, not a taxonomy ────────────────────────

Deno.test('CON-PROSE-002: owned "Brown Shoes" DOES license a shoe ownership claim', () => {
  const v = verdict('You already have brown shoes that would work here.', [
    ownedCandidate({ id: 's1', title: 'Brown Shoes', category: 'footwear' }),
  ]);
  assert.equal(v.conflictDetected, false, 'a TRUE ownership claim must survive');
  assert.match(v.safeText, /brown shoes/i);
});

Deno.test('CON-PROSE-002: owned "Leather Shoe Bag" does NOT license a shoe ownership claim', () => {
  const v = verdict('You already have brown shoes that would work here.', [
    ownedCandidate({ id: 'b1', title: 'Leather Shoe Bag', category: 'bag' }),
  ]);
  assert.equal(v.conflictDetected, true, 'a bag is not a shoe, whatever its name contains');
  assert.ok(v.conflictCodes.includes('unsupported_owned_shoe'));
  assert.equal(v.safeText, NEUTRAL, 'nothing safe survived, so neutral copy replaces it');
});

Deno.test('CON-PROSE-002: the head noun of the title IS still licensed', () => {
  // The repair must not make the guard blind to what the item actually is.
  const v = verdict('You already have a bag that works with this.', [
    ownedCandidate({ id: 'b1', title: 'Leather Shoe Bag', category: 'accessory' }),
  ]);
  assert.equal(v.conflictDetected, false, 'the item genuinely IS a bag');
});

Deno.test('CON-PROSE-002: an unrelated accessory naming a garment licenses nothing of it', () => {
  // Every noun here is in GARMENT_NOUNS, so a miss is a real guard failure
  // rather than the separately-recorded bounded-vocabulary limit (CON-PROSE-003).
  for (const [title, category, claim, noun] of [
    ['Cedar Shoe Tree', 'accessory', "You've got shoes that would work.", 'shoe'],
    ['Boot Bag', 'accessory', 'You already have boots for this.', 'boot'],
    ['Padded Coat Hanger', 'accessory', 'You already own a coat in camel.', 'coat'],
    ['Dress Bag', 'accessory', 'You already have a dress for this.', 'dress'],
  ] as const) {
    const v = verdict(claim, [ownedCandidate({ id: 'a1', title, category })]);
    assert.equal(v.conflictDetected, true, `"${title}" must not license "${noun}"`);
  }
});

Deno.test('CON-PROSE-002: a two-word garment name still licenses its head', () => {
  // "Shirt Dress" IS a dress. The modifier must not be licensed, the head must.
  const owned = [ownedCandidate({ id: 'd1', title: 'Shirt Dress', category: 'dress' })];
  assert.equal(verdict('You already have a dress for this.', owned).conflictDetected, false);
  assert.equal(
    verdict('You already have a shirt for this.', owned).conflictDetected,
    true,
    'a shirt dress is not a shirt',
  );
});

Deno.test('CON-PROSE-002: taxonomy still licenses directly, even against the title', () => {
  // category/subcategory are the server's own classification, not prose.
  const v = verdict('You already own loafers in brown.', [
    ownedCandidate({ id: 'l1', title: 'Weekend Pair', category: 'loafers' }),
  ]);
  assert.equal(v.conflictDetected, false, 'the taxonomy says these ARE loafers');
});

// ── CON-PROSE-001: "wardrobe" is an ownership claim ─────────────────────────

Deno.test('CON-PROSE-001: "already in your wardrobe" is checked, and rejected when false', () => {
  const v = verdict('The navy blazer is already in your wardrobe, so build around it.', [
    ownedCandidate({ id: 't1', title: 'Navy Wool Trousers', category: 'bottom' }),
  ]);
  assert.equal(v.conflictDetected, true, '"in your wardrobe" asserts ownership');
  assert.ok(v.conflictCodes.includes('unsupported_owned_blazer'));
});

Deno.test('CON-PROSE-001: every wardrobe phrasing is covered, not just one', () => {
  const owned = [ownedCandidate({ id: 't1', title: 'Navy Wool Trousers', category: 'bottom' })];
  for (const claim of [
    'Your wardrobe already includes a camel trench coat.',
    'Your wardrobe has a blazer that works here.',
    'Your wardrobe contains a silk blouse for this.',
    'The loafers from your wardrobe would finish it.',
  ]) {
    assert.equal(verdict(claim, owned).conflictDetected, true, `unguarded: ${claim}`);
  }
});

Deno.test('CON-PROSE-001: a TRUE wardrobe claim survives', () => {
  const v = verdict('The navy trousers already in your wardrobe work well here.', [
    ownedCandidate({ id: 't1', title: 'Navy Wool Trousers', category: 'bottom' }),
  ]);
  assert.equal(v.conflictDetected, false, 'the actor genuinely owns trousers');
  assert.match(v.safeText, /navy trousers/i);
});

// ── The boundary the guard already drew stays exactly where it was ──────────

Deno.test('a merely SCANNED item still licenses nothing, by either route', () => {
  const scanned = [scannedCandidate({ id: 'x1', title: 'Brown Shoes', category: 'footwear' })];
  assert.equal(verdict('You already have brown shoes.', scanned).conflictDetected, true);
  assert.equal(verdict('Brown shoes are already in your wardrobe.', scanned).conflictDetected, true);
});

Deno.test('ownership language naming no garment is still left alone', () => {
  const v = verdict('You already have a strong foundation in your wardrobe.', []);
  assert.equal(v.conflictDetected, false, 'this guard removes false claims, not confident tone');
});

Deno.test('prose asserting no ownership is still untouched', () => {
  const v = verdict('A leather jacket works well with these.', []);
  assert.equal(v.conflictDetected, false);
  assert.match(v.safeText, /leather jacket/i);
});

Deno.test('the guard still never rewrites a sentence into a different garment', () => {
  const v = verdict(
    'You already have brown shoes. A camel coat would lift the whole look.',
    [ownedCandidate({ id: 'b1', title: 'Leather Shoe Bag', category: 'bag' })],
  );
  assert.equal(v.conflictDetected, true);
  // The unsafe sentence is DROPPED; the safe one survives verbatim.
  assert.doesNotMatch(v.safeText, /brown shoes/i);
  assert.match(v.safeText, /A camel coat would lift the whole look\./);
});

Deno.test('conflict codes stay garment CLASS only -- never a title or a sentence', () => {
  const v = verdict('You already have brown shoes here.', [
    ownedCandidate({ id: 'b1', title: 'Leather Shoe Bag', category: 'bag' }),
  ]);
  for (const code of v.conflictCodes) {
    assert.match(code, /^unsupported_owned_[a-z0-9]+$/);
    assert.doesNotMatch(code, /leather|bag|brown/i);
  }
});
