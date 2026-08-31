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

import {
  enforceClosetAbsenceProseSafety,
  enforceOwnershipProseSafety,
} from './eliseOwnershipProseSafety.ts';
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

// ── CON-ABSENCE-005: a Closet ABSENCE claim needs census provenance ─────────
//
// The hostile runtime case: a NON-K+ actor -- who has no Closet at all, because
// RLS gates user_closet_items on has_active_k_plus() -- was told "I don't
// currently have any outerwear items listed in your Closet". A factual claim
// about a store the turn had no census of.
//
// The invariant: a factual assertion that the Closet/wardrobe LACKS something
// requires authoritative Closet census provenance. Ordinary styling advice must
// remain available without it, or Base Elise becomes useless for non-K+ users.

const NO_CENSUS = { censusAvailable: false, presentSubjects: [] };
const EMPTY_OUTERWEAR_CENSUS = { censusAvailable: true, presentSubjects: ['shirt', 'trousers'] };
const HAS_OUTERWEAR_CENSUS = { censusAvailable: true, presentSubjects: ['outerwear', 'coat', 'shirt'] };

function absence(text: string, evidence: unknown) {
  return enforceClosetAbsenceProseSafety({
    text,
    evidence: evidence as never,
    neutralFallback: NEUTRAL,
  });
}

// A. No census -> absence rejected, across semantic forms.
Deno.test('CON-ABSENCE-005: with NO census, every absence phrasing is rejected', () => {
  for (const claim of [
    // The exact sentence that shipped.
    "I don't currently have any outerwear items listed in your Closet.",
    'You don’t have any jackets in your Closet.',
    "There aren't any jackets in your wardrobe.",
    'Your Closet has no outerwear.',
    "You're missing outerwear from your wardrobe.",
    'You do not own a blazer.',
    'You have no coats.',
    'You lack a trench coat.',
    "Your wardrobe doesn't contain a blazer.",
    'Your wardrobe is missing outerwear.',
    'A camel coat is not in your Closet.',
    "I don't see any boots in your wardrobe.",
    'You did not have a jacket.',
  ]) {
    const v = absence(claim, NO_CENSUS);
    assert.equal(v.conflictDetected, true, `unguarded absence claim: ${claim}`);
    assert.equal(v.safeText, NEUTRAL);
  }
});

Deno.test('CON-ABSENCE-005: the conflict code says WHY, without leaking contents', () => {
  const v = absence("I don't currently have any outerwear items listed in your Closet.", NO_CENSUS);
  assert.ok(v.conflictCodes.includes('ungrounded_absent_outerwear'));
  for (const code of v.conflictCodes) assert.match(code, /^[a-z_]+_[a-z0-9]+$/);
});

// B. No census -> ordinary advice still allowed. Base Elise must stay useful.
Deno.test('CON-ABSENCE-005: general fashion advice survives without a census', () => {
  for (const advice of [
    'A lightweight jacket could work well with this outfit.',
    'A jacket could complement this outfit.',
    'Consider adding outerwear for colder weather.',
    'A tailored wool overcoat works wonderfully for a smart dinner.',
    'Pair it with dark trousers and a crisp shirt.',
    // "have to" is advice, not a claim about holdings.
    "You don't have to wear a jacket for this.",
  ]) {
    const v = absence(advice, NO_CENSUS);
    assert.equal(v.conflictDetected, false, `advice wrongly suppressed: ${advice}`);
    assert.equal(v.safeText, advice);
  }
});

Deno.test('CON-ABSENCE-005: absence language naming nothing checkable is left alone', () => {
  const v = absence("You're missing a little contrast here.", NO_CENSUS);
  assert.equal(v.conflictDetected, false, 'this guard removes unprovable claims, not hedged phrasing');
});

// C. Authoritative census + category genuinely absent -> may pass.
Deno.test('CON-ABSENCE-005: an exhaustive census that shows none PERMITS the claim', () => {
  for (const claim of [
    "You don't currently have outerwear in your Closet.",
    'Your Closet has no outerwear.',
    'You have no coats.',
  ]) {
    const v = absence(claim, EMPTY_OUTERWEAR_CENSUS);
    assert.equal(v.conflictDetected, false, `grounded absence wrongly removed: ${claim}`);
  }
});

