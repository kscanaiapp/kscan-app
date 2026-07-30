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

const handoff = loadModule('services/privateSavedLookHandoff.ts');

const savedLook = {
  schemaVersion: 1, id: 'saved-look-local-only', actorId: 'actor-private', source: 'dressing_room',
  sourceSessionId: 'session-private', sourceCompositionId: 'composition-private',
  sourceLookId: 'look-private', sourceInputFingerprint: 'fingerprint-private',
  name: null, occasion: 'Dinner', anchorSlot: 'top',
  slots: [{
    slotKey: 'top', closetItemId: 'closet-private', wasOwnedAtSave: false,
    snapshot: {
      category: 'Tops', clothingType: 'Blouse', subtype: 'Silk blouse', brand: 'Private Brand',
      primaryColor: 'Navy', secondaryColors: ['Silver'], material: ['Silk'],
    },
  }],
  createdAt: '2026-07-30T12:00:00.000Z', updatedAt: '2026-07-30T12:00:00.000Z',
};

test('minimum outbound query contains only retailer-neutral fashion fields', () => {
  const query = handoff.buildMissingPieceQuery({
    savedLook, slot: savedLook.slots[0], intent: 'find_missing_piece',
  });
  assert.deepEqual(Object.keys(query).sort(), [
    'brandPreference', 'category', 'clothingType', 'fit', 'intent', 'material',
    'occasion', 'pricePreference', 'primaryColor', 'schemaVersion', 'secondaryColors',
    'silhouette', 'slot', 'subtype',
  ].sort());
  assert.equal(query.slot, 'top');
  assert.equal(query.occasion, 'Dinner');
  assert.equal(query.brandPreference, null, 'saved brand is not an explicit preference');
});

test('outbound query omits all identity, local-storage, media and auth fields', () => {
  const query = handoff.buildMissingPieceQuery({
    savedLook, slot: savedLook.slots[0], intent: 'shop_anyway',
  });
  const serialized = JSON.stringify(query);
  for (const forbidden of [
    'actorId', 'savedLookId', 'closetItemId', 'sourceSessionId', 'sourceCompositionId',
    'sourceLookId', 'sourceInputFingerprint', 'returnRoute', 'createdAt', 'file:///',
    'image', 'face', 'notes', 'auth', 'token', 'actor-private', 'saved-look-local-only',
    'closet-private', 'session-private',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test('brand and price enter the query only as explicit bounded preferences', () => {
  const query = handoff.buildMissingPieceQuery({
    savedLook, slot: savedLook.slots[0], intent: 'different_brand',
    brandPreference: 'Selected Atelier',
    pricePreference: { min: 50, max: 200, currency: 'USD' },
  });
  assert.equal(query.brandPreference, 'Selected Atelier');
  assert.deepEqual(query.pricePreference, { min: 50, max: 200, currency: 'USD' });
});

test('local return context retains the Saved Look and slot outside the outbound query', () => {
  const context = handoff.buildSavedLookReturnContext({
    savedLookId: savedLook.id, slotKey: 'top',
    returnRoute: `/stylist/saved-looks/${savedLook.id}`, now: '2026-07-30T13:00:00.000Z',
  });
  assert.deepEqual(context, {
    savedLookId: savedLook.id, slotKey: 'top',
    returnRoute: `/stylist/saved-looks/${savedLook.id}`, createdAt: '2026-07-30T13:00:00.000Z',
  });
});

test('incomplete provider data is normalized incomplete and never auto-renderable', () => {
  const result = handoff.validateMissingPieceResult({
    slot: 'top', category: 'Tops', clothingType: 'Blouse', destinationUrl: null,
    confidence: 'high', material: ['Silk'],
  });
  assert.equal(result.completeness, 'incomplete');
  assert.equal(result.destinationUrl, null);
});

test('controlled adapter performs no external commerce and reports the governed statuses', async () => {
  const query = handoff.buildMissingPieceQuery({
    savedLook, slot: savedLook.slots[0], intent: 'find_missing_piece',
  });
  const controlled = await handoff.runControlledMissingPieceHandoff(query);
  assert.deepEqual(controlled.query, query);
  assert.equal(controlled.result.completeness, 'incomplete');
  assert.equal(controlled.result.providerProductRef, null);
  assert.equal(controlled.result.retailer, null);
  assert.equal(controlled.result.destinationUrl, null);
  assert.equal(handoff.MISSING_PIECE_HANDOFF_STATUS, 'STRUCTURED MISSING-PIECE HANDOFF READY');
  assert.equal(handoff.EXTERNAL_COMMERCE_STATUS, 'EXTERNAL COMMERCE DEFERRED');
});
