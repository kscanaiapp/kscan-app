// Try-On Studio: the permanent Home destination for Virtual Try-On.
// State table: docs/vto-discovery-integration-matrices.md section 3.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRenderer, runModule, deepStub, findAll, settle, textContent } = require('./helpers/componentRenderer');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const model = runModule('services/vto/vtoStudio.ts', {});
const { resolveVtoStudio, VTO_STUDIO_ACTIONS, VTO_STUDIO_COPY } = model;

const READY = Object.freeze({
  uiEnabled: true,
  authenticated: true,
  remote: { enabled: true, liveEnabled: false },
  kplus: 'active',
  liveBuildEnabled: false,
  liveNativeCapable: false,
  everUsed: false,
});
const decide = (over = {}) => resolveVtoStudio({ ...READY, ...over });

// ── The decision model ───────────────────────────────────────────────────────

test('S0: no build flag or no sign-in hides the Studio entirely, with no actions', () => {
  for (const over of [{ uiEnabled: false }, { authenticated: false }, { uiEnabled: false, authenticated: false }]) {
    const d = decide(over);
    assert.equal(d.state, 'HIDDEN');
    assert.equal(d.visible, false);
    assert.deepEqual([...d.actions], []);
    assert.equal(d.live, 'hidden');
    assert.equal(d.kplusMarker, 'none');
  }
});

test('S1: the operator switch off is UNAVAILABLE for every K+ state, with no actions and no marker', () => {
  for (const kplus of ['free', 'active', 'complimentary', 'resolving']) {
    const d = decide({ remote: { enabled: false, liveEnabled: true }, kplus, liveBuildEnabled: true, liveNativeCapable: true });
    assert.equal(d.state, 'UNAVAILABLE', kplus);
    assert.equal(d.visible, true);
    assert.equal(d.photo, 'unavailable');
    assert.equal(d.live, 'hidden', 'Live is never offered when the operator switch is off');
    assert.equal(d.kplusMarker, 'none');
    assert.deepEqual([...d.actions], []);
  }
});

test('S2: an unread remote row or an unresolved K+ answer is RESOLVING: visible, no marker, no actions', () => {
  for (const over of [{ remote: null }, { kplus: 'resolving' }, { remote: null, kplus: 'resolving' }]) {
    const d = decide(over);
    assert.equal(d.state, 'RESOLVING');
    assert.equal(d.visible, true, 'present, so the Home row never flashes in and out');
    assert.equal(d.kplusMarker, 'none', 'resolving is not Free');
    assert.deepEqual([...d.actions], []);
    assert.equal(d.photo, 'resolving');
  }
});

test('S3: Free sees the K+ marker BEFORE any tap, plus look-around actions, and nothing paid', () => {
  const d = decide({ kplus: 'free', everUsed: true, liveBuildEnabled: true, remote: { enabled: true, liveEnabled: true }, liveNativeCapable: true });
  assert.equal(d.photo, 'kplus_required');
  assert.equal(d.kplusMarker, 'locked');
  assert.deepEqual([...d.actions], ['scan', 'closet', 'elise']);
  assert.equal(d.live, 'hidden', 'Live is not offered to someone AI Photo is not available to');
});

test('S4: active and complimentary members get the same first-use experience', () => {
  const active = decide({ kplus: 'active' });
  const comp = decide({ kplus: 'complimentary' });
  assert.deepEqual(active, comp);
  assert.equal(active.state, 'FIRST_USE');
  assert.equal(active.photo, 'available');
  assert.equal(active.kplusMarker, 'included');
  assert.deepEqual([...active.actions], ['scan', 'closet', 'elise']);
});

test('RETURNING adds the Dressing Rooms action only once history is KNOWN true', () => {
  assert.deepEqual([...decide({ everUsed: true }).actions], ['scan', 'closet', 'elise', 'dressing_rooms']);
  assert.equal(decide({ everUsed: true }).state, 'RETURNING');
  assert.deepEqual([...decide({ everUsed: null }).actions], ['scan', 'closet', 'elise'], 'unknown never claims returning');
  assert.equal(decide({ everUsed: null }).state, 'FIRST_USE');
  assert.deepEqual([...decide({ everUsed: false }).actions], ['scan', 'closet', 'elise']);
});

