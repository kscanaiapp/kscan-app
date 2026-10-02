// Deterministic harness for the K+ mobile entitlement store and reader.
//
// Loads services/kplus/kplusEntitlementStore.ts, kplusEntitlementReader.ts and
// types/kplusEntitlementContract.ts into ONE vm realm with:
//   - a controllable clock (Date.now() and `new Date()` follow it),
//   - fake timers that fire only when the test says so (no real-clock races),
//   - mockable reader / activation client / Supabase client.
//
// Nothing here touches the network, Supabase, or the device.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const STORE_PATH = path.join(ROOT, 'services', 'kplus', 'kplusEntitlementStore.ts');
const READER_PATH = path.join(ROOT, 'services', 'kplus', 'kplusEntitlementReader.ts');
const CONTRACT_PATH = path.join(ROOT, 'types', 'kplusEntitlementContract.ts');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function createClock(startIso = '2026-10-02T12:00:00.000Z') {
  return {
    now: Date.parse(startIso),
    advance(ms) { this.now += ms; },
    iso(deltaMs = 0) { return new Date(this.now + deltaMs).toISOString(); },
  };
}

function createFakeTimers(clock) {
  let seq = 0;
  const items = new Map();
  return {
    setTimeout(callback, ms) {
      const id = ++seq;
      items.set(id, { callback, due: clock.now + ms });
      return { id, unref() {} };
    },
    clearTimeout(handle) {
      if (handle) items.delete(handle.id);
    },
    /** Fires every timer whose time has come, oldest first. */
    runDue() {
      for (const [id, timer] of [...items].sort((a, b) => a[1].due - b[1].due)) {
        if (timer.due <= clock.now) {
          items.delete(id);
          timer.callback();
        }
      }
    },
    pending() { return items.size; },
    nextDelay() {
      const dues = [...items.values()].map((t) => t.due - clock.now);
      return dues.length ? Math.min(...dues) : null;
    },
  };
}

function makeFakeDate(clock) {
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }

    static now() { return clock.now; }
  };
}

