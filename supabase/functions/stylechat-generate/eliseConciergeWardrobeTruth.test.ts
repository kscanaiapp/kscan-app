/**
 * Build 34 / K+ Wardrobe Concierge -- DEEP WARDROBE-TRUTH AUDIT (2026-09-02).
 *
 * The invariant this file exists to hold is one sentence:
 *
 *     A claim about what the customer's Closet CONTAINS or LACKS may only be
 *     made from evidence that actually proves it.
 *
 * The 2026-08-30 audit closed the "bounded shortlist spoken as whole Closet"
 * half of that. This file closes three ways the same falsehood was still
 * reachable, each of which arrives through a path that LOOKS like proof:
 *
 *   WC-001  an unreadable Closet returning `[]` reads as a proven-empty one
 *   WC-002  a category map truncated to its top-N slice read negatively
 *   WC-003  the ownership guard disabled by the flag the product ships OFF
 *
 * Kept separate from eliseConciergeV1Hostile.test.ts so each audit's evidence
 * stays independently attributable.
 */
import assert from 'node:assert/strict';

import {
  buildClosetCensus,
  censusConfirmedAbsentCategories,
  censusConfirmsRoleAbsent,
  censusLicensesAbsenceClaims,
  CENSUS_ROW_CAP,
} from './eliseClosetCensus.ts';
import { wardrobeRowsOrThrow } from './eliseWardrobeRetrieval.ts';
import { analyzeWardrobeGap } from './eliseWardrobeGap.ts';
import { enforceClosetAbsenceProseSafety } from './eliseOwnershipProseSafety.ts';
import { normalizeWardrobeCandidate } from './eliseFashionFeatures.ts';
import type { EliseFocusedItem, EliseScoredCandidate } from './eliseAdviceTypes.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';

/** An owned Closet candidate, scored, as the retrieval layer would produce it. */
function ownedScored(input: {
  id: string;
  title: string;
  category: string;
  color: string;
}): EliseScoredCandidate {
  return {
    candidate: normalizeWardrobeCandidate({
      candidateId: `closet:${input.id}`,
      sourceType: 'closet',
      actorRelationship: 'owned',
      row: {
        id: input.id,
        user_id: ACTOR,
        title: input.title,
        category: input.category,
        color: [input.color],
      },
      canonicalResourceIds: { itemId: input.id },
    }),
    score: {
      total: 0.8,
      dimensions: {
        categoryRole: 0.5,
        colorHarmony: 0.5,
        silhouetteBalance: 0.5,
        materialTexture: 0.5,
        formality: 0.5,
        season: 0.5,
        occasion: 0.5,
        signatureStyle: 0.5,
        ownershipPriority: 1,
        redundancyPenalty: 0.7,
      },
      reasons: [],
      warnings: [],
    },
    recommendationRole: 'primary',
  };
}

/**
 * The exact WC-001 shape: the RETRIEVAL query succeeded (so the turn holds real
 * owned evidence) while the CENSUS query failed. Pre-repair, the failure became
 * `[]` and the census reported the Closet provably empty.
 */
const RETRIEVAL_SUCCEEDED = [
  ownedScored({ id: '33333333-3333-4333-8333-333333333333', title: 'Black blazer', category: 'blazer', color: 'black' }),
  ownedScored({ id: '44444444-4444-4444-8444-444444444444', title: 'Navy trousers', category: 'trousers', color: 'navy' }),
  ownedScored({ id: '55555555-5555-4555-8555-555555555555', title: 'Brown loafers', category: 'loafers', color: 'brown' }),
];

const NO_FOCUS: EliseFocusedItem = {
  evidenceId: null,
  actorRelationship: 'unknown',
  candidate: null,
  resolution: 'none',
};