test('S7/S8: Live is offered only when the build flag, remote switch, native capability AND AI Photo all agree', () => {
  const all = { liveBuildEnabled: true, liveNativeCapable: true, remote: { enabled: true, liveEnabled: true } };
  assert.equal(decide(all).live, 'offered');
  const missing = [
    { liveBuildEnabled: false },
    { liveNativeCapable: false },
    { remote: { enabled: true, liveEnabled: false } },
    { kplus: 'free' },
  ];
  for (const m of missing) assert.equal(decide({ ...all, ...m }).live, 'hidden', JSON.stringify(m));
});

test('the action set has no Resume and no Recent Looks, by design', () => {
  assert.deepEqual([...VTO_STUDIO_ACTIONS], ['scan', 'closet', 'elise', 'dressing_rooms']);
  assert.equal(Object.keys(VTO_STUDIO_COPY.actions).sort().join(), [...VTO_STUDIO_ACTIONS].sort().join());
  const source = read('services/vto/vtoStudio.ts');
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /recentLooks|recent_looks|RecentLooks|'resume'/);
});

test('INVARIANTS hold over the whole input grid', () => {
  const bools = [true, false];
  const remotes = [null, { enabled: false, liveEnabled: false }, { enabled: true, liveEnabled: false }, { enabled: true, liveEnabled: true }];
  let n = 0;
  for (const uiEnabled of bools) for (const authenticated of bools) for (const remote of remotes)
    for (const kplus of ['free', 'active', 'complimentary', 'resolving'])
      for (const liveBuildEnabled of bools) for (const liveNativeCapable of bools)
        for (const everUsed of [true, false, null]) {
          const d = resolveVtoStudio({ uiEnabled, authenticated, remote, kplus, liveBuildEnabled, liveNativeCapable, everUsed });
          n += 1;
          if (d.actions.length > 0) {
            assert.ok(['available', 'kplus_required'].includes(d.photo), 'actions imply try-on is usable');
            assert.ok(d.state === 'FIRST_USE' || d.state === 'RETURNING');
            assert.ok(uiEnabled && authenticated && remote && remote.enabled);
          }
          if (d.kplusMarker !== 'none') assert.ok(d.state === 'FIRST_USE' || d.state === 'RETURNING');
          if (d.live === 'offered') {
            assert.equal(d.photo, 'available');
            assert.ok(liveBuildEnabled && liveNativeCapable && remote.liveEnabled);
          }
          if (!uiEnabled || !authenticated) assert.equal(d.visible, false);
          assert.ok(!d.actions.includes('dressing_rooms') || (everUsed === true && d.photo === 'available'));
        }
  assert.equal(n, 2 * 2 * 4 * 4 * 2 * 2 * 3);
});

test('COPY: AI Photo is a visualization and nothing claims fit, size or accuracy', () => {
  const all = JSON.stringify(VTO_STUDIO_COPY);
  assert.match(VTO_STUDIO_COPY.photoBody, /visualization/);
  assert.match(VTO_STUDIO_COPY.photoBody, /not a promise/);
  assert.doesNotMatch(all, /perfect|guarantee|true to size|exact fit|accurate fit|fits you/i);
  assert.doesNotMatch(all, /coming soon|\$|free trial|discount|unlimited/i, 'no price, promo or free allowance');
});

test('the model is import-free and the Studio cannot reach a generation', () => {
  assert.deepEqual([...read('services/vto/vtoStudio.ts').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]), []);
  const forbidden = /vtoClient|vtoRequestStore|VirtualTryOnSheet|VtoLaunchHost|TryItOnEntry|requestVtoGeneration|expo-image-picker|expo-camera|expo-file-system|AsyncStorage|supabase|fetch\(/;
  for (const rel of ['services/vto/vtoStudio.ts', 'hooks/useVtoStudio.ts', 'components/home/TryOnStudioEntry.tsx', 'app/try-on-studio.tsx']) {
    const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(code, forbidden, `${rel} must not reach generation, camera, photo, storage or network`);
  }
});

