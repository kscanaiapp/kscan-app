const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRenderer, runModule, deepStub, findAll, settle, deferred } = require('./helpers/componentRenderer');
const actor = require('../services/actorContext');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const garment = { productRef: `closet_item:${ITEM}`, source: { type: 'closet_item', closetItemId: ITEM }, imageUrl: 'file:///closet.jpg', category: 'top', ownedMediaReady: true };

function harness(availability = { available: true, loading: false }) {
  actor.__resetActorContextForTests(); actor.advanceActorEpoch(A);
  const r = createRenderer(); const pending = deferred(); let id = A; const calls = [];
  const scope = runModule('services/actorScope.ts', { './actorContext': actor });
  const module = runModule('app/closet/try-on.tsx', {
    ...r.runtimeModules,
    'react-native': { Image: 'Image', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: s => s } },
    'expo-router': { router: {}, useLocalSearchParams: () => ({ closetItemId: 'local-item' }) },
    '../../components/luxury': Object.fromEntries(['LuxuryScreen','KScanHeader','InlineNotice','SecondaryButton'].map(n => [n,n])),
    '../../components/vto/TryItOnEntry': { TryItOnEntry: 'TryItOnEntry' },
    '../../hooks/useVtoAvailability': { useVtoAvailability: () => availability },
    '../../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id }, isAuthenticated: true }) },
    '../../services/actorScope': scope,
    '../../services/closetLibrary': { loadClosetTyped: async (owner, options) => { calls.push({ owner, options }); return { ok: true, items: owner === A ? [{ id: 'local-item', title: 'My blouse', category: 'top' }] : [] }; } },
    '../../services/closetItemProjection': runModule('services/closetItemProjection.ts', {}),
    '../../services/vto/vtoOwnedGarment': { resolveOwnedClosetVtoInput: () => pending.promise },
    '../../services/navigationExit': {}, '../../constants/theme': { LUXURY: deepStub(), SPACING: deepStub() },
  });
  const render = () => r.render(r.jsx(module.default, {})); render();
  return { render, pending, calls, switchTo(next) { actor.advanceActorEpoch(next); id = next; render(); } };
}
test('owned route resolves actor-scoped Closet then mounts the existing consent/gate/provider pipeline', async () => {
  const h = harness(); await settle(2);
  h.pending.resolve({ ok: true, garment }); await settle(3);
  const entries = findAll(h.render(), n => n.type === 'TryItOnEntry');
  assert.equal(entries.length, 1); assert.equal(entries[0].props.origin, 'closet_item');
  assert.deepEqual(entries[0].props.garment.source, garment.source);
  assert.equal(h.calls[0].owner, A); assert.equal(h.calls[0].options.actorRequest.actorId, A);
});
test('owned route shows missing-media failure with retry and never mounts a generation surface', async () => {
  const h = harness(); await settle(2);
  h.pending.resolve({ ok: false, reason: 'missing_media' }); await settle(3);
  const tree = h.render(); assert.equal(findAll(tree, n => n.type === 'TryItOnEntry').length, 0);
  assert.equal(findAll(tree, n => n.type === 'InlineNotice' && /synced garment photo/.test(n.props.body)).length, 1);
  assert.equal(findAll(tree, n => n.type === 'SecondaryButton' && n.props.title === 'Try again').length, 1);
});
test('late owned adapter after account switch cannot mount A garment for B', async () => {
  const h = harness(); await settle(2); h.switchTo(B);
  h.pending.resolve({ ok: true, garment }); await settle(3);
  assert.equal(findAll(h.render(), n => n.type === 'TryItOnEntry').length, 0);
});

for (const reason of ['unsupported_category', 'feature_disabled']) {
  test(`owned route preserves ${reason} availability denial without a blank screen`, async () => {
    const h = harness({ available: false, loading: false, upgradeOpportunity: false, eligibility: { eligible: false, reason } });
    await settle(2); h.pending.resolve({ ok: true, garment }); await settle(3);
    const tree = h.render();
    assert.equal(findAll(tree, n => n.type === 'TryItOnEntry').length, 0);
    assert.equal(findAll(tree, n => n.type === 'InlineNotice' && n.props.title === 'Try-on unavailable').length, 1);
  });
}
test('both active canonical Closet card columns wire the owned try-on route', () => {
  const library = fs.readFileSync(path.join(__dirname, '../app/library.tsx'), 'utf8');
  for (const item of ['a','b']) assert.ok(library.includes(`canOfferOwnedClosetVto(${item}) ? () => router.push({ pathname: '/closet/try-on', params: { closetItemId: ${item}.id } })`));
});
