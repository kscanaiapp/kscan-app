// Receipt & Purchase Intelligence V1 — review edits, drafts, and the explicit
// ownership write against the REAL Closet store.
//
// Journeys covered: D (duplicate submission), E (quantity), F (partial
// failure), G (cancellation creates nothing), H (actor switch), L (deadline
// inheritance), Q (user correction -> USER_CONFIRMED).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, loadClosetStore, readCloset } = require('./helpers/purchaseImportHarness');

const N = loadModule('services/purchaseImport/purchaseImportNormalizer.ts');
const R = loadModule('services/purchaseImport/purchaseImportReview.ts');

function review(items, docOverrides = {}) {
  const r = N.normalizePurchaseExtraction(
    {
      document: {
        merchant: 'Northline',
        purchaseDate: '2026-09-10',
        currencyCode: 'USD',
        currencySymbol: null,
        currencyEvidence: 'explicit_code',
        explicitReturnDeadline: '2026-10-10',
        documentKind: 'purchase',
        documentConfidence: 0.9,
        ...docOverrides,
      },
      items,
    },
    { today: '2026-09-22' },
  );
  assert.equal(r.state, 'ready');
  return r;
}

function line(overrides = {}) {
  return {
    sourceLine: 'Atelier Nine Wool Coat Camel M 240.00',
    title: 'Atelier Nine Wool Coat',
    brand: 'Atelier Nine',
    brandEvidence: 'on_item_line',
    lineClass: 'apparel',
    lineKind: 'purchase',
    category: 'outerwear',
    subtype: 'wool coat',
    primaryColor: 'Camel',
    secondaryColors: [],
    material: ['Wool'],
    sizeRaw: 'M',
    quantity: 1,
    unitPrice: 240,
    totalPrice: 240,
    confidence: 0.9,
    ...overrides,
  };
}

// ── Q / BLOCK-RPI-30 ─────────────────────────────────────────────────────────

test('Q / RPI-30: a user edit replaces the value AND the provenance', () => {
  const [c] = review([line()]).candidates;
  assert.equal(c.brand.provenance, 'RECEIPT_EXPLICIT');
  const edited = R.applyCandidateEdit(c, 'brand', 'Atelier 9');
  assert.equal(edited.brand.value, 'Atelier 9');
  assert.equal(edited.brand.provenance, 'USER_CONFIRMED');
  assert.equal(c.brand.provenance, 'RECEIPT_EXPLICIT', 'edits never mutate the original');
  const cleared = R.applyCandidateEdit(edited, 'brand', '');
  assert.equal(cleared.brand.value, null);
  assert.equal(cleared.brand.provenance, 'UNKNOWN');
});

test('Q: choosing a currency for a printed "$" amount confirms that amount and clears the ambiguity', () => {
  const [c] = review([line()], { currencyCode: null, currencySymbol: '$', currencyEvidence: 'explicit_symbol' }).candidates;
  assert.equal(c.flags.currencyAmbiguous, true);
  const picked = R.applyCandidateEdit(c, 'currency', 'CAD');
  assert.equal(picked.currency.value, 'CAD');
  assert.equal(picked.currency.provenance, 'USER_CONFIRMED');
  assert.equal(picked.unitPrice.provenance, 'USER_CONFIRMED');
  assert.equal(picked.flags.currencyAmbiguous, false);
});

test('RPI-29 for customer input: a typed three-letter string that is not an ISO currency is refused', () => {
  const [c] = review([line()], { currencyCode: null, currencySymbol: null, currencyEvidence: 'none' }).candidates;
  assert.equal(R.applyCandidateEdit(c, 'currency', 'ABC'), c);
  assert.equal(R.applyCandidateEdit(c, 'currency', 'eur').currency.value, 'EUR');
});

test('RPI-26 for customer input: a card fragment typed into a field is scrubbed before it can persist', () => {
  const [c] = review([line()]).candidates;
  const edited = R.applyCandidateEdit(c, 'title', 'Wool coat paid VISA **** 4242');
  assert.doesNotMatch(edited.title.value, /4242/);
  assert.match(edited.title.value, /Wool coat/);
});

test('invalid edits are refused and leave the candidate unchanged', () => {
  const [c] = review([line()]).candidates;
  assert.equal(R.applyCandidateEdit(c, 'unitPrice', 'abc'), c);
  assert.equal(R.applyCandidateEdit(c, 'unitPrice', -5), c);
  assert.equal(R.applyCandidateEdit(c, 'currency', 'dollars'), c);
  assert.equal(R.applyCandidateEdit(c, 'title', '   '), c, 'a title cannot be cleared');
});

// ── Drafts ───────────────────────────────────────────────────────────────────