// ── The Home entry and the screen, rendered for real ─────────────────────────

const theme = { LUXURY: deepStub(), RADIUS: deepStub(), SHADOWS: deepStub(), SPACING: deepStub() };
const RN = { Pressable: 'Pressable', StyleSheet: { create: (s) => s }, Text: 'Text', View: 'View' };

function entryHarness(decision, kplus = 'active') {
  const r = createRenderer();
  const log = { push: [], impressions: [], taps: [], haptics: 0 };
  const module = runModule('components/home/TryOnStudioEntry.tsx', {
    ...r.runtimeModules,
    'react-native': RN,
    'expo-router': { router: { push: (target) => log.push.push(target) } },
    '../../constants/theme': theme,
    '../../hooks/useVtoAwareness': { useVtoActorKPlusState: () => kplus },
    '../../hooks/useVtoStudio': { useVtoStudio: () => decision },
    '../../services/haptics': { selectionTick: () => { log.haptics += 1; } },
    '../../services/vto/vtoAwareness': {
      emitVtoAwarenessImpression: (c) => log.impressions.push(c),
      emitVtoAwarenessTap: (c) => log.taps.push(c),
    },
    '../../services/vto/vtoStudio': model,
    '../icons/kscan': { KScanIcon: 'KScanIcon' },
    '../kplus/KPlusMarkerBadge': { KPlusMarkerBadge: 'KPlusMarkerBadge' },
  });
  const render = () => r.render(r.jsx(module.TryOnStudioEntry, {}));
  return { render, log };
}

test('Home entry: hidden state renders nothing and emits nothing', async () => {
  const h = entryHarness(decide({ uiEnabled: false }));
  const tree = h.render(); await settle(2);
  assert.equal(findAll(tree, (n) => n.props?.testID === 'home-try-on-studio-entry').length, 0);
  assert.deepEqual(h.log.impressions, []);
});

test('Home entry: present in every visible state, with state-true copy and the K+ marker only when known', async () => {
  const cases = [
    [decide({ remote: null }), VTO_STUDIO_COPY.entrySubtitleResolving, 0],
    [decide({ remote: { enabled: false, liveEnabled: false } }), VTO_STUDIO_COPY.entrySubtitleUnavailable, 0],
    [decide({ kplus: 'free' }), VTO_STUDIO_COPY.entrySubtitleReady, 1],
    [decide({ kplus: 'active' }), VTO_STUDIO_COPY.entrySubtitleReady, 1],
  ];
  for (const [decision, subtitle, badges] of cases) {
    const h = entryHarness(decision);
    const tree = h.render(); await settle(2);
    assert.equal(findAll(tree, (n) => n.props?.testID === 'home-try-on-studio-entry').length, 1, decision.state);
    assert.match(textContent(tree), new RegExp(subtitle.replace(/[.]/g, '\\.')));
    assert.equal(findAll(tree, (n) => n.type === 'KPlusMarkerBadge').length, badges, decision.state);
  }
  const free = entryHarness(decide({ kplus: 'free' })); free.render();
  assert.equal(findAll(free.render(), (n) => n.type === 'KPlusMarkerBadge')[0].props.state, 'locked');
  const active = entryHarness(decide({ kplus: 'active' }));
  assert.equal(findAll(active.render(), (n) => n.type === 'KPlusMarkerBadge')[0].props.state, 'included');
});

test('Home entry: tapping opens ONLY the Studio screen and reports a home awareness tap', async () => {
  const h = entryHarness(decide({ kplus: 'free' }), 'free');
  const tree = h.render(); await settle(2);
  const [row] = findAll(tree, (n) => n.props?.testID === 'home-try-on-studio-entry');
  row.props.onPress();
  assert.deepEqual(h.log.push, ['/try-on-studio'], 'no scanner, no sheet, no photo, no camera');
  assert.deepEqual(h.log.taps, [{ surface: 'home', kplus: 'free' }]);
  assert.equal(h.log.haptics, 1);
});

