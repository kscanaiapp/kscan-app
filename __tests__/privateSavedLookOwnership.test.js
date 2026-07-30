const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const cache = new Map();
function loadModule(relPath) {
  if (cache.has(relPath)) return cache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (!specifier.startsWith('.')) throw new Error(`Unexpected import ${specifier}`);
    let resolved = path.resolve(dirname, specifier);
    for (const ext of ['', '.ts', '.js']) {
      if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) { resolved += ext; break; }
    }
    return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
  };
  vm.runInThisContext(`(function(exports,module,require){${output}\n})`, { filename })(mod.exports, mod, localRequire);
  cache.set(relPath, mod.exports);
  return mod.exports;
}

const ownership = loadModule('services/privateSavedLookOwnership.ts');
const { PRIVATE_OWNERSHIP_FIXTURES } = loadModule('services/privateSavedLookOwnershipFixtures.ts');

for (const fixture of PRIVATE_OWNERSHIP_FIXTURES) {
  test(`ownership fixture: ${fixture.name}`, () => {
    assert.equal(fixture.savedLook.actorId, fixture.actorId);
    const result = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet, { loadedForActorId: fixture.actorId });
    const slot = result.slots[0];
    assert.equal(slot.state, fixture.expectedState);
    assert.equal(slot.matchedItem?.id ?? null, fixture.expectedMatchedItemId);
    assert.match(slot.confidenceExplanation, new RegExp(fixture.expectedConfidenceExplanation, 'i'));
    assert.equal(slot.commerceSuppressed, fixture.expectedCommerceSuppression);
    for (const action of fixture.expectedActions) assert.ok(slot.actions.includes(action), `missing ${action}`);
  });
}

test('exact and probable suppress automatic commerce but retain explicit Shop anyway', () => {
  for (const name of ['exact ID and same slot', 'no ID but strong taxonomy match']) {
    const fixture = PRIVATE_OWNERSHIP_FIXTURES.find((entry) => entry.name === name);
    const slot = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet, { loadedForActorId: fixture.actorId }).slots[0];
    assert.equal(slot.commerceSuppressed, true);
    assert.ok(slot.actions.includes('shop_anyway'));
  }
});

test('similar ownership places the owned alternative first before commerce', () => {
  const fixture = PRIVATE_OWNERSHIP_FIXTURES.find((entry) => entry.name === 'same slot with different color');
  const slot = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet, { loadedForActorId: fixture.actorId }).slots[0];
  assert.equal(slot.showOwnedAlternativeFirst, true);
  assert.equal(slot.actions[0], 'find_alternative');
  assert.equal(slot.matchedItem.id, fixture.expectedMatchedItemId);
});

test('same semantic slot with incompatible garment type is not claimed as similar', () => {
  const fixture = PRIVATE_OWNERSHIP_FIXTURES.find((entry) => entry.name === 'same slot with different color');
  const incompatibleTop = { ...fixture.closet[0], clothingType: 'T-shirt', subtype: 'Crew neck tee' };
  const slot = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, [incompatibleTop], { loadedForActorId: fixture.actorId }).slots[0];
  assert.equal(slot.state, 'not_owned');
  assert.equal(slot.matchedItem, null);
});

test('resolver is deterministic and does not mutate either input', () => {
  const fixture = PRIVATE_OWNERSHIP_FIXTURES.find((entry) => entry.name === 'same slot with different color');
  const beforeSaved = JSON.stringify(fixture.savedLook);
  const beforeCloset = JSON.stringify(fixture.closet);
  const one = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet, { loadedForActorId: fixture.actorId });
  const two = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet, { loadedForActorId: fixture.actorId });
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(fixture.savedLook), beforeSaved);
  assert.equal(JSON.stringify(fixture.closet), beforeCloset);
});