test('drafts carry confirmed taxonomy and bounded purchase provenance, and never the source line', () => {
  const r = review([line()]);
  const drafts = R.buildClosetDrafts(r.candidates, r.document, { sessionId: 'sess01', inputTier: 'order_confirmation' });
  assert.equal(drafts.length, 1);
  const d = drafts[0].draft;
  assert.equal(d.origin, 'purchase_import');
  assert.equal(d.brand, 'Atelier Nine');
  assert.equal(d.size, 'M');
  assert.equal(d.purchase.merchant, 'Northline');
  assert.equal(d.purchase.pricePaid, 240);
  assert.equal(d.purchase.currency, 'USD');
  assert.equal(d.purchase.fieldProvenance.brand, 'RECEIPT_EXPLICIT');
  assert.equal(d.purchase.fieldProvenance.merchant, 'RECEIPT_EXPLICIT');
  const serialized = JSON.stringify(drafts);
  assert.doesNotMatch(serialized, /240\.00/, 'the printed source line is not carried');
  assert.doesNotMatch(serialized, /"sourceLine"|"documentConfidence"|"confidence"/);
});

test('L: a document-level return deadline is inherited by every item and recorded as document-scoped', () => {
  const r = review([line(), line({ sourceLine: 'Atelier Nine Silk Scarf 80.00', title: 'Atelier Nine Silk Scarf', category: 'accessory', sizeRaw: null, unitPrice: 80, totalPrice: 80 })]);
  const drafts = R.buildClosetDrafts(r.candidates, r.document, { sessionId: 's', inputTier: 'digital_receipt' });
  for (const { draft } of drafts) {
    assert.equal(draft.purchase.returnDeadline, '2026-10-10');
    assert.equal(draft.purchase.returnDeadlineScope, 'document');
  }
});

test('RPI-29: a price with no known currency is not carried into a draft', () => {
  const r = review([line()], { currencyCode: null, currencySymbol: '$', currencyEvidence: 'explicit_symbol' });
  const [{ draft }] = R.buildClosetDrafts(r.candidates, r.document, { sessionId: 's', inputTier: 'paper_receipt' });
  assert.equal(draft.purchase.pricePaid, null);
  assert.equal(draft.purchase.currency, null);
  assert.equal(draft.purchase.fieldProvenance.pricePaid, undefined);
});

test('an unresolved price mismatch is not persisted as fact; a user-corrected one is', () => {
  const r = review([line({ quantity: 2, unitPrice: 240, totalPrice: 300, sourceLine: 'Atelier Nine Wool Coat M 2 @ 240.00 300.00' })]);
  const [c] = r.candidates;
  assert.equal(c.flags.priceInconsistent, true);
  let [{ draft }] = R.buildClosetDrafts([{ ...c, unitsToAdd: 1 }], r.document, { sessionId: 's', inputTier: 'digital_receipt' });
  assert.equal(draft.purchase.pricePaid, null);
  const fixed = R.applyCandidateEdit({ ...c, unitsToAdd: 1 }, 'unitPrice', '150');
  [{ draft }] = R.buildClosetDrafts([fixed], r.document, { sessionId: 's', inputTier: 'digital_receipt' });
  assert.equal(draft.purchase.pricePaid, 150);
  assert.equal(draft.purchase.fieldProvenance.pricePaid, 'USER_CONFIRMED');
});

test('E: quantity 3 produces three drafts with distinct per-unit lineage, bounded by the customer choice', () => {
  const r = review([line({ quantity: 3, unitPrice: 20, totalPrice: 60, sourceLine: 'Atelier Nine Tee M 3 @ 20.00' })]);
  let [c] = r.candidates;
  let drafts = R.buildClosetDrafts([c], r.document, { sessionId: 'abc', inputTier: 'order_confirmation' });
  assert.deepEqual(drafts.map((d) => d.sourceLineageId), [
    'purchase_import:abc:0:0',
    'purchase_import:abc:0:1',
    'purchase_import:abc:0:2',
  ]);
  c = R.setCandidateUnits(c, 2);
  assert.equal(R.buildClosetDrafts([c], r.document, { sessionId: 'abc', inputTier: 'order_confirmation' }).length, 2);
  assert.equal(R.setCandidateUnits(c, 99).unitsToAdd, 3, 'never more than the document says');
  assert.equal(R.setCandidateUnits(c, 0).unitsToAdd, 1);
});

test('deselected lines produce no drafts, and the count the button states matches the drafts', () => {
  const r = review([line(), line({ quantity: 2, unitPrice: 10, totalPrice: 20 })]);
  const candidates = [R.setCandidateSelected(r.candidates[0], false), r.candidates[1]];
  const drafts = R.buildClosetDrafts(candidates, r.document, { sessionId: 's', inputTier: 'order_confirmation' });
  assert.equal(drafts.length, 2);
  assert.equal(R.selectedUnitCount(candidates), drafts.length);
});

