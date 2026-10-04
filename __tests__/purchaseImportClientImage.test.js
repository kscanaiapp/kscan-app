// Receipt & Purchase Intelligence V1 — the network call and the on-device
// minimization boundary.
//
// BLOCK-RPI-32 (oversized input refused, never truncated), BLOCK-RPI-33 (flag
// off means no extraction path), BLOCK-RPI-35 (temp artifacts cleaned up), and
// the customer-safe error taxonomy (section 36).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, memfs } = require('./helpers/purchaseImportHarness');

function client({ enabled = true } = {}) {
  return loadModule('services/purchaseImport/purchaseImportClient.ts', {
    externals: {
      '../supabaseClient': { supabase: { functions: { invoke: async () => { throw new Error('real invoke must not run'); } } } },
      '../authenticatedFunctionSession': { resolveAuthenticatedFunctionSession: async () => ({ ok: true, accessToken: 't' }) },
      '../../constants/featureFlags': { RECEIPT_INTELLIGENCE_V1: enabled },
    },
  });
}

const GOOD_BODY = {
  ok: true,
  contractVersion: 'purchase-import-v1',
  document: {
    merchant: 'Northline',
    purchaseDate: '2026-09-10',
    currencyCode: 'USD',
    currencySymbol: null,
    currencyEvidence: 'explicit_code',
    explicitReturnDeadline: null,
    documentKind: 'purchase',
    documentConfidence: 0.9,
  },
  items: [
    {
      sourceLine: 'Linen Shirt White L 60.00',
      title: 'Linen Shirt',
      brand: null,
      brandEvidence: 'none',
      lineClass: 'apparel',
      lineKind: 'purchase',
      category: 'top',
      subtype: 'shirt',
      primaryColor: 'White',
      secondaryColors: [],
      material: ['Linen'],
      sizeRaw: 'L',
      quantity: 1,
      unitPrice: 60,
      totalPrice: 60,
      sku: null,
      gtin: null,
      retailerProductRef: null,
      confidence: 0.9,
    },
  ],
};

const IMAGE = '/9j/' + 'A'.repeat(200);

test('RPI-33: with the flag off there is no extraction call at all', async () => {
  let invoked = 0;
  const c = client({ enabled: false });
  const r = await c.extractPurchaseCandidates(
    { imageBase64: IMAGE, inputTier: 'order_confirmation', requestId: 'session01' },
    { invoke: async () => { invoked += 1; return { data: GOOD_BODY, error: null }; } },
  );
  assert.deepEqual(r, { ok: false, errorClass: 'feature_disabled' });
  assert.equal(invoked, 0);
});

test('R / RPI-32: an oversized image is refused on the device, before any call', async () => {
  let invoked = 0;
  const c = client();
  const r = await c.extractPurchaseCandidates(
    { imageBase64: 'A'.repeat(2 * 1024 * 1024 + 1), inputTier: 'order_confirmation', requestId: 'session01' },
    { invoke: async () => { invoked += 1; return { data: GOOD_BODY, error: null }; } },
  );
  assert.equal(r.errorClass, 'file_too_large');
  assert.equal(invoked, 0);
});

test('a signed-out session makes no call', async () => {
  let invoked = 0;
  const c = client();
  const r = await c.extractPurchaseCandidates(
    { imageBase64: IMAGE, inputTier: 'order_confirmation', requestId: 'session01' },
    {
      resolveSession: async () => ({ ok: false, reason: 'signed_out' }),
      invoke: async () => { invoked += 1; return { data: GOOD_BODY, error: null }; },
    },
  );
  assert.equal(r.errorClass, 'unauthorized');
  assert.equal(invoked, 0);
});

test('one document is one call, and the body carries only the contract fields', async () => {
  const bodies = [];
  const c = client();
  const r = await c.extractPurchaseCandidates(
    { imageBase64: IMAGE, inputTier: 'paper_receipt', requestId: 'session01' },
    { invoke: async (name, { body }) => { bodies.push({ name, body }); return { data: GOOD_BODY, error: null }; }, today: () => '2026-09-22' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.review.candidates.length, 1);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].name, 'purchase-import-extract');
  assert.deepEqual(Object.keys(bodies[0].body).sort(), ['contractVersion', 'imageBase64', 'inputTier', 'requestId']);
});