// D. Authoritative census + category present -> the same claim must fail.
Deno.test('CON-ABSENCE-005: a census that CONTRADICTS the claim rejects it', () => {
  const v = absence("You don't currently have outerwear in your Closet.", HAS_OUTERWEAR_CENSUS);
  assert.equal(v.conflictDetected, true, 'the census says the Closet holds outerwear');
  assert.ok(v.conflictCodes.some((c) => c.startsWith('contradicted_absent_')));
});

Deno.test('CON-ABSENCE-005: a non-exhaustive census is NOT provenance', () => {
  // censusAvailable folds in exhaustive + nothing-unclassified. A caller that
  // could not establish those must pass false, and then nothing is provable.
  const v = absence('Your Closet has no outerwear.', { censusAvailable: false, presentSubjects: ['shirt'] });
  assert.equal(v.conflictDetected, true);
});

Deno.test('CON-ABSENCE-005: only the offending sentence goes, never the advice with it', () => {
  const v = absence(
    "You don't have any outerwear in your Closet. A tailored overcoat would finish this well.",
    NO_CENSUS,
  );
  assert.equal(v.conflictDetected, true);
  assert.doesNotMatch(v.safeText, /don.t have any outerwear/i);
  assert.match(v.safeText, /A tailored overcoat would finish this well\./);
});

Deno.test('CON-ABSENCE-005: singular and plural subjects resolve the same', () => {
  // The CON-PROSE-004 variant resolver is shared, so "shoes" cannot be a claim
  // the ownership half can see and the absence half cannot.
  for (const claim of ['You have no shoes.', 'You have no shoe.', 'You have no dresses.']) {
    assert.equal(absence(claim, NO_CENSUS).conflictDetected, true, claim);
  }
});

Deno.test('CON-ABSENCE-005: a free-form census token still matches the claim subject', () => {
  // Census tokens are free-form manual entry ("Outerwear", "Coats"), so they go
  // through the same resolver as the sentence rather than a raw string compare.
  const v = absence('Your Closet has no outerwear.', {
    censusAvailable: true,
    presentSubjects: ['Outerwear'],
  });
  assert.equal(v.conflictDetected, true, 'a differently-cased census token must still contradict');
});

// E. Base Elise regression — a whole no-census answer must survive intact.
Deno.test('CON-ABSENCE-005: a full Base Elise answer is untouched without a census', () => {
  // The shape a non-K+ turn actually returns: useful, specific, and making no
  // claim about what the customer does or does not own. If this ever starts
  // being sanitized, the guard has become a Base Elise outage.
  const answer = [
    'For a smart dinner, pair tailored trousers with a crisp button-down shirt.',
    'A structured blazer instantly elevates the silhouette.',
    'Finish with sleek leather loafers or ankle boots.',
    'Consider adding outerwear for cooler weather.',
    'A blazer is another option.',
  ].join(' ');
  const v = absence(answer, NO_CENSUS);
  assert.equal(v.conflictDetected, false, 'Base Elise must not depend on K+ or on a census');
  assert.equal(v.safeText, answer, 'the answer must survive byte-for-byte');
});

Deno.test('CON-ABSENCE-005: advice survives even NEXT TO a removed absence claim', () => {
  const v = absence(
    'You currently have no jackets. A lightweight jacket could work well here.',
    NO_CENSUS,
  );
  assert.equal(v.conflictDetected, true);
  assert.doesNotMatch(v.safeText, /currently have no jackets/i);
  assert.match(v.safeText, /A lightweight jacket could work well here\./);
});

Deno.test('CON-ABSENCE-005: the three forbidden non-K+ claims are all rejected', () => {
  // Verbatim from the closure contract.
  for (const claim of [
    "You don't have a blazer.",
    'Your Closet is missing outerwear.',
    'You currently have no jackets.',
  ]) {
    assert.equal(absence(claim, NO_CENSUS).conflictDetected, true, claim);
  }
});

Deno.test('CON-ABSENCE-005: the three allowed non-K+ suggestions are all kept', () => {
  for (const advice of [
    'A lightweight jacket could work well here.',
    'Consider adding outerwear for cooler weather.',
    'A blazer is another option.',
  ]) {
    const v = absence(advice, NO_CENSUS);
    assert.equal(v.conflictDetected, false, advice);
    assert.equal(v.safeText, advice);
  }
});

