// Track B B1A-B5 hostile audit — Elise ownership grounding.
//
// THE INVARIANT UNDER TEST (audit sections 26 and 85):
//   Elise may describe an item as OWNED only when the evidence is a
//   server-authorized Track B Closet row. No other wardrobe source may be
//   promoted into `actorRelationship: 'owned'` or `sourceType: 'closet'`.
//
// This file exists because retrieveAuthorizedWardrobeCandidates' saved-scan
// branch unconditionally overwrote the relationship it had just derived:
//
//     actorRelationship: 'scanned'   ->   candidate.actorRelationship = 'owned'
//     sourceType:        'saved_scan' ->  candidate.sourceType = 'closet'
//
// so every saved scan — a shop window, a screenshot, someone else's outfit —
// reached the prompt carrying ownershipLanguageLabel('owned'), "You already
// have", and was counted under the same `closet` source bucket as the
// authoritative Track B Closet. That directly contradicted this repository's
// own governing provenance rule, asserted in
// supabase/functions/stylechat-generate/attachmentOwnership.test.ts:
// "saved_scan attachment (camera / gallery / recent scan) is scanned, never
// owned".
//
// Loads the REAL modules (no fakes for any pure dependency), the same way
// __tests__/eliseWardrobeRetrievalClosetSource.test.js does.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DIR = 'supabase/functions/stylechat-generate';