test('server outcomes map to the customer-safe taxonomy, never to server text', async () => {
  const c = client();
  const cases = [
    [{ ok: false, contractVersion: 'purchase-import-v1', errorClass: 'unreadable_document' }, 'unreadable_document'],
    [{ ok: false, contractVersion: 'purchase-import-v1', errorClass: 'too_many_items' }, 'too_many_items'],
    [{ ok: false, contractVersion: 'purchase-import-v1', errorClass: 'Something from the provider' }, 'schema_validation_failed'],
    [{ ok: true, contractVersion: 'other' }, 'schema_validation_failed'],
    [{ ...GOOD_BODY, document: { ...GOOD_BODY.document, documentConfidence: 0.2 } }, 'unreadable_document'],
    [{ ...GOOD_BODY, items: [{ ...GOOD_BODY.items[0], lineClass: 'non_fashion' }] }, 'no_fashion_purchases'],
  ];
  for (const [data, expected] of cases) {
    const r = await c.extractPurchaseCandidates(
      { imageBase64: IMAGE, inputTier: 'order_confirmation', requestId: 'session01' },
      { invoke: async () => ({ data, error: null }), today: () => '2026-09-22' },
    );
    assert.equal(r.errorClass, expected);
  }
});

test('HTTP failures read only the status and the enum class', async () => {
  const c = client();
  const failing = (status, body) => async () => ({
    data: null,
    error: { name: 'FunctionsHttpError', message: 'provider said: secret detail', context: { status, json: async () => body } },
  });
  const expectations = [
    [429, { errorClass: 'rate_limited' }, 'rate_limited'],
    [401, {}, 'unauthorized'],
    [413, {}, 'file_too_large'],
    [503, { errorClass: 'provider_unavailable' }, 'provider_unavailable'],
    [500, { message: 'stack trace here' }, 'provider_unavailable'],
  ];
  for (const [status, body, expected] of expectations) {
    const r = await c.extractPurchaseCandidates(
      { imageBase64: IMAGE, inputTier: 'order_confirmation', requestId: 'session01' },
      { invoke: failing(status, body) },
    );
    assert.equal(r.errorClass, expected);
    assert.equal(Object.keys(r).length, 2, 'no server text travels with the error');
  }
  const offline = await c.extractPurchaseCandidates(
    { imageBase64: IMAGE, inputTier: 'order_confirmation', requestId: 'session01' },
    { invoke: async () => ({ data: null, error: { name: 'FunctionsFetchError' } }) },
  );
  assert.equal(offline.errorClass, 'network_unavailable');
});

test('cancellation abandons the request and its late result is not applied', async () => {
  const c = client();
  const controller = new AbortController();
  let release;
  const pending = c.extractPurchaseCandidates(
    { imageBase64: IMAGE, inputTier: 'order_confirmation', requestId: 'session01', signal: controller.signal },
    {
      invoke: (name, { signal }) =>
        new Promise((resolve) => {
          release = () => resolve({ data: GOOD_BODY, error: null });
          signal.addEventListener('abort', () => resolve({ data: null, error: { name: 'AbortError' } }));
        }),
    },
  );
  controller.abort();
  const r = await pending;
  assert.equal(r.ok, false);
  release?.();
});

test('every error class has customer copy that names no provider and exposes no internals', () => {
  const E = loadModule('services/purchaseImport/purchaseImportErrors.ts');
  for (const cls of E.PURCHASE_IMPORT_ERROR_CLASSES) {
    const p = E.PURCHASE_IMPORT_ERRORS[cls];
    assert.ok(p && p.title && p.message, cls);
    const text = `${p.title} ${p.message}`;
    assert.doesNotMatch(text, /gemini|google|openai|supabase|edge function|stack|http|\d{3}\b|model/i, cls);
  }
  assert.equal(
    E.PURCHASE_IMPORT_ERRORS.file_too_large.title + ' ' + E.PURCHASE_IMPORT_ERRORS.file_too_large.message,
    'This image is too large to process Try cropping it to just the purchased items.',
  );
  assert.equal(E.PURCHASE_IMPORT_ERRORS.unreadable_document.message, 'Try another photo or crop to the purchased items.');
});

// ── Image boundary ───────────────────────────────────────────────────────────

function image({ manipulated } = {}) {
  const m = memfs();
  const calls = [];
  const manipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, actions, options) => {
      calls.push({ uri, actions, options });
      const out = '/cache/ImageManipulator/out.jpg';
      m.files.set(out, 'jpeg');
      return { uri: out, width: 1280, height: 2000, base64: '/9j/AAAA', ...(manipulated || {}) };
    },
  };
  const mod = loadModule('services/purchaseImport/purchaseImportImage.ts', {
    externals: { 'expo-file-system/legacy': m.api, 'expo-image-manipulator': manipulator },
  });
  return { m, calls, mod };
}