test('the lineage id is derived from nothing in the document (no receipt fingerprint)', () => {
  const r1 = review([line()]);
  const r2 = review([line({ sourceLine: 'Completely different text 1.00' })]);
  const a = R.buildClosetDrafts(r1.candidates, r1.document, { sessionId: 'same', inputTier: 'order_confirmation' })[0].sourceLineageId;
  const b = R.buildClosetDrafts(r2.candidates, r2.document, { sessionId: 'same', inputTier: 'order_confirmation' })[0].sourceLineageId;
  assert.equal(a, b);
});

// ── Duplicates (section 21) ─────────────────────────────────────────────────

test('duplicates: an exact GTIN, or a SKU from the same merchant, deselects with a reason; nothing fuzzy does', () => {
  const r = review([
    line({ sourceLine: 'Atelier Nine Coat M UPC 012345678905', gtin: '012345678905' }),
    line({ sourceLine: 'Atelier Nine Coat M SKU AN-77', sku: 'AN-77' }),
    line(),
  ]);
  const owned = [
    { purchase: { gtin: '012345678905' } },
    { purchase: { sku: 'AN-77', merchant: 'Northline' } },
    { title: 'Atelier Nine Wool Coat', brand: 'Atelier Nine', primaryColor: 'Camel', purchase: null },
  ];
  const marked = R.markOwnedDuplicates(r.candidates, 'Northline', owned);
  assert.equal(marked[0].flags.possibleDuplicate, true);
  assert.equal(marked[0].selected, false);
  assert.equal(marked[1].flags.possibleDuplicate, true);
  assert.equal(marked[2].flags.possibleDuplicate, false, 'same title/brand/colour is NOT evidence');
  assert.equal(marked[2].selected, true);
  const otherMerchant = R.markOwnedDuplicates(r.candidates, 'Elsewhere', [{ purchase: { sku: 'AN-77', merchant: 'Northline' } }]);
  assert.equal(otherMerchant[1].flags.possibleDuplicate, false, 'a SKU is only meaningful within its merchant');
});

test('corrections are counted per coarse group and never carry values', () => {
  const r = review([line()]);
  const edited = [R.applyCandidateEdit(R.applyCandidateEdit(r.candidates[0], 'brand', 'X'), 'size', 'L')];
  const counts = R.countCorrections(r.candidates, edited);
  assert.deepEqual(counts, { naming: 0, maker: 1, classification: 0, appearance: 0, fit: 1, money: 0 });
});

// ── The ownership write, against the REAL store ─────────────────────────────

function loadCommit(store) {
  let noted = [];
  const commit = loadModule('services/purchaseImport/purchaseImportCommit.ts', {
    externals: {
      '../closetLibrary': store.closetLibrary,
      '../closet/closetSyncCoordinator': { noteClosetItemSaved: async (o, id) => void noted.push(id) },
    },
  });
  return { commit, noted: () => noted };
}

function draftsFor(items, sessionId = 'sessX') {
  const r = review(items);
  return R.buildClosetDrafts(r.candidates, r.document, { sessionId, inputTier: 'order_confirmation' });
}

test('OWNED=NO before confirmation: review, drafts and cancellation write nothing (G)', () => {
  const store = loadClosetStore();
  draftsFor([line(), line()]);
  assert.deepEqual(readCloset(store.m), []);
});

test('OWNED=YES after the authoritative write: an item with no photo is committed with no media', async () => {
  const store = loadClosetStore();
  const { commit, noted } = loadCommit(store);
  store.actorContext.advanceActorEpoch('user-1');
  const request = store.actorContext.createActorRequest();
  const result = await commit.commitPurchaseDrafts(draftsFor([line()]), {
    actorRequest: request,
    ownerId: 'user-1',
    photos: new Map(),
  });
  assert.equal(result.addedCount, 1);
  assert.equal(result.failedCount, 0);
  const [record] = readCloset(store.m);
  assert.equal(record.origin, 'purchase_import');
  assert.equal(record.imageUri, null);
  assert.equal(record.thumbnailUri, null);
  assert.equal(record.brand, 'Atelier Nine');
  assert.equal(record.purchase.pricePaid, 240);
  assert.equal(record.purchase.currency, 'USD');
  assert.equal(record.ownerId, 'user-1');
  assert.deepEqual(noted(), [record.id], 'the new item is handed to cloud sync after the local commit');
});

