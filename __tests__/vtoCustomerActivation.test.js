// Build 35 -- VTO customer activation & discovery.
//
// WHAT THIS FILE PROVES. Virtual Try-On became VISIBLE in this lane (a Home
// introduction, a first-use cue, a K+ benefit line, attribution on the product
// control) and nothing else changed: who may try something on, which items
// qualify, when a photo leaves the device and what it costs are all still
// decided where they were. So the tests are about the seam between the two --
// awareness consumes the existing authorities, shows nothing on an unknown
// answer, never repeats itself, and can start nothing.
//
// HOW. The real modules are EXECUTED, not pattern-matched: the pure discovery
// model, the real availability hook over the real eligibility rule and the real
// remote-config reader, the real awareness store over a fake device, and the
// real entry component rendered to a tree. Source-level checks are used only
// for the things that are properties of source (what a module may import).
//
// NEGATIVE CONTROLS. Every protected behaviour has a `check*` function. The
// positive test runs it against the shipped source; the control re-runs the SAME
// function against a deliberately broken copy and requires an assertion failure.
// A control whose mutation changes nothing throws rather than passing
// (helpers/componentRenderer.js#transpile), so none of them can be vacuous.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT,
  byTestId,
  createReactNativeStub,
  createRenderer,
  deepStub,
  deferred,
  findAll,
  runModule,
  settle,
  textContent,
} = require('./helpers/componentRenderer');
const { createHookRuntime } = require('./helpers/hookRuntime');

const DISCOVERY = 'services/vto/vtoDiscovery.ts';
const AWARENESS = 'services/vto/vtoAwareness.ts';
const STORE = 'services/featureAwareness.ts';
const TELEMETRY = 'services/vto/vtoTelemetry.ts';
const ELIGIBILITY = 'services/vto/vtoEligibility.ts';
const LIVE_GARMENT = 'services/vto/vtoLiveGarment.ts';
const FEATURE_CONTROL = 'services/vto/vtoFeatureControl.ts';
const AVAILABILITY_HOOK = 'hooks/useVtoAvailability.ts';
const AWARENESS_HOOKS = 'hooks/useVtoAwareness.ts';
const ENTRY = 'components/vto/TryItOnEntry.tsx';
const CUE = 'components/vto/VtoFirstUseCue.tsx';
const HOME_CARD = 'components/home/HomeVtoDiscoveryCard.tsx';
const HOME = 'components/home/HomeLuxuryTechV1.tsx';
const PANEL = 'components/scan-results/PurchaseOptionsPanel.tsx';
const SIGNALS = 'services/kplus/kplusLiveCapabilitySignals.ts';
const GATE = 'components/kplus/KPlusGate.tsx';
const ACQUISITION = 'services/kplus/kplusAcquisitionSurface.ts';
const MEMBERSHIP_SHEET = 'components/kplus/KPlusMembershipSheet.tsx';
const CATALOG = 'services/kplus/kplusActivationCatalog.ts';
const PUBLIC_ROOM = 'app/(public)/rooms/[token].tsx';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

function mutateOpt(rel, from, to) {
  assert.ok(read(rel).includes(from), `mutation anchor not found in ${rel}: ${from.slice(0, 70)}`);
  return (source) => source.split(from).join(to);
}