/** The subject vocabulary the absence guard resolves, as index.ts supplies it. */
function presentSubjectsOf(census: {
  countsByCategory: Record<string, number>;
  countsByLayeringRole: Record<string, number>;
}): string[] {
  const out: string[] = [];
  for (const source of [census.countsByCategory, census.countsByLayeringRole]) {
    for (const [token, count] of Object.entries(source ?? {})) {
      if (count > 0) out.push(token);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// WC-001 -- an UNREADABLE Closet is not an EMPTY Closet.
//
// supabase-js resolves a failed query as `{ data: null, error }`; it does not
// throw. `return data ?? []` therefore made a database error indistinguishable
// from a genuinely empty table -- and the census reads an empty table as PROOF
// that the customer owns nothing, which is the strongest absence licence in the
// system. A statement timeout on the census scan, a revoked grant, a connection
// reset: any of them turned into "Your Closet doesn't have shoes yet."
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('WC-001: a failed wardrobe read throws instead of reporting no rows', () => {
  assert.throws(
    () => wardrobeRowsOrThrow({ data: null, error: { code: '42501' } }, 'user_closet_census'),
    /wardrobe_source_unavailable:user_closet_census/,
  );
});

Deno.test('WC-001: the thrown error carries the source only, never the database message', () => {
  // A Postgres error string can quote row values. It must not become the text of
  // an exception that a future log line or telemetry field might widen.
  const secret = 'duplicate key value violates unique constraint "Navy Wool Trousers"';
  try {
    wardrobeRowsOrThrow({ data: null, error: { message: secret } }, 'user_closet_items');
    assert.fail('expected a throw');
  } catch (error) {
    assert.match(String(error), /wardrobe_source_unavailable:user_closet_items/);
    assert.ok(!String(error).includes('Navy Wool Trousers'));
  }
});

Deno.test('WC-001: a genuinely empty Closet still returns no rows, and stays provable', () => {
  // The repair must not cost the true zero case its meaning: an actually-empty
  // Closet is still exhaustively empty, and may still be spoken about.
  const rows = wardrobeRowsOrThrow<{ category: string }>({ data: [], error: null }, 'x');
  assert.deepEqual(rows, []);
  const census = buildClosetCensus({ rows, rowCap: CENSUS_ROW_CAP });
  assert.equal(census.exhaustive, true);
  assert.equal(census.totalItems, 0);
  assert.equal(censusLicensesAbsenceClaims(census), true);
});

Deno.test('WC-001: the empty-census shape is what licenses a confident absence claim', () => {
  // This is the consequence the repair prevents, demonstrated on the object the
  // pre-repair code would have built out of a FAILED query.
  const censusFromFailedQuery = buildClosetCensus({ rows: [], rowCap: CENSUS_ROW_CAP });

  const licensed = analyzeWardrobeGap({
    focus: NO_FOCUS,
    shortlist: RETRIEVAL_SUCCEEDED,
    inventoryCount: RETRIEVAL_SUCCEEDED.length,
    census: censusFromFailedQuery,
    conciergeV1: true,
  });
  // "Your Closet doesn't have a top or an accessory yet." -- stated as fact,
  // about a customer whose Closet the turn could not read at all.
  assert.equal(licensed.evidenceIsExhaustive, true);
  assert.ok(licensed.gapCodes.length > 0);

  // With the repair the same failure yields NO census, and the identical turn
  // can only speak about what it reviewed.
  const withoutCensus = analyzeWardrobeGap({
    focus: NO_FOCUS,
    shortlist: RETRIEVAL_SUCCEEDED,
    inventoryCount: RETRIEVAL_SUCCEEDED.length,
    census: null,
    conciergeV1: true,
  });
  assert.equal(withoutCensus.evidenceIsExhaustive, false);
  assert.ok(withoutCensus.notes.includes('gap_evidence_bounded_scope_language_required'));
});

Deno.test('WC-001: no census means the prose guard removes the absence sentence', () => {
  const text = 'You do not own a jacket. A structured shoulder would suit you.';

  const guardedWithoutCensus = enforceClosetAbsenceProseSafety({
    text,
    evidence: { censusAvailable: false, presentSubjects: [] },
    neutralFallback: 'Here are some options to consider for this look.',
  });
  assert.equal(guardedWithoutCensus.conflictDetected, true);
  assert.ok(!guardedWithoutCensus.safeText.includes('do not own a jacket'));
  assert.ok(guardedWithoutCensus.safeText.includes('structured shoulder'));

  // And the failed-query census shape would have let it straight through.
  const failedShape = buildClosetCensus({ rows: [], rowCap: CENSUS_ROW_CAP });
  const guardedWithFalseProof = enforceClosetAbsenceProseSafety({
    text,
    evidence: {
      censusAvailable: censusLicensesAbsenceClaims(failedShape),
      presentSubjects: presentSubjectsOf(failedShape),
    },
    neutralFallback: 'Here are some options to consider for this look.',
  });
  assert.equal(guardedWithFalseProof.conflictDetected, false);
});

Deno.test('WC-001: every wardrobe source in the advice block routes through the guard', async () => {
  // A behavioural test cannot reach these closures -- they are built inline
  // against a live Supabase client -- so the wiring is asserted on the source.
  // The claim is narrow and mechanical: inside the advice data source, no query
  // may discard `error` by destructuring `data` alone.
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const start = source.indexOf('const wardrobeData: EliseWardrobeDataSource = {');
  assert.ok(start > 0, 'advice wardrobe data source not found');
  const end = source.indexOf('let closetCensus: EliseClosetCensus | null = null;', start);
  assert.ok(end > start, 'end of advice wardrobe data source not found');
  const block = source.slice(start, end);

  // Every read in the block is either guarded or an access-resolution read that
  // already handles `error` explicitly. Exactly one qualifies for the latter:
  // the shared-room MEMBERSHIP lookup, where an error genuinely means "no
  // access" and returning no shares is the fail-closed answer.
  const withoutMembershipLookup = block.replace(
    /const \{ data: memberships, error \} = await userClient[\s\S]*?if \(error\) return \[\];/g,
    '',
  );
  const unguarded = [
    ...withoutMembershipLookup.matchAll(/const \{ data(?::\s*\w+)? \} = await userClient/g),
  ];
  assert.deepEqual(
    unguarded.map((m) => m[0]),
    [],
    'a wardrobe query discards its error and would report a failed read as an empty Closet',
  );
  assert.ok(block.includes("wardrobeRowsOrThrow(await userClient"));
  // The two authoritative Closet reads specifically.
  assert.ok(/listClosetItems[\s\S]{0,400}?wardrobeRowsOrThrow/.test(block));
  assert.ok(/listClosetCensusRows[\s\S]{0,600}?wardrobeRowsOrThrow/.test(block));
});

// ─────────────────────────────────────────────────────────────────────────────
// WC-002 -- a TRUNCATED category map cannot be read negatively.
//
// `countsByCategory` is bounded to the largest `censusCategories` entries so the
// census result cannot smuggle Closet shape. `clothing_type` is free-form, so a
// large Closet easily carries more distinct values than that. Every dropped
// category then looked exactly like a category the customer owns none of --
// and `presentSubjects` is built from precisely that map.
// ─────────────────────────────────────────────────────────────────────────────

/** A Closet with `distinct` classifiable garment types, `bulk` copies each. */
function wideCloset(distinct: number, bulk: number) {
  const rows: Array<{ clothing_type: string }> = [];
  for (let i = 0; i < distinct; i += 1) {
    // All map to a layering role, so `unclassifiedItems` stays 0 and the census
    // is honest by every OTHER measure -- isolating the truncation.
    for (let n = 0; n < bulk; n += 1) rows.push({ clothing_type: `shirt ${i}` });
  }
  return rows;
}

Deno.test('WC-002: a Closet with more categories than the bound is marked truncated', () => {
  const wide = buildClosetCensus({ rows: wideCloset(41, 2), rowCap: CENSUS_ROW_CAP });
  assert.equal(wide.exhaustive, true, 'the row page was still complete');
  assert.equal(wide.unclassifiedItems, 0, 'every row still classified');
  assert.equal(wide.categoriesTruncated, true);
  assert.equal(Object.keys(wide.countsByCategory).length, 40);

  const narrow = buildClosetCensus({ rows: wideCloset(40, 2), rowCap: CENSUS_ROW_CAP });
  assert.equal(narrow.categoriesTruncated, false);
  assert.equal(censusLicensesAbsenceClaims(narrow), true);
});

Deno.test('WC-002: a truncated census licenses no absence claim at all', () => {
  const wide = buildClosetCensus({ rows: wideCloset(41, 2), rowCap: CENSUS_ROW_CAP });
  assert.equal(censusLicensesAbsenceClaims(wide), false);
  assert.deepEqual(censusConfirmedAbsentCategories(wide, ['shoes', 'outerwear']), []);
});

Deno.test('WC-002: a garment the truncation dropped is no longer spoken as absent', () => {
  // 40 heavily-stocked shirt types plus ONE scarf. The scarf is genuinely owned,
  // classifies cleanly, and is exactly the entry the top-N slice discards.
  const rows = [...wideCloset(40, 5), { clothing_type: 'scarf' }];
  const census = buildClosetCensus({ rows, rowCap: CENSUS_ROW_CAP });
  assert.equal(census.categoriesTruncated, true);
  assert.ok(!('scarf' in census.countsByCategory), 'the scarf was dropped by the bound');

  const verdict = enforceClosetAbsenceProseSafety({
    text: "You don't own a scarf. Try a contrast texture instead.",
    evidence: {
      censusAvailable: censusLicensesAbsenceClaims(census),
      presentSubjects: presentSubjectsOf(census),
    },
    neutralFallback: 'Here are some options to consider for this look.',
  });
  assert.equal(verdict.conflictDetected, true);
  assert.ok(!verdict.safeText.includes("don't own a scarf"));
  assert.ok(verdict.safeText.includes('contrast texture'));
});

Deno.test('WC-002: role absence is still provable, because roles are never truncated', () => {
  // The repair must not cost the sound claim. Layering roles are a fixed, small
  // vocabulary counted over every row, so a wide Closet with no footwear at all
  // still PROVES the footwear role absent for the structured layer.
  const census = buildClosetCensus({ rows: wideCloset(41, 2), rowCap: CENSUS_ROW_CAP });
  assert.equal(censusConfirmsRoleAbsent(census, 'shoe'), true);
  assert.equal(censusConfirmsRoleAbsent(census, 'base'), false, 'shirts fill the base role');
});

// ─────────────────────────────────────────────────────────────────────────────
// WC-003 -- the ownership guard must not be switched off by a capability flag.
//
// `ELISE_CONCIERGE_V1_ENABLED` defaults false and is the configuration that
// ships, while `listClosetItems` is gated on K+ and closetWardrobeContextV1 --
// NOT on Concierge. So the shipping configuration had owned Closet evidence and
// no last-line ownership guard, which is the same asymmetry CON-ABSENCE-005
// closed for the absence half.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('WC-003: the ownership prose guard is gated on EVIDENCE, never on the flag', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const call = source.indexOf('const verdict = enforceOwnershipProseSafety({');
  assert.ok(call > 0, 'ownership guard call site not found');

  // The condition immediately preceding the call is the guard's gate.
  const gateStart = source.lastIndexOf('  if (', call);
  const gate = source.slice(gateStart, call);
  assert.ok(
    gate.includes('adviceShortlistForProseSafety.length > 0'),
    'the evidence gate must remain',
  );
  assert.ok(
    !gate.includes('config.flags.conciergeV1'),
    'a capability flag must not decide whether a false ownership claim may reach the customer',
  );
});

Deno.test('WC-003: the absence guard remains unconditional too', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const call = source.indexOf('const absenceVerdict = enforceClosetAbsenceProseSafety({');
  assert.ok(call > 0, 'absence guard call site not found');
  // Walk back to the enclosing statement and prove no flag test intervenes
  // between the advice block and this call.
  const blockStart = source.lastIndexOf('let absenceProseConflict = false;', call);
  assert.ok(blockStart > 0);
  const preamble = source.slice(blockStart, call);
  assert.ok(!preamble.includes('config.flags.conciergeV1'));
});