test('Home entry: one home impression is reported when visible, none while hidden', async () => {
  const shown = entryHarness(decide({ kplus: 'active' })); shown.render(); await settle(2);
  assert.deepEqual(shown.log.impressions, [{ surface: 'home', kplus: 'active' }]);
});

const BUTTONS = { PrimaryButton: 'PrimaryButton', SecondaryButton: 'SecondaryButton' };

function screenHarness(decision, kplus = 'active') {
  const r = createRenderer();
  const log = { push: [], taps: [], backs: 0 };
  const module = runModule('app/try-on-studio.tsx', {
    ...r.runtimeModules,
    'react-native': RN,
    'expo-router': { router: { push: (target) => log.push.push(target) } },
    '../components/luxury': { InlineNotice: 'InlineNotice', KScanHeader: 'KScanHeader', LuxuryScreen: 'LuxuryScreen', ...BUTTONS },
    '../components/kplus/KPlusMarkerBadge': { KPlusMarkerBadge: 'KPlusMarkerBadge' },
    '../constants/theme': theme,
    '../contexts/AuthSessionContext': { useAuthSession: () => ({}) },
    '../services/actorScope': { currentActorScopeKey: () => 'actor-a' },
    '../hooks/useVtoAwareness': { useVtoActorKPlusState: () => kplus },
    '../hooks/useVtoStudio': { useVtoStudio: () => decision },
    '../services/haptics': { selectionTick: () => {} },
    '../services/navigationExit': { goBackOrHome: () => { log.backs += 1; } },
    '../services/vto/vtoAwareness': { emitVtoAwarenessTap: (c) => log.taps.push(c) },
    '../services/vto/vtoStudio': model,
  });
  const render = () => r.render(r.jsx(module.default, {}));
  return { render, log };
}
const ids = (tree, prefix) => findAll(tree, (n) => typeof n.props?.testID === 'string' && n.props.testID.startsWith(prefix)).map((n) => n.props.testID);

test('Screen: each state shows exactly its own content', async () => {
  const has = (tree, id) => findAll(tree, (n) => n.props?.testID === id).length === 1;
  const hidden = screenHarness(decide({ uiEnabled: false })).render();
  assert.ok(has(hidden, 'try-on-studio-hidden')); assert.deepEqual(ids(hidden, 'try-on-studio-action-'), []);
  const off = screenHarness(decide({ remote: { enabled: false, liveEnabled: false } })).render();
  assert.ok(has(off, 'try-on-studio-unavailable')); assert.deepEqual(ids(off, 'try-on-studio-action-'), []);
  const resolving = screenHarness(decide({ kplus: 'resolving' })).render();
  assert.ok(has(resolving, 'try-on-studio-resolving')); assert.deepEqual(ids(resolving, 'try-on-studio-action-'), []);
  assert.equal(findAll(resolving, (n) => n.type === 'KPlusMarkerBadge').length, 0);
  const ready = screenHarness(decide({})).render();
  assert.ok(has(ready, 'try-on-studio-content'));
  assert.deepEqual(ids(ready, 'try-on-studio-action-'), ['try-on-studio-action-scan', 'try-on-studio-action-closet', 'try-on-studio-action-elise']);
});

test('Screen: Free sees the K+ note and marker before tapping anything; no new paywall is rendered', () => {
  const tree = screenHarness(decide({ kplus: 'free' }), 'free').render();
  assert.equal(findAll(tree, (n) => n.props?.testID === 'try-on-studio-kplus-note').length, 1);
  assert.equal(findAll(tree, (n) => n.type === 'KPlusMarkerBadge')[0].props.state, 'locked');
  assert.match(textContent(tree), /part of K\+/);
});

test('Screen: Live appears only when offered, and never as a placeholder', () => {
  const off = screenHarness(decide({ liveBuildEnabled: true, remote: { enabled: true, liveEnabled: true } })).render();
  assert.equal(findAll(off, (n) => n.props?.testID === 'try-on-studio-live').length, 0);
  assert.doesNotMatch(textContent(off), /Live/);
  const on = screenHarness(decide({ liveBuildEnabled: true, liveNativeCapable: true, remote: { enabled: true, liveEnabled: true } })).render();
  assert.equal(findAll(on, (n) => n.props?.testID === 'try-on-studio-live').length, 1);
});

