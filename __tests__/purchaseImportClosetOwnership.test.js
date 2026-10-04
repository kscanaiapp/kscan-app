// Receipt & Purchase Intelligence V1 — the Closet store changes.
//
// Runs the REAL services/closetLibrary.js on an in-memory filesystem. What is
// under test is that the ONE relaxation this feature needs (a purchase import
// may commit without a photo) is exactly that narrow, that purchase provenance
// is bounded and allowlisted, and that later edits and restores keep it true.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, loadClosetStore, readCloset, CLOSET_PATH } = require('./helpers/purchaseImportHarness');

function purchase(overrides = {}) {
  return {
    source: 'purchase_import',
    contractVersion: 'purchase-import-v1',
    inputTier: 'order_confirmation',
    merchant: 'Northline',
    purchaseDate: '2026-09-10',
    pricePaid: 98,
    currency: 'USD',
    sku: 'AN-77',
    gtin: '012345678905',
    retailerProductRef: null,
    returnDeadline: '2026-10-10',
    returnDeadlineScope: 'document',
    fieldProvenance: { brand: 'RECEIPT_EXPLICIT', size: 'RECEIPT_EXPLICIT', pricePaid: 'RECEIPT_EXPLICIT', currency: 'RECEIPT_EXPLICIT' },
    ...overrides,
  };
}

async function create(store, draft, sourceUri = null, actor = 'user-1') {
  store.actorContext.advanceActorEpoch(actor);
  return store.closetLibrary.createClosetItem({
    sourceUri,
    draft,
    actorRequest: store.actorContext.createActorRequest(),
    ownerId: actor,
  });
}

test('only purchase_import may commit without media; every other origin still requires it', async () => {
  const store = loadClosetStore();
  for (const origin of ['direct_intake', 'recent_scan', undefined, 'anything_else']) {
    const r = await create(store, { title: 'X', origin });
    assert.deepEqual(r, { ok: false, reason: 'missing_source_media' }, `origin ${origin} must still need a photo`);
  }
  const ok = await create(store, { title: 'Wool coat', origin: 'purchase_import', purchase: purchase() });
  assert.equal(ok.ok, true);
  assert.equal(ok.item.imageUri, null);
  assert.equal(readCloset(store.m).length, 1);
});

