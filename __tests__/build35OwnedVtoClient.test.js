const test = require('node:test');
const assert = require('node:assert/strict');
const { runModule, deferred } = require('./helpers/componentRenderer');
const actor = require('../services/actorContext');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function harness(syncEntry = null) {
  actor.__resetActorContextForTests(); actor.advanceActorEpoch(A);
  const scope = runModule('services/actorScope.ts', { './actorContext': actor });
  const eligibility = runModule('services/vto/vtoEligibility.ts', {});
  const response = deferred(); const query = [];
  const chain = {
    select: fields => { query.push(['select', fields]); return chain; },
    eq: (key, value) => { query.push([key, value]); return chain; },
    is: (key, value) => { query.push([key, value]); return chain; },
    maybeSingle: () => response.promise,
  };
  const adapter = runModule('services/vto/vtoOwnedGarment.ts', {
    '../supabaseClient': { supabase: { from: table => { query.push(['from',table]); return chain; } } },
    '../actorScope': scope, './vtoEligibility': eligibility,
    '../closet/closetSyncStore': { getClosetSyncEntry: async owner => { assert.equal(owner, A); return syncEntry; } },
  });
  return { adapter, response, query, eligibility };
}
const item = { id: 'local-closet-id', title: 'My blouse', category: 'tops', clothingType: 'shirt', subtype: 'blouse', brand: 'Example', imageUri: 'file:///private/closet.jpg' };
const row = { id: ITEM, user_id: A, category: 'tops', clothing_type: 'shirt', subtype: 'blouse', media_status: 'ready', deleted_at: null };

test('existing actor-partitioned sync evidence preserves the K+ upgrade path without canonical SELECT', async () => {
  const h = harness({ serverId: ITEM, mediaState: 'ready', state: 'synced' });
  const result = await h.adapter.resolveOwnedClosetVtoInput(item);
  assert.equal(result.ok, true); assert.deepEqual(result.garment.source, { type: 'closet_item', closetItemId: ITEM });
  assert.equal(h.query.length, 0);
  assert.deepEqual(h.eligibility.evaluateVtoEligibility({ ...result.garment, featureEnabled: true, hasEntitlement: false }), { eligible: false, reason: 'entitlement_required' });
});

test('canonical client_id mapping produces source-only identity without commerce duplication', async () => {
  const h = harness(); const pending = h.adapter.resolveOwnedClosetVtoInput(item);
  h.response.resolve({ data: row, error: null }); const result = await pending;
  assert.equal(result.ok, true); assert.deepEqual(result.garment.source, { type: 'closet_item', closetItemId: ITEM });
  assert.equal(result.garment.productRef, `closet_item:${ITEM}`);
  assert.equal(result.garment.category, 'top'); assert.equal(result.garment.commerceSource, null);
  assert.ok(h.query.some(([key,value]) => key === 'client_id' && value === item.id));
  assert.ok(h.query.some(([key,value]) => key === 'user_id' && value === A));
  assert.equal(h.eligibility.evaluateVtoEligibility({ ...result.garment, featureEnabled: true, hasEntitlement: true }).eligible, true);
});
for (const [name, value, reason] of [
  ['missing row', null, 'missing_media'], ['missing media', { ...row, media_status: null }, 'missing_media'],
  ['foreign actor', { ...row, user_id: B }, 'missing_media'], ['soft deleted', { ...row, deleted_at: 'now' }, 'missing_media'],
  ['unsupported', { ...row, category: 'shoes', clothing_type: 'sneakers', subtype: null }, 'unsupported_category'],
]) {
  test(`owned client adapter fails safely: ${name}`, async () => {
    const h = harness(); const pending = h.adapter.resolveOwnedClosetVtoInput(item);
    h.response.resolve({ data: value, error: null });
    assert.deepEqual(await pending, { ok: false, reason });
  });
}
test('late canonical row after A→B→A does not launch an owned try-on', async () => {
  const h = harness(); const pending = h.adapter.resolveOwnedClosetVtoInput(item);
  actor.advanceActorEpoch(B); actor.advanceActorEpoch(A);
  h.response.resolve({ data: row, error: null });
  assert.deepEqual(await pending, { ok: false, reason: 'account_changed' });
});

function transport() {
  const types = runModule('types/vto.ts', {});
  const failures = runModule('services/vto/vtoFailures.ts', { '../../types/vto': types });
  return runModule('services/vto/vtoClient.ts', {
    '../supabaseClient': { supabase: {} }, '../authenticatedFunctionSession': {}, './vtoFailures': failures,
  });
}
test('owned transport sends only typed item source and checks response actor/item correlation', async () => {
  const client = transport(); const source = { type: 'closet_item', closetItemId: ITEM }; const calls = [];
  const args = { requestId: 'owned_req', origin: 'closet_item', personDataUri: 'data:image/jpeg;base64,AAAA', garment: { source, productRef: `closet_item:${ITEM}`, imageUrl: 'file:///private-image.jpg', category: 'top', ownedMediaReady: true } };
  const deps = { resolveSession: async () => ({ ok: true, accessToken: 'fixture-token' }), invoke: async (_name, options) => {
    calls.push(options); return { data: { requestId: args.requestId, garmentSource: source, result: { dataUri: 'data:image/png;base64,AAAA', mediaType: 'image/png' } }, error: null };
  } };
  assert.equal((await client.requestVtoGeneration(args, deps)).ok, true);
  assert.deepEqual(calls[0].body.garment, { source });
  assert.ok(!JSON.stringify(calls[0].body).includes('private-image'));
  for (const returnedSource of [undefined, { type: 'closet_item', closetItemId: B }]) {
    const outcome = await client.requestVtoGeneration(args, { ...deps, invoke: async () => ({ data: { requestId: args.requestId, garmentSource: returnedSource, result: { dataUri: 'data:image/png;base64,AAAA', mediaType: 'image/png' } }, error: null }) });
    assert.deepEqual(outcome, { ok: false, code: 'invalid_output' });
  }
});
