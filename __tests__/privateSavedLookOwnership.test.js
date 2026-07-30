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
    const result = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet);
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
    const slot = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet).slots[0];
    assert.equal(slot.commerceSuppressed, true);
    assert.ok(slot.actions.includes('shop_anyway'));
  }
});

test('similar ownership places the owned alternative first before commerce', () => {
  const fixture = PRIVATE_OWNERSHIP_FIXTURES.find((entry) => entry.name === 'same slot with different color');
  const slot = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet).slots[0];
  assert.equal(slot.showOwnedAlternativeFirst, true);
  assert.equal(slot.actions[0], 'find_alternative');
  assert.equal(slot.matchedItem.id, fixture.expectedMatchedItemId);
});

test('same semantic slot with incompatible garment type is not claimed as similar', () => {
  const fixture = PRIVATE_OWNERSHIP_FIXTURES.find((entry) => entry.name === 'same slot with different color');
  const incompatibleTop = { ...fixture.closet[0], clothingType: 'T-shirt', subtype: 'Crew neck tee' };
  const slot = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, [incompatibleTop]).slots[0];
  assert.equal(slot.state, 'not_owned');
  assert.equal(slot.matchedItem, null);
});

test('resolver is deterministic and does not mutate either input', () => {
  const fixture = PRIVATE_OWNERSHIP_FIXTURES.find((entry) => entry.name === 'same slot with different color');
  const beforeSaved = JSON.stringify(fixture.savedLook);
  const beforeCloset = JSON.stringify(fixture.closet);
  const one = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet);
  const two = ownership.resolvePrivateSavedLookOwnership(fixture.savedLook, fixture.closet);
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(fixture.savedLook), beforeSaved);
  assert.equal(JSON.stringify(fixture.closet), beforeCloset);
});