/** The check must fail with an ASSERTION failure -- a crash is not a red. */
async function expectRed(fn, label) {
  let failure = null;
  try {
    await fn();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${label}: the mutant was NOT caught (the check is not protecting anything)`);
  assert.ok(
    failure instanceof assert.AssertionError,
    `${label}: the mutant crashed instead of failing an assertion: ${failure && failure.stack}`,
  );
}

// ── The world: every authority awareness consumes, as a controllable fake ───

const ELIGIBLE_GARMENT = Object.freeze({
  productRef: 'prod-dress-1',
  imageUrl: 'https://cdn.example-retailer.test/img/dress.jpg',
  category: 'Dress',
  brand: null,
  commerceSource: 'RetailerA',
});
const INELIGIBLE_GARMENT = Object.freeze({ ...ELIGIBLE_GARMENT, productRef: 'prod-boot-1', category: 'Ankle boots' });

const ACTIVE = Object.freeze({ state: 'active', displaySource: 'store_subscription' });
const COMPLIMENTARY = Object.freeze({ state: 'active', displaySource: 'complimentary' });
const FREE = Object.freeze({ state: 'eligible', displaySource: null });
const RESOLVING = Object.freeze({ state: 'loading', displaySource: null });
const UNREADABLE = Object.freeze({ state: 'error', displaySource: null });

function createWorld(o = {}) {
  const mutate = (rel) => (o.mutate ? o.mutate[rel] : undefined);
  const env = {
    actorId: 'actor-a',
    authenticated: true,
    uiEnabled: o.uiEnabled ?? true,
    kplus: { ...(o.kplus ?? ACTIVE) },
    /** The `vto_generation` app_config row value, exactly as an operator writes it. */
    row: 'row' in o ? o.row : { schemaVersion: 1, enabled: true },
    rowError: false,
    /** When set, the config read waits on it (UNRESOLVED). */
    rowGate: null,
    storage: o.storage ?? new Map(),
    storageFails: false,
    /** When set, a device-storage read waits on it. */
    readGate: null,
    vtoStatus: 'idle',
    commerceStatus: 'IDLE',
    appState: 'active',
    window: { width: 390, height: 844 },
    rect: { x: 16, y: 300, width: 200, height: 44 },
    focused: true,
    now: 1_000_000,
    events: [],
    navigations: [],
    timers: [],
    calls: { configReads: 0, functionInvocations: 0, openUpgrade: 0, haptics: 0 },
  };

  const AsyncStorage = {
    async getItem(key) {
      if (env.readGate) await env.readGate.promise;
      if (env.storageFails) throw new Error('device storage unavailable');
      return env.storage.has(key) ? env.storage.get(key) : null;
    },
    async setItem(key, value) {
      if (env.storageFails) throw new Error('device storage unavailable');
      env.storage.set(key, value);
    },
  };
  const actorContext = {
    getActorContext: () => ({ actorId: env.authenticated ? env.actorId : null, epoch: 1 }),
  };
  const supabaseClient = {
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              env.calls.configReads += 1;
              if (env.rowGate) await env.rowGate.promise;
              if (env.rowError) return { data: null, error: new Error('unreadable') };
              return { data: env.row === null ? null : { value: env.row }, error: null };
            },
          }),
        }),
      }),
      functions: {
        invoke: async () => {
          env.calls.functionInvocations += 1;
          return { data: null, error: null };
        },
      },
    },
  };
  const featureFlags = { VTO_UI_ENABLED: env.uiEnabled, VTO_CONFIG_KEY: 'vto_generation' };

  const discovery = runModule(DISCOVERY, {}, { jsx: false, mutate: mutate(DISCOVERY) });
  const telemetry = runModule(TELEMETRY, {}, { jsx: false, mutate: mutate(TELEMETRY) });
  telemetry.setVtoAnalyticsSink((event, payload) => env.events.push({ event, ...payload }));
  const eligibility = runModule(ELIGIBILITY, {}, { jsx: false, mutate: mutate(ELIGIBILITY) });
  const liveGarment = runModule(LIVE_GARMENT, { './vtoEligibility': eligibility }, { jsx: false });
  const featureControl = runModule(
    FEATURE_CONTROL,
    {
      '../supabaseClient': supabaseClient,
      '../../constants/featureFlags': featureFlags,
      './vtoEligibility': eligibility,
      './vtoLiveGarment': liveGarment,
    },
    { jsx: false, mutate: mutate(FEATURE_CONTROL) },
  );
  const entitlements = runModule('types/entitlements.ts', {}, { jsx: false });
  const store = runModule(
    STORE,
    {
      '@react-native-async-storage/async-storage': { __esModule: true, default: AsyncStorage },
      './actorContext': actorContext,
    },
    { jsx: false, mutate: mutate(STORE) },
  );
  const awareness = runModule(
    AWARENESS,
    {
      '../actorContext': actorContext,
      '../featureAwareness': store,
      './vtoDiscovery': discovery,
      './vtoTelemetry': telemetry,
    },
    { jsx: false, mutate: mutate(AWARENESS) },
  );

  const useAuthSession = () => ({
    isAuthenticated: env.authenticated,
    user: env.authenticated ? { id: env.actorId } : null,
    loading: false,
  });
  const useKPlusEntitlement = () => ({ ...env.kplus, isActive: env.kplus.state === 'active' });

  /** Module map for hooks/useVtoAvailability.ts and hooks/useVtoAwareness.ts. */
  function hookModules(react) {
    const availability = runModule(
      AVAILABILITY_HOOK,
      {
        react,
        '../constants/featureFlags': featureFlags,
        '../contexts/AuthSessionContext': { useAuthSession },
        './useKPlusEntitlement': { useKPlusEntitlement },
        '../services/vto/vtoFeatureControl': featureControl,
        '../services/vto/vtoEligibility': eligibility,
        '../types/entitlements': entitlements,
      },
      { jsx: false, mutate: mutate(AVAILABILITY_HOOK) },
    );
    const awarenessHooks = runModule(
      AWARENESS_HOOKS,
      {
        react,
        'react-native': {
          AppState: {
            get currentState() {
              return env.appState;
            },
          },
          Dimensions: { get: () => env.window },
        },
        'expo-router': {
          useFocusEffect: (callback) => {
            react.useEffect(() => (env.focused ? callback() : undefined), [callback]);
          },
        },
        '../constants/featureFlags': featureFlags,
        '../contexts/AuthSessionContext': { useAuthSession },
        './useKPlusCommerce': { useKPlusCommerceSnapshot: () => ({ status: env.commerceStatus }) },
        './useKPlusEntitlement': { useKPlusEntitlement },
        './useVtoSessionStatus': { useVtoSessionStatus: () => ({ status: env.vtoStatus }) },
        '../services/vto/vtoAwareness': awareness,
        '../services/vto/vtoDiscovery': discovery,
        '../services/vto/vtoFeatureControl': featureControl,
        '../types/entitlements': entitlements,
      },
      { jsx: false, mutate: mutate(AWARENESS_HOOKS) },
    );
    return { availability, awarenessHooks };
  }

  /** Executes one real hook until its state stops changing. */
  async function mountHook(pick, getArgs = () => []) {
    const runtime = createHookRuntime();
    const hook = pick(hookModules(runtime.react));
    let result;
    const renderOnce = () => {
      runtime.beginRender();
      result = hook(...getArgs());
      runtime.flushEffects();
    };
    const flush = async (cycles = 10) => {
      for (let i = 0; i < cycles; i += 1) {
        await settle(2);
        runtime.clearDirty();
        renderOnce();
      }
    };
    renderOnce();
    await flush();
    return {
      get current() {
        return result;
      },
      flush,
      unmount: runtime.unmount,
    };
  }

  const world = {
    env,
    useKPlusEntitlement,
    mutationFor: mutate,
    discovery,
    telemetry,
    eligibility,
    featureControl,
    entitlements,
    store,
    awareness,
    hookModules,
    mountHook,
    /** The product control's decision, through the REAL hook and the REAL rule. */
    async productCta(garment = ELIGIBLE_GARMENT) {
      const hook = await mountHook(
        (m) => m.availability.useVtoAvailability,
        () => [{ category: garment.category, imageUrl: garment.imageUrl, productRef: garment.productRef }],
      );
      const signal = hook.current;
      return {
        hook,
        signal,
        cta: discovery.resolveVtoProductCta(signal),
        presentation: discovery.resolveVtoEligibilityPresentation(signal),
      };
    },
    eventsNamed: (name) => env.events.filter((entry) => entry.event === name),
    storedRecord(actorId = env.actorId) {
      const raw = env.storage.get(store.featureAwarenessKey('virtual_try_on', actorId));
      return raw ? JSON.parse(raw) : null;
    },
  };
  return world;
}

/** Patches the interval timer and the clock for a first-use cue test. */
async function withFakeTimers(world, run) {
  const { env } = world;
  const original = { setInterval: global.setInterval, clearInterval: global.clearInterval, now: Date.now };
  global.setInterval = (fn, ms) => {
    const timer = { fn, ms, active: true };
    env.timers.push(timer);
    return timer;
  };
  global.clearInterval = (timer) => {
    if (timer && typeof timer === 'object') timer.active = false;
  };
  Date.now = () => env.now;
  try {
    return await run();
  } finally {
    global.setInterval = original.setInterval;
    global.clearInterval = original.clearInterval;
    Date.now = original.now;
  }
}

const activeTimers = (world) => world.env.timers.filter((timer) => timer.active);

/** Mounts the real first-use cue hook for one product control. */
async function mountCue(world, { cta = 'try_it_on' } = {}) {
  const targetRef = {
    current: {
      measureInWindow: (callback) => {
        const { x, y, width, height } = world.env.rect;
        callback(x, y, width, height);
      },
    },
  };
  const args = { cta };
  const hook = await world.mountHook(
    (m) => m.awarenessHooks.useVtoFirstUseCue,
    () => [{ cta: args.cta, targetRef }],
  );
  return {
    hook,
    args,
    /** Advances the clock one sample at a time, as the device would. */
    async elapse(ms) {
      const step = world.discovery.VTO_MEANINGFUL_VIEW.sampleMs;
      for (let waited = 0; waited < ms; waited += step) {
        world.env.now += step;
        for (const timer of activeTimers(world)) timer.fn();
        await hook.flush(3);
      }
    },
  };
}

const OFFSCREEN = Object.freeze({ x: 16, y: 2400, width: 200, height: 44 });
const ONSCREEN = Object.freeze({ x: 16, y: 300, width: 200, height: 44 });
const DWELL = 1600; // comfortably past VTO_MEANINGFUL_VIEW.dwellMs

// ════════════════════════════════════════════════════════════════════════════
// 1. Eligibility has three states, and the control follows them
// ════════════════════════════════════════════════════════════════════════════

test('eligibility presentation: three states, and anything malformed is UNRESOLVED', () => {
  const { discovery } = createWorld();
  assert.deepEqual([...discovery.VTO_ELIGIBILITY_PRESENTATIONS], [
    'CONFIRMED_ELIGIBLE',
    'CONFIRMED_INELIGIBLE',
    'UNRESOLVED',
  ]);
  const present = discovery.resolveVtoEligibilityPresentation;
  assert.equal(present({ available: true, upgradeOpportunity: false, loading: false }), 'CONFIRMED_ELIGIBLE');
  assert.equal(present({ available: false, upgradeOpportunity: true, loading: false }), 'CONFIRMED_ELIGIBLE');
  assert.equal(present({ available: false, upgradeOpportunity: false, loading: false }), 'CONFIRMED_INELIGIBLE');
  // Loading wins over everything else, including a stale "available".
  assert.equal(present({ available: true, upgradeOpportunity: false, loading: true }), 'UNRESOLVED');
  for (const malformed of [null, undefined, {}, { available: 1, upgradeOpportunity: 0, loading: 0 }, 'yes']) {
    assert.equal(present(malformed), 'UNRESOLVED');
    assert.equal(discovery.resolveVtoProductCta(malformed), 'none');
  }
});

/** J3/J4/J6 + NC-01: the control renders for an eligible item and for nothing else. */
async function checkEligibilityGuard(o = {}) {
  const eligible = await createWorld(o).productCta(ELIGIBLE_GARMENT);
  assert.equal(eligible.presentation, 'CONFIRMED_ELIGIBLE');
  assert.equal(eligible.cta, 'try_it_on');

  const ineligible = await createWorld(o).productCta(INELIGIBLE_GARMENT);
  assert.equal(ineligible.presentation, 'CONFIRMED_INELIGIBLE', 'footwear is not a try-on garment');
  assert.equal(ineligible.cta, 'none', 'an unsupported product must not expose Try It On');

  // A garment with no usable image, or no stable reference, is not eligible
  // either -- and is not converted into a K+ prompt.
  for (const garment of [
    { ...ELIGIBLE_GARMENT, imageUrl: '' },
    { ...ELIGIBLE_GARMENT, imageUrl: 'file:///private/photo.jpg' },
    { ...ELIGIBLE_GARMENT, productRef: '' },
  ]) {
    const free = await createWorld({ ...o, kplus: FREE }).productCta(garment);
    assert.equal(free.cta, 'none');
  }
}

test('J3/J6: an eligible item exposes Try It On; an ineligible one exposes nothing', () => checkEligibilityGuard());

test('NC-01: removing the eligibility guard is caught', async () => {
  await expectRed(
    () => checkEligibilityGuard({
      mutate: {
        [ELIGIBILITY]: mutateOpt(
          ELIGIBILITY,
          "  if (!slot || !supported.includes(canonical)) {\n    return { eligible: false, reason: 'unsupported_category' };\n  }",
          '',
        ),
      },
    }),
    'eligibility guard removed',
  );
});

/** J7 + NC-02: nothing is rendered until every authority has answered. */
async function checkNoCtaWhileUnresolved(o = {}) {
  // The remote row has not arrived.
  const pending = createWorld(o);
  pending.env.rowGate = deferred();
  const first = await pending.productCta(ELIGIBLE_GARMENT);
  assert.equal(first.presentation, 'UNRESOLVED');
  assert.equal(first.cta, 'none', 'no control while eligibility is unresolved');

  // UNRESOLVED -> ELIGIBLE: the control appears once, and only then.
  pending.env.rowGate.resolve();
  await first.hook.flush();
  assert.equal(pending.discovery.resolveVtoProductCta(first.hook.current), 'try_it_on');

  // UNRESOLVED -> INELIGIBLE: the control never existed, so it never flashes.
  const flash = createWorld(o);
  flash.env.rowGate = deferred();
  const seen = [];
  const run = await flash.productCta(INELIGIBLE_GARMENT);
  seen.push(run.cta);
  flash.env.rowGate.resolve();
  await run.hook.flush();
  seen.push(flash.discovery.resolveVtoProductCta(run.hook.current));
  assert.deepEqual(seen, ['none', 'none'], 'a control must not be drawn and then withdrawn');

  // K+ still resolving, with everything else known.
  const kplusPending = await createWorld({ ...o, kplus: RESOLVING }).productCta(ELIGIBLE_GARMENT);
  assert.equal(kplusPending.cta, 'none');
}

test('J7: pending eligibility renders no control, and never flashes one', () => checkNoCtaWhileUnresolved());

test('NC-02: allowing the control during UNRESOLVED is caught', async () => {
  await expectRed(
    () => checkNoCtaWhileUnresolved({
      mutate: {
        [DISCOVERY]: mutateOpt(DISCOVERY, "  if (signal.loading) return 'UNRESOLVED';\n", ''),
        // The hook answers "eligible if K+" for a resolving actor once its own
        // loading guard is gone -- the shape the model has to refuse.
        [AVAILABILITY_HOOK]: mutateOpt(
          AVAILABILITY_HOOK,
          'upgradeOpportunity: !eligibility.eligible && !loading && eligibleWithKPlus,',
          'upgradeOpportunity: !eligibility.eligible && eligibleWithKPlus,',
        ),
      },
    }),
    'control during UNRESOLVED',
  );
});

/** J8: a failed resolver fails closed, silently. */
test('J8: an eligibility resolver error renders no control and no disabled control', async () => {
  const world = createWorld();
  world.env.rowError = true;
  const result = await world.productCta(ELIGIBLE_GARMENT);
  assert.equal(result.cta, 'none');
  // One read, not a per-card retry loop: ten more controls reuse the answer
  // path without a fan-out of provider or function calls.
  const before = world.env.calls.configReads;
  for (let i = 0; i < 10; i += 1) await world.productCta(ELIGIBLE_GARMENT);
  assert.ok(world.env.calls.configReads - before <= 10, 'at most one row read per control, never a retry loop');
  assert.equal(world.env.calls.functionInvocations, 0);
  // The component has exactly two control states and neither is "disabled".
  const entry = stripComments(read(ENTRY));
  assert.doesNotMatch(entry, /<Pressable[^>]*\bdisabled\b/, 'Try It On is never rendered disabled');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. K+ -- Free, active, complimentary, resolving
// ════════════════════════════════════════════════════════════════════════════

/** J2 + NC-03: a Free actor reaches the shared K+ surface, never the try-on. */
async function checkFreeIsNotAuthorized(o = {}) {
  for (const kplus of [FREE, { state: 'expired', displaySource: null }]) {
    const result = await createWorld({ ...o, kplus }).productCta(ELIGIBLE_GARMENT);
    assert.equal(result.signal.available, false, 'a Free actor is not authorized for a try-on');
    assert.equal(result.cta, 'unlock', 'a Free actor on an eligible item is offered K+');
  }
  // And an ineligible item is not turned into a K+ prompt.
  const ineligible = await createWorld({ ...o, kplus: FREE }).productCta(INELIGIBLE_GARMENT);
  assert.equal(ineligible.cta, 'none');
}

test('J2: a Free actor on an eligible item is routed to the shared K+ surface', () => checkFreeIsNotAuthorized());

test('NC-03: treating Free as authorized K+ is caught', async () => {
  await expectRed(
    () => checkFreeIsNotAuthorized({
      mutate: {
        [AVAILABILITY_HOOK]: mutateOpt(AVAILABILITY_HOOK, '      hasEntitlement: hasKPlus,', '      hasEntitlement: true,'),
      },
    }),
    'Free treated as K+',
  );
});

/** J5 + NC-04: an unknown K+ answer is never the Free path. */
async function checkResolvingIsNotFree(o = {}) {
  for (const kplus of [RESOLVING, UNREADABLE]) {
    const world = createWorld({ ...o, kplus });
    const result = await world.productCta(ELIGIBLE_GARMENT);
    assert.notEqual(result.cta, 'unlock', `K+ '${kplus.state}' must not be routed as Free`);
    assert.equal(result.cta, 'none');
    assert.equal(world.discovery.resolveVtoActorKPlusState(kplus), 'resolving');
  }
}

test('J5: resolving or unreadable K+ is never treated as Free', () => checkResolvingIsNotFree());

test('NC-04: treating RESOLVING as Free is caught', async () => {
  await expectRed(
    () => checkResolvingIsNotFree({
      mutate: {
        [AVAILABILITY_HOOK]: mutateOpt(
          AVAILABILITY_HOOK,
          'upgradeOpportunity: !eligibility.eligible && !loading && eligibleWithKPlus,',
          'upgradeOpportunity: !eligibility.eligible && eligibleWithKPlus,',
        ),
        [DISCOVERY]: mutateOpt(DISCOVERY, "  if (signal.loading) return 'UNRESOLVED';\n", ''),
      },
    }),
    'RESOLVING treated as Free',
  );
});

test('J4: complimentary K+ gets exactly the active-K+ experience', async () => {
  const paid = await createWorld({ kplus: ACTIVE }).productCta(ELIGIBLE_GARMENT);
  const complimentary = await createWorld({ kplus: COMPLIMENTARY }).productCta(ELIGIBLE_GARMENT);
  assert.equal(paid.cta, 'try_it_on');
  assert.equal(complimentary.cta, 'try_it_on');
  const { discovery } = createWorld();
  assert.equal(discovery.resolveVtoActorKPlusState(COMPLIMENTARY), 'complimentary');
  assert.equal(discovery.resolveVtoActorKPlusState(ACTIVE), 'active');
  assert.equal(discovery.resolveVtoActorKPlusState(FREE), 'free');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Globally unavailable, dimmed, and anonymous
// ════════════════════════════════════════════════════════════════════════════

/** J9 + NC-08: when VTO is off, no awareness surface stays actionable. */
async function checkDisabledMeansNoAwareness(o = {}) {
  const off = [
    { label: 'remote switch off', world: createWorld({ ...o, row: { schemaVersion: 1, enabled: false } }) },
    { label: 'no row', world: createWorld({ ...o, row: null }) },
    { label: 'unknown schema', world: createWorld({ ...o, row: { schemaVersion: 9, enabled: true } }) },
    { label: 'build without the try-on surface', world: createWorld({ ...o, uiEnabled: false }) },
  ];
  for (const { label, world } of off) {
    const product = await world.productCta(ELIGIBLE_GARMENT);
    assert.equal(product.cta, 'none', `${label}: no product control`);
    const home = await world.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
    assert.equal(home.current.visible, false, `${label}: no Home card`);
    assert.equal(home.current.state, 'VTO_UNAVAILABLE', label);
    assert.equal(world.eventsNamed('vto_awareness_impression').length, 0, `${label}: nothing was promoted`);
  }
  // The K+ benefit line obeys the same switch.
  const signals = runModule(SIGNALS, { '../vto/vtoFeatureControl': createWorld(o).featureControl }, { jsx: false });
  assert.deepEqual(
    await signals.readKPlusLiveCapabilitySignals({ readVtoConfig: async () => ({ enabled: false, awarenessEnabled: false }) }),
    { virtual_try_on: false },
  );
}

test('J9: VTO globally unavailable leaves no actionable awareness', () => checkDisabledMeansNoAwareness());

test('NC-08: awareness that survives a disabled feature is caught', async () => {
  await expectRed(
    () => checkDisabledMeansNoAwareness({
      mutate: {
        [DISCOVERY]: mutateOpt(DISCOVERY, "  if (input.remote.enabled !== true) return 'unavailable';\n", ''),
        [FEATURE_CONTROL]: mutateOpt(
          FEATURE_CONTROL,
          "awarenessEnabled: raw.enabled === true && awareness?.enabled !== false,",
          'awarenessEnabled: awareness?.enabled !== false,',
        ),
      },
    }),
    'awareness with VTO disabled',
  );
});

test('remote dimming: awareness can be reduced while the product control keeps working', async () => {
  const dimmed = createWorld({ row: { schemaVersion: 1, enabled: true, awareness: { enabled: false } } });
  const config = await dimmed.featureControl.getVtoRemoteConfig();
  assert.equal(config.enabled, true, 'generation stays on');
  assert.equal(config.awarenessEnabled, false, 'promotion is dimmed');

  const product = await dimmed.productCta(ELIGIBLE_GARMENT);
  assert.equal(product.cta, 'try_it_on', 'the control on an eligible item is not promotion');
  const home = await dimmed.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(home.current.visible, false, 'the Home introduction is dimmed');
  // The K+ benefit LINE is dimmed too -- but the capability is still reported
  // as SERVED, so dimming cannot make the membership look empty (FC-02).
  const signals = runModule(SIGNALS, { '../vto/vtoFeatureControl': dimmed.featureControl }, { jsx: false });
  assert.deepEqual(await signals.readKPlusLiveCapabilityState(), {
    signals: { virtual_try_on: true },
    promotion: { virtual_try_on: false },
  });
  assert.deepEqual(await signals.readKPlusLiveCapabilitySignals(), { virtual_try_on: true });

  // It can only REDUCE: every row written before the field existed is unchanged.
  const { normalizeVtoRemoteConfig: normalize } = dimmed.featureControl;
  assert.equal(normalize({ enabled: true }).awarenessEnabled, true);
  for (const junk of [{ awareness: 'off' }, { awareness: [] }, { awareness: { enabled: 'false' } }, { awareness: null }]) {
    assert.equal(normalize({ enabled: true, ...junk }).awarenessEnabled, true, 'only an explicit false dims');
  }
  assert.equal(normalize({ enabled: false, awareness: { enabled: true } }).awarenessEnabled, false, 'it cannot promote a disabled feature');
  assert.equal(dimmed.featureControl.DISABLED_VTO_REMOTE_CONFIG.awarenessEnabled, false);
});

/** J13 + NC-10: an unauthenticated viewer is offered nothing. */
async function checkAnonymousGetsNothing(o = {}) {
  const world = createWorld(o);
  world.env.authenticated = false;
  const product = await world.productCta(ELIGIBLE_GARMENT);
  assert.equal(product.cta, 'none', 'no Try It On control for an unauthenticated viewer');
  const home = await world.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(home.current.visible, false);
  assert.equal(world.env.calls.configReads, 0, 'not even the config row is read for an anonymous viewer');
  assert.equal(world.eventsNamed('vto_awareness_impression').length, 0);
  // The public shared-room route does not mount a try-on surface at all.
  const publicRoom = stripComments(read(PUBLIC_ROOM));
  assert.doesNotMatch(publicRoom, /TryItOnEntry|VirtualTryOnSheet|HomeVtoDiscoveryCard|VtoFirstUseCue/);
}

test('J13: an anonymous or public viewer gets no actionable Try It On', () => checkAnonymousGetsNothing());

test('NC-10: an unauthenticated viewer receiving Try It On is caught', async () => {
  await expectRed(
    () => checkAnonymousGetsNothing({
      mutate: {
        [AVAILABILITY_HOOK]: (source) => source
          .split('if (!VTO_UI_ENABLED || !isAuthenticated) {').join('if (!VTO_UI_ENABLED) {')
          .split('if (!VTO_UI_ENABLED || !isAuthenticated || !config) {').join('if (!VTO_UI_ENABLED || !config) {')
          .split('VTO_UI_ENABLED && isAuthenticated && (config === null').join('VTO_UI_ENABLED && (config === null'),
      },
    }),
    'anonymous Try It On',
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Home discovery card lifecycle
// ════════════════════════════════════════════════════════════════════════════

test('J10: the Home card shows, is dismissed, and stays dismissed', async () => {
  const storage = new Map();
  const world = createWorld({ storage });
  const home = await world.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(home.current.state, 'NEVER_ENGAGED');
  assert.equal(home.current.visible, true);
  assert.deepEqual(world.eventsNamed('vto_awareness_impression'), [
    { event: 'vto_awareness_impression', surface: 'home', actor_kplus_state: 'active' },
  ]);

  home.current.dismiss();
  await home.flush();
  assert.equal(home.current.visible, false);
  assert.equal(home.current.state, 'HOME_CARD_DISMISSED');
  assert.equal(world.storedRecord().homeCardDismissed, true, 'the dismissal is persisted');
  assert.deepEqual(world.eventsNamed('vto_awareness_dismissed'), [
    { event: 'vto_awareness_dismissed', surface: 'home', actor_kplus_state: 'active' },
  ]);

  // A relaunch -- new modules, same device -- keeps it dismissed.
  const relaunched = createWorld({ storage });
  const again = await relaunched.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(again.current.visible, false);
  assert.equal(again.current.state, 'HOME_CARD_DISMISSED');
  assert.equal(relaunched.eventsNamed('vto_awareness_impression').length, 0);
});

test('J10: opening a try-on retires the Home card, and a result keeps it retired', async () => {
  const storage = new Map();
  const world = createWorld({ storage });
  const home = await world.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(home.current.visible, true);

  world.awareness.markVtoInitiated();
  await home.flush();
  assert.equal(home.current.state, 'VTO_INITIATED');
  assert.equal(home.current.visible, false);

  world.awareness.markVtoCompleted();
  await home.flush();
  assert.equal(home.current.state, 'VTO_COMPLETED');

  const relaunched = createWorld({ storage });
  const again = await relaunched.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(again.current.state, 'VTO_COMPLETED');
  assert.equal(again.current.visible, false);
});

test('Home card: an unknown history shows nothing, and never shows-then-hides', async () => {
  // Unreadable device storage is "unknown", not "never seen".
  const unreadable = createWorld();
  unreadable.env.storageFails = true;
  const blocked = await unreadable.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(blocked.current.state, 'UNRESOLVED');
  assert.equal(blocked.current.visible, false);

  // A corrupt record is unknown too.
  const corrupt = createWorld();
  corrupt.env.storage.set(corrupt.store.featureAwarenessKey('virtual_try_on', 'actor-a'), '{not json');
  const garbled = await corrupt.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(garbled.current.visible, false);

  // While the remote row is pending the card is absent, then appears once.
  const pending = createWorld();
  pending.env.rowGate = deferred();
  const home = await pending.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(home.current.state, 'UNRESOLVED');
  assert.equal(home.current.visible, false);
  pending.env.rowGate.resolve();
  await home.flush();
  assert.equal(home.current.visible, true);
});

test('Home card: the pure lifecycle covers every state, and only one is visible', () => {
  const { discovery } = createWorld();
  const record = (o = {}) => ({
    homeCardDismissed: false, initiated: false, completed: false, cueDismissed: false, cuePresentations: 0, ...o,
  });
  const session = (o = {}) => ({ cueShown: false, pitchedAtStep6: false, ...o });
  const decide = (o) => discovery.resolveVtoHomeCard({ surface: 'available', awareness: record(), session: session(), ...o });
  const table = [
    [decide({}), 'NEVER_ENGAGED', true],
    [decide({ awareness: record({ homeCardDismissed: true }) }), 'HOME_CARD_DISMISSED', false],
    [decide({ awareness: record({ initiated: true }) }), 'VTO_INITIATED', false],
    [decide({ awareness: record({ initiated: true, completed: true }) }), 'VTO_COMPLETED', false],
    [decide({ surface: 'unavailable' }), 'VTO_UNAVAILABLE', false],
    [decide({ surface: 'resolving' }), 'UNRESOLVED', false],
    [decide({ awareness: null }), 'UNRESOLVED', false],
    [decide({ session: session({ pitchedAtStep6: true }) }), 'DEFERRED_AFTER_STEP6', false],
  ];
  for (const [decision, state, visible] of table) {
    assert.equal(decision.state, state);
    assert.equal(decision.visible, visible, state);
  }
  assert.deepEqual(
    [...new Set(table.map(([decision]) => decision.state))].sort(),
    [...discovery.VTO_HOME_CARD_STATES].sort(),
    'every declared state is reachable and tested',
  );
});

/** ADD-06: the Home card enters the Scanner journey and nothing else. */
function renderHomeCard({ visible = true, kplus = 'active', mutate } = {}) {
  const renderer = createRenderer();
  const calls = { navigations: [], taps: 0, dismissals: 0, haptics: 0 };
  const discovery = runModule(DISCOVERY, {}, { jsx: false });
  const card = runModule(
    HOME_CARD,
    {
      ...renderer.runtimeModules,
      'react-native': createReactNativeStub(),
      'expo-router': { router: { push: (target) => calls.navigations.push(target) } },
      '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SHADOWS: {}, SPACING: deepStub() },
      '../../hooks/useVtoAwareness': {
        useVtoHomeCard: () => ({
          visible,
          kplus,
          state: visible ? 'NEVER_ENGAGED' : 'HOME_CARD_DISMISSED',
          notePrimaryTap: () => { calls.taps += 1; },
          dismiss: () => { calls.dismissals += 1; },
        }),
      },
      '../../services/haptics': { selectionTick: () => { calls.haptics += 1; } },
      '../../services/vto/vtoDiscovery': discovery,
      '../icons/kscan': { KScanIcon: 'KScanIcon' },
      '../kplus/KPlusMarkerBadge': { KPlusMarkerBadge: 'KPlusMarkerBadge' },
    },
    { mutate },
  );
  const tree = renderer.render(renderer.jsx(card.HomeVtoDiscoveryCard, {}));
  const host = (testID) => byTestId(tree, testID).filter((node) => typeof node.type === 'string');
  return { tree, calls, host, discovery };
}

test('ADD-06: the Home card routes into the Scanner, never into an empty try-on', () => {
  const ui = renderHomeCard();
  assert.equal(ui.host('home-vto-discovery-card').length, 1);
  assert.match(textContent(ui.tree), /Try it on with AI/);
  assert.match(textContent(ui.tree), /Scan or open an eligible look to see it on you\./);

  ui.host('home-vto-discovery-scan')[0].props.onPress();
  assert.deepEqual(ui.calls.navigations, ['/scan'], 'the one destination is the Scanner');
  assert.equal(ui.calls.taps, 1);

  ui.host('home-vto-discovery-dismiss')[0].props.onPress();
  assert.equal(ui.calls.dismissals, 1);
  assert.deepEqual(ui.calls.navigations, ['/scan'], 'dismissing navigates nowhere');

  // Hidden means absent, not disabled.
  const hidden = renderHomeCard({ visible: false });
  assert.equal(hidden.host('home-vto-discovery-card').length, 0);
  assert.equal(textContent(hidden.tree), '');
});

test('Home card: accessible name, hint, 44pt targets, and no K+ marker while K+ resolves', () => {
  const ui = renderHomeCard({ kplus: 'free' });
  const scan = ui.host('home-vto-discovery-scan')[0];
  const dismiss = ui.host('home-vto-discovery-dismiss')[0];
  assert.equal(scan.props.accessibilityRole, 'button');
  assert.equal(scan.props.accessibilityLabel, 'Scan a look to try on');
  assert.ok(scan.props.accessibilityHint.length > 0);
  assert.equal(dismiss.props.accessibilityRole, 'button');
  assert.equal(dismiss.props.accessibilityLabel, 'Dismiss the Try It On tip');
  assert.equal(findAll(ui.tree, (node) => node.type === 'KPlusMarkerBadge')[0].props.state, 'locked');

  const included = renderHomeCard({ kplus: 'complimentary' });
  assert.equal(findAll(included.tree, (node) => node.type === 'KPlusMarkerBadge')[0].props.state, 'included');
  const resolving = renderHomeCard({ kplus: 'resolving' });
  assert.equal(findAll(resolving.tree, (node) => node.type === 'KPlusMarkerBadge').length, 0, 'RESOLVING != FREE');

  const source = stripComments(read(HOME_CARD));
  assert.match(source, /primary:\s*\{[\s\S]*?minHeight: 44/);
  assert.match(source, /dismiss:\s*\{[\s\S]*?minWidth: 44,[\s\S]*?minHeight: 44/);
  assert.doesNotMatch(source, /numberOfLines|allowFontScaling=\{false\}|maxFontSizeMultiplier/, 'large text is not clipped');
  assert.doesNotMatch(source, /Animated|LayoutAnimation/, 'no motion to reduce');
  assert.match(read(HOME), /<HomeVtoDiscoveryCard style=\{styles\.vtoDiscoveryCard\} \/>/, 'mounted on Home');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. First-use cue: meaningful view, collisions, one per session, dismissal
// ════════════════════════════════════════════════════════════════════════════

test('ADD-08: an eligible item that is rendered but not meaningfully viewed shows no cue', async () => {
  const world = createWorld();
  await withFakeTimers(world, async () => {
    world.env.rect = { ...OFFSCREEN };
    const cue = await mountCue(world);
    await cue.elapse(8_000);
    assert.equal(cue.hook.current.visible, false, 'mounted off-screen is not a view');

    // Scrolled into view for less than the dwell, then away again.
    world.env.rect = { ...ONSCREEN };
    await cue.elapse(800);
    world.env.rect = { ...OFFSCREEN };
    await cue.elapse(4_000);
    assert.equal(cue.hook.current.visible, false, 'passing through the window is not a view');

    // Partly clipped by the window edge the whole time.
    world.env.rect = { x: 16, y: 820, width: 200, height: 44 };
    await cue.elapse(4_000);
    assert.equal(cue.hook.current.visible, false, 'a clipped control is not a view');

    assert.equal(world.eventsNamed('vto_awareness_impression').filter((e) => e.surface === 'coachmark').length, 0);
    assert.equal(world.storedRecord(), null, 'nothing was recorded as presented');
  });
});

test('first-use cue: a meaningful view on a stable surface shows it exactly once', async () => {
  const world = createWorld();
  await withFakeTimers(world, async () => {
    const cue = await mountCue(world);
    assert.equal(cue.hook.current.visible, false, 'not shown on mount');
    await cue.elapse(DWELL);
    assert.equal(cue.hook.current.visible, true);
    assert.equal(world.awareness.readVtoAwarenessSession().cueShown, true);
    assert.equal(world.storedRecord().cuePresentations, 1);
    assert.deepEqual(
      world.eventsNamed('vto_awareness_impression').filter((e) => e.surface === 'coachmark'),
      [{ event: 'vto_awareness_impression', surface: 'coachmark', actor_kplus_state: 'active' }],
    );
    assert.equal(activeTimers(world).length, 0, 'measuring stops once the cue is up');

    // A second eligible product in the same session never shows another.
    const second = await mountCue(world);
    await second.elapse(DWELL * 3);
    assert.equal(second.hook.current.visible, false);
    assert.equal(activeTimers(world).length, 0, 'and it is not even measured');
  });
});

test('first-use cue: acting on it retires it, for a Free actor as well', async () => {
  const world = createWorld({ kplus: FREE });
  await withFakeTimers(world, async () => {
    const cue = await mountCue(world, { cta: 'unlock' });
    await cue.elapse(DWELL);
    assert.equal(cue.hook.current.visible, true, 'a Free actor on an eligible item is taught too');
    cue.hook.current.notePrimaryTap();
    await cue.hook.flush();
    assert.equal(cue.hook.current.visible, false, 'the cue does not linger behind the K+ sheet');
    assert.equal(world.storedRecord().cueDismissed, true);
    assert.equal(world.storedRecord().initiated, false, 'asking about K+ is not using try-on');
    assert.deepEqual(world.eventsNamed('vto_awareness_tap'), [
      { event: 'vto_awareness_tap', surface: 'coachmark', actor_kplus_state: 'free' },
    ]);
  });
});

/** J11 + NC-07: the cue respects collisions and dismissal. */
async function checkCueCollisionAndDismissal(o = {}) {
  // A modal is up when the view completes: suppressed, and NOT queued.
  const world = createWorld(o);
  await withFakeTimers(world, async () => {
    const release = world.awareness.acquireVtoAwarenessBlocker();
    const cue = await mountCue(world);
    await cue.elapse(DWELL);
    assert.equal(cue.hook.current.visible, false, 'no cue while another modal is presenting');

    release();
    await cue.elapse(DWELL * 2);
    assert.equal(cue.hook.current.visible, false, 'the cue is not queued to appear when the modal closes');
    assert.equal(world.storedRecord(), null, 'a suppressed cue does not count as presented');

    // A later, stable encounter is evaluated afresh.
    world.env.rect = { ...OFFSCREEN };
    await cue.elapse(800);
    world.env.rect = { ...ONSCREEN };
    await cue.elapse(DWELL);
    assert.equal(cue.hook.current.visible, true, 'a later stable encounter may show it');

    // "Not now" is respected, persisted, and final.
    cue.hook.current.dismiss();
    await cue.hook.flush();
    assert.equal(cue.hook.current.visible, false);
    assert.equal(world.storedRecord().cueDismissed, true);
  });

  // After dismissal the cue is never offered again, on any launch.
  const relaunched = createWorld({ ...o, storage: world.env.storage });
  await withFakeTimers(relaunched, async () => {
    const cue = await mountCue(relaunched);
    await cue.elapse(DWELL * 3);
    assert.equal(cue.hook.current.visible, false, 'a dismissed cue is not re-escalated');
    assert.equal(activeTimers(relaunched).length, 0);
  });
}

test('J11: the cue does not stack on a modal, is not queued, and respects "Not now"', () => checkCueCollisionAndDismissal());

test('NC-07: a cue that ignores the collision policy is caught', async () => {
  await expectRed(
    () => checkCueCollisionAndDismissal({
      mutate: { [DISCOVERY]: mutateOpt(DISCOVERY, "  if (hasVtoCueCollision(input.collisions)) return no('collision');\n", '') },
    }),
    'collision ignored',
  );
});

test('NC-07: a cue that ignores dismissal is caught', async () => {
  await expectRed(
    () => checkCueCollisionAndDismissal({
      mutate: {
        [DISCOVERY]: mutateOpt(DISCOVERY, "  if (input.awareness.cueDismissed) return no('dismissed');\n", ''),
        [AWARENESS_HOOKS]: mutateOpt(AWARENESS_HOOKS, '    && !awareness.cueDismissed\n', ''),
      },
    }),
    'dismissal ignored',
  );
});

test('first-use cue: every collision suppresses it', async () => {
  const collisions = [
    ['K+ resolving', (env) => { env.kplus = { ...RESOLVING }; }],
    ['a try-on request is active', (env) => { env.vtoStatus = 'generating'; }],
    ['a photo is being chosen', (env) => { env.vtoStatus = 'selecting_input'; }],
    ['a purchase is processing', (env) => { env.commerceStatus = 'PURCHASING'; }],
    ['a restore is processing', (env) => { env.commerceStatus = 'RESTORING'; }],
    ['the app is not foreground-active', (env) => { env.appState = 'inactive'; }],
    ['the host screen is not focused', (env) => { env.focused = false; }],
  ];
  for (const [label, apply] of collisions) {
    const world = createWorld();
    apply(world.env);
    await withFakeTimers(world, async () => {
      // K+ resolving also means the control itself is not rendered ('none').
      const cue = await mountCue(world, { cta: world.env.kplus.state === 'loading' ? 'none' : 'try_it_on' });
      await cue.elapse(DWELL * 2);
      assert.equal(cue.hook.current.visible, false, label);
      assert.equal(world.storedRecord(), null, `${label}: not counted as presented`);
    });
  }
  const { discovery } = createWorld();
  assert.deepEqual(Object.keys(discovery.VTO_CUE_NO_COLLISIONS).sort(), [
    'appInactive', 'kplusResolving', 'modalPresenting', 'purchaseInFlight', 'surfaceUnstable', 'vtoRequestActive',
  ]);
});

test('cross-surface coordination: a Step 6 pitch defers Home and the cue for the session', async () => {
  const storage = new Map();
  const world = createWorld({ storage });
  world.awareness.noteVtoPitchedAtStep6();
  const home = await world.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(home.current.state, 'DEFERRED_AFTER_STEP6');
  assert.equal(home.current.visible, false);
  await withFakeTimers(world, async () => {
    const cue = await mountCue(world);
    await cue.elapse(DWELL * 2);
    assert.equal(cue.hook.current.visible, false, 'no cue right after the Step 6 pitch');
    assert.equal(activeTimers(world).length, 0);
  });
  // Next launch the deferral is gone -- it was never persisted.
  assert.equal(world.storedRecord(), null);
  const next = createWorld({ storage });
  const later = await next.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(later.current.visible, true);
});

test('first-use cue: retires itself after the presentation cap, and after any use', async () => {
  const { discovery } = createWorld();
  assert.equal(discovery.VTO_CUE_MAX_PRESENTATIONS, 2);
  const base = {
    surface: 'available',
    cta: 'try_it_on',
    meaningfullyViewed: true,
    session: { cueShown: false, pitchedAtStep6: false },
    collisions: discovery.VTO_CUE_NO_COLLISIONS,
  };
  const record = (o = {}) => ({
    homeCardDismissed: false, initiated: false, completed: false, cueDismissed: false, cuePresentations: 0, ...o,
  });
  const reason = (o) => discovery.resolveVtoFirstUseCue({ ...base, awareness: record(), ...o }).reason;
  assert.equal(reason({}), 'show');
  assert.equal(reason({ awareness: record({ cuePresentations: 2 }) }), 'retired');
  assert.equal(reason({ awareness: record({ initiated: true }) }), 'already_used');
  assert.equal(reason({ awareness: record({ cueDismissed: true }) }), 'dismissed');
  assert.equal(reason({ awareness: null }), 'history_unknown');
  assert.equal(reason({ cta: 'none' }), 'not_eligible');
  assert.equal(reason({ surface: 'unavailable' }), 'surface_unavailable');
  assert.equal(reason({ surface: 'resolving' }), 'surface_unavailable');
  assert.equal(reason({ meaningfullyViewed: false }), 'not_viewed');
  assert.equal(reason({ session: { cueShown: true, pitchedAtStep6: false } }), 'shown_this_session');
  assert.equal(reason({ session: { cueShown: false, pitchedAtStep6: true } }), 'pitched_at_step6');
  // A permanent reason outranks a momentary one: a dismissed cue is never
  // reported as merely "colliding".
  assert.equal(
    reason({ awareness: record({ cueDismissed: true }), collisions: { ...discovery.VTO_CUE_NO_COLLISIONS, modalPresenting: true } }),
    'dismissed',
  );
});

test('MEANINGFULLY_VIEWED: whole control in the window, continuously, for the dwell', () => {
  const { discovery } = createWorld();
  assert.deepEqual({ ...discovery.VTO_MEANINGFUL_VIEW }, { dwellMs: 1200, sampleMs: 400 });
  const viewport = { width: 390, height: 844 };
  const inWindow = (rect) => discovery.isVtoRectInWindow(rect, viewport);
  assert.equal(inWindow({ x: 0, y: 0, width: 390, height: 44 }), true);
  assert.equal(inWindow({ x: 16, y: 801, width: 200, height: 44 }), false, 'clipped at the bottom');
  assert.equal(inWindow({ x: -4, y: 300, width: 200, height: 44 }), false, 'clipped at the left');
  assert.equal(inWindow({ x: 300, y: 300, width: 200, height: 44 }), false, 'clipped at the right');
  assert.equal(inWindow({ x: 16, y: 300, width: 0, height: 0 }), false, 'an unmounted view measures as zero');
  assert.equal(inWindow({ x: NaN, y: 300, width: 200, height: 44 }), false);
  assert.equal(inWindow(null), false);
  assert.equal(discovery.isVtoRectInWindow({ x: 0, y: 0, width: 1, height: 1 }, null), false);

  let state = discovery.VTO_VIEW_DWELL_IDLE;
  const step = (sample) => {
    const next = discovery.advanceVtoViewDwell(state, sample);
    state = next.dwell;
    return next.meaningfullyViewed;
  };
  assert.equal(step({ inWindow: true, stable: true, nowMs: 0 }), false);
  assert.equal(step({ inWindow: true, stable: true, nowMs: 800 }), false);
  assert.equal(step({ inWindow: true, stable: false, nowMs: 1000 }), false, 'an unstable surface resets the run');
  assert.equal(step({ inWindow: true, stable: true, nowMs: 1400 }), false);
  assert.equal(step({ inWindow: true, stable: true, nowMs: 2599 }), false);
  assert.equal(step({ inWindow: true, stable: true, nowMs: 2600 }), true, 'exactly the dwell, continuously');
  assert.equal(step({ inWindow: false, stable: true, nowMs: 2700 }), false, 'leaving the window resets it');

  // One encounter: a view at the wrong moment is DEFERRED until the control
  // leaves -- never shown the moment the collision clears, never used up.
  const advance = discovery.advanceVtoCueEncounter;
  const no = { show: false, reason: 'collision' };
  const yes = { show: true, reason: 'show' };
  assert.equal(advance('watching', { type: 'viewed', decision: no }), 'deferred');
  assert.equal(advance('deferred', { type: 'viewed', decision: yes }), 'deferred', 'not queued');
  assert.equal(advance('deferred', { type: 'left_window' }), 'watching', 're-armed by leaving');
  assert.equal(advance('watching', { type: 'viewed', decision: yes }), 'presented');
  assert.equal(advance('presented', { type: 'left_window' }), 'presented', 'a shown cue is not withdrawn by scrolling');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Awareness history: actor-scoped, device-local, monotonic
// ════════════════════════════════════════════════════════════════════════════

test('ADD-05: awareness history does not leak between accounts', async () => {
  const world = createWorld();
  const { store, awareness, env } = world;

  assert.deepEqual({ ...(await store.loadFeatureAwareness('virtual_try_on')) }, { ...store.EMPTY_FEATURE_AWARENESS });
  awareness.dismissVtoHomeCard();
  awareness.dismissVtoCue();
  awareness.noteVtoPitchedAtStep6();
  await settle();
  assert.equal(awareness.readVtoAwareness().homeCardDismissed, true);
  assert.equal(awareness.readVtoAwarenessSession().pitchedAtStep6, true);

  // Account B signs in on the same device, in the same launch.
  env.actorId = 'actor-b';
  assert.equal(awareness.readVtoAwareness(), null, "B's history is unknown until it is read -- never A's");
  assert.deepEqual({ ...awareness.readVtoAwarenessSession() }, { cueShown: false, pitchedAtStep6: false });
  const forB = await awareness.loadVtoAwareness();
  assert.equal(forB.homeCardDismissed, false);
  assert.equal(forB.cueDismissed, false);
  const homeB = await world.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(homeB.current.visible, true, "B is introduced to the feature; A's dismissal is A's");

  // Signing out reads nothing and writes nothing.
  env.authenticated = false;
  assert.equal(awareness.readVtoAwareness(), null);
  assert.equal(await awareness.loadVtoAwareness(), null);
  assert.equal(await store.patchFeatureAwareness('virtual_try_on', { homeCardDismissed: true }), false);
  awareness.noteVtoPitchedAtStep6();
  assert.deepEqual({ ...awareness.readVtoAwarenessSession() }, { cueShown: false, pitchedAtStep6: false });

  // A returns and finds exactly what A left.
  env.authenticated = true;
  env.actorId = 'actor-a';
  assert.equal((await awareness.loadVtoAwareness()).homeCardDismissed, true);

  // The two records are separate keys, named by account.
  assert.deepEqual([...env.storage.keys()].sort(), ['kscan.featureAwareness.v1:virtual_try_on:actor-a']);
  assert.equal(world.storedRecord('actor-b'), null, 'reading B wrote nothing for B');
});

test('awareness history: an account switch during a read files the result under the right account', async () => {
  const world = createWorld();
  const { store, env } = world;
  env.storage.set(store.featureAwarenessKey('virtual_try_on', 'actor-a'), JSON.stringify({ homeCardDismissed: true }));

  // A's read is in flight when B becomes the current account.
  env.readGate = deferred();
  const pending = store.loadFeatureAwareness('virtual_try_on');
  env.actorId = 'actor-b';
  const gate = env.readGate;
  env.readGate = null;
  gate.resolve();

  assert.equal(await pending, null, 'the read answers nothing to the account that is now current');
  assert.equal(store.getFeatureAwarenessNow('virtual_try_on'), null, "B does not inherit A's read");
  env.actorId = 'actor-a';
  assert.equal(store.getFeatureAwarenessNow('virtual_try_on').homeCardDismissed, true, 'A keeps it');
});

test('awareness history: monotonic, merged, bounded, and honest about unknown', async () => {
  const world = createWorld();
  const { store, env } = world;
  const key = store.featureAwarenessKey('virtual_try_on', 'actor-a');

  // A dismissal recorded BEFORE a slow read lands is not undone by it.
  env.storage.set(key, JSON.stringify({ initiated: true, cuePresentations: 1 }));
  await store.patchFeatureAwareness('virtual_try_on', { homeCardDismissed: true });
  const loaded = await store.loadFeatureAwareness('virtual_try_on');
  assert.deepEqual({ ...loaded }, {
    homeCardDismissed: true, initiated: true, completed: false, cueDismissed: false, cuePresentations: 1,
  });
  // Nothing ever moves backwards.
  await store.patchFeatureAwareness('virtual_try_on', { homeCardDismissed: false, initiated: false, cuePresentations: 0 });
  assert.equal(store.getFeatureAwarenessNow('virtual_try_on').homeCardDismissed, true);
  assert.equal(store.getFeatureAwarenessNow('virtual_try_on').cuePresentations, 1);
  assert.deepEqual(JSON.parse(env.storage.get(key)), { ...store.getFeatureAwarenessNow('virtual_try_on') });

  // A failed write still honours the dismissal for this session.
  const offline = createWorld();
  await offline.store.loadFeatureAwareness('virtual_try_on');
  offline.env.storageFails = true;
  assert.equal(await offline.store.patchFeatureAwareness('virtual_try_on', { cueDismissed: true }), false);
  assert.equal(offline.store.getFeatureAwarenessNow('virtual_try_on').cueDismissed, true);

  // Only a declared feature is accepted, and counts are clamped.
  assert.equal(await store.patchFeatureAwareness('closet', { initiated: true }), false);
  assert.equal(store.getFeatureAwarenessNow('closet'), null);
  await store.patchFeatureAwareness('virtual_try_on', { cuePresentations: 1e9 });
  assert.equal(store.getFeatureAwarenessNow('virtual_try_on').cuePresentations, 99);
  await store.patchFeatureAwareness('virtual_try_on', { cuePresentations: -5 });
  assert.equal(store.getFeatureAwarenessNow('virtual_try_on').cuePresentations, 99);
  assert.deepEqual([...store.FEATURE_AWARENESS_FEATURES], ['virtual_try_on']);
});

test('awareness history is device-local: no network client, no server table', () => {
  const store = stripComments(read(STORE));
  assert.doesNotMatch(store, /supabase|fetch\(|functions\.invoke|XMLHttpRequest/);
  assert.deepEqual(
    [...store.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort(),
    ['./actorContext', '@react-native-async-storage/async-storage'],
  );
  // The VTO modules themselves still hold no device storage.
  for (const rel of [DISCOVERY, AWARENESS, AWARENESS_HOOKS, CUE]) {
    assert.doesNotMatch(read(rel), /AsyncStorage|expo-file-system|SecureStore/, rel);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 7. The product control, rendered
// ════════════════════════════════════════════════════════════════════════════

function renderEntry(o = {}) {
  const world = createWorld(o);
  const renderer = createRenderer();
  const { availability, awarenessHooks } = world.hookModules(renderer.react);
  const calls = world.env.calls;
  // By default the gate is a stub that hands back `openUpgrade`. With
  // `realGate`, the REAL components/kplus/KPlusGate.tsx is rendered over the
  // REAL acquisition-surface resolver, with only the two sheets it can open
  // replaced by named hosts -- so "which sheet does Try It On open" is answered
  // by the shipped routing, not by the test.
  const gateModule = o.realGate
    ? runModule(
      GATE,
      {
        ...renderer.runtimeModules,
        '../../hooks/useKPlusEntitlement': { useKPlusEntitlement: world.useKPlusEntitlement },
        './KPlusEarlyAccessSheet': { KPlusEarlyAccessSheet: 'KPlusEarlyAccessSheet' },
        './KPlusMembershipSheet': { KPlusMembershipSheet: 'KPlusMembershipSheet' },
        '../../services/kplus/kplusTelemetry': {
          emitKPlusEvent: (event, payload) => { (world.env.kplusEvents ??= []).push({ event, ...payload }); },
        },
        '../../services/kplus/kplusAcquisitionSurface': runModule(
          ACQUISITION, {}, { jsx: false, mutate: world.mutationFor(ACQUISITION) },
        ),
        '../../types/entitlements': world.entitlements,
      },
      { mutate: world.mutationFor(GATE) },
    )
    : {
      KPlusGate: ({ children, source }) => {
        world.env.gateSource = source;
        return children({ openUpgrade: () => { calls.openUpgrade += 1; } });
      },
    };
  const entry = runModule(
    ENTRY,
    {
      ...renderer.runtimeModules,
      'react-native': createReactNativeStub(),
      '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SPACING: deepStub() },
      '../../services/haptics': { selectionTick: () => { calls.haptics += 1; } },
      '../kplus/KPlusGate': gateModule,
      '../../hooks/useVtoAvailability': availability,
      '../../hooks/useVtoAwareness': awarenessHooks,
      '../../hooks/useVtoLiveCapability': { useVtoLiveCapability: () => ({ kind: 'ai_photo_only' }) },
      '../../hooks/useVtoSessionStatus': { useVtoSessionStatus: () => ({ status: world.env.vtoStatus }) },
      '../../services/vto/vtoAwareness': world.awareness,
      '../../services/vto/vtoDiscovery': world.discovery,
      '../../services/vto/vtoTelemetry': world.telemetry,
      './VirtualTryOnSheet': { VirtualTryOnSheet: 'VirtualTryOnSheet' },
      './VtoFirstUseCue': { VtoFirstUseCue: 'VtoFirstUseCue' },
      './VtoMinimizedPill': { VtoMinimizedPill: 'VtoMinimizedPill' },
    },
    { mutate: o.mutate ? o.mutate[ENTRY] : undefined },
  );
  const props = {
    garment: o.garment ?? ELIGIBLE_GARMENT,
    garmentTitle: 'Silk Slip Dress',
    surface: o.surface,
    firstUseEducation: o.firstUseEducation,
    testID: 'entry',
  };
  let tree = null;
  const api = {
    world,
    async render() {
      tree = renderer.render(renderer.jsx(entry.TryItOnEntry, props, 'card'));
      await settle();
      tree = renderer.render(renderer.jsx(entry.TryItOnEntry, props, 'card'));
      return tree;
    },
    get tree() { return tree; },
    host: (testID) => byTestId(tree, testID).filter((node) => typeof node.type === 'string'),
    ofType: (type) => findAll(tree, (node) => node.type === type),
    async press(testID) {
      api.host(testID)[0].props.onPress();
      await settle();
      return api.render();
    },
  };
  return api;
}

test('J3: active K+ opens the existing try-on sheet -- and nothing else happens', async () => {
  const ui = renderEntry({ kplus: ACTIVE, surface: 'scan_result' });
  await ui.render();
  assert.equal(ui.host('entry').length, 1);
  assert.equal(textContent(ui.tree), 'TRY IT ON');
  assert.equal(ui.host('entry')[0].props.accessibilityLabel, 'Try on Silk Slip Dress');
  assert.equal(ui.ofType('VirtualTryOnSheet').length, 0, 'the sheet is not mounted until asked for');

  await ui.press('entry');
  const sheets = ui.ofType('VirtualTryOnSheet');
  assert.equal(sheets.length, 1, 'the existing governed sheet -- consent and photo choice live inside it');
  assert.equal(sheets[0].props.garment.productRef, ELIGIBLE_GARMENT.productRef);
  assert.equal(ui.world.env.calls.openUpgrade, 0, 'an active member is never sent to the K+ sheet');
  assert.equal(ui.world.env.calls.functionInvocations, 0, 'opening the sheet starts no generation');
  assert.equal(ui.world.awareness.readVtoAwareness().initiated, true, 'which retires the Home card');
  assert.deepEqual(ui.world.eventsNamed('vto_awareness_tap'), [
    { event: 'vto_awareness_tap', surface: 'scan_result', actor_kplus_state: 'active' },
  ]);
});

test('J2: a Free actor reaches the ONE shared K+ surface -- no sheet, no generation', async () => {
  const ui = renderEntry({ kplus: FREE });
  await ui.render();
  assert.equal(ui.host('entry-upgrade').length, 1);
  assert.equal(ui.host('entry').length, 0);
  assert.equal(textContent(ui.tree), 'TRY IT ON · K+');
  assert.equal(ui.world.env.gateSource, 'vto', 'the shared K+ gate, with the bounded vto source');

  await ui.press('entry-upgrade');
  assert.equal(ui.world.env.calls.openUpgrade, 1);
  assert.equal(ui.ofType('VirtualTryOnSheet').length, 0, 'no try-on surface for a Free actor');
  assert.equal(ui.world.env.calls.functionInvocations, 0);
  assert.equal(ui.world.awareness.readVtoAwareness()?.initiated ?? false, false, 'asking about K+ is not using try-on');
  assert.deepEqual(ui.world.eventsNamed('vto_awareness_tap'), [
    { event: 'vto_awareness_tap', surface: 'product', actor_kplus_state: 'free' },
  ]);
});

test('J5/J6/J13: resolving, ineligible and signed-out all render nothing at all', async () => {
  for (const [label, options, tweak] of [
    ['K+ resolving', { kplus: RESOLVING }],
    ['K+ unreadable', { kplus: UNREADABLE }],
    ['ineligible item', { garment: INELIGIBLE_GARMENT }],
    ['feature off', { row: { schemaVersion: 1, enabled: false } }],
    ['signed out', {}, (env) => { env.authenticated = false; }],
  ]) {
    const ui = renderEntry(options);
    if (tweak) tweak(ui.world.env);
    await ui.render();
    assert.equal(textContent(ui.tree), '', `${label}: no control text`);
    assert.equal(findAll(ui.tree, (node) => typeof node.type === 'string').length, 0, `${label}: no host element`);
    assert.equal(ui.world.eventsNamed('vto_awareness_impression').length, 0, `${label}: nothing was promoted`);
  }
});

test('the first-use cue is opt-in per host, and only the shipped scan surface opts in', async () => {
  const plain = renderEntry({ kplus: ACTIVE });
  await plain.render();
  assert.equal(plain.ofType('VtoFirstUseCue').length, 0, 'off unless the host asks for it');

  const taught = renderEntry({ kplus: ACTIVE, firstUseEducation: true });
  await taught.render();
  const cue = taught.ofType('VtoFirstUseCue');
  assert.equal(cue.length, 1);
  assert.equal(cue[0].props.cta, 'try_it_on');
  // The cue's action IS the control's action -- the same handler.
  assert.equal(cue[0].props.onTry, taught.host('entry')[0].props.onPress);

  const panel = stripComments(read(PANEL));
  assert.match(panel, /<TryItOnEntry[\s\S]*?surface="scan_result"[\s\S]*?firstUseEducation[\s\S]*?\/>/);
  assert.match(panel, /useVtoAwarenessBlocker\(!!watchCandidate\);/, 'the host declares its own modal');
  // ProductShelf belongs to the unmerged Commerce lane (#457): untouched here.
  const shelf = stripComments(read('components/ProductShelf.tsx'));
  assert.doesNotMatch(shelf, /firstUseEducation|useVtoAwarenessBlocker|surface="/);
});

test('product impressions are counted once per surface per session, not once per card', async () => {
  const ui = renderEntry({ kplus: ACTIVE, surface: 'scan_result' });
  await ui.render();
  for (let i = 0; i < 9; i += 1) {
    ui.world.awareness.emitVtoAwarenessImpression({ surface: 'scan_result', kplus: 'active' });
  }
  assert.deepEqual(ui.world.eventsNamed('vto_awareness_impression'), [
    { event: 'vto_awareness_impression', surface: 'scan_result', actor_kplus_state: 'active' },
  ]);
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Awareness starts nothing: no generation, no camera, no photo chooser
// ════════════════════════════════════════════════════════════════════════════

/** Every module that makes Try It On visible without being the try-on itself. */
const AWARENESS_MODULES = [DISCOVERY, AWARENESS, STORE, AWARENESS_HOOKS, CUE, HOME_CARD];

const GENERATION_REACH = [
  /vtoClient/, /vtoRequestStore/, /useVirtualTryOn\b/, /requestVtoGeneration/, /startVtoGeneration/,
  /\.generate\(/, /\.retry\(/, /functions\.invoke/, /\bfetch\(/, /supabaseClient/, /vto-generate/,
  /tryon-clothes/, /scan-identify/, /stylechat/i,
];
const HARDWARE_REACH = [
  /expo-image-picker/, /expo-camera/, /launchImageLibraryAsync/, /launchCameraAsync/,
  /requestCameraPermissionsAsync/, /requestMediaLibraryPermissionsAsync/, /useCameraPermissions/,
  /pickVtoPersonInput/, /vtoPersonInput/, /selectPerson/, /adoptPerson/, /vtoLiveCameraPermission/,
];

function checkNoReach(patterns, what, sources = {}) {
  for (const rel of AWARENESS_MODULES) {
    const source = stripComments(sources[rel] ?? read(rel));
    for (const pattern of patterns) {
      assert.doesNotMatch(source, pattern, `${rel} must not reach ${what} (${pattern})`);
    }
  }
}

test('awareness cannot start a generation', () => {
  checkNoReach(GENERATION_REACH, 'the generation path');
});

test('NC-05: an awareness surface that starts a generation is caught', async () => {
  const mutated = mutateOpt(
    HOME_CARD,
    "    router.push('/scan');",
    "    void require('../../services/vto/vtoClient').requestVtoGeneration({});\n    router.push('/scan');",
  )(read(HOME_CARD));
  await expectRed(() => checkNoReach(GENERATION_REACH, 'the generation path', { [HOME_CARD]: mutated }), 'Home card generates');
  const cue = mutateOpt(CUE, '    onTry();', '    void vto.generate();\n    onTry();')(read(CUE));
  await expectRed(() => checkNoReach(GENERATION_REACH, 'the generation path', { [CUE]: cue }), 'cue generates');
});

test('awareness cannot open a camera or a photo chooser', () => {
  checkNoReach(HARDWARE_REACH, 'a camera or photo chooser');
  // The Home card's only navigation target is the Scanner landing.
  const card = stripComments(read(HOME_CARD));
  assert.deepEqual([...card.matchAll(/router\.(push|replace|navigate)\(([^)]*)\)/g)].map((m) => m[2]), ["'/scan'"]);
});

test('NC-06: an awareness surface that opens the photo chooser or camera is caught', async () => {
  const picker = mutateOpt(
    CUE,
    '    onTry();',
    "    void require('expo-image-picker').launchImageLibraryAsync({});\n    onTry();",
  )(read(CUE));
  await expectRed(() => checkNoReach(HARDWARE_REACH, 'a camera or photo chooser', { [CUE]: picker }), 'cue opens the picker');
  const camera = mutateOpt(
    HOME_CARD,
    "    router.push('/scan');",
    "    void require('expo-camera').Camera.requestCameraPermissionsAsync();",
  )(read(HOME_CARD));
  await expectRed(() => checkNoReach(HARDWARE_REACH, 'a camera or photo chooser', { [HOME_CARD]: camera }), 'Home card opens the camera');
});

/** NC-13: rendering awareness costs one shared config row and nothing else. */
async function checkAwarenessCostsNothing(o = {}) {
  const world = createWorld(o);
  const home = await world.mountHook((m) => m.awarenessHooks.useVtoHomeCard);
  assert.equal(home.current.visible, true);
  await withFakeTimers(world, async () => {
    const cues = [];
    for (let i = 0; i < 10; i += 1) cues.push(await mountCue(world));
    for (const cue of cues) await cue.elapse(DWELL);
  });
  for (let i = 0; i < 10; i += 1) await world.productCta(ELIGIBLE_GARMENT);

  assert.equal(world.env.calls.functionInvocations, 0, 'PROVIDER_CALLS=0, MODEL_CALLS=0, PAID_GENERATIONS=0');
  assert.equal(world.env.calls.configReads, 1, 'one shared, memoized config row for the whole screen');
  const allowed = new Set(['vto_awareness_impression', 'vto_awareness_tap', 'vto_awareness_dismissed']);
  for (const entry of world.env.events) {
    assert.ok(allowed.has(entry.event), `awareness emitted a non-awareness event: ${entry.event}`);
  }
}

test('awareness rendering adds no provider, model or paid-generation work', () => checkAwarenessCostsNothing());

test('NC-13: awareness that introduces network or generation work is caught', async () => {
  // A per-surface config fan-out: every awareness surface issues its own read.
  await expectRed(
    () => checkAwarenessCostsNothing({
      mutate: {
        [FEATURE_CONTROL]: mutateOpt(
          FEATURE_CONTROL,
          '  if (memo && memo.expiresAt > now) return memo.value;\n  if (inFlight) return inFlight;\n',
          '',
        ),
      },
    }),
    'awareness config fan-out',
  );
  // An awareness module that calls out on its own.
  const generating = mutateOpt(
    AWARENESS,
    '  void patchFeatureAwareness(FEATURE, { homeCardDismissed: true });',
    "  void patchFeatureAwareness(FEATURE, { homeCardDismissed: true });\n  void fetch('https://example.test/vto-generate');",
  )(read(AWARENESS));
  await expectRed(() => checkNoReach(GENERATION_REACH, 'the generation path', { [AWARENESS]: generating }), 'awareness calls out');
});

// ════════════════════════════════════════════════════════════════════════════
// 9. No second eligibility, entitlement or mode authority
// ════════════════════════════════════════════════════════════════════════════

const PRESENTATION_MODULES = [DISCOVERY, AWARENESS, AWARENESS_HOOKS, CUE, HOME_CARD, ENTRY, PANEL];

const CATEGORY_LOGIC = [
  /['"`](top|tops|outerwear|blazer|dress|dresses|pants|skirt|jumpsuit|footwear|bag|accessory|bottom|full_body)['"`]/i,
  /supportedCategories/, /DEFAULT_VTO_SUPPORTED_CATEGORIES/, /toCanonicalVtoCategory/, /resolveVtoGarmentSlot/,
  /evaluateVtoEligibility/, /category\s*(===|!==|==|!=)/, /\.category\s*\.\s*(includes|match|test|startsWith)/,
  /unsupported_category/,
];
const ENTITLEMENT_LOGIC = [
  /has_active_k_plus/, /get_my_kplus_entitlement_summary/, /revenuecat/i, /Purchases\./, /kplusClient/,
  /kplusEntitlementStore/, /entitlement_required/, /\bquota\b/i, /dailyLimit|perDay|per_day|10 per day/i,
  /provider\s*[:=]/, /ailabtools|rapidapi/i,
];

function checkNoDuplicatedAuthority(sources = {}) {
  for (const rel of PRESENTATION_MODULES) {
    const source = stripComments(sources[rel] ?? read(rel));
    for (const pattern of CATEGORY_LOGIC) {
      assert.doesNotMatch(source, pattern, `${rel} re-derives garment eligibility (${pattern})`);
    }
    if (rel === PANEL) continue; // the panel also hosts Watch, which has its own K+ copy
    for (const pattern of ENTITLEMENT_LOGIC) {
      assert.doesNotMatch(source, pattern, `${rel} re-derives entitlement, quota or provider (${pattern})`);
    }
  }
  // Exactly one module evaluates eligibility for the UI, and the discovery
  // model is not it: it has no imports at all.
  const discovery = stripComments(sources[DISCOVERY] ?? read(DISCOVERY));
  assert.deepEqual([...discovery.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]), [], `${DISCOVERY} must stay import-free`);
}

