// Private Dressing Room ↔ Elise contract — Deno-runtime coverage (Phase 4).
//
// The Node suite (__tests__/privateDressingRoomEliseContract.test.js) proves the
// mirror matches the governing source and that the validators fail closed. This
// suite proves the same module actually LOADS AND RUNS under Deno, which is the
// only runtime that will execute it in production. A mirror that is textually
// perfect but does not import under Deno would pass there and fail here.
//
// Deterministic: no network, no Supabase, no provider, no Deno.env reads.

import assert from 'node:assert/strict';

import {
  PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
  PRIVATE_ELISE_BOUNDS,
  PRIVATE_ELISE_CANDIDATE_FIELDS,
  PRIVATE_ELISE_INTENTS,
  PRIVATE_ELISE_OCCASIONS,
  PRIVATE_ELISE_STATUSES,
  buildRequestAlias,
  isAliasForRequest,
  parsePrivateEliseRequest,
  parsePrivateEliseResponse,
} from './privateDressingRoomEliseContract.ts';

const REQ = '3f9a2b1c-0000-4000-8000-000000000001';
const alias = (index: number) => buildRequestAlias(REQ, index);

function anchorRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
    requestId: REQ,
    intent: 'build_around_item',
    instruction: 'build around this',
    anchorRef: alias(1),
    candidates: [
      { ref: alias(1), slot: 'outerwear', isAnchor: true },
      { ref: alias(2), slot: 'footwear', color: 'black' },
    ],
    ...overrides,
  };
}

Deno.test('the contract loads under Deno and exposes the frozen vocabularies', () => {
  assert.equal(PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION, 'private-dressing-room-elise-v1');
  assert.deepEqual([...PRIVATE_ELISE_INTENTS], ['interpret_occasion', 'build_around_item']);
  assert.deepEqual([...PRIVATE_ELISE_STATUSES], [
    'success',
    'clarification_required',
    'unsupported',
    'invalid_request',
    'safe_failure',
  ]);
  assert.deepEqual([...PRIVATE_ELISE_OCCASIONS], [
    'Work',
    'Dinner',
    'Weekend',
    'Event',
    'Travel',
    'Smart',
  ]);
  assert.equal(PRIVATE_ELISE_BOUNDS.candidates, 20);
});

Deno.test('a valid Phase 4 request parses under Deno', () => {
  const parsed = parsePrivateEliseRequest(anchorRequest());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.intent, 'build_around_item');
  assert.equal(parsed.request.anchorRef, alias(1));
  assert.equal(parsed.request.candidates?.length, 2);
});

Deno.test('unknown schema versions and intents are rejected server-side', () => {
  const wrongVersion = parsePrivateEliseRequest(anchorRequest({ schemaVersion: 'v2' }));
  assert.equal(wrongVersion.ok, false);
  if (!wrongVersion.ok) assert.equal(wrongVersion.error, 'unsupported_schema_version');

  const wrongIntent = parsePrivateEliseRequest(anchorRequest({ intent: 'make_more_casual' }));
  assert.equal(wrongIntent.ok, false);
  if (!wrongIntent.ok) assert.equal(wrongIntent.error, 'unsupported_intent');
});

Deno.test('candidates carrying unlisted fields are rejected server-side', () => {
  for (const leak of [
    { closetItemId: 'closet-1' },
    { imageUri: 'file:///closet/1.jpg' },
    { title: 'navy blazer' },
    { actorId: 'actor-1' },
  ]) {
    const parsed = parsePrivateEliseRequest(
      anchorRequest({ candidates: [{ ref: alias(1), slot: 'outerwear', isAnchor: true, ...leak }] }),
    );
    assert.equal(parsed.ok, false, `${Object.keys(leak)[0]} must be rejected`);
    if (!parsed.ok) assert.equal(parsed.error, 'invalid_candidates');
  }
});

Deno.test('the candidate allowlist is exactly the documented field set', () => {
  assert.deepEqual([...PRIVATE_ELISE_CANDIDATE_FIELDS], [
    'ref',
    'slot',
    'category',
    'clothingType',
    'subtype',
    'color',
    'material',
    'isAnchor',
    'isLocked',
  ]);
  // Fields the authoritative Closet record does not carry are absent, so the
  // function cannot ask a provider to reason over invented metadata.
  for (const absent of ['texture', 'silhouette', 'fit', 'occasionCompatibility']) {
    assert.equal(PRIVATE_ELISE_CANDIDATE_FIELDS.includes(absent), false, `${absent} must be absent`);
  }
});

Deno.test('an oversized pool is rejected rather than silently truncated', () => {
  const candidates = Array.from({ length: 21 }, (_, index) => ({
    ref: alias(index + 1),
    slot: 'top',
  }));
  const parsed = parsePrivateEliseRequest(anchorRequest({ candidates }));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.error, 'invalid_candidates');
});

Deno.test('aliases are request-scoped and reject foreign fragments', () => {
  assert.equal(isAliasForRequest(alias(1), REQ), true);
  assert.equal(isAliasForRequest('item_deadbeef_1', REQ), false);
  assert.equal(isAliasForRequest('closet-item-1', REQ), false);
  assert.notEqual(buildRequestAlias('aaaabbbb-0000-4000-8000-000000000002', 1), alias(1));
});

Deno.test('response validation refuses aliases outside the authorized set', () => {
  const expected = {
    requestId: REQ,
    intent: 'build_around_item' as const,
    authorizedRefs: [alias(1), alias(2)],
  };
  const good = parsePrivateEliseResponse(
    {
      schemaVersion: PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
      requestId: REQ,
      intent: 'build_around_item',
      status: 'success',
      anchorRef: alias(1),
      selectedRefs: [alias(1), alias(2)],
    },
    expected,
  );
  assert.equal(good.ok, true);

  const foreign = parsePrivateEliseResponse(
    {
      schemaVersion: PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
      requestId: REQ,
      intent: 'build_around_item',
      status: 'success',
      anchorRef: alias(3),
    },
    expected,
  );
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.error, 'invalid_alias');
});

Deno.test('the contract module is pure: no Deno API or import surface', async () => {
  const source = await Deno.readTextFile(
    new URL('./privateDressingRoomEliseContract.ts', import.meta.url),
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /\bDeno\b/);
  assert.doesNotMatch(code, /\bfetch\s*\(/);
});
