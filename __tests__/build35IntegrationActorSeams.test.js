const test = require('node:test');
const assert = require('node:assert/strict');
const { runModule, deferred } = require('./helpers/componentRenderer');
const { createHookRuntime, settle } = require('./helpers/hookRuntime');
const { loadModule } = require('./helpers/purchaseImportHarness');
const actor = require('../services/actorContext.js');

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function hookHarness(file, name, dependencies, args) {
  actor.__resetActorContextForTests();
  actor.advanceActorEpoch(A);
  const runtime = createHookRuntime();
  let auth = { isAuthenticated: true, user: { id: A } };
  const scope = runModule('services/actorScope.ts', { './actorContext': actor });
  const hook = runModule(file, {
    react: runtime.react,
    '../contexts/AuthSessionContext': { useAuthSession: () => auth },
    '../services/actorScope': scope,
    '../services/actorContext': actor,
    ...dependencies(runtime),
  })[name];
  let api;
  const render = () => {
    runtime.beginRender();
    api = hook(args);
    runtime.flushEffects();
  };
  const flush = async () => {
    await settle(2);
    for (let i = 0; runtime.dirty && i < 20; i += 1) {
      runtime.clearDirty();
      render();
      await settle(2);
    }
  };
  render();
  return {
    get api() { return api; },
    flush,
    unmount: () => runtime.unmount(),
    switchTo(id, rerender = true) {
      actor.advanceActorEpoch(id);
      auth = { isAuthenticated: !!id, user: id ? { id } : null };
      if (rerender) render();
    },
  };
}

function pickerHarness() {
  const requests = [];
  const scans = [];
  const h = hookHarness('hooks/useOwnedClosetItems.ts', 'useOwnedClosetItems', () => ({
    './useLibrary': { useLibrary: () => ({ scans, loading: false }) },
    '../services/ownedClosetItems': {
      listOwnedClosetItems: () => {
        const d = deferred(); requests.push(d); return d.promise;
      },
      normalizeLocalSavedScan: (s) => s,
    },
  }));
  return { ...h, get api() { return h.api; }, requests };
}

test('Closet picker rejects a late A load after B loads, including A -> B -> A', async () => {
  const h = pickerHarness();
  h.switchTo(B);
  await h.flush();
  assert.equal(h.requests.length, 2, 'B needs a fresh load even when both actors are authenticated');
  h.requests[1].resolve([{ title: 'B wardrobe' }]);
  await h.flush();
  h.requests[0].resolve([{ title: 'A wardrobe' }]);
  await h.flush();
  assert.deepEqual(h.api.items, [{ title: 'B wardrobe' }]);
  h.switchTo(A);
  await h.flush();
  assert.deepEqual(h.api.items, [], 'previous generation cannot remain visible');
  h.requests[2].resolve([{ title: 'new A wardrobe' }]);
  await h.flush();
  assert.deepEqual(h.api.items, [{ title: 'new A wardrobe' }]);
  h.unmount();
});

test('Closet picker keeps newest refresh and discards departed actor errors/finally', async () => {
  const h = pickerHarness();
  const refresh = h.api.reload();
  h.requests[1].resolve([{ title: 'current wardrobe' }]);
  await refresh; await h.flush();
  h.requests[0].resolve([{ title: 'old wardrobe' }]);
  await h.flush();
  assert.equal(h.api.items[0].title, 'current wardrobe');
  const old = h.api.reload();
  h.switchTo(B);
  h.requests[2].reject(new Error('A private error'));
  await old; await h.flush();
  assert.equal(h.api.error, null);
  assert.equal(h.api.loading, true);
  h.requests[3].resolve([]);
  await h.flush();
  h.unmount();
});

test('canonical Closet query failure is an error, not an empty wardrobe', async () => {
  const service = runModule('services/ownedClosetItems.ts', {
    './supabaseClient': { supabase: { from(table) {
      const query = { select() { return this; }, is() { return this; }, order() {
        return Promise.resolve({ data: [], error: table === 'user_closet_items' ? { message: 'permission denied' } : null });
      } };
      return query;
    } } },
    './savedScansCloud': {},
    '../types/ownedClosetItem': runModule('types/ownedClosetItem.ts', {}),
  });
  await assert.rejects(service.listOwnedClosetItems(), /closet/i);
});