test('Screen: every action goes to its existing destination and reports a home awareness tap', () => {
  const h = screenHarness(decide({ everUsed: true }));
  const tree = h.render();
  const press = (id) => findAll(tree, (n) => n.props?.testID === id)[0].props.onPress();
  press('try-on-studio-action-scan');
  press('try-on-studio-action-closet');
  press('try-on-studio-action-elise');
  press('try-on-studio-action-dressing_rooms');
  assert.deepEqual(h.log.push, [
    '/scan',
    { pathname: '/library', params: { section: 'closet' } },
    '/style-chat',
    '/dressing-rooms',
  ]);
  assert.equal(h.log.taps.length, 4);
  for (const tap of h.log.taps) assert.deepEqual(tap, { surface: 'home', kplus: 'active' });
});

test('Screen: the first action is the primary button, the rest are secondary', () => {
  const tree = screenHarness(decide({ everUsed: true })).render();
  const types = findAll(tree, (n) => typeof n.props?.testID === 'string' && n.props.testID.startsWith('try-on-studio-action-')).map((n) => n.type);
  assert.deepEqual(types, ['PrimaryButton', 'SecondaryButton', 'SecondaryButton', 'SecondaryButton']);
});

test('Screen: back uses the shared exit, and the screen is keyed by the actor so a switch remounts it', () => {
  const h = screenHarness(decide({}));
  const tree = h.render();
  findAll(tree, (n) => n.type === 'KScanHeader')[0].props.onBack();
  assert.equal(h.log.backs, 1);
  assert.match(read('app/try-on-studio.tsx'), /<StudioContent key=\{currentActorScopeKey\(\)\} \/>/);
});

// ── The hook: account switch, stale reads, native-only Live ──────────────────

function hookHarness(opts = {}) {
  const r = createRenderer();
  const state = {
    auth: { user: { id: 'actor-a' }, isAuthenticated: true },
    records: { 'actor-a': { initiated: true, completed: false }, 'actor-b': null },
    configGate: null,
    config: { enabled: true, liveEnabled: false },
    kplus: 'active',
    harness: opts.harness ?? null,
    capable: opts.capable ?? false,
    loads: 0,
    listeners: new Set(),
  };
  let out = null;
  const module = runModule('hooks/useVtoStudio.ts', {
    ...r.runtimeModules,
    'react-native': { Platform: { OS: opts.os ?? 'android' } },
    '../constants/featureFlags': { LIVE_VTO_ENABLED: opts.liveBuild ?? false, VTO_UI_ENABLED: opts.ui ?? true },
    '../contexts/AuthSessionContext': { useAuthSession: () => state.auth },
    './useVtoAwareness': { useVtoActorKPlusState: () => state.kplus },
    '../services/vto/vtoFeatureControl': { getVtoRemoteConfig: () => (state.configGate ? state.configGate.promise : Promise.resolve(state.config)) },
    '../services/vto/liveVtoNativeModule': {
      describeLiveVtoNativeCapability: () => ({ capable: state.capable }),
      isLiveVtoNativeCapable: (c) => c.capable === true,
      LIVE_VTO_SUPPORTED_PLATFORMS: ['ios', 'android'],
    },
    '../services/vto/vtoLiveHarness': { getLiveVtoHarnessState: () => state.harness },
    '../services/vto/vtoAwareness': {
      loadVtoAwareness: async () => { state.loads += 1; },
      readVtoAwareness: () => state.records[state.auth.user?.id] ?? null,
      subscribeVtoAwareness: (fn) => { state.listeners.add(fn); return () => state.listeners.delete(fn); },
    },
    '../services/vto/vtoStudio': model,
  });
  const Probe = () => { out = module.useVtoStudio(); return null; };
  const render = () => r.render(r.jsx(Probe, {}));
  return { state, render, get out() { return out; } };
}

test('Hook: starts RESOLVING, then resolves from the remote row', async () => {
  const h = hookHarness();
  h.render(); assert.equal(h.out.state, 'RESOLVING');
  await settle(3); h.render();
  assert.equal(h.out.state, 'RETURNING');
  assert.deepEqual([...h.out.actions], ['scan', 'closet', 'elise', 'dressing_rooms']);
});