function loadTsModule(rel, requireMap = {}) {
  const filename = path.join(ROOT, rel);
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    out,
    {
      console,
      exports: module.exports,
      module,
      Date, Math, Number, Object, Array, JSON, String, Boolean, Map, Set, Promise,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        throw new Error(`Unexpected require in ${rel}: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

const resourceResolvers = loadTsModule(`${DIR}/eliseResourceResolvers.ts`);
const adviceTypes = loadTsModule(`${DIR}/eliseAdviceTypes.ts`);
const fashionFeatures = loadTsModule(`${DIR}/eliseFashionFeatures.ts`);
const adviceIntents = loadTsModule(`${DIR}/eliseAdviceIntents.ts`, {
  './eliseAdviceTypes.ts': adviceTypes,
});
const retrieval = loadTsModule(`${DIR}/eliseWardrobeRetrieval.ts`, {
  './eliseResourceResolvers.ts': resourceResolvers,
  './eliseFashionFeatures.ts': fashionFeatures,
  './eliseAdviceTypes.ts': adviceTypes,
  './eliseAdviceIntents.ts': adviceIntents,
});

const { retrieveAuthorizedWardrobeCandidates } = retrieval;
const { ownershipLanguageLabel } = fashionFeatures;

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SCAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLOSET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ROOM_ITEM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SHARED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ROOM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function dataSource(overrides = {}) {
  return {
    listSavedScans: async () => [],
    listInspirationItems: async () => [],
    listOwnedRoomItems: async () => [],
    ...overrides,
  };
}

function retrieve(overrides, extra = {}) {
  return retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'build_outfit',
    message: 'what should I wear tonight',
    data: dataSource(overrides),
    ...extra,
  });
}

const byId = (result, prefix) =>
  result.candidates.find((c) => c.candidateId.startsWith(prefix)) ?? null;

// ── The defect this file closes ─────────────────────────────────────────────

test('OWNERSHIP: a saved scan is scanned, never owned, and never sourced as closet', async () => {
  const result = await retrieve({
    listSavedScans: async () => [
      { id: SCAN, user_id: ACTOR, title: 'Shop window screenshot', analysis_result: {} },
    ],
  });

  const candidate = byId(result, 'saved_scan:');
  assert.ok(candidate, 'the saved scan is still retrieved — this is not a removal');
  assert.equal(candidate.actorRelationship, 'scanned');
  assert.notEqual(candidate.actorRelationship, 'owned');
  assert.equal(candidate.sourceType, 'saved_scan');
  assert.notEqual(candidate.sourceType, 'closet');
});

test('OWNERSHIP: a saved scan never reaches the prompt with owning language', async () => {
  const result = await retrieve({
    listSavedScans: async () => [{ id: SCAN, user_id: ACTOR, title: 'Someone else’s coat' }],
  });
  const label = ownershipLanguageLabel(byId(result, 'saved_scan:').actorRelationship);
  assert.equal(label, 'The item you scanned');
  assert.notEqual(label, 'You already have');
});

test('OWNERSHIP: source and relationship counters do not conflate scans with the Closet', async () => {
  const result = await retrieve({
    listSavedScans: async () => [{ id: SCAN, user_id: ACTOR, title: 'Scanned jacket' }],
    listClosetItems: async () => [
      { id: CLOSET, user_id: ACTOR, title: 'Owned jacket', category: 'jacket' },
    ],
  });

  assert.equal(result.countsBySource.closet, 1, 'only the real Closet row counts as closet');
  assert.equal(result.countsBySource.saved_scan, 1);
  assert.equal(result.ownershipSourceCounts.owned, 1, 'exactly one owned candidate');
  assert.equal(result.ownershipSourceCounts.scanned, 1);
});

// ── Negative controls: the one source that IS owned still is ────────────────

test('NEGATIVE CONTROL: an authorized Track B Closet row is still owned/closet', async () => {
  const result = await retrieve({
    listClosetItems: async () => [
      { id: CLOSET, user_id: ACTOR, title: 'Black bomber', category: 'jacket' },
    ],
  });
  const candidate = byId(result, 'closet:');
  assert.ok(candidate);
  assert.equal(candidate.actorRelationship, 'owned');
  assert.equal(candidate.sourceType, 'closet');
  assert.equal(ownershipLanguageLabel(candidate.actorRelationship), 'You already have');
});

test("NEGATIVE CONTROL: another account's Closet row is rejected, not relabelled", async () => {
  const result = await retrieve({
    listClosetItems: async () => [{ id: CLOSET, user_id: OTHER, title: 'Not mine' }],
  });
  assert.equal(byId(result, 'closet:'), null);
  assert.ok(result.rejectedCount >= 1);
  assert.equal(result.ownershipSourceCounts.owned, undefined);
});

// ── Every other source keeps its own truthful relationship ──────────────────

test('OWNERSHIP: inspiration is saved, a shared room item is shared, neither is owned', async () => {
  const result = await retrieve(
    {
      listInspirationItems: async () => [{ id: INSP, user_id: ACTOR, category: 'skirt' }],
      listSharedRoomItems: async () => [
        { id: SHARED, room_id: ROOM, category: 'bag', __shared_access: true },
      ],
    },
    { includeShared: true },
  );

  assert.equal(byId(result, 'inspiration:').actorRelationship, 'saved');
  assert.equal(byId(result, 'shared_room:').actorRelationship, 'shared');
  assert.equal(result.ownershipSourceCounts.owned, undefined);
});

test('OWNERSHIP: an unknown-provenance dressing room item stays unverified', async () => {
  const result = await retrieve({
    listOwnedRoomItems: async () => [
      { id: ROOM_ITEM, room_id: ROOM, category: 'shoes', __room_owned_by_actor: true },
    ],
  });
  assert.equal(byId(result, 'owned_room:').actorRelationship, 'unverified');
  assert.equal(result.ownershipSourceCounts.owned, undefined);
});

test('OWNERSHIP: with no Closet source at all, nothing in the result claims ownership', async () => {
  const result = await retrieve(
    {
      listSavedScans: async () => [{ id: SCAN, user_id: ACTOR, title: 'Scanned' }],
      listInspirationItems: async () => [{ id: INSP, user_id: ACTOR, category: 'top' }],
      listOwnedRoomItems: async () => [
        { id: ROOM_ITEM, room_id: ROOM, source_type: 'product_match', __room_owned_by_actor: true },
      ],
    },
    { includeShared: false },
  );
  assert.deepEqual(
    result.candidates.filter((c) => c.actorRelationship === 'owned'),
    [],
    'a K+ user with no synced Closet has no owned evidence, and Elise must not invent any',
  );
});

// ── Source-level guard against the exact regression shape ───────────────────

test('OWNERSHIP: the retrieval source contains no post-hoc relationship promotion', () => {
  const source = fs.readFileSync(path.join(ROOT, DIR, 'eliseWardrobeRetrieval.ts'), 'utf8');
  assert.doesNotMatch(
    source,
    /candidate\.actorRelationship\s*=\s*['"]owned['"]/,
    'a candidate must never be reassigned to owned after normalization',
  );
  assert.doesNotMatch(
    source,
    /candidate\.sourceType\s*=\s*['"]closet['"]/,
    "a candidate must never be reassigned to the Closet source after normalization",
  );
});