test('Elise conversation list rejects departed actor history and reloads for B', async () => {
  const requests = [];
  const h = hookHarness('hooks/useStyleChatSessions.ts', 'useStyleChatSessions', (runtime) => ({
    'expo-router': { useFocusEffect: (cb) => runtime.react.useEffect(cb, [cb]) },
    '../services/style-chat/styleChatRepository': {
      listStyleChatSessions: () => { const d = deferred(); requests.push(d); return d.promise; },
    },
    '../services/style-chat/styleChatErrors': { getFriendlyStyleChatError: () => 'Unable to load conversations.' },
  }));
  h.switchTo(B); await h.flush();
  assert.equal(requests.length, 2);
  requests[1].resolve([{ id: 'B', title: 'B conversation' }]); await h.flush();
  requests[0].resolve([{ id: 'A', title: 'A private conversation' }]); await h.flush();
  assert.deepEqual(h.api.sessions, [{ id: 'B', title: 'B conversation' }]);
  h.unmount();
});

function importHarness(sweep = async () => {}) {
  const staged = deferred();
  const discarded = [];
  let calls = 0;
  let stageCalls = 0;
  const h = hookHarness('hooks/usePurchaseImport.ts', 'usePurchaseImport', () => ({
    '../constants/featureFlags': { RECEIPT_INTELLIGENCE_V1: true },
    '../services/closetLibrary': { loadCloset: async () => [] },
    '../services/purchaseImport/purchaseImportClient': { extractPurchaseCandidates: async () => { calls += 1; return { ok: false, errorClass: 'unreadable_document' }; } },
    '../services/purchaseImport/purchaseImportCommit': { commitPurchaseDrafts: async () => ({}), draftsToRetry: (x) => x },
    '../services/purchaseImport/purchaseImportImage': {
      stagePickedImage: () => { stageCalls += 1; return staged.promise; },
      discardPurchaseImportArtifacts: async (s) => { if (s) discarded.push(s.stagedUri); },
      sweepPurchaseImportArtifacts: sweep,
      prepareCroppedImage: async () => ({ ok: true, base64: 'receipt' }),
    },
    '../services/purchaseImport/purchaseImportReview': { selectedUnitCount: () => 0 },
    '../services/purchaseImport/purchaseImportTelemetry': { emitPurchaseImportEvent() {} },
  }));
  return { ...h, get api() { return h.api; }, staged, discarded, get calls() { return calls; }, get stageCalls() { return stageCalls; } };
}

test('receipt staging waits for entry cleanup and preserves a current actor document', async () => {
  const sweep = deferred();
  const h = importHarness(() => sweep.promise);
  const pending = h.api.acceptPickedImage({ uri: 'current receipt' });
  await h.flush();
  assert.equal(h.stageCalls, 0, 'cleanup cannot run concurrently with new staged files');
  sweep.resolve(); await h.flush();
  assert.equal(h.stageCalls, 1);
  h.staged.resolve({ stagedUri: '/cache/current-receipt.jpg' });
  await pending; await h.flush();
  assert.equal(h.api.state.step, 'crop');
  assert.equal(h.api.state.staged.stagedUri, '/cache/current-receipt.jpg');
  assert.deepEqual(h.discarded, []);
  h.unmount();
});

test('late receipt staging cannot put A image into B workflow', async () => {
  const h = importHarness();
  const pending = h.api.acceptPickedImage({ uri: 'A receipt' });
  await h.flush();
  h.switchTo(B); await h.flush();
  h.staged.resolve({ stagedUri: '/cache/A-receipt.jpg' });
  await pending; await h.flush();
  assert.equal(h.api.state.staged, null);
  assert.ok(h.discarded.includes('/cache/A-receipt.jpg'));
  h.unmount();
});