// ── Phase 6: actor isolation must fail CLOSED ────────────────────────────────
//
// DEFECT-P6-003. belongsToActor read:
//     item.actorId === undefined || item.actorId === null || item.actorId === actorId
// so any Closet projection WITHOUT an actorId was admitted as the saved Look
// actor's own. ClosetItemProjection carries no actorId at all, so in production
// every item took that branch and the filter was a no-op: isolation rested
// entirely on loadClosetTyped being scoped upstream, with no defence in depth.
//
// The scope is now a required argument. Absent per-item evidence is admitted
// only under an explicit, matching attestation from the caller.

const ACTOR_A = 'actor-a-11111111';
const ACTOR_B = 'actor-b-22222222';

function baseFixture() {
  return PRIVATE_OWNERSHIP_FIXTURES.find((entry) => entry.name === 'exact ID and same slot');
}

test('an unattributed Closet item is NOT admitted without a matching scope', () => {
  const fixture = baseFixture();
  // No scope can be proven: the item carries no actorId and the caller says so.
  const slot = ownership.resolvePrivateSavedLookOwnership(
    fixture.savedLook,
    fixture.closet,
    { loadedForActorId: null },
  ).slots[0];
  assert.notEqual(slot.state, 'exact_owned', 'unattributed items must not resolve as owned');
  assert.equal(slot.matchedItem, null, 'no item may be reported as matched without actor evidence');
});

test('a scope for a DIFFERENT actor does not admit unattributed items', () => {
  const fixture = baseFixture();
  const slot = ownership.resolvePrivateSavedLookOwnership(
    fixture.savedLook,
    fixture.closet,
    { loadedForActorId: ACTOR_B },
  ).slots[0];
  assert.notEqual(slot.state, 'exact_owned');
  assert.equal(slot.matchedItem, null);
});

test("an item explicitly owned by another actor is refused even under a valid scope", () => {
  const fixture = baseFixture();
  const foreign = fixture.closet.map((item) => ({ ...item, actorId: ACTOR_B }));
  const slot = ownership.resolvePrivateSavedLookOwnership(
    { ...fixture.savedLook, actorId: ACTOR_A },
    foreign,
    { loadedForActorId: ACTOR_A },
  ).slots[0];
  assert.equal(slot.matchedItem, null, "another actor's item must never be matched");
  assert.notEqual(slot.state, 'exact_owned');
});

test('an explicit matching actorId is admitted regardless of scope', () => {
  const fixture = baseFixture();
  const owned = fixture.closet.map((item) => ({ ...item, actorId: fixture.actorId }));
  const slot = ownership.resolvePrivateSavedLookOwnership(
    fixture.savedLook,
    owned,
    { loadedForActorId: null },
  ).slots[0];
  assert.equal(slot.state, fixture.expectedState, 'explicit per-item evidence is sufficient');
});

test('a proven scope preserves normal ownership and commerce suppression', () => {
  // The regression guard for the OTHER failure direction: failing closed must
  // not mark genuinely owned pieces not_owned and un-suppress commerce.
  for (const fixture of PRIVATE_OWNERSHIP_FIXTURES) {
    const slot = ownership.resolvePrivateSavedLookOwnership(
      fixture.savedLook,
      fixture.closet,
      { loadedForActorId: fixture.actorId },
    ).slots[0];
    assert.equal(slot.state, fixture.expectedState, `${fixture.name} changed state`);
    assert.equal(
      slot.commerceSuppressed,
      fixture.expectedCommerceSuppression,
      `${fixture.name} changed commerce suppression`,
    );
  }
});

test('a blank or whitespace actor attestation is not a valid scope', () => {
  const fixture = baseFixture();
  for (const loadedForActorId of ['', '   ']) {
    const slot = ownership.resolvePrivateSavedLookOwnership(
      fixture.savedLook,
      fixture.closet,
      { loadedForActorId },
    ).slots[0];
    assert.equal(slot.matchedItem, null, `"${loadedForActorId}" must not attest a scope`);
  }
});