test('no eligibility, entitlement, quota or provider logic exists in the presentation layer', () => {
  checkNoDuplicatedAuthority();
});

test('NC-09: garment eligibility duplicated in presentation code is caught', async () => {
  const entry = mutateOpt(
    ENTRY,
    "  if (cta === 'none') return null;",
    "  if (garment.category === 'dress' || garment.category === 'top') return null;\n  if (cta === 'none') return null;",
  )(read(ENTRY));
  await expectRed(() => checkNoDuplicatedAuthority({ [ENTRY]: entry }), 'category rule in the entry');
  const model = mutateOpt(
    DISCOVERY,
    'export type VtoProductCta',
    "const PROMOTABLE = ['dress', 'outerwear'];\nexport type VtoProductCta",
  )(read(DISCOVERY));
  await expectRed(() => checkNoDuplicatedAuthority({ [DISCOVERY]: model }), 'category list in the model');
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Telemetry: surface attribution, bounded, content-free
// ════════════════════════════════════════════════════════════════════════════

/** NC-12: nothing but closed-set values survives the awareness properties. */
function checkTelemetryIsBounded(o = {}) {
  const world = createWorld(o);
  const { telemetry, discovery, env } = world;
  assert.deepEqual([...telemetry.VTO_BOUNDED_PROPERTY_VALUES.surface], [...discovery.VTO_AWARENESS_SURFACES]);
  assert.deepEqual([...telemetry.VTO_BOUNDED_PROPERTY_VALUES.actor_kplus_state], [...discovery.VTO_ACTOR_KPLUS_STATES]);
  assert.deepEqual([...discovery.VTO_AWARENESS_SURFACES], [
    'kplus_step6', 'home', 'coachmark', 'product', 'scan_result', 'commerce',
  ]);

  // The property vocabulary is closed and names no content. Adding a
  // dimension is a deliberate edit to this list as well as to the sink.
  assert.deepEqual([...telemetry.VTO_EVENT_PROPERTIES].sort(), [
    'actor_kplus_state', 'category', 'eligibility', 'failureCode', 'inputBucket', 'latencyMs', 'mode',
    'origin', 'outputBucket', 'provider', 'retryCount', 'slot', 'surface',
  ]);

  telemetry.emitVtoEvent('vto_awareness_impression', { surface: 'home', actor_kplus_state: 'free' });
  assert.deepEqual(env.events.at(-1), { event: 'vto_awareness_impression', surface: 'home', actor_kplus_state: 'free' });

  const hostile = {
    surface: 'data:image/jpeg;base64,/9j/4AAQSkZJRg',
    actor_kplus_state: 'user-7f3a2c1e-uuid',
    image: 'data:image/png;base64,AAAA',
    photo: 'file:///private/var/person.jpg',
    resultImage: 'data:image/png;base64,BBBB',
    productUrl: 'https://www.retailer.com/product/123',
    providerResponse: { status: 'ok', output: ['https://signed.example/img'] },
    email: 'customer@example.com',
    text: 'I want to see this on me for my wedding',
    garmentTitle: 'Silk Slip Dress',
  };
  env.events.length = 0;
  telemetry.emitVtoEvent('vto_awareness_tap', hostile);
  assert.deepEqual(env.events, [{ event: 'vto_awareness_tap' }], 'every hostile value is dropped, key and all');

  // A safe-LOOKING string that is not a member of the set is dropped as well.
  for (const [key, value] of [['surface', 'settings'], ['surface', 'Home'], ['actor_kplus_state', 'paid'], ['surface', 7]]) {
    env.events.length = 0;
    telemetry.emitVtoEvent('vto_awareness_impression', { [key]: value });
    assert.deepEqual(env.events, [{ event: 'vto_awareness_impression' }], `${key}=${value} is outside the closed set`);
  }
  // And an event outside the vocabulary is not sent at all.
  env.events.length = 0;
  telemetry.emitVtoEvent('vto_awareness_photo', { surface: 'home' });
  assert.deepEqual(env.events, []);
}

test('awareness telemetry carries a bounded surface and K+ state, and nothing else', () => checkTelemetryIsBounded());

test('NC-12: telemetry that accepts image data, provider payloads or customer text is caught', async () => {
  await expectRed(
    () => checkTelemetryIsBounded({
      mutate: {
        [TELEMETRY]: (source) => source
          .split("      if (bounded && !(typeof scrubbed === 'string' && bounded.includes(scrubbed))) continue;\n").join('')
          .split('const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;').join('const SAFE_STRING = /^[\\s\\S]{1,4096}$/;'),
      },
    }),
    'unbounded telemetry',
  );
  await expectRed(
    () => checkTelemetryIsBounded({
      mutate: { [TELEMETRY]: mutateOpt(TELEMETRY, "  'actor_kplus_state',\n", "  'actor_kplus_state',\n  'productUrl',\n  'email',\n") },
    }),
    'content properties allowlisted',
  );
});

test('telemetry: every awareness surface is attributable, and existing events are untouched', () => {
  const { telemetry } = createWorld();
  const events = [...telemetry.VTO_EVENTS];
  for (const name of ['vto_awareness_impression', 'vto_awareness_tap', 'vto_awareness_dismissed']) {
    assert.ok(events.includes(name), name);
  }
  // The pre-existing vocabulary is still there, in order, unrenamed.
  for (const name of [
    'vto_entry_impression', 'vto_entry_tap', 'vto_person_selected', 'vto_request_start', 'vto_request_success',
    'vto_request_failure', 'vto_request_cancelled', 'vto_request_superseded', 'vto_retry',
    'vto_result_compare_toggle', 'vto_minimized', 'vto_restored', 'vto_result_save_opened', 'vto_mode_selected',
  ]) {
    assert.ok(events.includes(name), `${name} must survive`);
  }
  assert.equal(new Set(events).size, events.length, 'no duplicated event names');
  // Awareness modules emit ONLY the three awareness events.
  for (const rel of [AWARENESS, AWARENESS_HOOKS, CUE, HOME_CARD]) {
    const emitted = [...stripComments(read(rel)).matchAll(/emitVtoEvent\('([^']+)'/g)].map((m) => m[1]);
    for (const name of emitted) assert.match(name, /^vto_awareness_/, `${rel} emits ${name}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Copy: what the awareness layer may and may not say
// ════════════════════════════════════════════════════════════════════════════

const FORBIDDEN_CLAIMS = [
  /photo-?realistic/i, /\bexact(ly)?\b/i, /\bperfect/i, /\bfit\b/i, /\bfits\b/i, /\bsiz(e|ing)\b/i,
  /measure/i, /\bdrape\b/i, /body scan/i, /\bAR\b/, /augmented/i, /\baccura/i, /guarantee/i, /\brealistic/i,
  /\bper day\b/i, /\bdaily\b/i, /\b\d+\s+(try-ons|generations)\b/i, /\bnew\b/i, /\bdelete/i, /\bretain/i,
  /\btrain/i, /never stored/i, /\bavoid faces\b/i,
];

test('copy: awareness names the feature factually and claims nothing about fit or quality', () => {
  const { discovery } = createWorld();
  const copy = discovery.VTO_DISCOVERY_COPY;
  assert.equal(copy.title, 'Try it on with AI');
  assert.equal(copy.benefitBody, 'See how an eligible look might work on you before you buy.');
  assert.equal(copy.homeBody, 'Scan or open an eligible look to see it on you.');
  assert.equal(copy.cueBody, 'You can preview this look on a photo of yourself.');
  assert.equal(copy.cuePrimary, 'TRY IT ON');
  assert.equal(copy.cueDismiss, 'NOT NOW');
  for (const [key, value] of Object.entries(copy)) {
    for (const claim of FORBIDDEN_CLAIMS) {
      assert.doesNotMatch(value, claim, `VTO_DISCOVERY_COPY.${key} makes a claim it cannot support: "${value}"`);
    }
  }
  // "eligible" is load-bearing wherever the feature is introduced.
  assert.match(copy.benefitBody, /\beligible\b/);
  assert.match(copy.homeBody, /\beligible\b/);

  // The K+ benefit line is the same sentence, from the catalog.
  const catalog = runModule(CATALOG, {
    '../../constants/featureFlags': {
      VOICESCAN_ENABLED: true, VTO_UI_ENABLED: true, ELISE_CONCIERGE_V1: false, PACKING_INTELLIGENCE_V1: false,
    },
  }, { jsx: false });
  const vto = catalog.KPLUS_ACTIVATION_CAPABILITIES.find((capability) => capability.id === 'virtual_try_on');
  assert.equal(vto.title, copy.title);
  assert.equal(vto.description, copy.benefitBody);
  assert.ok(vto.description.length <= 60, 'still one scannable line');
});

test('copy: consent wording is NOT touched by this lane, and no surface restates it', () => {
  // The consent copy is counsel/owner-reviewed and digest-pinned by
  // __tests__/vtoThirdPartyConsent.test.js. Awareness adds no privacy or
  // retention sentence of its own.
  for (const rel of [DISCOVERY, CUE, HOME_CARD, AWARENESS_HOOKS, AWARENESS]) {
    const source = stripComments(read(rel));
    assert.doesNotMatch(source, /VTO_CONSENT_COPY|grantVtoConsent|recordThirdPartyAiConsent|vtoConsent/, rel);
    assert.doesNotMatch(source, /external AI service|privacy policy|metadata/i, `${rel} restates disclosure copy`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Every activation route still passes through consent and photo choice
// ════════════════════════════════════════════════════════════════════════════

test('routing: every awareness surface ends at the product control, and the control at the governed sheet', () => {
  const entry = stripComments(read(ENTRY));
  // One sheet, mounted only on an explicit tap of the control.
  assert.equal([...entry.matchAll(/<VirtualTryOnSheet/g)].length, 1);
  assert.match(entry, /\{sheetVisible \? \(\s*<VirtualTryOnSheet/);
  assert.equal([...entry.matchAll(/setSheetVisible\(true\)/g)].length, 1, 'one way to open it');
  // The cue calls the control's handler; it has no route of its own.
  assert.match(entry, /<VtoFirstUseCue cta=\{cta\} targetRef=\{controlRef\} onTry=\{openSheet\} \/>/);
  assert.match(entry, /<VtoFirstUseCue cta=\{cta\} targetRef=\{controlRef\} onTry=\{unlock\} \/>/);

  // The sheet still asks before it sends, and the store still refuses without proof.
  const sheet = stripComments(read('components/vto/VirtualTryOnSheet.tsx'));
  assert.match(sheet, /const requestGenerate = useCallback\(\(\) => \{\s*if \(hasVtoConsent\(\)\) \{\s*vto\.generate\(\);/);
  assert.match(sheet, /\{consentOpen \? <VtoConsentStep error=\{consentError\} \/> : null\}/);
  assert.match(stripComments(read('hooks/useVirtualTryOn.ts')), /consentGranted: hasVtoConsent\(\)/);

  // No awareness module mounts the sheet or the consent step itself.
  for (const rel of [CUE, HOME_CARD, AWARENESS_HOOKS, AWARENESS, DISCOVERY]) {
    assert.doesNotMatch(stripComments(read(rel)), /VirtualTryOnSheet|VtoConsentStep|<Modal/, rel);
  }
});

test('first-use cue: inline, accessible, and not a modal', () => {
  const source = stripComments(read(CUE));
  assert.doesNotMatch(source, /Modal|position:\s*'absolute'|zIndex|Animated/, 'not an overlay, nothing to stack or animate');
  assert.match(source, /accessibilityLiveRegion="polite"/);
  assert.match(source, /accessibilityRole="header"/);
  assert.equal([...source.matchAll(/accessibilityRole="button"/g)].length, 2, 'both actions are buttons');
  assert.match(source, /action:\s*\{[\s\S]*?minHeight: 44,[\s\S]*?minWidth: 44/);
  assert.doesNotMatch(source, /numberOfLines|allowFontScaling=\{false\}|maxFontSizeMultiplier/);
  assert.doesNotMatch(source, /Platform\.OS|ios|android/i, 'no platform-specific assumption');
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Quota exhaustion stays a governed message, never the paywall
// ════════════════════════════════════════════════════════════════════════════

test('J12: an active member who hits the limit gets the governed message, not an upgrade prompt', () => {
  const failures = runModule('services/vto/vtoFailures.ts', {
    '../../types/vto': runModule('types/vto.ts', {}, { jsx: false }),
  }, { jsx: false });
  const limited = failures.toVtoFailure('rate_limited');
  assert.equal(limited.code, 'rate_limited');
  assert.equal(limited.message, "You've reached the try-on limit for now. Try again later.");
  assert.doesNotMatch(limited.message, /K\+|upgrade|unlock|subscribe|\d/, 'no upsell and no hardcoded number');
  assert.notEqual(limited.message, failures.toVtoFailure('unknown').message, 'not a generic unexplained failure');

  // The sheet renders that message in place; nothing in it opens the K+ surface.
  const sheet = stripComments(read('components/vto/VirtualTryOnSheet.tsx'));
  assert.match(sheet, /body=\{vto\.failure\.message\}/);
  assert.doesNotMatch(sheet, /KPlusGate|KPlusEarlyAccessSheet|openUpgrade|KPlusMembershipStep/);
});

// ════════════════════════════════════════════════════════════════════════════
// 14. One icon, one upgrade seam, no new flag system
// ════════════════════════════════════════════════════════════════════════════

test('one canonical Try It On glyph, in the existing icon registry', () => {
  const registry = read('components/icons/kscan/KScanIcon.tsx');
  assert.equal([...registry.matchAll(/'try-on'\s*:/g)].length, 1);
  assert.match(read('components/icons/kscan/iconTypes.ts'), /\| 'try-on'/);
  assert.match(read(HOME_CARD), /<KScanIcon name="try-on"/);
  const glyph = stripComments(read('components/icons/kscan/TryOnIcon.tsx'));
  assert.match(glyph, /IconSvg/);
  assert.match(glyph, /strokeProps/);
  // No surface invents a second one.
  for (const rel of [CUE, ENTRY, PANEL]) {
    assert.doesNotMatch(stripComments(read(rel)), /react-native-svg|<Svg|\bEmoji\b/, rel);
  }
});

test('the Free-user seam is the existing shared K+ gate -- no VTO paywall, no pricing', () => {
  const entry = stripComments(read(ENTRY));
  assert.match(entry, /<KPlusGate source="vto">/);
  for (const rel of PRESENTATION_MODULES.concat([STORE])) {
    const source = stripComments(read(rel));
    assert.doesNotMatch(source, /KPlusMembershipStep|kplusPaywallModel|kplusCommerceService|purchaseKPlus|restoreKPlusPurchases|localizedPrice/, `${rel} builds its own acquisition`);
    assert.doesNotMatch(source, /[$€£¥]\s?\d|\/month|per month|free trial|\d+-day/i, `${rel} names a commercial term`);
  }
});

test('no new remote-config system: awareness reads the existing row through the existing reader', () => {
  const hooks = stripComments(read(AWARENESS_HOOKS));
  assert.match(hooks, /getVtoRemoteConfig\(\)/);
  assert.doesNotMatch(hooks, /app_config|supabase|\.from\(/, 'no second reader');
  const flags = read('constants/featureFlags.ts');
  assert.doesNotMatch(flags, /VTO_AWARENESS|VTO_DISCOVERY|VTO_COACHMARK|VTO_HOME_CARD/, 'no new build flag for awareness');
});

// ════════════════════════════════════════════════════════════════════════════
// FUNCTIONAL CLOSURE (FC-01, FC-03)
// ════════════════════════════════════════════════════════════════════════════
//
// Two repairs to the activation lane, each with its own negative control:
//
//   FC-01  A Free actor who taps Try It On reaches the PAID K+ membership
//          paywall (the Step 6 orchestrator, in a sheet) -- not the legacy
//          complimentary Early Access sheet.
//   FC-03  A collision DEFERS the first-use cue. It records nothing, so the
//          education is still owed on a later stable encounter.
//
// FC-02 (the promotion dimmer must not remove Step 6) and the sheet's own
// commercial proof live in __tests__/kplusPaywallPhaseD.test.js, next to the
// paywall harness they need.

// ── FC-01 ───────────────────────────────────────────────────────────────────

/** T1 + T2: Free + eligible -> the membership surface, and never Early Access. */
async function checkFreeUnlockReachesMembership(o = {}) {
  const ui = renderEntry({ ...o, kplus: FREE, realGate: true });
  await ui.render();
  assert.equal(ui.host('entry-upgrade').length, 1, 'the control is rendered for a Free actor on an eligible item');
  assert.equal(ui.host('entry-upgrade')[0].props.accessibilityHint, 'Opens K+ membership options');

  // Before the tap: exactly one K+ surface is mounted, closed, and it is the
  // membership one. The Early Access sheet is not in the tree at all.
  assert.equal(ui.ofType('KPlusEarlyAccessSheet').length, 0, 'the VTO path must not mount the Early Access sheet');
  assert.equal(ui.ofType('KPlusMembershipSheet').length, 1);
  assert.equal(ui.ofType('KPlusMembershipSheet')[0].props.visible, false);

  await ui.press('entry-upgrade');
  const membership = ui.ofType('KPlusMembershipSheet');
  assert.equal(membership.length, 1);
  assert.equal(membership[0].props.visible, true, 'Try It On opens the paid K+ membership surface');
  assert.equal(ui.ofType('KPlusEarlyAccessSheet').length, 0, 'and still never the Early Access sheet');
  assert.equal(ui.ofType('VirtualTryOnSheet').length, 0, 'a Free actor gets no try-on surface');
  assert.equal(ui.world.env.calls.functionInvocations, 0, 'and no generation');
  assert.deepEqual(ui.world.env.kplusEvents.filter((entry) => entry.event === 'kplus_feature_gate_opened'), [
    { event: 'kplus_feature_gate_opened', source: 'vto', feature: 'vto', entitlement_state: 'eligible' },
  ]);

  // Closing it returns to the product; nothing else was opened.
  membership[0].props.onClose();
  await ui.render();
  assert.equal(ui.ofType('KPlusMembershipSheet')[0].props.visible, false);
}

test('FC-01 T1/T2: a Free actor tapping Try It On reaches the paid K+ membership surface, not Early Access', () =>
  checkFreeUnlockReachesMembership());

test('NC-FC-01: routing VTO back to KPlusEarlyAccessSheet is caught', async () => {
  // The resolver sends the vto source to the legacy surface again.
  await expectRed(
    () => checkFreeUnlockReachesMembership({
      mutate: { [ACQUISITION]: mutateOpt(ACQUISITION, "Object.freeze(['vto'])", 'Object.freeze([])') },
    }),
    'resolver routes vto to Early Access',
  );
  // The gate ignores the resolver and always opens the legacy surface.
  await expectRed(
    () => checkFreeUnlockReachesMembership({
      mutate: { [GATE]: mutateOpt(GATE, "{surface === 'membership' ? (", "{surface === 'no-such-surface' ? (") },
    }),
    'gate always opens Early Access',
  );
});

test('FC-01: Early Access is not globally retired -- every other K+ gate still opens it', () => {
  const acquisition = runModule(ACQUISITION, {}, { jsx: false });
  assert.deepEqual([...acquisition.KPLUS_MEMBERSHIP_ACQUISITION_SOURCES], ['vto']);
  assert.equal(acquisition.resolveKPlusAcquisitionSurface('vto'), 'membership');
  const sources = runModule('types/kplusSource.ts', {}, { jsx: false }).KPLUS_SOURCES;
  for (const source of sources) {
    if (source === 'vto') continue;
    assert.equal(acquisition.resolveKPlusAcquisitionSurface(source), 'early_access', `${source} is unchanged`);
  }
  assert.equal(acquisition.resolveKPlusAcquisitionSurface('not-a-source'), 'early_access', 'an unknown source is not upgraded by accident');

  // The gate mounts exactly one surface per source, and the legacy component
  // and its file are still there, untouched in purpose.
  const gate = stripComments(read(GATE));
  assert.match(gate, /\{surface === 'membership' \? \(\s*<KPlusMembershipSheet visible=\{sheetVisible\} onClose=\{\(\) => setSheetVisible\(false\)\} \/>\s*\) : \(\s*<KPlusEarlyAccessSheet visible=\{sheetVisible\} onClose=\{\(\) => setSheetVisible\(false\)\} source=\{source\} \/>\s*\)\}/);
  assert.ok(fs.existsSync(path.join(ROOT, 'components/kplus/KPlusEarlyAccessSheet.tsx')));
  // No other gate consumer was edited to pass anything new.
  for (const rel of [
    'components/home/HomeVoiceScanPill.tsx',
    'components/text-scan/VoiceScanButton.tsx',
    'app/packing/index.tsx',
    'components/ProductShelf.tsx',
  ]) {
    assert.doesNotMatch(stripComments(read(rel)), /KPlusMembershipSheet|kplusAcquisitionSurface/, rel);
  }
});

/** T3 + T4: a member is never sent to acquisition. */
async function checkMembersBypassAcquisition(o = {}) {
  for (const [label, kplus] of [['active', ACTIVE], ['complimentary', COMPLIMENTARY]]) {
    const ui = renderEntry({ ...o, kplus, realGate: true });
    await ui.render();
    assert.equal(ui.host('entry').length, 1, `${label} K+ gets the direct control`);
    assert.equal(ui.host('entry-upgrade').length, 0);
    assert.equal(ui.ofType('KPlusMembershipSheet').length, 0, `${label} K+ mounts no acquisition surface`);
    assert.equal(ui.ofType('KPlusEarlyAccessSheet').length, 0);
    await ui.press('entry');
    assert.equal(ui.ofType('VirtualTryOnSheet').length, 1, `${label} K+ goes straight to the try-on flow`);
    assert.equal(ui.ofType('KPlusMembershipSheet').length, 0);
    assert.equal((ui.world.env.kplusEvents ?? []).length, 0, `${label} K+ never opens a K+ gate`);
  }
}

test('FC-01 T3/T4: active and complimentary K+ bypass acquisition entirely', () => checkMembersBypassAcquisition());

/** T5: an unknown K+ answer is not routed to paid acquisition. */
async function checkResolvingIsNotSentToAcquisition(o = {}) {
  for (const kplus of [RESOLVING, UNREADABLE]) {
    const ui = renderEntry({ ...o, kplus, realGate: true });
    await ui.render();
    assert.equal(ui.host('entry-upgrade').length, 0, `K+ '${kplus.state}' must not be offered an upgrade`);
    assert.equal(ui.host('entry').length, 0);
    assert.equal(ui.ofType('KPlusMembershipSheet').length, 0, `K+ '${kplus.state}' mounts no acquisition surface`);
    assert.equal(ui.ofType('KPlusEarlyAccessSheet').length, 0);
    assert.equal(findAll(ui.tree, (node) => typeof node.type === 'string').length, 0, 'nothing is rendered at all');
  }
}

test('FC-01 T5: resolving or unreadable K+ is never routed to paid acquisition', () =>
  checkResolvingIsNotSentToAcquisition());

test('NC-FC-04: treating resolving K+ as Free is caught', async () => {
  await expectRed(
    () => checkResolvingIsNotSentToAcquisition({
      mutate: {
        [AVAILABILITY_HOOK]: mutateOpt(
          AVAILABILITY_HOOK,
          'upgradeOpportunity: !eligibility.eligible && !loading && eligibleWithKPlus,',
          'upgradeOpportunity: !eligibility.eligible && eligibleWithKPlus,',
        ),
        [DISCOVERY]: mutateOpt(DISCOVERY, "  if (signal.loading) return 'UNRESOLVED';\n", ''),
      },
    }),
    'resolving K+ sent to acquisition',
  );
});

test('FC-01: the VTO modules carry no acquisition of their own -- the gate decides', () => {
  const entry = stripComments(read(ENTRY));
  assert.match(entry, /<KPlusGate source="vto">/, 'still the one shared gate, with the bounded source');
  assert.doesNotMatch(entry, /KPlusEarlyAccessSheet|KPlusMembershipSheet|KPlusMembershipStep|kplusAcquisitionSurface/, 'the entry names no K+ surface');
  assert.doesNotMatch(entry, /early access/i, 'no stale Early Access wording on the VTO path');
  // The membership sheet is an entry wrapper: it holds no commercial term.
  // (Its commercial behaviour is proven against the real paywall in
  // __tests__/kplusPaywallPhaseD.test.js.)
  assert.ok(fs.existsSync(path.join(ROOT, MEMBERSHIP_SHEET)));
});

// ── FC-03 ───────────────────────────────────────────────────────────────────

const coachmarkEvents = (world) => world.env.events.filter((entry) => entry.surface === 'coachmark');

/**
 * T13 + T14 + T17: a collision defers the cue without spending anything, and a
 * later stable encounter shows it.
 */
async function checkCollisionDefersWithoutSpending(o = {}) {
  const world = createWorld(o);
  await withFakeTimers(world, async () => {
    const release = world.awareness.acquireVtoAwarenessBlocker();
    const cue = await mountCue(world);
    await cue.elapse(DWELL * 2);

    // T13: hidden, and NOTHING was used up.
    assert.equal(cue.hook.current.visible, false, 'no cue during a collision');
    assert.equal(world.storedRecord(), null, 'a collision writes nothing to the account history');
    assert.equal(world.awareness.readVtoAwareness().cuePresentations, 0, 'it is not a presentation');
    assert.equal(world.awareness.readVtoAwareness().cueDismissed, false, 'it is not a dismissal');
    assert.equal(world.awareness.readVtoAwarenessSession().cueShown, false, "the session's one presentation is still available");
    // T17: no false impression, and no false dismissal either.
    assert.deepEqual(coachmarkEvents(world), [], 'a collision emits no awareness telemetry');
    assert.ok(activeTimers(world).length > 0, 'the control is still being watched: the education is still owed');

    // Not a queue: the collision clearing shows nothing.
    release();
    await cue.elapse(DWELL * 3);
    assert.equal(cue.hook.current.visible, false, 'nothing appears the moment the collision clears');
    assert.equal(world.storedRecord(), null);
    assert.deepEqual(coachmarkEvents(world), []);

    // T14: a later stable encounter (the control left the window and was
    // viewed again) shows the cue, judged from the top.
    world.env.rect = { ...OFFSCREEN };
    await cue.elapse(800);
    world.env.rect = { ...ONSCREEN };
    await cue.elapse(DWELL);
    assert.equal(cue.hook.current.visible, true, 'a later stable encounter shows the cue');
    assert.equal(world.storedRecord().cuePresentations, 1, 'and only NOW is a presentation counted');
    assert.deepEqual(coachmarkEvents(world), [
      { event: 'vto_awareness_impression', surface: 'coachmark', actor_kplus_state: 'active' },
    ]);
  });

  // The other kind of later encounter: a different product surface, in the
  // same session, after an earlier control was deferred.
  const other = createWorld(o);
  await withFakeTimers(other, async () => {
    const release = other.awareness.acquireVtoAwarenessBlocker();
    const first = await mountCue(other);
    await first.elapse(DWELL * 2);
    assert.equal(first.hook.current.visible, false);
    release();
    const second = await mountCue(other);
    await second.elapse(DWELL);
    assert.equal(second.hook.current.visible, true, 'a new eligible product, viewed stably, shows the cue');
    assert.equal(other.storedRecord().cuePresentations, 1);
  });

  // Every momentary collision behaves the same way -- none of them spends it.
  for (const [label, begin, end] of [
    ['a try-on request', (env) => { env.vtoStatus = 'generating'; }, (env) => { env.vtoStatus = 'idle'; }],
    ['a purchase', (env) => { env.commerceStatus = 'PURCHASING'; }, (env) => { env.commerceStatus = 'IDLE'; }],
  ]) {
    const again = createWorld(o);
    begin(again.env);
    await withFakeTimers(again, async () => {
      const cue = await mountCue(again);
      await cue.elapse(DWELL * 2);
      assert.equal(again.storedRecord(), null, `${label}: nothing recorded`);
      assert.equal(again.awareness.readVtoAwarenessSession().cueShown, false, label);
      end(again.env);
      await cue.hook.flush();
      again.env.rect = { ...OFFSCREEN };
      await cue.elapse(800);
      again.env.rect = { ...ONSCREEN };
      await cue.elapse(DWELL);
      assert.equal(cue.hook.current.visible, true, `${label}: a later stable encounter still shows the cue`);
    });
  }
}

test('FC-03 T13/T14/T17: a collision defers the cue, spends nothing, and a later stable encounter shows it', () =>
  checkCollisionDefersWithoutSpending());

test('NC-FC-03: a collision that marks the cue as spent is caught', async () => {
  // The collision is recorded as a presentation (history + session + telemetry).
  await expectRed(
    () => checkCollisionDefersWithoutSpending({
      mutate: {
        [AWARENESS_HOOKS]: mutateOpt(
          AWARENESS_HOOKS,
          '        if (vtoCueDecisionRecordsPresentation(decision)) {',
          "        if (vtoCueDecisionRecordsPresentation(decision) || decision.reason === 'collision') {",
        ),
      },
    }),
    'collision counted as a presentation',
  );
  // The collision is recorded as a dismissal.
  await expectRed(
    () => checkCollisionDefersWithoutSpending({
      mutate: {
        [AWARENESS_HOOKS]: mutateOpt(
          AWARENESS_HOOKS,
          "        moveEncounter({ type: 'viewed', decision });",
          "        if (decision.reason === 'collision') dismissVtoCue();\n        moveEncounter({ type: 'viewed', decision });",
        ),
      },
    }),
    'collision counted as a dismissal',
  );
  // A deferral that never ends: the later encounter is never evaluated.
  await expectRed(
    () => checkCollisionDefersWithoutSpending({
      mutate: {
        [DISCOVERY]: mutateOpt(
          DISCOVERY,
          "  if (event.type === 'left_window') return current === 'presented' ? 'presented' : 'watching';",
          "  if (event.type === 'left_window') return current;",
        ),
      },
    }),
    'deferral is permanent',
  );
});

test('FC-03: only a real presentation records anything', () => {
  const { discovery } = createWorld();
  const records = discovery.vtoCueDecisionRecordsPresentation;
  assert.equal(records({ show: true, reason: 'show' }), true);
  for (const reason of [
    'collision', 'not_viewed', 'dismissed', 'retired', 'already_used', 'shown_this_session',
    'pitched_at_step6', 'history_unknown', 'not_eligible', 'surface_unavailable',
  ]) {
    assert.equal(records({ show: false, reason }), false, `${reason} records nothing`);
  }
  // A malformed "show" with a refusal reason is not trusted either.
  assert.equal(records({ show: true, reason: 'collision' }), false);
  assert.deepEqual(
    ['watching', 'presented', 'deferred'].map((state) => discovery.advanceVtoCueEncounter(state, { type: 'left_window' })),
    ['watching', 'presented', 'watching'],
  );
  // The hook has exactly one place a presentation can be recorded.
  const hooks = stripComments(read(AWARENESS_HOOKS));
  assert.equal([...hooks.matchAll(/noteVtoCuePresented\(\)/g)].length, 1);
  assert.match(hooks, /if \(vtoCueDecisionRecordsPresentation\(decision\)\) \{\s*noteVtoCuePresented\(\);\s*emitVtoAwarenessImpression\(\{ surface: 'coachmark', kplus: live\.kplus \}\);\s*\}/);
});

test('FC-03 T15: an explicit "Not now" still suppresses the cue permanently', async () => {
  const storage = new Map();
  const world = createWorld({ storage });
  await withFakeTimers(world, async () => {
    const cue = await mountCue(world);
    await cue.elapse(DWELL);
    assert.equal(cue.hook.current.visible, true);
    cue.hook.current.dismiss();
    await cue.hook.flush();
    assert.equal(cue.hook.current.visible, false);
    assert.equal(world.storedRecord().cueDismissed, true);
    assert.deepEqual(coachmarkEvents(world).map((entry) => entry.event), ['vto_awareness_impression', 'vto_awareness_dismissed']);
    // Leaving and returning does NOT bring a dismissed cue back.
    world.env.rect = { ...OFFSCREEN };
    await cue.elapse(800);
    world.env.rect = { ...ONSCREEN };
    await cue.elapse(DWELL * 2);
    assert.equal(cue.hook.current.visible, false, 'dismissal is not a deferral');
    assert.equal(activeTimers(world).length, 0, 'a dismissed cue is no longer measured at all');
  });
  for (let launch = 0; launch < 3; launch += 1) {
    const relaunched = createWorld({ storage });
    await withFakeTimers(relaunched, async () => {
      const cue = await mountCue(relaunched);
      await cue.elapse(DWELL * 2);
      assert.equal(cue.hook.current.visible, false, `launch ${launch + 2}: still dismissed`);
    });
  }
});

test('FC-03 T16: real presentations still respect one-per-session and the two-session cap', async () => {
  const storage = new Map();

  // Session 1: shown once; a collision earlier in the session did not use it up.
  const first = createWorld({ storage });
  await withFakeTimers(first, async () => {
    const release = first.awareness.acquireVtoAwarenessBlocker();
    const deferred = await mountCue(first);
    await deferred.elapse(DWELL * 2);
    release();
    assert.equal(first.storedRecord(), null, 'the deferred view did not count toward the cap');

    const shown = await mountCue(first);
    await shown.elapse(DWELL);
    assert.equal(shown.hook.current.visible, true);
    assert.equal(first.storedRecord().cuePresentations, 1);

    const again = await mountCue(first);
    await again.elapse(DWELL * 3);
    assert.equal(again.hook.current.visible, false, 'one per session');
    assert.equal(first.storedRecord().cuePresentations, 1, 'and it is not counted twice');
  });

  // Session 2: shown once more -- the second and last valid exposure.
  const second = createWorld({ storage });
  await withFakeTimers(second, async () => {
    const cue = await mountCue(second);
    await cue.elapse(DWELL);
    assert.equal(cue.hook.current.visible, true);
    assert.equal(second.storedRecord().cuePresentations, 2);
  });

  // Session 3 and after: retired, reached through two REAL exposures.
  const third = createWorld({ storage });
  await withFakeTimers(third, async () => {
    const cue = await mountCue(third);
    await cue.elapse(DWELL * 3);
    assert.equal(cue.hook.current.visible, false, 'retired after the cap');
    assert.equal(activeTimers(third).length, 0);
    assert.equal(third.storedRecord().cuePresentations, 2);
  });
  assert.equal(
    [first, second, third].flatMap((world) => coachmarkEvents(world)).filter((entry) => entry.event === 'vto_awareness_impression').length,
    2,
    'exactly two impressions were ever reported -- one per real presentation',
  );
});