test('only images are accepted; filenames are consulted for their extension only', () => {
  const { mod } = image();
  assert.equal(mod.isAcceptedPickedImage({ uri: '/cache/a.png', width: 800, height: 1600, mimeType: 'image/png' }), true);
  assert.equal(mod.isAcceptedPickedImage({ uri: '/cache/a.pdf', width: 800, height: 1600, mimeType: 'application/pdf' }), false);
  assert.equal(mod.isAcceptedPickedImage({ uri: '/cache/a.gif', width: 800, height: 1600 }), false);
  assert.equal(mod.isAcceptedPickedImage({ uri: '/cache/a.jpg', width: 20, height: 20 }), false);
});

test('the crop is required to have substance and is clamped to the image', () => {
  const { mod } = image();
  assert.equal(mod.normalizeCrop({ x: 0, y: 0, width: 0.01, height: 1 }), null);
  assert.deepEqual(mod.normalizeCrop({ x: -1, y: 0.5, width: 5, height: 5 }), { x: 0, y: 0.5, width: 1, height: 0.5 });
});

test('R / RPI-32: a crop that would exceed the height bound is refused, not cut', () => {
  const { mod } = image();
  const plan = mod.planCrop({ width: 1080, height: 20000 }, { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(plan, { ok: false, errorClass: 'file_too_large' });
  const ok = mod.planCrop({ width: 1080, height: 20000 }, { x: 0, y: 0.1, width: 1, height: 0.15 });
  assert.equal(ok.ok, true);
});

test('prepare: crops, re-encodes as JPEG (metadata strip), and deletes the intermediate whatever happens', async () => {
  const { m, calls, mod } = image();
  const staged = { uri: '/cache/ImagePicker/p.jpg', stagedUri: '/cache/kscan_purchase_import/s.jpg', width: 1080, height: 2400 };
  const r = await mod.prepareCroppedImage(staged, { x: 0, y: 0.2, width: 1, height: 0.4 });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.format, 'jpeg');
  assert.equal(calls[0].options.base64, true);
  assert.ok(calls[0].actions[0].crop, 'the crop is the first operation: nothing outside it is encoded');
  assert.equal(m.files.has('/cache/ImageManipulator/out.jpg'), false);
});

test('prepare: an encoded image over the byte bound is refused and still cleaned up', async () => {
  const { m, mod } = image({ manipulated: { base64: '/9j/' + 'A'.repeat(2 * 1024 * 1024) } });
  const staged = { uri: 'x', stagedUri: '/cache/kscan_purchase_import/s.jpg', width: 1080, height: 2400 };
  const r = await mod.prepareCroppedImage(staged, { x: 0, y: 0, width: 1, height: 0.5 });
  assert.deepEqual(r, { ok: false, errorClass: 'file_too_large' });
  assert.equal(m.files.has('/cache/ImageManipulator/out.jpg'), false);
});

test('RPI-35: staging copies into the feature namespace, removes the picker cache copy, and the sweep empties it', async () => {
  const { m, mod } = image();
  m.files.set('/cache/ImagePicker/pick.jpg', 'receipt-bytes');
  const staged = await mod.stagePickedImage({ uri: '/cache/ImagePicker/pick.jpg', width: 1080, height: 2400, mimeType: 'image/jpeg', fileName: 'pick.jpg' });
  assert.ok(staged.stagedUri.startsWith('/cache/kscan_purchase_import/'));
  assert.ok(staged.stagedUri.endsWith('.jpg'));
  assert.equal(m.files.has('/cache/ImagePicker/pick.jpg'), false, "the picker's cache copy of the receipt is removed");
  assert.equal(m.files.get(staged.stagedUri), 'receipt-bytes');
  await mod.sweepPurchaseImportArtifacts();
  assert.deepEqual([...m.files.keys()].filter((k) => k.startsWith('/cache/kscan_purchase_import/')), []);
});

test('staging never deletes a file outside this app cache (the photo library is never touched)', async () => {
  const { m, mod } = image();
  m.files.set('content://media/external/images/1', 'library-photo');
  await mod.stagePickedImage({ uri: 'content://media/external/images/1', width: 1080, height: 2400, mimeType: 'image/jpeg' });
  assert.equal(m.files.has('content://media/external/images/1'), true);
});
