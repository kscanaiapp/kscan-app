'use strict';

// #703: actual direct attachment/privacy service; synthetic encoder/persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runModule, deferred, settle } = require('./helpers/componentRenderer');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function elise() {
  const actor = runModule('services/actorContext.js', {}, { jsx: false });
  actor.advanceActorEpoch(A);
  const encoding = deferred(); const writes = []; const deleted = [];
  const privacy = runModule('services/privacyImageUpload.ts', {
    'expo-image-manipulator': {
      SaveFormat: { JPEG: 'jpeg' },
      manipulateAsync: async () => { await encoding.promise; return { uri: 'file:///cache/derived-a.jpg', width: 32, height: 32 }; },
    },
    'expo-file-system/legacy': { deleteAsync: async (uri) => { deleted.push(uri); } },
  });
  const direct = runModule('services/style-chat/eliseDirectImageAttachment.ts', {
    '../imageUtils': { SCANNER_IMAGE_MAX_WIDTH: 1024, SCANNER_IMAGE_JPEG_QUALITY: 0.85 },
    '../privacyImageUpload': privacy, '../actorContext': actor,
    '../closetCandidateLibrary': {
      getClosetCandidate: async () => ({ ok: true, candidate: { status: 'ready_for_review' } }),
      updateClosetCandidate: async () => ({ ok: true, candidate: { status: 'ready_for_review' } }),
      createClosetCandidate: async (request, payload) => {
        writes.push({ request, payload });
        return { kind: 'created', candidate: { candidateId: 'synthetic-candidate', batchId: 'synthetic-batch', candidateImageUri: `file:///owned/${request.actorId}/candidate.jpg` } };
      },
    },
    '../closetCandidatePromotion': {},
  });
  return { actor, direct, encoding, writes, deleted, run: () => direct.prepareEliseDirectImage('file:///photos/private-a.jpg', 'photo_library') };
}

// Repair regression controls for the two existing callers of the same staging
// helper. These extend the confirmed INT-004 fix; no extra matrix credit.
for (const enabled of [false, true]) for (const phase of ['compress', 'identify']) {
  test(`703 Elise repair: ${enabled ? 'V2' : 'legacy'} header gallery fences actor changes during ${phase}`, async () => {
    const h = elise(); const gate = deferred(); const reached = deferred(); let dispatches = 0;
    const boundary = async name => { if (phase === name) { reached.resolve(); await gate.promise; } };
    const mod = runModule('services/style-chat/eliseVisualContextEvidence.ts', {
      '../actorContext': h.actor,
      '../privacyImageUpload': { PrivacyPrepareError: class extends Error {},
        compressSanitizedImageForAnalysis: async () => { await boundary('compress'); return { base64: 'data:image/jpeg;base64,AAAA' }; } },
      '../scanIdentification': { identifyScanImage: async () => { dispatches += 1; await boundary('identify'); return { status: 'completed' }; } },
      '../scanIdentificationMapper': { mapScanIdentifyToAnalysis: () => ({ type: 'fashion', title: 'Jacket', metadata: { category: 'outerwear' } }) },
      './eliseDirectImageAttachment': h.direct,
      '../fashionEvidenceGateway': { prepareFashionEvidence: x => x },
      './eliseIdentifyForStyle': { identifyPreparedImageForStyle: async () => {
        dispatches += 1; await boundary('identify');
        return { state: 'ready', identifications: [{}] };
      } },
      './eliseIdentificationV2': { beginEliseV2Session: () => ({ enabled }), createEvidenceId: () => 'synthetic-evidence' },
      './eliseDirectImageIdentification': { currentIdentificationPlatform: () => 'ios' },
      './eliseVisualContextV2Projection': { projectV2ToVisualContextFields: () => ({ title: 'Jacket', category: 'outerwear', summary: null, confidence: null }) },
    });
    const pending = mod.prepareVisualContextEvidence({ sanitizedUri: 'file:///cache/derived-a.jpg', sessionFlag: { enabled }, isCurrent: () => true });
    await reached.promise; h.actor.advanceActorEpoch(B); gate.resolve();
    const result = await pending;
    assert.equal(h.writes.length, 0, 'shared header staging must retain the origin before async work');
    assert.equal(result.ok, false); assert.equal(result.reason, 'cancelled');
    assert.equal(dispatches, phase === 'compress' ? 0 : 1, 'stale compression must not start identification');
  });
}

test('703 Elise positive control: metadata-prepared derivative is staged for the initiating actor', async () => {
  const h = elise(); const pending = h.run(); h.encoding.resolve();
  const result = await pending;
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].request.actorId, A);
  assert.equal(h.writes[0].payload.sourceUri, 'file:///cache/derived-a.jpg');
  assert.equal(result.preparedUri, 'file:///cache/derived-a.jpg');
});

for (const transition of ['A-B', 'A-B-A']) {
  test(`703 Elise ${transition}: delayed preparation cannot stage A image in a new actor generation`, async () => {
    const h = elise();
    const outcome = h.run().then((value) => ({ value }), (error) => ({ error }));
    await settle(); h.actor.advanceActorEpoch(B);
    if (transition === 'A-B-A') h.actor.advanceActorEpoch(A);
    h.encoding.resolve(); const settled = await outcome;
    assert.equal(h.writes.length, 0, 'candidate ownership must be captured before encoding, not after it');
    assert.ok(settled.error, 'stale preparation must fail closed');
    assert.ok(h.deleted.includes('file:///cache/derived-a.jpg'), 'drop the stale derivative');
  });
}
