'use strict';

// #703: actual Scanner modules; only auth/network/native boundaries synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runModule, deferred, settle } = require('./helpers/componentRenderer');
const { fixtureInput } = require('./helpers/scannerPrivacyFixture');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const image = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures/image-upload/small-jpeg.jpg')).toString('base64');

function scanner(options = {}) {
  const actor = runModule('services/actorContext.js', {}, { jsx: false });
  actor.advanceActorEpoch(A);
  const authGate = deferred(); const calls = [];
  const adapter = runModule('services/scanIdentification.ts', {
    './actorContext': actor,
    './supabaseClient': { supabase: {
      auth: { getSession: async () => { await authGate.promise; return { data: { session: { ...(options.missingToken ? {} : { access_token: 'synthetic-token-a' }), user: { id: actor.getActorContext().actorId } } } }; } },
      functions: { invoke: async (name, options) => { calls.push({ name, body: options.body }); return { data: { status: 'completed', attributes: { category: 'tops' }, recommendedProducts: [] }, error: null }; } },
    } },
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
  });
  const guard = runModule('services/privacy/scannerDispatchGuard.ts', { '../actorContext': actor });
  const request = runModule('services/scannerScanRequest.ts', {
    './actorContext': actor, './scanIdentification': adapter,
    './privacy/scannerDispatchGuard': guard,
    './scannerIdentificationV2': {}, // legacy path; existing V2 evidence reused
  });
  const input = fixtureInput(guard, {
    mode: 'detect_items', evidence: { evidenceId: 'ev_synthetic_private_a', imageBase64: image, source: 'gallery', mimeType: 'image/jpeg' },
    sessionFlag: { enabled: false }, platform: 'ios', requestId: 'residual-private-a',
  });
  return { actor, authGate, calls, run: () => request.runScannerIdentification(input) };
}

test('703 Scanner: a missing preflight token cannot fall back to a later SDK identity', async () => {
  const h = scanner({ missingToken: true }); h.authGate.resolve();
  await h.run();
  assert.equal(h.calls.length, 0);
});

test('703 Scanner: cached prepared proof from A cannot authorize B', async () => {
  const h = scanner(); h.actor.advanceActorEpoch(B); h.authGate.resolve();
  await h.run();
  assert.equal(h.calls.length, 0, 'byte equality is not ownership authority');
});

test('703 Scanner: actor change during local preparation discards the derivative and proof', async () => {
  const actor = runModule('services/actorContext.js', {}, { jsx: false });
  actor.advanceActorEpoch(A); const gate = deferred(); let cleaned = 0;
  const guard = runModule('services/privacy/scannerDispatchGuard.ts', { '../actorContext': actor });
  const prepare = runModule('services/privacy/scannerImagePreparation.ts', {
    '../actorContext': actor,
    './privacyBoundary': { prepareImageForDispatch: () => gate.promise, PrivacyDispatchBlockedError: class extends Error {} },
    '../privacyImageUpload': { compressSanitizedImageForAnalysis: async () => ({ uri: 'file:///cache/encoded-a.jpg', base64: image }), cleanupSanitizedImage: async () => {} },
    './scannerDispatchGuard': guard,
  });
  const outcome = prepare.prepareScannerImageForDispatch('file:///photos/private-a.jpg').then(value => ({ value }), error => ({ error }));
  await settle(); actor.advanceActorEpoch(B);
  gate.resolve({ status: 'SANITIZED_AND_VERIFIED', sanitizedUri: 'file:///cache/derived-a.jpg', width: 32, height: 32,
    proof: { processingCompleted: true, outputVerified: true, metadataStripped: true, faceDetectionPerformed: true, plateDetectionPerformed: true },
    cleanup: async () => { cleaned += 1; } });
  const result = await outcome;
  assert.ok(result.error, 'stale preparation must not return a proof for B');
  assert.equal(cleaned, 1);
});

test('703 Scanner positive control: prepared A bytes reach the real invoke body exactly once', async () => {
  const h = scanner(); const pending = h.run(); await settle();
  assert.equal(h.calls.length, 0); h.authGate.resolve();
  assert.equal((await pending).response.status, 'completed');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, 'scan-identify');
  assert.equal(h.calls[0].body.imageBase64, image.split(',')[1]);
  assert.equal(h.calls[0].body.userId, undefined);
});

for (const transition of ['A-B', 'A-B-A']) {
  test(`703 Scanner ${transition}: auth preflight cannot transmit the previous actor image before React cleanup`, async () => {
    const h = scanner(); const pending = h.run(); await settle();
    h.actor.advanceActorEpoch(B);
    if (transition === 'A-B-A') h.actor.advanceActorEpoch(A);
    h.authGate.resolve(); await pending;
    assert.equal(h.calls.length, 0, 'old prepared pixels must not cross the invoke boundary under another actor generation');
  });
}

test('703 Scanner: the actual SDK cannot rebind an already-authorized image to B while resolving its fetch token', async () => {
  const { createClient } = require('@supabase/supabase-js');
  const actor = runModule('services/actorContext.js', {}, { jsx: false });
  actor.advanceActorEpoch(A); const signing = deferred(); const captured = [];
  const sdk = createClient('https://synthetic.invalid', 'synthetic-publishable-key', { accessToken: async () => {
    await signing.promise;
    return actor.getActorContext().actorId === A ? 'synthetic-token-a' : 'synthetic-token-b';
  }, global: { fetch: async (_url, options) => {
    captured.push({ authorization: new Headers(options.headers).get('Authorization'), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ status: 'completed', attributes: { category: 'tops' }, recommendedProducts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } } });
  const adapter = runModule('services/scanIdentification.ts', {
    './actorContext': actor,
    './supabaseClient': { supabase: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic-token-a', user: { id: A } } } }) },
      functions: sdk.functions,
    } },
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
  });
  const pending = adapter.identifyScanImage(image); await settle();
  actor.advanceActorEpoch(B); signing.resolve(); await pending;
  assert.equal(captured.length, 1);
  assert.equal(captured[0].authorization, 'Bearer synthetic-token-a', 'the SDK must retain the identity that authorized these pixels');
  assert.equal(captured[0].body.imageBase64, image.split(',')[1]);
});
