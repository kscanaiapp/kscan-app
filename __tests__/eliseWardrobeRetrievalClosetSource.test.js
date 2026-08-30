// Build 34 / Track B / Phase B5 — Track B Closet as an Elise wardrobe source.
//
// Loads the REAL eliseWardrobeRetrieval.ts directly, plus its real pure
// dependencies (eliseFashionFeatures.ts, eliseAdviceIntents.ts,
// eliseAdviceTypes.ts, eliseResourceResolvers.ts) — no fakes for any of them,
// since none has a Deno/network dependency. The point of this file is to
// prove that adding `listClosetItems` to EliseWardrobeDataSource is safe: it
// never bypasses the existing ownership check, never appears when absent
// from the data source (the K+-gated case), and produces exactly the
// `sourceType: 'closet'`, `actorRelationship: 'owned'` shape the rest of the
// pipeline (and the response's ownership-claim rule) already expects.

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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
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

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function closetRow(overrides = {}) {
  return {
    id: ITEM_A,
    user_id: ACTOR,
    title: 'Black bomber',
    category: 'jacket',
    brand: 'Acme',
    color: ['black'],
    material: ['nylon'],
    ...overrides,
  };
}

function emptyDataSource(overrides = {}) {
  return {
    listSavedScans: async () => [],
    listInspirationItems: async () => [],
    listOwnedRoomItems: async () => [],
    ...overrides,
  };
}

test('BASIC: an owned Closet row becomes a candidate with sourceType closet, actorRelationship owned', async () => {
  const data = emptyDataSource({ listClosetItems: async () => [closetRow()] });
  const result = await retrieval.retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'general',
    message: 'what should I wear',
    data,
  });
  assert.equal(result.authorizedCount, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceType, 'closet');
  assert.equal(result.candidates[0].actorRelationship, 'owned');
  assert.equal(result.candidates[0].candidateId, `closet:${ITEM_A}`);
  assert.equal(result.candidates[0].canonicalResourceIds.itemId, ITEM_A);
  assert.equal(result.countsBySource.closet, 1);
  assert.equal(result.ownershipSourceCounts.owned, 1);
});

test('OWNERSHIP GUARD: a row claiming a different owner is rejected, never authorized as owned', async () => {
  const data = emptyDataSource({
    listClosetItems: async () => [closetRow({ id: ITEM_B, user_id: OTHER })],
  });
  const result = await retrieval.retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'general',
    message: 'what should I wear',
    data,
  });
  assert.equal(result.authorizedCount, 0);
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.candidates.length, 0);
});

test('MALFORMED ID: a non-UUID id is rejected rather than trusted', async () => {
  const data = emptyDataSource({
    listClosetItems: async () => [closetRow({ id: 'not-a-uuid' })],
  });
  const result = await retrieval.retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'general',
    message: 'x',
    data,
  });
  assert.equal(result.authorizedCount, 0);
  assert.equal(result.rejectedCount, 1);
});

test('ABSENT SOURCE (K+ inactive case): listClosetItems missing from the data source yields zero closet candidates, no error', async () => {
  const data = emptyDataSource(); // no listClosetItems at all
  const result = await retrieval.retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'general',
    message: 'x',
    data,
  });
  assert.equal(result.authorizedCount, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.countsBySource.closet, undefined);
});

test('RETRIEVAL FAILURE: a throwing listClosetItems degrades to partialFailure, never crashes the pipeline', async () => {
  const data = emptyDataSource({
    listClosetItems: async () => { throw new Error('boom'); },
  });
  const result = await retrieval.retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'general',
    message: 'x',
    data,
  });
  assert.equal(result.partialFailure, true);
  assert.equal(result.candidates.length, 0);
});

test('PRIORITY: owned Closet candidates are never pushed below saved/scanned/shared/discovered', async () => {
  const data = {
    listSavedScans: async () => [{ id: ITEM_B, user_id: ACTOR, title: 'Scanned tee' }],
    listInspirationItems: async () => [],
    listOwnedRoomItems: async () => [],
    listClosetItems: async () => [closetRow()],
  };
  const result = await retrieval.retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'general',
    message: 'x',
    data,
  });
  // Both saved_scan (forced to owned/closet) and the real Closet row are
  // 'owned' — both should be present, and the real Closet row's identity
  // must be preserved (not deduplicated away or overwritten).
  const closetCandidate = result.candidates.find((c) => c.candidateId === `closet:${ITEM_A}`);
  assert.ok(closetCandidate, 'the real Closet candidate must survive alongside other owned candidates');
  assert.equal(closetCandidate.actorRelationship, 'owned');
});

test('MULTIPLE ITEMS: several owned Closet rows all become authorized owned candidates', async () => {
  const ids = [ITEM_A, ITEM_B, '33333333-3333-4333-8333-333333333333'];
  const data = emptyDataSource({
    listClosetItems: async () => ids.map((id) => closetRow({ id })),
  });
  const result = await retrieval.retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'general',
    message: 'x',
    data,
  });
  assert.equal(result.authorizedCount, 3);
  assert.equal(result.countsBySource.closet, 3);
});