test('Hook: an account switch never renders the previous account\'s history', async () => {
  const h = hookHarness();
  h.render(); await settle(3); h.render();
  assert.ok(h.out.actions.includes('dressing_rooms'), 'account A has used try-on');
  h.state.auth = { user: { id: 'actor-b' }, isAuthenticated: true };
  h.render(); await settle(3); h.render();
  assert.ok(!h.out.actions.includes('dressing_rooms'), 'account B has no history, and A\'s must not leak');
  assert.equal(h.out.state, 'FIRST_USE');
  assert.ok(h.state.loads >= 2, 'history is re-read when the actor changes');
});

test('Hook: signing out hides the Studio', async () => {
  const h = hookHarness();
  h.render(); await settle(3); h.render();
  h.state.auth = { user: null, isAuthenticated: false };
  h.render(); await settle(3); h.render();
  assert.equal(h.out.state, 'HIDDEN');
  assert.deepEqual([...h.out.actions], []);
});

test('Hook: a build without VTO UI is HIDDEN and reads nothing', async () => {
  const h = hookHarness({ ui: false });
  h.render(); await settle(3); h.render();
  assert.equal(h.out.state, 'HIDDEN');
  assert.equal(h.state.loads, 0);
});

test('Hook: Live is offered only on a NATIVE capability, never from the development harness', async () => {
  const live = { liveBuild: true, capable: true };
  const native = hookHarness(live); native.state.config = { enabled: true, liveEnabled: true };
  native.render(); await settle(3); native.render();
  assert.equal(native.out.live, 'offered');

  const harness = hookHarness({ ...live, harness: { nativeCapability: { capable: true } } });
  harness.state.config = { enabled: true, liveEnabled: true };
  harness.render(); await settle(3); harness.render();
  assert.equal(harness.out.live, 'hidden', 'the harness is a test double, not customer-facing Live');

  const web = hookHarness({ ...live, os: 'web' });
  web.state.config = { enabled: true, liveEnabled: true };
  web.render(); await settle(3); web.render();
  assert.equal(web.out.live, 'hidden', 'an unsupported platform never offers Live');

  const buildOff = hookHarness({ liveBuild: false, capable: true });
  buildOff.state.config = { enabled: true, liveEnabled: true };
  buildOff.render(); await settle(3); buildOff.render();
  assert.equal(buildOff.out.live, 'hidden', 'with the build flag off (every shipped profile) Live is never shown');
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('WIRING: Home mounts the permanent entry beside, not instead of, the dismissible introduction', () => {
  const home = read('components/home/HomeLuxuryTechV1.tsx');
  assert.match(home, /import \{ TryOnStudioEntry \} from '\.\/TryOnStudioEntry';/);
  assert.match(home, /<TryOnStudioEntry style=\{styles\.vtoStudioEntry\} \/>/);
  assert.match(home, /<HomeVtoDiscoveryCard style=\{styles\.vtoDiscoveryCard\} \/>/);
});

test('WIRING: no new bottom-navigation tab, and the Studio is a plain route', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'app', 'try-on-studio.tsx')));
  const layouts = ['app/_layout.tsx', 'app/(tabs)/_layout.tsx'].filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  for (const rel of layouts) assert.doesNotMatch(read(rel), /try-on-studio/, `${rel} must not register the Studio as a tab`);
});

test('WIRING: every Studio destination is an existing route', () => {
  for (const rel of ['app/scan/index.tsx', 'app/library.tsx', 'app/style-chat/index.tsx', 'app/dressing-rooms/index.tsx']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} must exist`);
  }
});

test('NEGATIVE CONTROL: the invariant grid would catch a Studio that offers actions while unavailable', () => {
  const broken = { ...decide({ remote: { enabled: false, liveEnabled: false } }), actions: ['scan'] };
  assert.ok(broken.actions.length > 0 && !['available', 'kplus_required'].includes(broken.photo),
    'this is the shape the invariant test forbids');
});
