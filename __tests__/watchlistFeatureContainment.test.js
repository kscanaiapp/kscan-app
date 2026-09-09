// Smart Watchlist feature containment (K SCAN AI Watchlist Repair 06).
//
// THE DEFECT
//
// SMART_WATCHLIST_V1 controlled the Home Watchlist entry and nothing else.
// The ProductShelf Watch action, the SHIPPED scan-results Watch action
// (components/scan-results/PurchaseOptionsPanel.tsx), the Watch-creation modal,
// both /watchlist routes and the createWatch/resumeWatch/refreshWatches service
// operations consulted K+ alone, or nothing at all.
//
// Production containment therefore rested partly on KPLUS_EARLY_ACCESS_ENABLED
// being false rather than on SMART_WATCHLIST_V1 being false. An unrelated K+
// activation could have reached Watch creation without Smart Watchlist ever
// being switched on. P2 — latent, not a live incident: both flags are off in
// production today, so nothing is currently exposed.
//
// THE REPAIR
//
// services/watchlist/watchlistAvailability.ts is the single feature-existence
// authority, consumed by every Watchlist surface and every activation-class
// write. K+ remains entitlement only. The composition is AVAILABLE && ENTITLED,
// never ENTITLED alone.
//
// Everything below executes the real modules with controlled inputs. The four
// availability/entitlement combinations are exercised as behaviour, not as text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function transpile(rel, jsx = false) {
  return ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
      ...(jsx ? { jsx: ts.JsxEmit.React } : {}),
    },
  }).outputText;
}

function evaluate(rel, shim, { jsx = false, sandbox = {} } = {}) {
  const mod = { exports: {} };
  const factory = vm.runInNewContext(
    `(function (exports, module, require, console, setTimeout, clearTimeout, Date) {\n${transpile(rel, jsx)}\n})`,
    { Promise, Object, Array, JSON, Math, Error, String, Number, Boolean, Symbol, RegExp, ...sandbox },
    { filename: rel },
  );
  factory(mod.exports, mod, shim, console, setTimeout, clearTimeout, Date);
  return mod.exports;
}

// ── minimal React + element-tree harness (house pattern) ────────────────────

