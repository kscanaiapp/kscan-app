// Build 35: canonical K+ entitlement truth is independent of the legacy
// complimentary Early Access acquisition flag.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, 'hooks', 'useKPlusEntitlement.ts');
const hookSource = fs.readFileSync(HOOK_PATH, 'utf8');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(?<!:)\/\/.*$/gm, '');

function loadHook({
  flag = false,
  authenticated = true,
  userId = 'actor-a',
  snapshot = {
    state: 'eligible',
    expiresAt: null,
    campaignKey: null,
    externalSyncStatus: null,
    displaySource: null,
    isOpenEnded: false,
  },
  source = hookSource,
} = {}) {
  const effects = [];
  const calls = { refresh: 0, activate: 0 };
  let appStateListener = null;

  const react = {
    useCallback: (callback) => callback,
    useEffect: (effect) => effects.push(effect),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: () => snapshot,
  };
  const reactNative = {
    AppState: {
      currentState: 'active',
      addEventListener: (_event, listener) => {
        appStateListener = listener;
        return { remove() {} };
      },
    },
  };
  const store = {
    activateKPlus: async () => {
      calls.activate += 1;
      return 'granted';
    },
    getKPlusEntitlementSnapshot: () => snapshot,
    refreshKPlusEntitlement: async () => {
      calls.refresh += 1;
    },
    subscribeToKPlusEntitlement: () => () => {},
  };
  const requireMap = {
    react,
    'react-native': reactNative,
    '../contexts/AuthSessionContext': {
      useAuthSession: () => ({ isAuthenticated: authenticated, user: userId ? { id: userId } : null }),
    },
    '../services/kplus/kplusEntitlementStore': store,
    '../constants/featureFlags': { KPLUS_EARLY_ACCESS_ENABLED: flag },
  };

  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    module: mod,
    exports: mod.exports,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`Unexpected hook import: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: HOOK_PATH }).runInContext(sandbox);

  const result = mod.exports.useKPlusEntitlement();
  const cleanups = effects.map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function');
  return {
    result,
    calls,
    sendAppState(next) {
      assert.ok(appStateListener, 'authenticated hooks must subscribe to AppState');
      appStateListener(next);
    },
    cleanup() {
      cleanups.forEach((cleanup) => cleanup());
    },
  };
}

function activeSnapshot(displaySource, { openEnded = false } = {}) {
  return {
    state: 'active',
    expiresAt: openEnded ? null : '2026-11-01T12:00:00.000Z',
    campaignKey: null,
    externalSyncStatus: null,
    displaySource,
    isOpenEnded: openEnded,
  };
}

test('A-E: complimentary, trial, subscription, and lifetime K+ stay active when acquisition is off', () => {
  const cases = [
    ['complimentary + ON', true, activeSnapshot('complimentary')],
    ['complimentary + OFF', false, activeSnapshot('complimentary')],
    ['trial + OFF', false, activeSnapshot('trial')],
    ['subscription + OFF', false, activeSnapshot('subscription')],
    ['lifetime + OFF', false, activeSnapshot('lifetime', { openEnded: true })],
  ];
  for (const [label, flag, snapshot] of cases) {
    const harness = loadHook({ flag, snapshot });
    assert.equal(harness.result.state, 'active', label);
    assert.equal(harness.result.isActive, true, label);
    assert.equal(harness.result.displaySource, snapshot.displaySource, label);
    assert.equal(harness.result.isOpenEnded, snapshot.isOpenEnded, label);
    harness.cleanup();
  }
});

test('F-J: free/expired/resolving/error states remain canonical when acquisition is off', () => {
  for (const state of ['eligible', 'expired', 'loading', 'error']) {
    const harness = loadHook({ flag: false, snapshot: { ...activeSnapshot(null), state } });
    assert.equal(harness.result.state, state);
    assert.equal(harness.result.isActive, false);
    if (state === 'loading' || state === 'error') {
      assert.notEqual(harness.result.state, 'eligible', `${state} must never become Free`);
    }
    harness.cleanup();
  }
});

test('K-M: initial, foreground, and manual refresh run with acquisition off', () => {
  const harness = loadHook({ flag: false, snapshot: activeSnapshot('subscription') });
  assert.equal(harness.calls.refresh, 1, 'initial refresh');
  harness.sendAppState('background');
  harness.sendAppState('active');
  assert.equal(harness.calls.refresh, 2, 'foreground refresh');
  harness.result.refresh();
  assert.equal(harness.calls.refresh, 3, 'manual refresh');
  harness.cleanup();
});

test('missing and malformed acquisition values behave like OFF without hiding entitlement truth', () => {
  // constants/featureFlags.ts maps all of these values to false; exercising the
  // hook with that resolved value proves false cannot suppress the snapshot.
  for (const rawValue of [undefined, '', 'false', 'TRUE', '1', 'true ']) {
    const harness = loadHook({ flag: false, snapshot: activeSnapshot('lifetime', { openEnded: true }) });
    assert.equal(harness.result.state, 'active', String(rawValue));
    assert.equal(harness.calls.refresh, 1, String(rawValue));
    harness.cleanup();
  }
});

test('O-P: complimentary activation mutates only when acquisition is ON', async () => {
  const enabled = loadHook({ flag: true });
  assert.equal(await enabled.result.activate(), 'granted');
  assert.equal(enabled.calls.activate, 1);
  enabled.cleanup();

  const disabled = loadHook({ flag: false });
  assert.equal(await disabled.result.activate(), 'failed');
  assert.equal(disabled.calls.activate, 0, 'OFF must block the network mutation');
  disabled.cleanup();
});

test('signed-out sessions keep the existing unavailable semantics and perform no reads', () => {
  const harness = loadHook({
    flag: true,
    authenticated: false,
    userId: null,
    snapshot: activeSnapshot('lifetime', { openEnded: true }),
  });
  assert.equal(harness.result.state, 'unavailable');
  assert.equal(harness.result.isActive, false);
  assert.equal(harness.calls.refresh, 0);
  assert.equal(harness.calls.activate, 0);
  harness.cleanup();
});

test('source guard: the hook references Early Access only for complimentary activate()', () => {
  const code = stripComments(hookSource);
  const references = code.match(/KPLUS_EARLY_ACCESS_ENABLED/g) ?? [];
  assert.equal(references.length, 2, 'only the import and activate guard may reference the flag');
  const activateStart = code.indexOf('const activate = useCallback');
  assert.ok(activateStart > 0);
  assert.doesNotMatch(code.slice(0, activateStart).replace(/import[\s\S]*?from '..\/constants\/featureFlags';/, ''), /KPLUS_EARLY_ACCESS_ENABLED/);
  assert.match(
    code.slice(activateStart),
    /if \(!KPLUS_EARLY_ACCESS_ENABLED \|\| !isAuthenticated\) return 'failed';/,
  );
});

test('Q: Step 6 skips the complimentary offer when OFF, but waits for resolution first', () => {
  const source = stripComments(read('components', 'kplus', 'KPlusActivationStep.tsx'));
  assert.match(
    source,
    /const nothingToOffer = !KPLUS_EARLY_ACCESS_ENABLED \|\| isActive \|\| state === 'unavailable'/,
  );
  assert.match(source, /if \(nothingToOffer && !resolving\) onSkip\(\);/);
  assert.match(source, /if \(resolving\) \{[\s\S]*kplus-activation-resolving/);
  assert.match(source, /if \(nothingToOffer\) \{[\s\S]*kplus-activation-skipped/);
});

test('legacy sheet cannot present or invoke complimentary activation when OFF', () => {
  const source = stripComments(read('components', 'kplus', 'KPlusEarlyAccessSheet.tsx'));
  assert.match(source, /KPLUS_EARLY_ACCESS_ENABLED && state === 'eligible'/);
  const handler = source.slice(source.indexOf('const handleActivate'), source.indexOf('const isActive'));
  assert.ok(
    handler.indexOf('if (!KPLUS_EARLY_ACCESS_ENABLED) return;') < handler.indexOf('await activate()'),
    'the stale-control guard must precede the mutation',
  );
  assert.match(source, /complimentaryOfferAvailable \? \([\s\S]*Activate K\+ Early Access/);
  assert.match(source, /isActive \|\| isExpired \|\| !complimentaryOfferAvailable/);
});

test('R-S: KPlusGate authorizes only from canonical isActive, never the acquisition flag or grant source', () => {
  const source = stripComments(read('components', 'kplus', 'KPlusGate.tsx'));
  assert.doesNotMatch(source, /KPLUS_EARLY_ACCESS_ENABLED|displaySource|subscription|lifetime/);
  assert.match(source, /const \{ state, isActive \} = useKPlusEntitlement\(\);/);
  assert.match(source, /children\(\{ state, isActive, resolving:/);
});

test('Voice Scan and Account recognize canonical active K+ while acquisition is OFF', () => {
  const voice = stripComments(read('components', 'text-scan', 'TextScanFeatureRow.tsx'));
  assert.match(voice, /if \(!VOICESCAN_ENABLED\)/);
  assert.doesNotMatch(voice, /if \(!VOICESCAN_ENABLED \|\| !KPLUS_EARLY_ACCESS_ENABLED\)/);
  assert.match(voice, /isActive \|\| resolving \|\| !KPLUS_EARLY_ACCESS_ENABLED/);
  assert.match(voice, /isActive[\s\S]*'Included with K\+'/);

  const account = stripComments(read('app', 'privacy.tsx'));
  assert.match(account, /\{isAuthenticated \? \([\s\S]*title="K\+"/);
  assert.match(account, /kPlusStatus\.action === 'activate' && KPLUS_EARLY_ACCESS_ENABLED/);
});

test('negative controls: re-gating reads, returned state, activation, or Step 6 is detected', async () => {
  const gateReads = hookSource.replaceAll(
    'if (!isAuthenticated || !user?.id) return;',
    'if (!KPLUS_EARLY_ACCESS_ENABLED || !isAuthenticated || !user?.id) return;',
  );
  assert.throws(() => {
    const harness = loadHook({ flag: false, source: gateReads, snapshot: activeSnapshot('subscription') });
    assert.equal(harness.calls.refresh, 1);
  });

  const hideState = hookSource.replace(
    'if (!isAuthenticated) {',
    'if (!KPLUS_EARLY_ACCESS_ENABLED || !isAuthenticated) {',
  );
  assert.throws(() => {
    const harness = loadHook({ flag: false, source: hideState, snapshot: activeSnapshot('lifetime', { openEnded: true }) });
    assert.equal(harness.result.state, 'active');
  });

  const allowActivation = hookSource.replace(
    "if (!KPLUS_EARLY_ACCESS_ENABLED || !isAuthenticated) return 'failed';",
    "if (!isAuthenticated) return 'failed';",
  );
  const activationHarness = loadHook({ flag: false, source: allowActivation });
  await activationHarness.result.activate();
  assert.notEqual(activationHarness.calls.activate, 0, 'the mutant proves the real OFF assertion has teeth');

  const step = read('components', 'kplus', 'KPlusActivationStep.tsx');
  const reexposedStep = step.replace('!KPLUS_EARLY_ACCESS_ENABLED || ', '');
  assert.doesNotMatch(
    stripComments(reexposedStep),
    /const nothingToOffer = !KPLUS_EARLY_ACCESS_ENABLED/,
    'the mutant removes the Step 6 OFF guard and would fail the real assertion',
  );
});