function transpile(file, sourceOverride) {
  const source = sourceOverride ?? fs.readFileSync(file, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

/**
 * Builds one realm and returns { load(file, overrides), clock, timers }.
 * `mocks` maps an import specifier to the module object that should answer it.
 */
function createRealm({ clock = createClock(), mocks = {}, sources = {} } = {}) {
  const timers = createFakeTimers(clock);
  const sandbox = {
    console,
    Date: makeFakeDate(clock),
    setTimeout: (cb, ms) => timers.setTimeout(cb, ms),
    clearTimeout: (h) => timers.clearTimeout(h),
    Promise,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    Error,
    TextEncoder,
  };
  vm.createContext(sandbox);
  const cache = new Map();

  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    const code = transpile(file, sources[file]);
    const localRequire = (specifier) => {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
      if (specifier === '../../types/kplusEntitlementContract') return load(CONTRACT_PATH);
      throw new Error(`Unexpected import in ${path.basename(file)}: ${specifier}`);
    };
    const wrapper = vm.runInContext(`(function (exports, require, module) {${code}\n})`, sandbox, { filename: file });
    wrapper(mod.exports, localRequire, mod);
    return mod.exports;
  }

  return { load, clock, timers, sandbox };
}

// ── Summary builders (shapes the server returns) ──────────────────────────────

function summaryOf(clock, overrides = {}) {
  return {
    contractVersion: 1,
    entitlementKey: 'k_plus',
    access: 'k_plus',
    displaySource: 'complimentary',
    effectiveExpiresAt: clock.iso(30 * DAY),
    isOpenEnded: false,
    trialEndsAt: null,
    willRenew: null,
    store: null,
    billingState: null,
    complimentaryHistory: true,
    accountManagement: { storeManagementRelevant: false, managementStore: null },
    snapshotIssuedAt: clock.iso(),
    ...overrides,
  };
}

const build = {
  complimentary: (clock, days = 30, o = {}) => summaryOf(clock, { effectiveExpiresAt: clock.iso(days * DAY), ...o }),
  subscription: (clock, o = {}) => summaryOf(clock, {
    displaySource: 'subscription',
    effectiveExpiresAt: clock.iso(29 * DAY),
    willRenew: true,
    store: 'apple',
    billingState: 'normal',
    complimentaryHistory: false,
    accountManagement: { storeManagementRelevant: true, managementStore: 'apple' },
    ...o,
  }),
  trial: (clock, o = {}) => summaryOf(clock, {
    displaySource: 'trial',
    effectiveExpiresAt: clock.iso(7 * DAY),
    trialEndsAt: clock.iso(7 * DAY),
    willRenew: true,
    store: 'google',
    billingState: 'normal',
    complimentaryHistory: false,
    accountManagement: { storeManagementRelevant: true, managementStore: 'google' },
    ...o,
  }),
  lifetime: (clock, o = {}) => summaryOf(clock, {
    displaySource: 'lifetime',
    effectiveExpiresAt: null,
    isOpenEnded: true,
    complimentaryHistory: false,
    ...o,
  }),
  free: (clock, { history = false, ...o } = {}) => summaryOf(clock, {
    access: 'free',
    displaySource: null,
    effectiveExpiresAt: null,
    isOpenEnded: false,
    complimentaryHistory: history,
    ...o,
  }),
};

const resolved = (summary) => ({ status: 'resolved', summary });
const unavailable = (reason) => ({ status: 'unavailable', reason });
const SIGNED_OUT = { status: 'signed_out' };

/** A reader whose answers the test scripts. `next()` queues; `defer()` holds. */
function createReader() {
  const queue = [];
  const held = [];
  const reader = {
    calls: 0,
    readKPlusEntitlementSummary: () => {
      reader.calls += 1;
      if (queue.length) {
        const item = queue.shift();
        if (item instanceof Error) return Promise.reject(item);
        return Promise.resolve(item);
      }
      return new Promise((resolveFn) => held.push(resolveFn));
    },
    answer(...results) { queue.push(...results); },
    /** Resolves the oldest held (deferred) read. */
    release(result) { held.shift()(result); },
    heldCount() { return held.length; },
  };
  return reader;
}

function createActivationClient(result) {
  const client = {
    calls: 0,
    result,
    activateKPlusEarlyAccess: async () => {
      client.calls += 1;
      return client.result;
    },
  };
  return client;
}

/** Loads the store with scripted collaborators. */
function loadKPlusStore({ clock = createClock(), reader = createReader(), activation = createActivationClient({ ok: false, reason: 'request_failed' }), sources } = {}) {
  const realm = createRealm({
    clock,
    sources: sources ?? {},
    mocks: {
      './kplusClient': activation,
      './kplusEntitlementReader': reader,
    },
  });
  const store = realm.load(STORE_PATH);
  const contract = realm.load(CONTRACT_PATH);
  return { store, contract, clock, timers: realm.timers, reader, activation };
}

/** Loads the real reader against a scripted Supabase client. */
function loadKPlusReader({ client, sources }) {
  const realm = createRealm({ sources: sources ?? {}, mocks: { '../supabaseClient': { supabase: client } } });
  return { reader: realm.load(READER_PATH), contract: realm.load(CONTRACT_PATH) };
}

/** Lets already-resolved promise chains run. */
const flush = () => new Promise((resolveFn) => setImmediate(resolveFn));

module.exports = {
  ROOT, STORE_PATH, READER_PATH, CONTRACT_PATH,
  MINUTE, HOUR, DAY,
  createClock, createFakeTimers, createRealm,
  summaryOf, build, resolved, unavailable, SIGNED_OUT,
  createReader, createActivationClient,
  loadKPlusStore, loadKPlusReader, flush,
};