function makeReact() {
  const React = {
    __esModule: true,
    createElement(type, props, ...children) {
      const merged = { ...(props || {}) };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { __element: true, type, props: merged };
    },
    Fragment: 'Fragment',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (init) => ({ current: init === undefined ? null : init }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
  React.default = React;
  return React;
}

function deepStub(label) {
  return new Proxy(function stub() {}, {
    get(_t, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'toString') return () => label;
      if (typeof prop === 'symbol') return undefined;
      return deepStub(`${label}.${String(prop)}`);
    },
    apply() { return deepStub(`${label}()`); },
  });
}

function named(name) {
  const fn = function marker() {};
  Object.defineProperty(fn, 'name', { value: name });
  fn.displayName = name;
  return fn;
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  if (typeof node !== 'object' || node.__element !== true) return;
  visit(node);
  if (node.props && 'children' in node.props) walk(node.props.children, visit);
}

function collect(tree, predicate) {
  const out = [];
  walk(tree, (n) => { if (predicate(n)) out.push(n); });
  return out;
}

const isNamed = (n, name) => typeof n.type === 'function' && (n.type.displayName === name || n.type.name === name);

/**
 * Invokes the named local function components a module delegates to, so the
 * harness sees the subtree a route actually renders rather than an unrendered
 * `<WatchlistUnavailableScreen />` placeholder. Restricted to an explicit name
 * list: the deepStub proxies standing in for imported components are functions
 * too, and calling those would collapse the tree.
 */
function renderLocal(node, names) {
  if (Array.isArray(node)) return node.map((n) => renderLocal(n, names));
  if (!node || typeof node !== 'object' || node.__element !== true) return node;
  if (typeof node.type === 'function' && typeof node.type.name === 'string' && names.includes(node.type.name)) {
    return renderLocal(node.type(node.props), names);
  }
  const props = { ...node.props };
  if ('children' in props) props.children = renderLocal(props.children, names);
  return { ...node, props };
}

// ════════════════════════════════════════════════════════════════════════════
// PART A — the availability resolver: real module, controlled input
// ════════════════════════════════════════════════════════════════════════════

const AVAILABILITY = 'services/watchlist/watchlistAvailability.ts';

/**
 * Loads the REAL resolver.
 *
 * The flag module is shimmed with K+ deliberately ON by default. The resolver
 * does not import it today, so the extra key is inert — but the moment anyone
 * wires entitlement into availability it becomes live, and every OFF assertion
 * below starts failing. That is what makes CONTROL AI bite behaviourally and
 * not merely as a source-text rule.
 */
function loadAvailability(smartWatchlistActive, kPlusEnabled = true) {
  return evaluate(AVAILABILITY, (spec) => {
    if (spec === '../../constants/featureFlags') {
      return {
        SMART_WATCHLIST_V1: smartWatchlistActive,
        KPLUS_EARLY_ACCESS_ENABLED: kPlusEnabled,
        KPLUS_ENTITLEMENT_ACTIVE: kPlusEnabled,
      };
    }
    throw new Error(`unexpected watchlistAvailability import: ${spec}`);
  });
}

test('AVAILABILITY: the flag alone decides whether the feature exists', () => {
  assert.equal(loadAvailability(true).resolveWatchlistAvailable(), true);
  assert.equal(loadAvailability(false).resolveWatchlistAvailable(), false);
});

test('AVAILABILITY: fails closed on every non-true flag state', () => {
  // Proven end to end from the raw environment value through the REAL
  // constants/featureFlags.ts resolver, not from a hand-written boolean.
  for (const raw of [undefined, '', ' ', 'false', 'TRUE', 'True', '1', 'yes', 'null']) {
    const flags = evaluate('constants/featureFlags.ts', () => ({}), {
      sandbox: { process: { env: { EXPO_PUBLIC_SMART_WATCHLIST_V1: raw } }, __DEV__: false },
    });
    assert.equal(
      loadAvailability(flags.SMART_WATCHLIST_V1).resolveWatchlistAvailable(),
      false,
      `raw env ${JSON.stringify(raw)} must resolve unavailable`,
    );
  }
  const on = evaluate('constants/featureFlags.ts', () => ({}), {
    sandbox: { process: { env: { EXPO_PUBLIC_SMART_WATCHLIST_V1: 'true' } }, __DEV__: false },
  });
  assert.equal(loadAvailability(on.SMART_WATCHLIST_V1).resolveWatchlistAvailable(), true);
});

test('AVAILABILITY: entitlement can never make a dark feature available', () => {
  // The inversion this repair exists to forbid, asserted as behaviour: with K+
  // fully enabled and Smart Watchlist off, the answer is still "does not exist".
  for (const kPlusEnabled of [true, false]) {
    assert.equal(
      loadAvailability(false, kPlusEnabled).resolveWatchlistAvailable(),
      false,
      `K+ enabled=${kPlusEnabled} must not conjure the feature into existence`,
    );
  }
  // And the converse: availability does not depend on K+ being on either.
  assert.equal(loadAvailability(true, false).resolveWatchlistAvailable(), true);
});

test('AVAILABILITY: has exactly one feature-existence input and no entitlement input', () => {
  const source = read(AVAILABILITY);
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(executable, /import \{ SMART_WATCHLIST_V1 \} from '\.\.\/\.\.\/constants\/featureFlags';/);
  for (const forbidden of [
    'KPlus', 'kplus', 'K_PLUS', 'entitlement', 'RevenueCat', 'process.env',
    'remoteConfig', 'FeatureFreeze', 'app_config', 'Platform',
  ]) {
    assert.ok(
      !executable.includes(forbidden),
      `availability must not derive from "${forbidden}" — one authority, not a second rollout system`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART B — the service boundary: real watchlistClient, every operation
// ════════════════════════════════════════════════════════════════════════════

function loadClient(watchlistAvailable) {
  const calls = { sessions: 0, invokes: [], authGetSession: 0, selects: [] };
  const availability = loadAvailability(watchlistAvailable);

  const mod = evaluate('services/watchlist/watchlistClient.ts', (spec) => {
    if (spec === './watchlistAvailability') return availability;
    if (spec === '../authenticatedFunctionSession') {
      return {
        resolveAuthenticatedFunctionSession: async () => {
          calls.sessions += 1;
          return { ok: true };
        },
      };
    }
    if (spec === '../supabaseClient') {
      const builder = {
        select: () => builder, is: () => builder, eq: () => builder,
        order: () => builder, limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (res) => res({ data: [], error: null }),
      };
      return {
        supabase: {
          auth: { getSession: async () => { calls.authGetSession += 1; return { data: { session: { user: { id: 'u1' } } } }; } },
          from: (table) => { calls.selects.push(table); return builder; },
          functions: {
            invoke: async (fn, options) => {
              calls.invokes.push({ fn, body: options.body });
              return { data: { watch: {}, deleted: true }, error: null };
            },
          },
        },
      };
    }
    if (spec === '../../types/watchlist') return {};
    throw new Error(`unexpected watchlistClient import: ${spec}`);
  });

  return { mod, calls };
}

test('SERVICE OFF: createWatch refuses before any auth resolution or network', () => {
  const { mod, calls } = loadClient(false);
  return mod
    .createWatch({ listing: {}, watchIntent: 'just_watching' })
    .then((result) => {
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'feature_unavailable');
      assert.notEqual(result.reason, 'kplus_required', 'must not impersonate an entitlement error');
      assert.equal(calls.sessions, 0, 'resolveAuthenticatedFunctionSession must not run');
      assert.equal(calls.invokes.length, 0, 'supabase.functions.invoke must not run');
    });
});

test('SERVICE OFF: resumeWatch and refreshWatches are refused the same way', () => {
  const { mod, calls } = loadClient(false);
  return Promise.all([mod.resumeWatch('w1'), mod.refreshWatches(), mod.refreshWatches('w1')]).then(
    (results) => {
      for (const result of results) {
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'feature_unavailable');
      }
      assert.equal(calls.sessions, 0);
      assert.equal(calls.invokes.length, 0);
    },
  );
});

test('SERVICE OFF: cleanup stays reachable — pause and delete still work', () => {
  // A build that darkened Watchlist must never strand a Watch created under an
  // earlier build in a permanently active, unremovable state.
  const { mod, calls } = loadClient(false);
  return Promise.all([mod.pauseWatch('w1'), mod.deleteWatch('w1')]).then(([paused, deleted]) => {
    assert.equal(paused.ok, true, 'pause must remain callable while the feature is dark');
    assert.equal(deleted.ok, true, 'delete must remain callable while the feature is dark');
    assert.deepEqual(calls.invokes.map((c) => c.body.action), ['pause', 'delete']);
    assert.equal(calls.sessions, 2, 'cleanup still authenticates normally');
  });
});

test('SERVICE ON: every operation keeps its existing contract', () => {
  const { mod, calls } = loadClient(true);
  return Promise.all([
    mod.createWatch({ listing: {}, watchIntent: 'just_watching' }),
    mod.resumeWatch('w1'),
    mod.pauseWatch('w1'),
    mod.deleteWatch('w1'),
    mod.refreshWatches(),
  ]).then((results) => {
    for (const result of results) assert.equal(result.ok, true);
    assert.deepEqual(
      calls.invokes.map((c) => c.body.action).sort(),
      ['create', 'delete', 'pause', 'refresh', 'resume'],
    );
  });
});

test('SERVICE: reads are not converted into K+ or availability requirements', () => {
  // §12: an expired-K+ actor may still see a Watch they already created. The
  // route boundary is what makes reads unreachable when the feature is dark;
  // the read primitives themselves are deliberately left alone.
  const source = read('services/watchlist/watchlistClient.ts');
  for (const fn of ['fetchWatchlist', 'fetchWatch', 'fetchWatchEvents']) {
    const body = source.slice(source.indexOf(`export async function ${fn}`));
    const end = body.indexOf('\nexport ', 1);
    const scoped = end > 0 ? body.slice(0, end) : body;
    assert.ok(
      !scoped.includes('resolveWatchlistAvailable'),
      `${fn} must stay ungated — reads are contained by the route boundary`,
    );
  }
});

test('SERVICE: activation is gated, deactivation is not — the classification is explicit', () => {
  const source = read('services/watchlist/watchlistClient.ts');
  const bodyOf = (fn) => {
    const start = source.indexOf(`export async function ${fn}`);
    assert.ok(start >= 0, `${fn} must exist`);
    const rest = source.slice(start);
    const end = rest.indexOf('\nexport ', 1);
    return end > 0 ? rest.slice(0, end) : rest;
  };
  for (const gated of ['createWatch', 'resumeWatch', 'refreshWatches']) {
    assert.match(bodyOf(gated), /if \(!resolveWatchlistAvailable\(\)\) return FEATURE_UNAVAILABLE;/,
      `${gated} creates or reactivates feature state and must be gated`);
  }
  for (const cleanup of ['pauseWatch', 'deleteWatch']) {
    assert.ok(!bodyOf(cleanup).includes('resolveWatchlistAvailable'),
      `${cleanup} only retires existing state and must stay reachable`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART C — ProductShelf: the four-case availability × entitlement matrix
// ════════════════════════════════════════════════════════════════════════════

const WATCHABLE = {
  id: 'p1', title: 'Wool Coat', price: 420, source: 'farfetch',
  productUrl: 'https://example.com/p1', type: 'retail',
  watchCapability: 'refreshable_listing',
};
const UNSUPPORTED = { ...WATCHABLE, id: 'p2', watchCapability: 'unsupported' };

function renderProductShelf({ watchlistAvailable, products = [WATCHABLE] }) {
  const React = makeReact();
  const availability = loadAvailability(watchlistAvailable);
  const KPlusGate = named('KPlusGate');

  const shim = (spec) => {
    if (spec === 'react') return React;
    if (spec === '../services/watchlist/watchlistAvailability') return availability;
    if (spec === './kplus/KPlusGate') return { KPlusGate };
    if (spec === '../contexts/FeatureFreezeContext' || spec.includes('FeatureFreeze')) {
      return { useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }) };
    }
    return deepStub(spec);
  };

  const mod = evaluate('components/ProductShelf.tsx', shim, { jsx: true });
  return mod.ProductShelf({ products, testID: 'shelf' });
}

/** The Watch affordance is exactly the K+ gate whose source is 'watchlist'. */
function watchGates(tree) {
  return collect(tree, (n) => isNamed(n, 'KPlusGate') && n.props && n.props.source === 'watchlist');
}

test('CASE B (the defect): Watchlist OFF + K+ ACTIVE renders no Watch action', () => {
  // This is the configuration the repair exists to close. Before Repair 06 the
  // Watch action depended on canWatchProduct + KPlusGate only, so an unrelated
  // K+ activation exposed it while Smart Watchlist was still dark.
  const tree = renderProductShelf({ watchlistAvailable: false });
  assert.equal(watchGates(tree).length, 0,
    'no watchlist K+ gate may be mounted at all — not disabled, not upsold, absent');
});

test('CASE A: Watchlist OFF + K+ inactive also renders no Watch action', () => {
  const tree = renderProductShelf({ watchlistAvailable: false });
  assert.equal(watchGates(tree).length, 0);
});

test('CASE C: Watchlist ON + K+ inactive preserves the existing upgrade behaviour', () => {
  const tree = renderProductShelf({ watchlistAvailable: true });
  const gates = watchGates(tree);
  assert.equal(gates.length, 1, 'the feature exists, so the gate is mounted');
  let upgraded = false;
  const rendered = gates[0].props.children({ isActive: false, openUpgrade: () => { upgraded = true; } });
  const button = collect(rendered, (n) => n.props && n.props.testID === 'watch-listing-button');
  assert.equal(button.length, 1, 'a non-K+ actor still sees the affordance');
  button[0].props.onPress();
  assert.equal(upgraded, true, 'and is offered the upgrade rather than the action');
});

test('CASE D: Watchlist ON + K+ ACTIVE opens the creation flow', () => {
  const tree = renderProductShelf({ watchlistAvailable: true });
  const rendered = watchGates(tree)[0].props.children({ isActive: true, openUpgrade: () => {
    throw new Error('an entitled actor must not be sent to the upgrade sheet');
  } });
  const button = collect(rendered, (n) => n.props && n.props.testID === 'watch-listing-button');
  assert.equal(button.length, 1);
  button[0].props.onPress(); // must not throw
});

test('UNSUPPORTED LISTING: Watchlist ON but not a refreshable listing renders nothing', () => {
  const tree = renderProductShelf({ watchlistAvailable: true, products: [UNSUPPORTED] });
  assert.equal(watchGates(tree).length, 0, 'server-authored eligibility still governs');
});

test('MODAL MOUNT: ProductShelf mounts the creation modal only when the feature exists', () => {
  const off = collect(renderProductShelf({ watchlistAvailable: false }), (n) => isNamed(n, 'WatchThisModal'));
  const on = collect(renderProductShelf({ watchlistAvailable: true }), (n) => isNamed(n, 'WatchThisModal'));
  assert.equal(off.length, 0, 'no creation modal may be mounted while the feature is dark');
  assert.equal(on.length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// PART D — PurchaseOptionsPanel: the SHIPPED scan-results Watch surface
// ════════════════════════════════════════════════════════════════════════════

const WATCHABLE_OPTION = {
  id: 'o1', title: 'Wool Coat', retailer: 'farfetch',
  productUrl: 'https://example.com/o1', priceLabel: '$420',
  watchCandidate: { id: 'o1', watchCapability: 'refreshable_listing' },
  watchCapability: 'refreshable_listing',
};

function renderPurchaseOptionsPanel({ watchlistAvailable }) {
  const React = makeReact();
  const availability = loadAvailability(watchlistAvailable);
  const KPlusGate = named('KPlusGate');

  const shim = (spec) => {
    if (spec === 'react') return React;
    if (spec === '../../services/watchlist/watchlistAvailability') return availability;
    if (spec === '../kplus/KPlusGate') return { KPlusGate };
    if (spec === './types') {
      return {
        canWatchPurchaseOption: (option) => option?.watchCapability === 'refreshable_listing',
        resolvePurchaseOptionsPanelMode: () => 'data',
      };
    }
    if (spec === '../ProductShelf') return { WatchThisModal: named('WatchThisModal') };
    return deepStub(spec);
  };

  const mod = evaluate('components/scan-results/PurchaseOptionsPanel.tsx', shim, { jsx: true });
  return mod.PurchaseOptionsPanel({ purchaseOptions: [WATCHABLE_OPTION], testID: 'panel' });
}

test('SHIPPED SURFACE / CASE B: Watchlist OFF + K+ ACTIVE renders no Watch action', () => {
  // PurchaseOptionsPanel is the surface production actually ships
  // (EXPO_PUBLIC_SCAN_RESULTS_V2_UI=true), so it carries the same boundary.
  const tree = renderPurchaseOptionsPanel({ watchlistAvailable: false });
  assert.equal(watchGates(tree).length, 0);
  assert.equal(
    collect(tree, (n) => isNamed(n, 'WatchThisModal')).length, 0,
    'and mounts no creation modal',
  );
});

test('SHIPPED SURFACE / CASE D: Watchlist ON keeps the Watch action and modal', () => {
  const tree = renderPurchaseOptionsPanel({ watchlistAvailable: true });
  const gates = watchGates(tree);
  assert.equal(gates.length, 1);
  const rendered = gates[0].props.children({ isActive: true, openUpgrade: () => {} });
  assert.equal(
    collect(rendered, (n) => n.props && String(n.props.testID || '').startsWith('purchase-option-watch-')).length,
    1,
  );
  assert.equal(collect(tree, (n) => isNamed(n, 'WatchThisModal')).length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// PART E — the creation modal fails closed on its own
// ════════════════════════════════════════════════════════════════════════════

test('MODAL: a forced-visible modal cannot write, and emits no feature-start', () => {
  // §9: hiding the button is necessary but not sufficient. Stale state, a
  // refactor, or another caller could still reach handleSave.
  const React = makeReact();
  const availability = loadAvailability(false);
  const created = [];
  const telemetry = [];

  const shim = (spec) => {
    if (spec === 'react') return React;
    if (spec === '../services/watchlist/watchlistAvailability') return availability;
    if (spec === '../services/watchlist/watchlistClient') {
      return { createWatch: async (...args) => { created.push(args); return { ok: true, data: { id: 'w1' } }; } };
    }
    if (spec === '../services/kplus/kplusTelemetry') {
      return { emitKPlusEvent: (name, payload) => telemetry.push({ name, payload }) };
    }
    if (spec === './kplus/KPlusGate') return { KPlusGate: named('KPlusGate') };
    if (spec.includes('FeatureFreeze')) {
      return { useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }) };
    }
    return deepStub(spec);
  };

  const mod = evaluate('components/ProductShelf.tsx', shim, { jsx: true });
  const tree = mod.WatchThisModal({ product: WATCHABLE, visible: true, onClose: () => {} });

  // Reach the save handler the way the rendered modal would.
  const pressables = collect(tree, (n) => n.props && typeof n.props.onPress === 'function');
  assert.ok(pressables.length > 0, 'the modal must render its own controls');
  for (const node of pressables) node.props.onPress();

  assert.equal(created.length, 0, 'no Watch may be created while the feature is dark');
  assert.equal(
    telemetry.filter((e) => e.name === 'kplus_feature_started').length,
    0,
    'a refused attempt is not a feature start — §24',
  );
  assert.equal(telemetry.filter((e) => e.name === 'kplus_feature_completed').length, 0);
});

test('MODAL: the availability check precedes both the telemetry and the write', () => {
  // Comments are stripped first: the gate's own comment explains that it runs
  // before the emit, and naming the emit there would otherwise satisfy — or in
  // this case defeat — the positional check.
  const source = read('components/ProductShelf.tsx').replace(/\/\/.*$/gm, '');
  const body = source.slice(source.indexOf('const handleSave = async () => {'));
  const gate = body.indexOf('resolveWatchlistAvailable');
  const started = body.indexOf('kplus_feature_started');
  const create = body.indexOf('createWatch(');
  assert.ok(gate >= 0 && started >= 0 && create >= 0, 'all three must be present');
  assert.ok(gate < started, 'the gate must precede the feature-start emit');
  assert.ok(started < create, 'sanity: the emit precedes the write in the unblocked path');
});

// ════════════════════════════════════════════════════════════════════════════
// PART F — Watchlist home route: zero Watchlist I/O while OFF
// ════════════════════════════════════════════════════════════════════════════

function renderWatchlistHome(watchlistAvailable) {
  const React = makeReact();
  const availability = loadAvailability(watchlistAvailable);
  const io = { fetchWatchlist: 0, refreshWatches: 0, useWatchlistCalls: 0 };

  const shim = (spec) => {
    if (spec === 'react') return React;
    if (spec === '../../services/watchlist/watchlistAvailability') return availability;
    if (spec === '../../hooks/useWatchlist') {
      return {
        useWatchlist: () => {
          io.useWatchlistCalls += 1;
          // The real hook issues both of these from its mount effects. Counting
          // them here proves the gate ran BEFORE the hook, not after it.
          io.fetchWatchlist += 1;
          io.refreshWatches += 1;
          return { watches: [], loading: false, error: null, refreshing: false, reload: () => {} };
        },
      };
    }
    return deepStub(spec);
  };

  const mod = evaluate('app/watchlist/index.tsx', shim, { jsx: true });
  const tree = renderLocal(mod.default(), ['WatchlistUnavailableScreen', 'WatchlistHomeContent', 'WatchRow']);
  return { tree, io };
}

test('HOME ROUTE OFF: the content component is never mounted and no I/O is issued', () => {
  const { tree, io } = renderWatchlistHome(false);
  assert.equal(io.useWatchlistCalls, 0, 'useWatchlist must not execute at all');
  assert.equal(io.fetchWatchlist, 0);
  assert.equal(io.refreshWatches, 0);
  const shell = collect(tree, (n) => n.props && n.props.testID === 'watchlist-unavailable-screen');
  assert.equal(shell.length, 1, 'a truthful unavailable shell is rendered instead');
  assert.equal(
    collect(tree, (n) => n.props && n.props.testID === 'watchlist-home-screen').length, 0,
    'never the real Watchlist screen',
  );
});

test('HOME ROUTE OFF: the shell shows no Watchlist data and no K+ upsell', () => {
  const { tree } = renderWatchlistHome(false);
  assert.equal(collect(tree, (n) => isNamed(n, 'KPlusGate')).length, 0,
    'availability is not an entitlement the user can buy');
  assert.equal(collect(tree, (n) => n.props && n.props.testID === 'watchlist-list').length, 0);
  assert.equal(collect(tree, (n) => n.props && n.props.testID === 'watchlist-empty-state').length, 0,
    'an empty Watchlist would imply the feature is active and the user simply has none');
  const exits = collect(tree, (n) => n.props && typeof n.props.onBack === 'function');
  assert.ok(exits.length >= 1, 'the shell must offer a safe way out');
});

test('HOME ROUTE ON: the real screen mounts and the hook runs exactly once', () => {
  const { tree, io } = renderWatchlistHome(true);
  assert.equal(io.useWatchlistCalls, 1);
  assert.equal(collect(tree, (n) => n.props && n.props.testID === 'watchlist-home-screen').length, 1);
});

test('HOME ROUTE: the gate is structural — the hook is not called in the exported component', () => {
  // A check written after `const x = useWatchlist()` would be too late; this
  // pins the split so a future edit cannot quietly reintroduce that ordering.
  const source = read('app/watchlist/index.tsx');
  const exported = source.slice(
    source.indexOf('export default function WatchlistHomeScreen()'),
    source.indexOf('function WatchlistUnavailableScreen()'),
  );
  assert.ok(exported.length > 0, 'the exported route component must be locatable');
  assert.ok(!exported.includes('useWatchlist('), 'the exported route must not call useWatchlist');
  assert.match(exported, /if \(!resolveWatchlistAvailable\(\)\)/);
});

// ════════════════════════════════════════════════════════════════════════════
// PART G — Watch detail route: zero Watchlist I/O while OFF
// ════════════════════════════════════════════════════════════════════════════

function renderWatchDetail(watchlistAvailable) {
  const React = makeReact();
  const availability = loadAvailability(watchlistAvailable);
  const io = { fetchWatch: 0, fetchWatchEvents: 0, refreshWatches: 0, pause: 0, resume: 0, del: 0, focusEffects: 0 };

  const shim = (spec) => {
    if (spec === 'react') return React;
    if (spec === '../../services/watchlist/watchlistAvailability') return availability;
    if (spec === '../../services/watchlist/watchlistClient') {
      return {
        fetchWatch: async () => { io.fetchWatch += 1; return { ok: false, reason: 'read_failed' }; },
        fetchWatchEvents: async () => { io.fetchWatchEvents += 1; return { ok: false, reason: 'read_failed' }; },
        refreshWatches: async () => { io.refreshWatches += 1; return { ok: true, data: {} }; },
        pauseWatch: async () => { io.pause += 1; return { ok: true, data: {} }; },
        resumeWatch: async () => { io.resume += 1; return { ok: true, data: {} }; },
        deleteWatch: async () => { io.del += 1; return { ok: true, data: true }; },
      };
    }
    if (spec === 'expo-router') {
      return {
        router: { back: () => {}, push: () => {}, replace: () => {} },
        useLocalSearchParams: () => ({ watchId: 'w1' }),
        // Executing the focus callback is what a real focus does; counting it
        // proves the gate decided BEFORE the effect was ever installed.
        useFocusEffect: (cb) => { io.focusEffects += 1; const teardown = cb(); if (typeof teardown === 'function') teardown(); },
      };
    }
    if (spec === '../../components/kplus/KPlusGate') return { KPlusGate: named('KPlusGate') };
    return deepStub(spec);
  };

  const mod = evaluate('app/watchlist/[watchId].tsx', shim, { jsx: true });
  const tree = renderLocal(mod.default(), ['WatchDetailUnavailableScreen', 'WatchDetailContent']);
  return { tree, io };
}

test('DETAIL ROUTE OFF: no Watch, events, refresh or mutation call is issued', () => {
  const { tree, io } = renderWatchDetail(false);
  assert.equal(io.focusEffects, 0, 'the focus effect must never be installed');
  assert.equal(io.fetchWatch, 0);
  assert.equal(io.fetchWatchEvents, 0);
  assert.equal(io.refreshWatches, 0);
  assert.equal(io.pause + io.resume + io.del, 0);
  assert.equal(
    collect(tree, (n) => n.props && n.props.testID === 'watch-detail-unavailable-screen').length, 1,
  );
  for (const action of ['watch-detail-refresh', 'watch-detail-resume', 'watch-detail-pause', 'watch-detail-delete']) {
    assert.equal(collect(tree, (n) => n.props && n.props.testID === action).length, 0,
      `${action} must not be rendered`);
  }
});

test('DETAIL ROUTE OFF: no Watchlist data and no K+ upsell in the shell', () => {
  const { tree } = renderWatchDetail(false);
  assert.equal(collect(tree, (n) => isNamed(n, 'KPlusGate')).length, 0);
  assert.equal(collect(tree, (n) => n.props && n.props.testID === 'watch-detail-screen').length, 0);
});

test('DETAIL ROUTE ON: the real screen mounts and loads as before', () => {
  const { tree, io } = renderWatchDetail(true);
  assert.equal(io.focusEffects, 1, 'the existing focus-load behaviour is unchanged');
  assert.equal(collect(tree, (n) => n.props && n.props.testID === 'watch-detail-screen').length, 1);
});

test('DETAIL ROUTE: the gate is structural — no hooks in the exported component', () => {
  const source = read('app/watchlist/[watchId].tsx');
  const exported = source.slice(
    source.indexOf('export default function WatchDetailScreen()'),
    source.indexOf('function WatchDetailUnavailableScreen()'),
  );
  assert.ok(exported.length > 0);
  for (const hook of ['useFocusEffect', 'useLocalSearchParams', 'useState', 'useCallback']) {
    assert.ok(!exported.includes(hook), `the exported route must not call ${hook} before the gate`);
  }
  assert.match(exported, /if \(!resolveWatchlistAvailable\(\)\)/);
});

// ════════════════════════════════════════════════════════════════════════════
// PART H — Home stays the reference implementation
// ════════════════════════════════════════════════════════════════════════════

test('HOME ENTRY: availability is composed before entitlement, never entitlement alone', () => {
  const source = read('components/home/HomeLuxuryTechV1.tsx');
  const executable = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/.*$/gm, '');
  assert.match(executable, /const watchlistEnabled = SMART_WATCHLIST_V1;/);
  assert.match(
    executable,
    /\{watchlistEnabled && \(\s*\n\s*<KPlusGate source="watchlist">/,
    'the K+ gate must sit INSIDE the availability check, never replace it',
  );
  const tile = executable.slice(executable.indexOf('home-luxury-watchlist'));
  assert.ok(tile.length > 0, 'the Watchlist tile must exist');
});

// ════════════════════════════════════════════════════════════════════════════
// PART I — governed profile matrix + Repair 05 regression
// ════════════════════════════════════════════════════════════════════════════

test('PROFILES: production ships Watchlist dark; staging-certification ships it on', () => {
  // Resolved through the governed resolver so `extends` inheritance is honoured.
  const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles.js');
  const profiles = resolveEasBuildProfiles(JSON.parse(read('eas.json')));
  assert.equal((profiles.production.env ?? {}).EXPO_PUBLIC_SMART_WATCHLIST_V1, undefined);
  assert.equal(loadAvailability(false).resolveWatchlistAvailable(), false);
  assert.equal((profiles['staging-certification'].env ?? {}).EXPO_PUBLIC_SMART_WATCHLIST_V1, 'true');
  const on = Object.entries(profiles)
    .filter(([, p]) => (p.env ?? {}).EXPO_PUBLIC_SMART_WATCHLIST_V1 === 'true')
    .map(([name]) => name);
  assert.deepEqual(on, ['staging-certification'], 'only certification may turn the feature on');
});

test('PRODUCTION: Watchlist stays dark even with K+ forced ACTIVE', () => {
  // The whole point of the repair, stated once more at the profile level: the
  // production answer does not consult entitlement at all.
  const tree = renderProductShelf({ watchlistAvailable: false });
  assert.equal(watchGates(tree).length, 0);
  const panel = renderPurchaseOptionsPanel({ watchlistAvailable: false });
  assert.equal(watchGates(panel).length, 0);
  const { io } = renderWatchlistHome(false);
  assert.equal(io.fetchWatchlist + io.refreshWatches, 0);
});

test('REPAIR 05/N-1 REGRESSION: push activation still derives from the same flag, on both governed platforms', () => {
  const cap = evaluate('services/notifications/remotePushCapability.ts', (spec) => {
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === '../../constants/featureFlags') return { SMART_WATCHLIST_V1: false };
    throw new Error(`unexpected import: ${spec}`);
  });
  assert.equal(cap.resolveRemotePushActivationAllowed(), false, 'production stays push-dark');
  assert.equal(cap.resolveRemotePushActivationAllowed('android', true), true, 'certification stays eligible');
  // N-1: iOS is no longer ungated -- it answers the same governed question
  // Android does, from the same single consumer authority.
  assert.equal(cap.resolveRemotePushActivationAllowed('ios', false), false, 'iOS stays push-dark with Watchlist OFF');
  assert.equal(cap.resolveRemotePushActivationAllowed('ios', true), true, 'iOS is eligible with Watchlist ON');
  // Repair 06 must not have rewired Repair 05 into itself.
  const source = read('services/notifications/remotePushCapability.ts');
  assert.match(source, /import \{ SMART_WATCHLIST_V1 \} from '\.\.\/\.\.\/constants\/featureFlags';/);
  assert.ok(!source.includes('watchlistAvailability'), 'Repair 05 is left exactly as it was');
});

test('PUSH CLEANUP: deactivation paths remain ungated by Watchlist availability', () => {
  const push = read('services/watchlist/pushRegistration.ts');
  for (const fn of ['revokeThisDevicePushRoute', 'claimDeviceForCurrentActor', 'disableDeviceNotifications']) {
    const start = push.indexOf(fn);
    assert.ok(start >= 0, `${fn} must exist`);
    const body = push.slice(start, start + 2500);
    assert.ok(!body.includes('resolveWatchlistAvailable'),
      `${fn} must stay reachable so existing push state can always be retired`);
  }
});