/**
 * CON-ABSENCE-006 -- adverb interposition, found EMPIRICALLY on live staging.
 *
 * The Build 34 K+ entitlement / failure-state certification drove the deployed
 * stylechat-generate (integration 1a33ebe) with a non-K+ actor, an empty
 * Closet, Concierge flag OFF and therefore NO census -- the exact configuration
 * CON-ABSENCE-005 was reported on -- and Elise answered:
 *
 *   "Based on your available items, your wardrobe is CURRENTLY missing
 *    foundational pieces across core bases, bottoms, layering pieces,
 *    footwear, and accessories."
 *
 * #257 had already identified this defect class ("you CURRENTLY have no
 * jackets" defeats `you\s+have`) and widened exactly ONE pattern for it. Every
 * sibling kept the gap, so five of the seven assertion shapes still admitted
 * any adverb between subject and verb. The subject vocabulary was never the
 * problem -- "bottoms", "footwear" and "accessories" are all already census
 * nouns; the sentence simply was not recognised as an assertion at all.
 *
 * Both directions, per section 34: the false claim must go, and ordinary advice
 * that merely contains an adverb must survive untouched.
 */
Deno.test('CON-ABSENCE-006: the verbatim live-staging sentence is rejected without a census', () => {
  const live =
    'Based on your available items, your wardrobe is currently missing foundational pieces '
    + 'across core bases, bottoms, layering pieces, footwear, and accessories.';
  const v = absence(live, NO_CENSUS);
  assert.equal(v.conflictDetected, true, 'the live sentence must be recognised as an absence claim');
  assert.doesNotMatch(v.safeText, /currently missing/i);
});

Deno.test('CON-ABSENCE-006: an interposed adverb defeats no assertion shape', () => {
  // One bare form and one adverbed form of every shape the guard covers. The
  // bare forms already passed before this repair; the adverbed ones did not.
  for (const claim of [
    'You do not own outerwear.',
    'You do not currently own outerwear.',
    'You have no jackets.',
    'You apparently have no jackets.',
    'You are missing outerwear.',
    'You are currently missing outerwear.',
    'You lack outerwear.',
    'You currently lack outerwear.',
    'Your closet does not contain outerwear.',
    'Your closet does not currently contain outerwear.',
    'Your closet has no outerwear.',
    'Your closet currently has no outerwear.',
    'Your wardrobe is missing footwear.',
    'Your wardrobe is currently missing footwear.',
    'Your closet is still missing outerwear.',
  ]) {
    assert.equal(absence(claim, NO_CENSUS).conflictDetected, true, claim);
  }
});

Deno.test('CON-ABSENCE-006: "is lacking" is the same claim as "is missing"', () => {
  assert.equal(absence('Your wardrobe is lacking footwear.', NO_CENSUS).conflictDetected, true);
  assert.equal(absence('Your closet is currently lacking outerwear.', NO_CENSUS).conflictDetected, true);
});

Deno.test('CON-ABSENCE-006: the adverb slot never turns ordinary advice into a false positive', () => {
  // Every one of these contains an adverb, several contain a negation, and not
  // one of them asserts anything about what the Closet holds.
  for (const advice of [
    'You do not have to wear a jacket.',
    'A navy blazer is genuinely versatile for most wedding dress codes.',
    'You can absolutely style a blazer with almost anything.',
    'No two outfits have to look alike.',
    'You have plenty of great options here.',
    'I want you to have fun with this look.',
    'If you scan the blazers you have, I can help you choose.',
    'Layering works especially well in cooler weather.',
  ]) {
    const v = absence(advice, NO_CENSUS);
    assert.equal(v.conflictDetected, false, advice);
    assert.equal(v.safeText, advice, advice);
  }
});

Deno.test('CON-ABSENCE-006: census authority still decides, in both directions', () => {
  // A TRUE absence backed by an exhaustive census survives WITH the adverb.
  const permitted = absence('Your wardrobe is currently missing outerwear.', EMPTY_OUTERWEAR_CENSUS);
  assert.equal(permitted.conflictDetected, false);
  assert.equal(permitted.safeText, 'Your wardrobe is currently missing outerwear.');
  // The same adverbed shape CONTRADICTED by the census is still removed --
  // widening the pattern must not have widened what counts as permission.
  const refused = absence('Your wardrobe is currently missing outerwear.', HAS_OUTERWEAR_CENSUS);
  assert.equal(refused.conflictDetected, true);
  assert.doesNotMatch(refused.safeText, /currently missing outerwear/i);
});
