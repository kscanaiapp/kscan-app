const test = require('node:test');
const assert = require('node:assert/strict');
const { runModule, deferred } = require('./helpers/componentRenderer');
const actor = require('../services/actorContext');

function harness() {
  actor.__resetActorContextForTests();
  actor.advanceActorEpoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const scope = runModule('services/actorScope.ts', { './actorContext': actor });
  let response = { data: { status: 'no_result' }, error: null };
  let preflight = async () => ({ ok: true, accessToken: 'fixture-token' });
  const calls = [];
  const client = runModule('services/styleOutfits.ts', {
    './supabaseClient': { supabase: { functions: { invoke: async (...args) => { calls.push(args); return response; } } } },
    './authenticatedFunctionSession': { resolveAuthenticatedFunctionSession: () => preflight() },
    './actorScope': scope,
    '../constants/featureFlags': { AI_STYLIST_UI_ENABLED: true, AI_STYLIST_BACKEND_ENABLED: true },
    '../types/fashionReasoning': runModule('types/fashionReasoning.ts', {}),
    '../types/ownedClosetItem': runModule('types/ownedClosetItem.ts', {}),
  });
  return { client, calls, setResponse(r) { response = r; }, setPreflight(p) { preflight = p; } };
}

for (const [status, body, expected] of [
  [429, { status: 'quota_exceeded', usage: { generationsUsed: 10, generationsLimit: 10 } }, 'quota_exceeded'],
  [429, { status: 'burst_limit', retryAfterSeconds: 4.2 }, 'burst_limit'],
  [401, { error: 'auth diagnostic' }, 'session_expired'],
  [403, { error: 'account inactive diagnostic' }, 'session_expired'],
  [403, { error: 'Anchor item is not available for styling' }, 'error'],
  [400, { error: 'raw input contents' }, 'error'],
  [422, { error: 'raw provider request' }, 'error'],
  [503, { status: 'quota_exceeded' }, 'unavailable'],
  [429, { error: 'unknown response' }, 'burst_limit'],
]) {
  test(`real HTTP ${status} (${body.status ?? 'unclassified'}) maps to ${expected}`, async () => {
    const h = harness();
    h.setResponse({ data: null, error: { context: new Response(JSON.stringify(body), { status }) } });
    const result = await h.client.generateOutfits({ mode: 'style_event' });
    assert.equal(result.status, expected);
    assert.ok(!JSON.stringify(result).includes('diagnostic'));
    if (body.status === 'burst_limit') assert.equal(result.retryAfterSeconds, 5);
    if (body.status === 'quota_exceeded' && status === 429) assert.deepEqual(result.usage, body.usage);
    if (expected === 'quota_exceeded') assert.equal(result.message, h.client.AI_QUOTA_MESSAGE);
    if (expected === 'burst_limit') assert.equal(result.message, h.client.AI_BURST_MESSAGE);
    assert.equal(h.client.isInUnavailableCooldown(), expected === 'unavailable');
  });
}

test('invalid JSON in HTTP 429 remains a bounded temporary limit without outage cooldown', async () => {
  const h = harness();
  h.setResponse({ data: null, error: { context: new Response('not json', { status: 429 }) } });
  assert.deepEqual(await h.client.generateOutfits({ mode: 'style_event' }), {
    status: 'burst_limit', message: h.client.AI_BURST_MESSAGE, retryAfterSeconds: 60,
  });
  assert.equal(h.client.isInUnavailableCooldown(), false);
});

test('successful no-result and network outage remain separate', async () => {
  const h = harness();
  assert.equal((await h.client.generateOutfits({ mode: 'style_event' })).status, 'no_result');
  h.setResponse({ data: null, error: new Error('network secret') });
  assert.equal((await h.client.generateOutfits({ mode: 'style_event' })).status, 'unavailable');
});

test('actor change during auth preflight makes no outfit invocation', async () => {
  const h = harness(); const auth = deferred();
  h.setPreflight(() => auth.promise);
  const pending = h.client.generateOutfits({ mode: 'style_event', event: { note: 'A private context' } });
  actor.advanceActorEpoch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  auth.resolve({ ok: true, accessToken: 'A-token' });
  assert.equal((await pending).status, 'session_expired');
  assert.equal(h.calls.length, 0);
});

test('outfit outage cooldown does not transfer to the next actor', async () => {
  const h = harness();
  h.setResponse({ data: null, error: new Error('offline') });
  await h.client.generateOutfits({ mode: 'style_event' });
  actor.advanceActorEpoch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  h.setResponse({ data: { status: 'no_result' }, error: null });
  assert.equal((await h.client.generateOutfits({ mode: 'style_event' })).status, 'no_result');
  assert.equal(h.calls.length, 2);
});