test('navigation away invalidates receipt staging and releases its late file', async () => {
  const h = importHarness();
  const pending = h.api.acceptPickedImage({ uri: 'A receipt' });
  await h.flush();
  h.unmount();
  h.staged.resolve({ stagedUri: '/cache/abandoned-receipt.jpg' });
  await pending;
  assert.ok(h.discarded.includes('/cache/abandoned-receipt.jpg'));
});

test('receipt crop completion cannot send A document after actor epoch changes before React renders', async () => {
  const h = importHarness();
  const pending = h.api.acceptPickedImage({ uri: 'A receipt' });
  h.staged.resolve({ stagedUri: '/cache/A-receipt.jpg' }); await pending; await h.flush();
  const extracting = h.api.extract({ x: 0, y: 0, width: 1, height: 1 });
  h.switchTo(B, false);
  await extracting;
  assert.equal(h.calls, 0);
  h.unmount();
});

test('receipt cancellation during auth preflight makes no invoke', async () => {
  const session = deferred();
  const c = loadModule('services/purchaseImport/purchaseImportClient.ts', { externals: {
    '../supabaseClient': { supabase: {} },
    '../authenticatedFunctionSession': {},
    '../../constants/featureFlags': { RECEIPT_INTELLIGENCE_V1: true },
  } });
  const controller = new AbortController();
  let calls = 0;
  const pending = c.extractPurchaseCandidates({ imageBase64: 'receipt', inputTier: 'paper_receipt', requestId: 'r1', signal: controller.signal }, {
    resolveSession: () => session.promise,
    invoke: async () => { calls += 1; return { data: {}, error: null }; },
  });
  controller.abort(); session.resolve({ ok: true, accessToken: 'A-token' });
  await pending;
  assert.equal(calls, 0);
});

function vtoPickerHarness() {
  const picker = deferred(); const attached = []; const released = [];
  const h = hookHarness('hooks/useVirtualTryOn.ts', 'useVirtualTryOn', runtime => {
    runtime.react.useLayoutEffect = runtime.react.useEffect;
    runtime.react.useSyncExternalStore = (_subscribe, get) => get();
    return {
      '../services/vto/vtoRequestStore': {
        getVtoSnapshot: () => ({ status: 'idle', person: null }), subscribeToVto() {},
        setVtoPersonInput: person => attached.push(person), leaveVtoSurface() {},
      },
      '../services/vto/vtoPersonInput': {
        pickVtoPersonInput: () => picker.promise, releaseVtoPersonInput: async person => released.push(person),
      },
      '../services/vto/vtoConsent': { hasVtoConsent: () => true },
    };
  }, { garment: { productRef: 'closet_item:A', imageUrl: '', category: 'top' }, origin: 'closet_item' });
  return { ...h, get api() { return h.api; }, picker, attached, released };
}
for (const boundary of ['actor change', 'unmount']) {
  test(`person photo picker completion after ${boundary} cannot attach private imagery`, async () => {
    const h = vtoPickerHarness();
    const selecting = h.api.selectPerson();
    if (boundary === 'actor change') h.switchTo(B, false); else h.unmount();
    const person = { sanitizedUri: '/cache/A-person.jpg', source: 'photo_library' };
    h.picker.resolve({ ok: true, person });
    assert.deepEqual(await selecting, { ok: false, reason: 'cancelled' });
    assert.deepEqual(h.attached, []); assert.deepEqual(h.released, [person.sanitizedUri]);
    h.unmount();
  });
}

test('current actor person picker still attaches the sanitized photo', async () => {
  const h = vtoPickerHarness();
  const selecting = h.api.selectPerson();
  const person = { sanitizedUri: '/cache/current-person.jpg', source: 'photo_library' };
  h.picker.resolve({ ok: true, person });
  assert.deepEqual(await selecting, { ok: true, person });
  assert.deepEqual(h.attached, [person]);
  assert.deepEqual(h.released, []);
  h.unmount();
});