test('Android still requires an authenticated actor for a media-less purchase import', async () => {
  const store = loadClosetStore({ platform: 'android' });
  store.actorContext.advanceActorEpoch(null);
  const r = await store.closetLibrary.createClosetItem({
    sourceUri: null,
    draft: { title: 'Coat', origin: 'purchase_import' },
    actorRequest: store.actorContext.createActorRequest(),
    ownerId: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'android_requires_authenticated_actor');
});

test('purchase provenance is allowlisted and bounded, and only exists on purchase_import items', async () => {
  const store = loadClosetStore();
  const r = await create(store, {
    title: 'Coat',
    origin: 'purchase_import',
    purchase: purchase({
      rawReceipt: 'SHOULD NOT PERSIST',
      ocrText: 'SHOULD NOT PERSIST',
      cardLast4: '4242',
      email: 'a@b.test',
      fieldProvenance: { brand: 'RECEIPT_EXPLICIT', evil: 'RECEIPT_EXPLICIT', size: 'MADE_UP' },
      retailerProductRef: 'https://example.test/p/1',
    }),
  });
  const p = r.item.purchase;
  assert.deepEqual(Object.keys(p).sort(), [
    'contractVersion',
    'currency',
    'fieldProvenance',
    'gtin',
    'inputTier',
    'merchant',
    'pricePaid',
    'purchaseDate',
    'retailerProductRef',
    'returnDeadline',
    'returnDeadlineScope',
    'sku',
    'source',
  ]);
  assert.deepEqual(p.fieldProvenance, { brand: 'RECEIPT_EXPLICIT' });
  assert.equal(p.retailerProductRef, null, 'no URL is ever stored');
  const disk = store.m.files.get(CLOSET_PATH);
  assert.doesNotMatch(disk, /SHOULD NOT PERSIST|4242|a@b\.test/);

  // A purchase object pasted onto any other origin is dropped entirely.
  store.m.files.set('/cache/p.jpg', 'x');
  const other = await create(store, { title: 'Tee', origin: 'direct_intake', purchase: purchase() }, '/cache/p.jpg');
  assert.equal(other.item.purchase, undefined);
});

test('RPI-29 at the store: a price without a currency is not stored, and neither is its provenance', async () => {
  const store = loadClosetStore();
  const r = await create(store, { title: 'Coat', origin: 'purchase_import', purchase: purchase({ currency: null }) });
  assert.equal(r.item.purchase.pricePaid, null);
  assert.equal(r.item.purchase.currency, null);
  assert.equal(r.item.purchase.fieldProvenance.pricePaid, undefined);
});

test('records that are not purchase imports keep exactly their previous key set', async () => {
  const store = loadClosetStore();
  store.m.files.set('/cache/p.jpg', 'x');
  const r = await create(store, { title: 'Tee', origin: 'direct_intake' }, '/cache/p.jpg');
  assert.equal(Object.prototype.hasOwnProperty.call(r.item, 'purchase'), false);
});

test('Q / RPI-30 after commit: editing a purchase-imported field flips its provenance to USER_CONFIRMED', async () => {
  const store = loadClosetStore();
  const r = await create(store, { title: 'Coat', brand: 'Atelier Nine', size: 'M', origin: 'purchase_import', purchase: purchase() });
  const updated = await store.closetLibrary.updateClosetItem(
    r.item.id,
    { brand: 'Atelier 9', size: null },
    { actorRequest: store.actorContext.createActorRequest(), ownerId: 'user-1' },
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.item.purchase.fieldProvenance.brand, 'USER_CONFIRMED');
  assert.equal(updated.item.purchase.fieldProvenance.size, 'UNKNOWN', 'a cleared field is absent, not user-confirmed');
  assert.equal(updated.item.purchase.pricePaid, 98, 'an unrelated edit leaves purchase facts alone');
});

test('a remote-wins restore cannot erase purchase provenance or downgrade the origin', async () => {
  const store = loadClosetStore();
  const r = await create(store, { title: 'Coat', origin: 'purchase_import', purchase: purchase() });
  const applied = await store.closetLibrary.applyRestoredClosetItemFacts(
    r.item.id,
    'user-1',
    { title: 'Coat (remote)', origin: 'direct_intake' },
    '2026-09-23T00:00:00.000Z',
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.item.origin, 'purchase_import');
  assert.equal(applied.item.purchase.merchant, 'Northline');
  assert.equal(applied.item.title, 'Coat (remote)');
});

test('purchase facts stay on the record and never reach the consumer projection (no financial profiling)', async () => {
  // Reads are VALIDATED, NOT TRANSFORMED (closetLibrary readClosetManifest):
  // the raw record keeps its purchase object for this feature's own duplicate
  // hints. What Elise, Packing, the Concierge and every screen read is the
  // projection, and the projection must carry no price, merchant or code.
  const store = loadClosetStore();
  await create(store, { title: 'Coat', brand: 'Atelier Nine', origin: 'purchase_import', purchase: purchase() });
  const items = await store.closetLibrary.loadCloset('user-1');
  assert.equal(items[0].purchase.merchant, 'Northline');
  const projection = loadModule('services/closetItemProjection.ts', { realPrefixes: ['services/'] });
  const [projected] = projection.getClosetItemProjections(items);
  assert.equal(projected.brand, 'Atelier Nine', 'confirmed taxonomy DOES reach consumers - that is the point');
  assert.equal(projected.origin, 'purchase_import');
  assert.equal(projected.purchase, undefined);
  assert.doesNotMatch(JSON.stringify(projected), /Northline|pricePaid|"USD"|AN-77|012345678905|returnDeadline/);
});

// ── Cloud mirror mapping ────────────────────────────────────────────────────

const syncContract = loadModule('services/closet/closetSyncContract.ts', { realPrefixes: ['services/closet/'] });
const restoreContract = loadModule('services/closet/closetRestoreContract.ts', { realPrefixes: ['services/closet/'] });

test('sync carries purchase_import as itself, and still collapses any unknown origin', () => {
  assert.equal(syncContract.projectClosetItemForCloud({ origin: 'purchase_import', title: 'x' }).origin, 'purchase_import');
  assert.equal(syncContract.projectClosetItemForCloud({ origin: 'recent_scan', title: 'x' }).origin, 'recent_scan');
  assert.equal(syncContract.projectClosetItemForCloud({ origin: 'mystery', title: 'x' }).origin, 'direct_intake');
});

test('purchase provenance never reaches the cloud row in V1', () => {
  const row = syncContract.projectClosetItemForCloud({ origin: 'purchase_import', title: 'x', purchase: purchase() });
  assert.equal(row.purchase, undefined);
  assert.doesNotMatch(JSON.stringify(row), /Northline|pricePaid|012345678905|AN-77/);
});

test('restore maps purchase_import back as itself', () => {
  assert.equal(restoreContract.projectClosetRestoreRowForLocal({ origin: 'purchase_import', title: 't' }).origin, 'purchase_import');
  assert.equal(restoreContract.projectClosetRestoreRowForLocal({ origin: 'weird', title: 't' }).origin, 'direct_intake');
});
