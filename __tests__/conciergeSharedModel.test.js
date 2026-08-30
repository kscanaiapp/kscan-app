/**
 * Build 34 / K+ Wardrobe Concierge V1 — C4 shared presentation tests.
 *
 * Covers the layer BOTH platforms mount, so a behaviour proven here is proven
 * for iOS and Android at once (section 38). Platform branches add wiring and
 * navigation on top; they do not re-implement any of this.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildConciergeResult,
  toConciergeRelationship,
  EMPTY_CONCIERGE_RESULT,
} = require('../services/concierge/conciergeModel.ts');
const {
  conciergeSectionTitle,
  conciergeCardLabel,
  conciergeGapCopy,
  conciergeAmbiguityCopy,
} = require('../services/concierge/conciergeLabels.ts');
const {
  resolveConciergeImage,
  resolveConciergeImages,
} = require('../services/concierge/conciergeImageResolver.ts');

const ROOT = path.resolve(__dirname, '..');

const LOAFERS = '33333333-3333-4333-8333-333333333333';
const TROUSERS = '44444444-4444-4444-8444-444444444444';

function facts(overrides = {}) {
  return {
    title: 'Brown loafers',
    category: 'loafers',
    subtype: 'penny loafer',
    brand: 'Aldo',
    primaryColor: 'brown',
    clientId: LOAFERS,
    ...overrides,
  };
}

function metadata(overrides = {}) {
  return {
    adviceIntent: 'build_outfit',
    contractVersion: 'elise_advice_v2',
    wardrobeContextMode: 'closet',
    focusedItem: { evidenceId: null, actorRelationship: 'owned', displayFacts: facts() },
    recommendations: [
      {
        candidateId: `closet:${TROUSERS}`,
        sourceType: 'closet',
        actorRelationship: 'owned',
        recommendationRole: 'primary',
        score: 0.8,
        reasonCodes: [],
        displayFacts: facts({
          title: 'Navy trousers',
          category: 'trousers',
          subtype: 'wide leg',
          brand: null,
          primaryColor: 'navy',
          clientId: TROUSERS,
        }),
      },
    ],
    wardrobeGap: null,
    purchaseAdvice: null,
    looks: null,
    ...overrides,
  };
}

// ── projection ───────────────────────────────────────────────────────────────

test('a v1 payload renders no Concierge surface at all', () => {
  // v1 has no wardrobeContextMode. Absence must read as 'none', never as
  // "unknown, so assume Closet" — that would put Closet chrome on an answer
  // that never claimed any Closet participation.
  const result = buildConciergeResult({
    contractVersion: 'elise_advice_v1',
    recommendations: [{ candidateId: 'closet:x', actorRelationship: 'owned' }],
  });
  assert.deepEqual(result, EMPTY_CONCIERGE_RESULT);
});

test('mode "none" renders nothing even with recommendations present', () => {
  const result = buildConciergeResult(metadata({ wardrobeContextMode: 'none' }));
  assert.equal(result.presentation, 'none');
  assert.equal(result.cards.length, 0);
});

test('malformed metadata degrades to empty rather than throwing', () => {
  for (const input of [null, undefined, 'string', 42, [], { recommendations: 'nope' }]) {
    assert.doesNotThrow(() => buildConciergeResult(input));
    assert.equal(buildConciergeResult(input).presentation, 'none');
  }
});

test('a v2 closet payload projects the focus card and the recommendation cards', () => {
  const result = buildConciergeResult(metadata());
  assert.equal(result.presentation, 'closet');
  assert.equal(result.focusCard.title, 'Brown loafers');
  assert.equal(result.focusCard.isFocus, true);
  assert.equal(result.focusCard.clientId, LOAFERS);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].title, 'Navy trousers');
  assert.equal(result.cards[0].subtype, 'wide leg');
});

test('a recommendation with no display facts is DROPPED, never backfilled', () => {
  const result = buildConciergeResult(
    metadata({
      recommendations: [
        { candidateId: 'closet:a', actorRelationship: 'owned', displayFacts: facts() },
        // No displayFacts at all — a v1-shaped entry on a v2 payload.
        { candidateId: 'closet:b', actorRelationship: 'owned' },
      ],
    }),
  );
  // Section 36: dropped. The surviving card must not be duplicated to fill the
  // hole, and no placeholder identity is invented for the missing one.
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].candidateId, 'closet:a');
});

test('a card with no title, category or clientId is dropped', () => {
  const result = buildConciergeResult(
    metadata({
      recommendations: [
        {
          candidateId: 'closet:blank',
          actorRelationship: 'owned',
          displayFacts: {
            title: null, category: null, subtype: null,
            brand: null, primaryColor: null, clientId: null,
          },
        },
      ],
      focusedItem: { evidenceId: null, actorRelationship: 'owned' },
    }),
  );
  // Nothing renderable and nothing resolvable is a grey box claiming to be one
  // of the user's clothes. Better to show no card.
  assert.equal(result.presentation, 'none');
});

test('an unknown relationship becomes "unknown", never "owned"', () => {
  assert.equal(toConciergeRelationship('newly_invented_kind'), 'unknown');
  assert.equal(toConciergeRelationship(undefined), 'unknown');
  assert.equal(toConciergeRelationship(null), 'unknown');
  assert.equal(toConciergeRelationship('owned'), 'owned');
  assert.equal(toConciergeRelationship('saved'), 'saved');
});

test('look ids that no longer resolve are dropped from the group', () => {
  const result = buildConciergeResult(
    metadata({
      looks: [
        {
          lookId: 'look_1',
          label: 'casual',
          candidateIds: [`closet:${TROUSERS}`, 'closet:deleted'],
          missingPieceCodes: [],
        },
      ],
    }),
  );
  assert.equal(result.looks.length, 1);
  // The dangling id is gone; the surviving item is NOT joined by a substitute.
  assert.equal(result.looks[0].cards.length, 1);
  assert.equal(result.looks[0].cards[0].candidateId, `closet:${TROUSERS}`);
});

test('a look whose every item vanished disappears rather than rendering empty', () => {
  const result = buildConciergeResult(
    metadata({
      looks: [{ lookId: 'look_1', label: 'casual', candidateIds: ['gone:1'], missingPieceCodes: [] }],
    }),
  );
  assert.equal(result.looks.length, 0);
});

test('section 44: recommendations without looks stay a flat list', () => {
  const result = buildConciergeResult(metadata({ looks: [] }));
  assert.equal(result.cards.length, 1);
  assert.equal(result.looks.length, 0);
});

test('gap evidence defaults to non-exhaustive when the payload cannot say', () => {
  const result = buildConciergeResult(
    metadata({
      wardrobeGap: {
        gapCodes: ['missing_shoe'],
        categories: ['shoes'],
        partialInventory: true,
        notes: [],
      },
    }),
  );
  // A payload with no evidenceIsExhaustive is an older one. Treating it as
  // exhaustive would upgrade a bounded finding into a certainty.
  assert.equal(result.gapEvidenceIsExhaustive, false);
  assert.deepEqual(result.gapCodes, ['missing_shoe']);
});

test('focus ambiguity survives projection', () => {
  const result = buildConciergeResult(
    metadata({
      focusedItem: { evidenceId: null, actorRelationship: 'owned' },
      focusAmbiguity: { ambiguous: true, candidateIds: ['a', 'b'], sharedCategory: 'jacket' },
    }),
  );
  assert.equal(result.focusAmbiguous, true);
  assert.equal(result.focusAmbiguousCategory, 'jacket');
});

// ── labels (section 42) ──────────────────────────────────────────────────────

test('section 42: an all-owned section is headed, and its cards carry no badge', () => {
  assert.equal(conciergeSectionTitle('closet'), 'From your Closet');
  // The heading is the ownership signal. A per-item chip here would be the
  // "K+ badge on every item" the section rules out.
  assert.equal(conciergeCardLabel('owned', 'closet'), null);
});

test('mixed evidence is never headed "From your Closet"', () => {
  const title = conciergeSectionTitle('mixed');
  assert.notEqual(title, 'From your Closet');
  assert.equal(typeof title, 'string');
  // With mixed evidence the heading cannot speak for every card, so each one
  // states its own relationship.
  assert.equal(conciergeCardLabel('owned', 'mixed'), 'In your Closet');
});

test('non-owned relationships never read as ownership', () => {
  for (const relationship of ['saved', 'scanned', 'shared', 'discovered']) {
    const label = conciergeCardLabel(relationship, 'mixed');
    assert.equal(typeof label, 'string');
    assert.equal(/your closet/i.test(label), false, `${relationship} must not claim the Closet`);
    assert.equal(/you own|you have/i.test(label), false);
  }
});

test('unknown ownership says nothing rather than guessing', () => {
  assert.equal(conciergeCardLabel('unknown', 'mixed'), null);
  assert.equal(conciergeCardLabel('unverified', 'mixed'), null);
});

test('section 27: gap copy is a certainty only with exhaustive evidence', () => {
  const bounded = conciergeGapCopy({ gapCodes: ['missing_shoe'], evidenceIsExhaustive: false });
  assert.equal(/didn't find/i.test(bounded), true);
  assert.equal(/you don'?t own|doesn'?t have/i.test(bounded), false);

  const exhaustive = conciergeGapCopy({ gapCodes: ['missing_shoe'], evidenceIsExhaustive: true });
  assert.equal(/doesn'?t have/i.test(exhaustive), true);
});

test('no gap codes produces no gap copy at all', () => {
  assert.equal(conciergeGapCopy({ gapCodes: [], evidenceIsExhaustive: true }), null);
  assert.equal(conciergeGapCopy({ gapCodes: ['unknown_code'], evidenceIsExhaustive: true }), null);
});

test('section 43: no Concierge copy pressures the user to add items', () => {
  const strings = [
    conciergeSectionTitle('closet'),
    conciergeSectionTitle('mixed'),
    conciergeCardLabel('owned', 'mixed'),
    conciergeCardLabel('saved', 'mixed'),
    conciergeGapCopy({ gapCodes: ['missing_shoe'], evidenceIsExhaustive: false }),
    conciergeGapCopy({ gapCodes: ['missing_shoe'], evidenceIsExhaustive: true }),
    conciergeAmbiguityCopy('jacket'),
    conciergeAmbiguityCopy(null),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  for (const forbidden of ['add 3', 'add more', 'unlock', 'too small', 'need more', 'upgrade']) {
    assert.equal(strings.includes(forbidden), false, `Concierge copy must not say "${forbidden}"`);
  }
});

test('section 21: ambiguity copy never names one of the matches', () => {
  const copy = conciergeAmbiguityCopy('jacket');
  assert.equal(/a few/i.test(copy), true);
  // Speaks about the GROUP. Naming a specific item would be the silent
  // selection the server declined to make.
  assert.equal(/^your (black|brown|navy) /i.test(copy), false);
});

// ── image resolution (sections 39/40/45) ─────────────────────────────────────

test('section 39: a local image wins and no cloud call is made', async () => {
  let cloudCalls = 0;
  const state = await resolveConciergeImage(
    {
      resolveLocalUri: async () => 'file:///local/loafers.jpg',
      hydrateFromPrivateStore: async () => {
        cloudCalls += 1;
        return 'file:///cloud/loafers.jpg';
      },
    },
    LOAFERS,
  );
  assert.deepEqual(state, { status: 'ready', uri: 'file:///local/loafers.jpg' });
  assert.equal(cloudCalls, 0);
});

test('section 40: a device with facts but no media falls back to private storage', async () => {
  const state = await resolveConciergeImage(
    {
      resolveLocalUri: async () => null,
      hydrateFromPrivateStore: async () => 'file:///cache/loafers.jpg',
    },
    LOAFERS,
  );
  assert.deepEqual(state, { status: 'ready', uri: 'file:///cache/loafers.jpg' });
});

test('section 40: with no safe cloud media the card falls back to text', async () => {
  const state = await resolveConciergeImage({ resolveLocalUri: async () => null }, LOAFERS);
  assert.deepEqual(state, { status: 'unavailable' });
});

test('every failure mode collapses to unavailable, never an error state', async () => {
  const throwingLocal = await resolveConciergeImage(
    {
      resolveLocalUri: async () => {
        throw new Error('fs exploded');
      },
      hydrateFromPrivateStore: async () => null,
    },
    LOAFERS,
  );
  assert.deepEqual(throwingLocal, { status: 'unavailable' });

  const throwingCloud = await resolveConciergeImage(
    {
      resolveLocalUri: async () => null,
      hydrateFromPrivateStore: async () => {
        throw new Error('network exploded');
      },
    },
    LOAFERS,
  );
  assert.deepEqual(throwingCloud, { status: 'unavailable' });
});

test('a card with no clientId resolves to unavailable without any lookup', async () => {
  let calls = 0;
  const state = await resolveConciergeImage(
    {
      resolveLocalUri: async () => {
        calls += 1;
        return 'file:///nope.jpg';
      },
    },
    null,
  );
  assert.deepEqual(state, { status: 'unavailable' });
  assert.equal(calls, 0);
});

test('section 45: a deleted item resolves to unavailable, not another image', async () => {
  const state = await resolveConciergeImage(
    {
      resolveLocalUri: async (id) => (id === 'still-here' ? 'file:///a.jpg' : null),
      hydrateFromPrivateStore: async () => null,
    },
    'deleted-item',
  );
  assert.deepEqual(state, { status: 'unavailable' });
});

test('batch resolution de-duplicates and stays bounded', async () => {
  const seen = [];
  const source = {
    resolveLocalUri: async (id) => {
      seen.push(id);
      return `file:///${id}.jpg`;
    },
  };
  const ids = [LOAFERS, LOAFERS, TROUSERS, null, ...Array.from({ length: 40 }, (_, i) => `x${i}`)];
  const resolved = await resolveConciergeImages(source, ids, 5);
  // A look repeating an item must not resolve it twice, and a malformed
  // payload must not fan out into unbounded storage reads.
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert.equal(Object.keys(resolved).length, 5);
});

// ── structural guarantees ────────────────────────────────────────────────────

test('the Concierge surface never reads message prose', () => {
  // Section 32/41: wardrobe objects come from validated structured data only.
  // A reference to message text anywhere in this layer would be the start of
  // reconstructing owned items from a sentence.
  const files = [
    'services/concierge/conciergeModel.ts',
    'services/concierge/conciergeLabels.ts',
    'services/concierge/conciergeImageResolver.ts',
    'components/concierge/ConciergeEvidence.tsx',
    'components/concierge/ConciergeClosetCard.tsx',
  ];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(
      /message\.content|\.content\b|parseAssistantContent/.test(code),
      false,
      `${relative} must not read assistant prose`,
    );
  }
});

test('the Concierge presentation flag is default-OFF and separate from transport', () => {
  const source = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');
  assert.equal(
    source.includes("ELISE_CONCIERGE_V1 =\n  process.env.EXPO_PUBLIC_ELISE_CONCIERGE_V1 === 'true'"),
    true,
    'the flag must be an explicit opt-in string comparison, so absence is OFF',
  );
  // Section 14: the capability flag must not be aliased onto the transport one.
  assert.equal(
    /ELISE_CONCIERGE_V1\s*=\s*ELISE_ADVICE_METADATA_CLIENT_V1/.test(source),
    false,
  );
});