test('a garment photo, when given, becomes the item media', async () => {
  const store = loadClosetStore();
  const { commit } = loadCommit(store);
  store.m.files.set('/cache/ImagePicker/garment.jpg', 'imgbytes');
  store.actorContext.advanceActorEpoch('user-1');
  const result = await commit.commitPurchaseDrafts(draftsFor([line()]), {
    actorRequest: store.actorContext.createActorRequest(),
    ownerId: 'user-1',
    photos: new Map([[0, '/cache/ImagePicker/garment.jpg']]),
  });
  assert.equal(result.addedCount, 1);
  const [record] = readCloset(store.m);
  assert.match(record.imageUri, /kscan_closet\/images\//);
});

test('D: a double tap / retry of the same units cannot create a second item', async () => {
  const store = loadClosetStore();
  const { commit } = loadCommit(store);
  store.actorContext.advanceActorEpoch('user-1');
  const drafts = draftsFor([line()]);
  const args = { actorRequest: store.actorContext.createActorRequest(), ownerId: 'user-1', photos: new Map() };
  const [a, b] = await Promise.all([commit.commitPurchaseDrafts(drafts, args), commit.commitPurchaseDrafts(drafts, args)]);
  assert.equal(readCloset(store.m).length, 1);
  const statuses = [a.outcomes[0].status, b.outcomes[0].status].sort();
  assert.deepEqual(statuses, ['added', 'already_added']);
});

test('E: two identical units become two owned items', async () => {
  const store = loadClosetStore();
  const { commit } = loadCommit(store);
  store.actorContext.advanceActorEpoch('user-1');
  const drafts = draftsFor([line({ quantity: 2, unitPrice: 240, totalPrice: 480 })]);
  await commit.commitPurchaseDrafts(drafts, { actorRequest: store.actorContext.createActorRequest(), ownerId: 'user-1', photos: new Map() });
  assert.equal(readCloset(store.m).length, 2);
});

test('F: success, success, failure is reported exactly, and retry does not duplicate the successes', async () => {
  const store = loadClosetStore();
  let calls = 0;
  const flaky = {
    ...store.closetLibrary,
    createClosetItem: async (args) => {
      calls += 1;
      if (calls === 3) return { ok: false, reason: 'unexpected_error' };
      return store.closetLibrary.createClosetItem(args);
    },
  };
  const commit = loadModule('services/purchaseImport/purchaseImportCommit.ts', {
    externals: { '../closetLibrary': flaky, '../closet/closetSyncCoordinator': { noteClosetItemSaved: async () => {} } },
  });
  store.actorContext.advanceActorEpoch('user-1');
  const drafts = draftsFor([
    line(),
    line({ sourceLine: 'Atelier Nine Scarf 80.00', title: 'Atelier Nine Scarf', sizeRaw: null, unitPrice: 80, totalPrice: 80 }),
    line({ sourceLine: 'Atelier Nine Belt 60.00', title: 'Atelier Nine Belt', sizeRaw: null, unitPrice: 60, totalPrice: 60 }),
  ]);
  const args = { actorRequest: store.actorContext.createActorRequest(), ownerId: 'user-1', photos: new Map() };
  const first = await commit.commitPurchaseDrafts(drafts, args);
  assert.equal(first.addedCount, 2);
  assert.equal(first.failedCount, 1);
  assert.deepEqual(first.outcomes.map((o) => o.status), ['added', 'added', 'failed']);
  assert.equal(readCloset(store.m).length, 2);

  // Retrying EVERYTHING (the worst case) still cannot duplicate: lineage dedupes.
  const all = await commit.commitPurchaseDrafts(drafts, args);
  assert.deepEqual(all.outcomes.map((o) => o.status), ['already_added', 'already_added', 'added']);
  assert.equal(readCloset(store.m).length, 3);

  // And the targeted retry helper only re-sends what did not land.
  assert.equal(commit.draftsToRetry(drafts, first).length, 1);
});

test('H: an actor switch mid-confirmation stops the remaining writes and reports it', async () => {
  const store = loadClosetStore();
  const { commit } = loadCommit(store);
  store.actorContext.advanceActorEpoch('user-1');
  const request = store.actorContext.createActorRequest();
  const drafts = draftsFor([line(), line({ title: 'Other', sourceLine: 'Atelier Nine Other 10.00', sizeRaw: null, unitPrice: 10, totalPrice: 10 })]);
  store.actorContext.advanceActorEpoch('user-2');
  const result = await commit.commitPurchaseDrafts(drafts, { actorRequest: request, ownerId: 'user-1', photos: new Map() });
  assert.equal(result.actorChanged, true);
  assert.equal(result.addedCount, 0);
  assert.deepEqual(result.outcomes.map((o) => o.status), ['failed', 'not_attempted']);
  assert.deepEqual(readCloset(store.m), [], 'nothing is written for the old actor, or for the new one');
});
