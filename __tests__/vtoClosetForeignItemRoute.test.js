// Launch-contract negative N-08 (client half): an owned-Closet try-on can only
// ever be resolved from the CURRENT actor's own Closet. A route parameter that
// names another account's item (or nothing at all) never reaches the garment
// resolver, never mounts a generation surface, and never asks for another
// account's Closet. The backend half (foreign actor / foreign item / foreign
// storage path refused before signing or any provider spend) is covered by
// supabase/functions/vto-generate/vtoOwnedGarment.test.ts.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderer, runModule, deepStub, findAll, settle } = require('./helpers/componentRenderer');
const actor = require('../services/actorContext');

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A_ITEM = 'closet-item-owned-by-A';
const B_ITEM = 'closet-item-owned-by-B';
const garment = { productRef: `closet_item:${A_ITEM}`, source: { type: 'closet_item', closetItemId: A_ITEM }, imageUrl: 'file:///a.jpg', category: 'top', ownedMediaReady: true };

function harness(closetItemId) {
  actor.__resetActorContextForTests(); actor.advanceActorEpoch(A);
  const r = createRenderer();
  const calls = { closetOwners: [], resolved: [] };
  const closets = {
    [A]: [{ id: A_ITEM, title: 'A blouse', category: 'top' }],
    [B]: [{ id: B_ITEM, title: 'B coat', category: 'outerwear' }],
  };
  const scope = runModule('services/actorScope.ts', { './actorContext': actor });
  const module = runModule('app/closet/try-on.tsx', {
    ...r.runtimeModules,
    'react-native': { Image: 'Image', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (s) => s } },
    'expo-router': { router: {}, useLocalSearchParams: () => ({ closetItemId }) },
    '../../components/luxury': Object.fromEntries(['LuxuryScreen', 'KScanHeader', 'InlineNotice', 'SecondaryButton'].map((n) => [n, n])),
    '../../components/vto/TryItOnEntry': { TryItOnEntry: 'TryItOnEntry' },
    '../../hooks/useVtoAvailability': { useVtoAvailability: () => ({ available: true, loading: false }) },
    '../../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id: A }, isAuthenticated: true }) },
    '../../services/actorScope': scope,
    '../../services/closetLibrary': {
      loadClosetTyped: async (owner) => { calls.closetOwners.push(owner); return { ok: true, items: closets[owner] ?? [] }; },
    },
    '../../services/closetItemProjection': runModule('services/closetItemProjection.ts', {}),
    '../../services/vto/vtoOwnedGarment': {
      resolveOwnedClosetVtoInput: async (item) => { calls.resolved.push(item.id); return { ok: true, garment }; },
    },
    '../../services/navigationExit': {},
    '../../constants/theme': { LUXURY: deepStub(), SPACING: deepStub() },
  });
  const render = () => r.render(r.jsx(module.default, {}));
  render();
  return { render, calls };
}

const entries = (tree) => findAll(tree, (n) => n.type === 'TryItOnEntry');
const unavailable = (tree) => findAll(tree, (n) => n.type === 'InlineNotice' && n.props.title === 'Try-on unavailable' && /unavailable/.test(n.props.body));

test("N-08: another account's Closet item id never reaches the resolver or a generation surface", async () => {
  const h = harness(B_ITEM);
  await settle(4);
  const tree = h.render();
  assert.equal(entries(tree).length, 0, 'no try-on surface for an item that is not the actor\'s');
  assert.equal(unavailable(tree).length, 1, 'a bounded unavailable state, not a blank screen');
  assert.deepEqual(h.calls.resolved, [], 'the garment resolver is never asked about it');
});

test("N-08: the route only ever loads the CURRENT actor's Closet, never the owner of the id it was given", async () => {
  const h = harness(B_ITEM);
  await settle(4);
  assert.ok(h.calls.closetOwners.length >= 1);
  for (const owner of h.calls.closetOwners) assert.equal(owner, A, 'never requests B\'s Closet');
});

test('N-08: a missing or malformed item id is unavailable and resolves nothing', async () => {
  for (const id of [undefined, '', 'not-in-any-closet', '../../etc/passwd', `${A_ITEM}/../${B_ITEM}`]) {
    const h = harness(id);
    await settle(4);
    const tree = h.render();
    assert.equal(entries(tree).length, 0, String(id));
    assert.deepEqual(h.calls.resolved, [], String(id));
  }
});

test('N-08 control: the actor\'s OWN item still resolves and mounts the shared entry', async () => {
  const h = harness(A_ITEM);
  await settle(4);
  const tree = h.render();
  assert.equal(entries(tree).length, 1);
  assert.equal(entries(tree)[0].props.origin, 'closet_item');
  assert.deepEqual(h.calls.resolved, [A_ITEM]);
});
