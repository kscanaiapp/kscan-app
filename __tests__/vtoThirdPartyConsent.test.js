// VTO third-party AI consent: the gate between a customer's photo and an
// external AI service.
//
// THE DEFECT THIS FILE EXISTS TO KEEP FIXED. Virtual Try-On sends a photo the
// customer chose of themselves -- which may show their face or body -- through
// K Scan's server to an external AI vendor. Before this gate the only thing a
// customer saw was one passive sentence that disappeared once a photo was
// chosen, and the generic onboarding checkbox that names no provider and
// predates VTO. Nothing asked for permission at the moment the photo left the
// device, and nothing recorded that it had.
//
// Four kinds of assertion, and the difference matters:
//   - BEHAVIOURAL: the persistence service and the store backstop are EXECUTED
//     against fake device storage, a fake actor and a stubbed transport,
//     because "nothing is sent without consent" is a claim about what the code
//     does, not about what it says.
//   - STRUCTURAL: the sheet, the consent step and the hook are read as
//     comment-stripped source. This repo has no react-test-renderer; the
//     properties under test -- every action goes through the gate, exactly one
//     Modal -- are properties of the wiring.
//   - GOVERNANCE: the wording is pinned by digest so a wording change cannot
//     ship without bumping the consent version (and so re-asking every
//     customer), and every provider the server can call has a disclosure.
//   - NEGATIVE CONTROLS: each guard is proven able to FAIL by mutating the
//     source text it protects and re-running the very same checker.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that
// literal suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const FILES = {
  service: 'services/thirdPartyAiConsent.ts',
  consent: 'services/vto/vtoConsent.ts',
  store: 'services/vto/vtoRequestStore.ts',
  hook: 'hooks/useVirtualTryOn.ts',
  sheet: 'components/vto/VirtualTryOnSheet.tsx',
  step: 'components/vto/VtoConsentStep.tsx',
  providers: 'supabase/functions/vto-generate/providers/index.ts',
};

const FEATURE = 'virtual_try_on';
const VERSION = 'vto-third-party-v1';
const keyFor = (actorId, feature = FEATURE) => `kscan.thirdPartyAiConsent.v1:${feature}:${actorId}`;

// ── Harness ──────────────────────────────────────────────────────────────────

/** A missing file is reported as a missing FEATURE, not as an ENOENT stack. */
function read(relative) {
  const absolute = path.join(ROOT, relative);
  assert.ok(
    fs.existsSync(absolute),
    `${relative} does not exist -- the third-party AI consent gate is not implemented`,
  );
  return fs.readFileSync(absolute, 'utf8');
}

/** Source with comments removed. Absence checks must run against code, not
 *  prose: this project documents what it deliberately does NOT do. The regex
 *  keeps `://` so a URL in a string literal survives. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function loadFromSource(relative, source, requireMap = {}) {
  const filename = path.join(ROOT, relative);
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
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    Set,
    Map,
    Math,
    Date,
    JSON,
    Object,
    Array,
    Number,
    String,
    Promise,
    Error,
    RangeError,
    __DEV__: false,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

function loadModule(relative, requireMap = {}) {
  return loadFromSource(relative, read(relative), requireMap);
}

/** Drains the microtask queue so every await inside the code under test ran. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Applies a mutation and PROVES it applied: a control whose mutation silently
 *  did nothing would pass for the wrong reason. */
function mutate(source, pattern, replacement, expectedCount) {
  let count = 0;
  const mutated = source.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
  assert.equal(
    count,
    expectedCount,
    `mutation applied ${count} time(s), expected ${expectedCount}: the guard this control targets is not in the source`,
  );
  assert.notEqual(mutated, source);
  return mutated;
}

/** Runs an async or sync checker, returns the AssertionError it raised. */
async function observeFailure(checker) {
  try {
    await checker();
  } catch (error) {
    return error;
  }
  return null;
}

// ── Fakes for the persistence service ────────────────────────────────────────

function createFakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  const calls = { get: [], set: [], remove: [] };
  const fault = { get: null, set: null, remove: null };
  const hooks = { beforeGet: null, beforeSet: null };
  const storage = {
    async getItem(key) {
      calls.get.push(key);
      // Read BEFORE the hook, so a paused read models a read that raced ahead
      // of a write that lands later.
      const value = data.has(key) ? data.get(key) : null;
      if (hooks.beforeGet) await hooks.beforeGet(key);
      if (fault.get) throw fault.get;
      return value;
    },
    async setItem(key, value) {
      calls.set.push(key);
      if (hooks.beforeSet) await hooks.beforeSet(key, value);
      if (fault.set) throw fault.set;
      data.set(key, value);
    },
    async removeItem(key) {
      calls.remove.push(key);
      if (fault.remove) throw fault.remove;
      data.delete(key);
    },
  };
  return { storage, data, calls, fault, hooks };
}

function createFakeActor(initial = null) {
  let actorId = initial;
  let epoch = 0;
  return {
    module: { getActorContext: () => ({ actorId, epoch }) },
    setActor(next) {
      actorId = next;
      epoch += 1;
    },
  };
}

function serviceHarness(initialActor = 'actor-a', seed = {}, source = undefined) {
  const fake = createFakeStorage(seed);
  const actor = createFakeActor(initialActor);
  const requireMap = {
    '@react-native-async-storage/async-storage': fake.storage,
    './actorContext': actor.module,
  };
  const service = source === undefined
    ? loadModule(FILES.service, requireMap)
    : loadFromSource(FILES.service, source, requireMap);
  return { service, fake, actor };
}

/** The per-account isolation check, shared with negative control (d). */
async function assertPerActorIsolation(source) {
  const h = serviceHarness('actor-a', {}, source);
  assert.equal(await h.service.recordThirdPartyAiConsent(FEATURE, VERSION), true, 'account A can consent');
  h.actor.setActor('actor-b');
  assert.equal(
    h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION),
    false,
    "account B must not inherit account A's consent (synchronous check)",
  );
  assert.equal(
    await h.service.loadThirdPartyAiConsent(FEATURE, VERSION),
    false,
    "account B must not inherit account A's consent (storage load)",
  );
  assert.equal(await h.service.recordThirdPartyAiConsent(FEATURE, VERSION), true, 'account B can consent');
  assert.deepEqual(
    [...h.fake.data.keys()].sort(),
    [keyFor('actor-a'), keyFor('actor-b')],
    'each account has its own record under its own key',
  );
  h.actor.setActor('actor-a');
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), true, "A's consent survives B's visit");
  h.actor.setActor(null);
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false, 'a signed-out device has no consent');
}

// ── 1. Persistence service (BEHAVIOURAL) ─────────────────────────────────────

test('service: with no record there is no consent, however it is asked', async () => {
  const h = serviceHarness('actor-a');
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false);
  assert.equal(await h.service.loadThirdPartyAiConsent(FEATURE, VERSION), false);
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false);
});

test('service: consent is persisted first and only then visible to the synchronous check', async () => {
  const h = serviceHarness('actor-a');
  const gate = deferred();
  h.fake.hooks.beforeSet = () => gate.promise;

  const pending = h.service.recordThirdPartyAiConsent(FEATURE, VERSION, new Date('2026-09-24T12:00:00.000Z'));
  await flush();
  assert.equal(
    h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION),
    false,
    'not consented while the write is still in flight',
  );

  gate.resolve();
  assert.equal(await pending, true);
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), true);
  assert.deepEqual(JSON.parse(h.fake.data.get(keyFor('actor-a'))), {
    version: VERSION,
    grantedAt: '2026-09-24T12:00:00.000Z',
  });
});

test('service: a recorded consent is found again by a cold load (a new app session)', async () => {
  const first = serviceHarness('actor-a');
  await first.service.recordThirdPartyAiConsent(FEATURE, VERSION);

  // A fresh module instance with the same device storage: the in-memory cache is cold.
  const second = serviceHarness('actor-a', Object.fromEntries(first.fake.data));
  assert.equal(second.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false, 'cold cache is not consent');
  assert.equal(await second.service.loadThirdPartyAiConsent(FEATURE, VERSION), true);
  assert.equal(second.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), true, 'load warms the cache');
});

test('service: consent is per account -- actor B never sees actor A on the same device', async () => {
  await assertPerActorIsolation(read(FILES.service));
});

test('service: a record for another version is not consent (and a bump invalidates a warm cache)', async () => {
  const stale = serviceHarness('actor-a', {
    [keyFor('actor-a')]: JSON.stringify({ version: 'vto-third-party-v0', grantedAt: '2026-01-01T00:00:00.000Z' }),
  });
  assert.equal(await stale.service.loadThirdPartyAiConsent(FEATURE, VERSION), false);
  assert.equal(stale.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false);

  const warm = serviceHarness('actor-a');
  await warm.service.recordThirdPartyAiConsent(FEATURE, 'vto-third-party-v0');
  assert.equal(warm.service.hasThirdPartyAiConsentNow(FEATURE, 'vto-third-party-v0'), true);
  assert.equal(warm.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false, 'the new version was never accepted');
  assert.equal(await warm.service.loadThirdPartyAiConsent(FEATURE, VERSION), false);
  assert.equal(
    warm.service.hasThirdPartyAiConsentNow(FEATURE, 'vto-third-party-v0'),
    false,
    'a load that finds a different version clears the stale entry',
  );
});

test('service: corrupt storage fails closed and clears a warm cache', async () => {
  const corrupt = [
    ['not JSON', '{oops'],
    ['a JSON string', '"granted"'],
    ['null', 'null'],
    ['an array', '[]'],
    ['no grantedAt', JSON.stringify({ version: VERSION })],
    ['no version', JSON.stringify({ grantedAt: '2026-09-24T12:00:00.000Z' })],
    ['grantedAt not a date', JSON.stringify({ version: VERSION, grantedAt: 'yesterday' })],
  ];
  for (const [label, raw] of corrupt) {
    const h = serviceHarness('actor-a');
    await h.service.recordThirdPartyAiConsent(FEATURE, VERSION);
    assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), true, `${label}: precondition`);
    h.fake.data.set(keyFor('actor-a'), raw);
    assert.equal(await h.service.loadThirdPartyAiConsent(FEATURE, VERSION), false, `${label}: load`);
    assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false, `${label}: cache cleared`);
  }
});

test('service: a storage read error fails closed and clears a warm cache', async () => {
  const h = serviceHarness('actor-a');
  await h.service.recordThirdPartyAiConsent(FEATURE, VERSION);
  h.fake.fault.get = new Error('storage unavailable');
  assert.equal(await h.service.loadThirdPartyAiConsent(FEATURE, VERSION), false);
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false);
});

test('service: a failed write is not consent and leaves the cache untouched', async () => {
  const h = serviceHarness('actor-a');
  await h.service.recordThirdPartyAiConsent(FEATURE, 'vto-third-party-v0');
  h.fake.fault.set = new Error('disk full');
  assert.equal(await h.service.recordThirdPartyAiConsent(FEATURE, VERSION), false);
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false, 'the failed choice is not consent');
  assert.equal(
    h.service.hasThirdPartyAiConsentNow(FEATURE, 'vto-third-party-v0'),
    true,
    'and the cache was not touched',
  );
});

test('service: an account switch during the write never sets the cache for another account', async () => {
  const h = serviceHarness('actor-a');
  const gate = deferred();
  h.fake.hooks.beforeSet = () => gate.promise;

  const pending = h.service.recordThirdPartyAiConsent(FEATURE, VERSION);
  await flush();
  h.actor.setActor('actor-b');
  gate.resolve();

  assert.equal(await pending, false, 'the record is not applied to a session that is no longer the one that asked');
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false, 'actor B has no consent');

  h.actor.setActor('actor-a');
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false, 'and the cache was not set for A either');
  assert.equal(
    await h.service.loadThirdPartyAiConsent(FEATURE, VERSION),
    true,
    "A's tap was real: the record was persisted under A's key and A finds it on load",
  );
});

test('service: with no signed-in actor nothing is recorded, loaded or granted', async () => {
  const h = serviceHarness(null);
  assert.equal(await h.service.recordThirdPartyAiConsent(FEATURE, VERSION), false);
  assert.equal(h.fake.calls.set.length, 0, 'nothing written');
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false);
  assert.equal(await h.service.loadThirdPartyAiConsent(FEATURE, VERSION), false);
  assert.equal(h.fake.calls.get.length, 0, 'nothing read');
  assert.equal(await h.service.withdrawThirdPartyAiConsent(FEATURE), false);
  assert.equal(h.fake.calls.remove.length, 0);
});

test('service: withdraw removes the storage record and the cache, for that account only', async () => {
  const h = serviceHarness('actor-a');
  await h.service.recordThirdPartyAiConsent(FEATURE, VERSION);
  h.actor.setActor('actor-b');
  await h.service.recordThirdPartyAiConsent(FEATURE, VERSION);
  h.actor.setActor('actor-a');

  assert.equal(await h.service.withdrawThirdPartyAiConsent(FEATURE), true);
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false);
  assert.equal(h.fake.data.has(keyFor('actor-a')), false, "A's record is gone");
  assert.equal(await h.service.loadThirdPartyAiConsent(FEATURE, VERSION), false);

  h.actor.setActor('actor-b');
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), true, "B's consent is untouched");
});

test('service: the feature union is closed and the version must be a non-empty string', async () => {
  const h = serviceHarness('actor-a');
  for (const feature of ['virtual_tryon', 'scan', '', undefined, null, 42]) {
    assert.equal(await h.service.recordThirdPartyAiConsent(feature, VERSION), false, `record ${String(feature)}`);
    assert.equal(h.service.hasThirdPartyAiConsentNow(feature, VERSION), false, `has ${String(feature)}`);
    assert.equal(await h.service.loadThirdPartyAiConsent(feature, VERSION), false, `load ${String(feature)}`);
  }
  for (const version of ['', '   ', undefined, null, 7]) {
    assert.equal(await h.service.recordThirdPartyAiConsent(FEATURE, version), false, `record v=${String(version)}`);
    assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, version), false, `has v=${String(version)}`);
  }
  assert.equal(h.fake.calls.set.length, 0, 'nothing was ever written');
});

test('service: a read that started before a grant cannot erase the grant', async () => {
  const h = serviceHarness('actor-a');
  const gate = deferred();
  h.fake.hooks.beforeGet = () => gate.promise;
  const staleLoad = h.service.loadThirdPartyAiConsent(FEATURE, VERSION);
  await flush();

  h.fake.hooks.beforeGet = null;
  assert.equal(await h.service.recordThirdPartyAiConsent(FEATURE, VERSION), true);
  gate.resolve();

  assert.equal(await staleLoad, true, 'the load reports the newer truth, not the stale read');
  assert.equal(h.service.hasThirdPartyAiConsentNow(FEATURE, VERSION), true);
});

test('service: works against the shipping actorContext (signed out is fail-closed, ids are normalised)', async () => {
  const actorContext = loadModule('services/actorContext.js');
  const fake = createFakeStorage();
  const service = loadModule(FILES.service, {
    '@react-native-async-storage/async-storage': fake.storage,
    './actorContext': actorContext,
  });
  assert.equal(await service.recordThirdPartyAiConsent(FEATURE, VERSION), false, 'signed out');
  actorContext.advanceActorEpoch('user-1');
  assert.equal(await service.recordThirdPartyAiConsent(FEATURE, VERSION), true);
  actorContext.advanceActorEpoch(null);
  assert.equal(service.hasThirdPartyAiConsentNow(FEATURE, VERSION), false);
  actorContext.advanceActorEpoch('  user-1  ');
  assert.equal(service.hasThirdPartyAiConsentNow(FEATURE, VERSION), true, 'the same account returns');
});

test('service: stays a local, closed persistence seam (no network client, closed feature union)', () => {
  const source = read(FILES.service);
  const code = stripComments(source);
  const imported = [...code.matchAll(/from\s*'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    imported,
    ['./actorContext', '@react-native-async-storage/async-storage'],
    'the consent service persists a record and asks who is signed in -- nothing else',
  );
  assert.ok(!/supabase|fetch\(|XMLHttpRequest/.test(code), 'the consent record never leaves the device');
  assert.match(code, /export type ThirdPartyAiFeature = /);
  const service = loadModule(FILES.service, {
    '@react-native-async-storage/async-storage': createFakeStorage().storage,
    './actorContext': createFakeActor('actor-a').module,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(service.THIRD_PARTY_AI_FEATURES)), ['virtual_try_on']);
});

// ── 2. The VTO consent module (BEHAVIOURAL + GOVERNANCE) ─────────────────────

function consentModule(serviceStub = {}) {
  return loadModule(FILES.consent, { '../thirdPartyAiConsent': serviceStub });
}

test('vtoConsent: the wrappers bind the VTO feature and the current version', async () => {
  const calls = [];
  const consent = consentModule({
    hasThirdPartyAiConsentNow: (feature, version) => { calls.push(['has', feature, version]); return true; },
    loadThirdPartyAiConsent: async (feature, version) => { calls.push(['load', feature, version]); return true; },
    recordThirdPartyAiConsent: async (feature, version) => { calls.push(['record', feature, version]); return true; },
  });
  assert.equal(consent.VTO_CONSENT_FEATURE, 'virtual_try_on');
  assert.equal(consent.VTO_CONSENT_VERSION, 'vto-third-party-v1');
  assert.equal(consent.hasVtoConsent(), true);
  assert.equal(await consent.loadVtoConsent(), true);
  assert.equal(await consent.grantVtoConsent(), true);
  assert.deepEqual(calls, [
    ['has', 'virtual_try_on', 'vto-third-party-v1'],
    ['load', 'virtual_try_on', 'vto-third-party-v1'],
    ['record', 'virtual_try_on', 'vto-third-party-v1'],
  ]);
});

test('vtoConsent: the header states that the wording still needs legal review', () => {
  // Comment line wraps must not decide this: join the header into one line first.
  const source = read(FILES.consent).replace(/\s*\n\s*\*?\s*/g, ' ');
  assert.ok(
    source.includes('VTO_CONSENT_COPY_LEGAL_REVIEW_REQUIRED=YES'),
    'the mechanism ships now; the final wording is counsel/owner review and the file must say so',
  );
  assert.ok(/bump VTO_CONSENT_VERSION/i.test(source), 'and that any wording change must bump the version');
});

test('vtoConsent: the module is otherwise pure -- it imports only the persistence service', () => {
  const code = stripComments(read(FILES.consent));
  const imported = [...code.matchAll(/from\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imported, ['../thirdPartyAiConsent']);
});

// ── 3. Store backstop (BEHAVIOURAL, through the REAL default transport path) ─

const GARMENT = {
  productRef: 'prod_1',
  imageUrl: 'https://cdn.example.com/coat.jpg',
  category: 'wool coat',
  brand: 'Example',
  commerceSource: 'example',
};

const PERSON = {
  source: 'photo_library',
  sanitizedUri: 'file:///cache/person-a.jpg',
  width: 1024,
  height: 1280,
  metadataStripped: true,
  sanitizerVersion: 'test-1.0.0',
};

const TRANSPORT_SUCCESS = {
  ok: true,
  requestId: 'server-echo',
  provider: 'mock',
  dataUri: 'data:image/png;base64,AAAA',
  mediaType: 'image/png',
  width: 256,
  height: 320,
  latencyMs: 5,
};

function createStoreHarness(storeSource) {
  const transportCalls = [];
  const events = [];
  const released = [];
  const actorContext = loadModule('services/actorContext.js');
  const clientTypes = loadModule('types/vto.ts');
  const failures = loadModule('services/vto/vtoFailures.ts', { '../../types/vto': clientTypes });
  const eligibility = loadModule('services/vto/vtoEligibility.ts', { '../../types/vto': clientTypes });

  // The store's import list is EXACTLY these seven (VTO-NC-010). Consent is
  // deliberately not one of them: the backstop is a proof carried in options.
  const store = loadFromSource(FILES.store, storeSource, {
    '../actorContext': actorContext,
    '../../types/vto': clientTypes,
    './vtoClient': {
      // The REAL default transport, stubbed at the module boundary.
      requestVtoGeneration: (args) => {
        transportCalls.push(args);
        return Promise.resolve({ ...TRANSPORT_SUCCESS, requestId: args.requestId });
      },
    },
    './vtoEligibility': eligibility,
    './vtoFailures': failures,
    './vtoPersonInput': {
      buildVtoPersonPayload: (person) => Promise.resolve({
        ok: true,
        dataUri: 'data:image/jpeg;base64,AAAA',
        transientUri: `${person.sanitizedUri}.compressed`,
      }),
      releaseVtoPersonInput: (...uris) => {
        released.push(...uris);
        return Promise.resolve();
      },
    },
    './vtoTelemetry': {
      dimensionBucket: () => 'le1024',
      emitVtoEvent: (event, payload) => events.push({ event, payload }),
    },
  });
  actorContext.advanceActorEpoch('user-a');
  store.setVtoPersonInput(PERSON, GARMENT, 'commerce_product');
  return { store, transportCalls, events, released };
}

/** No consent proof, by every route into the real transport. */
async function runNoConsentScenario(storeSource) {
  const h = createStoreHarness(storeSource);
  const before = h.store.getVtoSnapshot();
  const intentBefore = h.store.__vtoStoreInternals.getIntentSequence();
  const eventsBefore = h.events.length;
  const base = { garment: GARMENT, origin: 'commerce_product' };

  await h.store.startVtoGeneration(base);
  await h.store.startVtoGeneration({ ...base, consentGranted: false });
  // A truthy value is not a proof: consent is exactly `true`.
  await h.store.startVtoGeneration({ ...base, consentGranted: 'yes' });
  await flush();
  const afterStart = {
    transportCalls: h.transportCalls.length,
    snapshotSame: h.store.getVtoSnapshot() === before,
  };

  await h.store.retryVtoGeneration(base);
  await flush();
  return {
    afterStart,
    transportCalls: h.transportCalls.length,
    snapshotSame: h.store.getVtoSnapshot() === before,
    intentSame: h.store.__vtoStoreInternals.getIntentSequence() === intentBefore,
    newEvents: h.events.slice(eventsBefore).map((e) => e.event),
  };
}

async function assertStoreRefusesWithoutConsent(storeSource) {
  const r = await runNoConsentScenario(storeSource);
  assert.equal(
    r.afterStart.transportCalls,
    0,
    'the real transport was reached without a consent proof: the start backstop is missing',
  );
  assert.equal(r.afterStart.snapshotSame, true, 'a refused start must not change any state');
  assert.equal(r.transportCalls, 0, 'the real transport was reached without a consent proof (retry)');
  assert.equal(r.snapshotSame, true, 'a refused retry must not advance any state (retryCount, status)');
  assert.equal(r.intentSame, true, 'a refused retry must not advance the intent sequence');
  assert.deepEqual(r.newEvents, [], 'a refused retry must not emit vto_retry or vto_request_start');
}

test('store: without a consent proof the real transport is never reached and nothing changes', async () => {
  await assertStoreRefusesWithoutConsent(read(FILES.store));
});

test('store: with a consent proof the real transport is called exactly once', async () => {
  const h = createStoreHarness(read(FILES.store));
  await h.store.startVtoGeneration({ garment: GARMENT, origin: 'commerce_product', consentGranted: true });
  await flush();
  assert.equal(h.transportCalls.length, 1);
  assert.equal(h.store.getVtoSnapshot().status, 'success');
  assert.equal(h.transportCalls[0].personDataUri, 'data:image/jpeg;base64,AAAA');
});

test('store: a retry with a consent proof is a new intent and reaches the transport once', async () => {
  const h = createStoreHarness(read(FILES.store));
  await h.store.startVtoGeneration({ garment: GARMENT, origin: 'commerce_product', consentGranted: true });
  await h.store.retryVtoGeneration({ garment: GARMENT, origin: 'commerce_product', consentGranted: true });
  await flush();
  assert.equal(h.transportCalls.length, 2, 'one start + one retry');
  assert.equal(h.store.getVtoSnapshot().retryCount, 1);
});

test('store: an injected transport path is unchanged (the backstop keys on the REAL transport)', async () => {
  const h = createStoreHarness(read(FILES.store));
  const injected = [];
  await h.store.startVtoGeneration({
    garment: GARMENT,
    origin: 'commerce_product',
    generate: (args) => {
      injected.push(args);
      return Promise.resolve(TRANSPORT_SUCCESS);
    },
  });
  await flush();
  assert.equal(injected.length, 1, 'the injected generate ran');
  assert.equal(h.transportCalls.length, 0, 'the real transport did not');
  assert.equal(h.store.getVtoSnapshot().status, 'success');
});

test('store: the guard sits before any state change in both entry points', () => {
  const code = stripComments(read(FILES.store));
  const guard = 'if (!options.generate && options.consentGranted !== true) return;';
  // [entry point, its first original statement, the first state change it makes]
  for (const [name, firstStatement, firstChange] of [
    ['startVtoGeneration', 'const current = snapshot;', 'invalidate()'],
    ['retryVtoGeneration', 'const current = getVtoSnapshot();', 'advanceIntent()'],
  ]) {
    const open = code.indexOf(`export async function ${name}(options: StartVtoOptions): Promise<void> {`);
    assert.ok(open >= 0, `${name} must exist with the StartVtoOptions signature`);
    const body = code.slice(open);
    const guardAt = body.indexOf(guard);
    const firstAt = body.indexOf(firstStatement);
    assert.ok(guardAt >= 0, `${name} must carry the consent backstop`);
    assert.ok(guardAt < firstAt, `${name}: the backstop must run before any state is read or changed`);
    assert.ok(body.indexOf(firstChange) > guardAt, `${name}: the backstop must run before ${firstChange}`);
  }
  assert.match(code, /consentGranted\?: boolean;/, 'StartVtoOptions carries the proof');
  const imports = [...code.matchAll(/from\s*'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    imports,
    ['../../types/vto', '../actorContext', './vtoClient', './vtoEligibility', './vtoFailures', './vtoPersonInput', './vtoTelemetry'],
    'the store gained no import: its harnesses and VTO-NC-010 list exactly these seven',
  );
});

// ── 4. Hook wiring (STRUCTURAL) ──────────────────────────────────────────────

function assertHookPassesProof(hookSource) {
  const code = stripComments(hookSource);
  assert.match(
    code,
    /import \{ hasVtoConsent \} from '\.\.\/services\/vto\/vtoConsent';/,
    'the hook reads the consent state through hasVtoConsent',
  );
  for (const name of ['generate', 'retry']) {
    const match = code.match(new RegExp(`const ${name} = useCallback\\(\\(\\) => \\{([\\s\\S]*?)\\n  \\}, \\[\\]\\);`));
    assert.ok(match, `${name} must remain a useCallback (pinned by vtoPrivacyAndWiring.test.js)`);
    assert.match(match[1], /consentGranted: hasVtoConsent\(\),/, `${name} must pass the consent proof to the store`);
  }
}

test('hook: generate and retry pass the synchronous consent proof to the store', () => {
  assertHookPassesProof(read(FILES.hook));
});

// ── 5. Sheet + step wiring (STRUCTURAL) ──────────────────────────────────────

function assertSheetGated(sheetSource) {
  const code = stripComments(sheetSource);
  const gates = {};
  for (const [name, action] of [['requestGenerate', 'generate'], ['requestRetry', 'retry']]) {
    const match = code.match(new RegExp(`const ${name} = useCallback\\(\\(\\) => \\{([\\s\\S]*?)\\n  \\}, \\[[^\\]]*\\]\\);`));
    assert.ok(match, `${name} must exist: it is the only door to vto.${action}`);
    assert.match(match[1], /if \(hasVtoConsent\(\)\) \{/, `${name} must check consent synchronously`);
    assert.ok(match[1].includes(`vto.${action}();`), `${name} must delegate to vto.${action}()`);
    gates[name] = match[1];
  }

  // Everything else -- every button, every handler -- must go through the gate.
  let rest = code;
  for (const body of Object.values(gates)) rest = rest.replace(body, '');
  const liveHandoff = /vto\.adoptPerson\(person\);\s*vto\.generate\(\);/;
  assert.match(rest, liveHandoff, 'the Live handoff literal is pinned by vtoLivePhotorealHandoff.test.js');
  rest = rest.replace(liveHandoff, '');
  const stray = rest.match(/vto\.(?:generate|retry)\b/g);
  assert.equal(
    stray,
    null,
    `a raw vto.generate/vto.retry reference bypasses the consent gate: ${JSON.stringify(stray)}`,
  );

  assert.match(
    code,
    /onPress=\{vto\.status === 'failed' \? requestRetry : requestGenerate\}/,
    'the primary action button goes through the gate',
  );
  assert.match(code, /title="Try again"\s+onPress=\{requestRetry\}/, 'the result "Try again" goes through the gate');
}

function assertConsentHandlers(sheetSource) {
  const code = stripComments(sheetSource);
  const cont = code.match(/const handleConsentContinue = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/);
  assert.ok(cont, 'handleConsentContinue must be an async useCallback');
  const body = cont[1];

  const grantAt = body.indexOf('await grantVtoConsent()');
  assert.ok(grantAt >= 0, 'Continue must await grantVtoConsent()');
  const runAt = Math.min(
    ...['requestGenerate(', 'requestRetry('].map((needle) => {
      const at = body.indexOf(needle);
      return at < 0 ? Infinity : at;
    }),
  );
  assert.ok(Number.isFinite(runAt), 'Continue must run the pending action');
  assert.ok(grantAt < runAt, 'the pending action may only run AFTER consent has been persisted');
  assert.ok(!/vto\.(?:generate|retry)\b/.test(body), 'Continue must go through the gate, not around it');

  const noticeAt = body.indexOf('setConsentError(VTO_CONSENT_COPY.persistFailure)');
  assert.ok(noticeAt >= 0, 'a failed save must show the persist-failure notice');
  const returnAt = body.indexOf('return;', noticeAt);
  assert.ok(returnAt > noticeAt && returnAt < runAt, 'a failed save must stay on the step and run nothing');

  const cancel = code.match(/const handleConsentCancel = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/);
  assert.ok(cancel, 'handleConsentCancel must exist');
  for (const forbidden of ['grantVtoConsent', 'requestGenerate', 'requestRetry', 'vto.generate', 'vto.retry']) {
    assert.ok(!cancel[1].includes(forbidden), `Cancel must not call ${forbidden}: nothing is sent, nothing is recorded`);
  }
}

/**
 * The guards that stop a photo being sent on the strength of a tap the customer has
 * walked back. Continue persists the choice ASYNCHRONOUSLY, so between the tap and the
 * save resolving the customer can press Cancel, remove the photo, or close the sheet;
 * `leaveVtoSurface` keeps the chosen photo, so without these guards the pending action
 * would still run and transmit it. Each guard below is a statement whose deletion the
 * behavioural checks in this file cannot see, hence a source assertion and a control.
 */
function assertConsentRaceGuards(sheetSource) {
  const code = stripComments(sheetSource);
  const cont = code.match(/const handleConsentContinue = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/);
  assert.ok(cont, 'handleConsentContinue must be an async useCallback');
  const body = cont[1];

  const reentry = body.match(/if \(pending === null \|\| consentInFlightRef\.current\) return;/);
  const grantAt = body.indexOf('await grantVtoConsent()');
  assert.ok(reentry && grantAt >= 0 && reentry.index < grantAt, 'Continue must refuse a second tap while a save is in flight');

  const stale = body.match(/if \(token !== consentTokenRef\.current\) return;/);
  const runAt = Math.min(
    ...['setConsentStep(null)', 'requestGenerate(', 'requestRetry('].map((needle) => {
      const at = body.indexOf(needle);
      return at < 0 ? Infinity : at;
    }),
  );
  assert.ok(
    stale && stale.index > grantAt && stale.index < runAt,
    'Continue must drop a save that resolves after Cancel, dismissal or close, BEFORE it runs anything',
  );

  const dismiss = code.match(/const dismissConsentStep = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/);
  assert.ok(dismiss, 'dismissConsentStep must exist');
  assert.match(dismiss[1], /consentTokenRef\.current \+= 1;/, 'dismissing the step must void a save that is still in flight');

  assert.match(
    code,
    /useEffect\(\(\) => \{\s*return \(\) => \{\s*consentTokenRef\.current \+= 1;\s*\};\s*\}, \[\]\);/,
    'closing the sheet must void a save that is still in flight',
  );

  const cancel = code.match(/const handleConsentCancel = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/);
  assert.ok(cancel, 'handleConsentCancel must exist');
  assert.match(cancel[1], /if \(consentInFlightRef\.current\) return;/, 'Cancel must not race a save that is in flight');
}

function assertSingleModal(sheetSource, stepSource) {
  const sheetModals = stripComments(sheetSource).match(/<Modal[\s>\/]/g) || [];
  assert.equal(
    sheetModals.length,
    1,
    `VirtualTryOnSheet must contain exactly one <Modal (found ${sheetModals.length}): a Modal shown over another Modal can be silently dropped on iOS`,
  );
  const stepCode = stripComments(stepSource);
  assert.equal(
    (stepCode.match(/<Modal[\s>\/]/g) || []).length,
    0,
    'VtoConsentStep must not render a <Modal: it renders INSIDE the sheet',
  );
  assert.ok(!/\bModal\b/.test(stepCode), 'VtoConsentStep must not even import Modal');
}

test('sheet: every generate/retry action goes through the consent gate', () => {
  assertSheetGated(read(FILES.sheet));
});

test('sheet: Continue awaits grantVtoConsent before running anything; Cancel calls neither', () => {
  assertConsentHandlers(read(FILES.sheet));
});

test('sheet: a Continue that is walked back (Cancel, photo removed, sheet closed) sends nothing', () => {
  assertConsentRaceGuards(read(FILES.sheet));
});

test('sheet: exactly one Modal in the sheet and none in the consent step', () => {
  assertSingleModal(read(FILES.sheet), read(FILES.step));
});

test('sheet: the step renders inside the ScrollView body; Continue/Cancel live in the actions row', () => {
  const code = stripComments(read(FILES.sheet));
  const scrollStart = code.indexOf('<ScrollView');
  const scrollEnd = code.indexOf('</ScrollView>');
  const stepAt = code.indexOf('<VtoConsentStep');
  assert.ok(scrollStart >= 0 && scrollEnd > scrollStart, 'the sheet body is a ScrollView');
  assert.ok(stepAt > scrollStart && stepAt < scrollEnd, 'the consent step renders INSIDE the ScrollView body');
  const actionsAt = code.indexOf('<View style={styles.actions}>');
  assert.ok(actionsAt > scrollEnd, 'the actions row follows the body');
  for (const id of ['vto-consent-continue', 'vto-consent-cancel']) {
    const at = code.indexOf(`testID="${id}"`);
    assert.ok(at > actionsAt, `${id} must live in the actions row`);
  }
  // The actions row is matched lazily up to its first </View> by vtoAiPhotoRegression.test.js:
  // it must stay a flat row of buttons.
  const row = code.match(/<View style=\{styles\.actions\}>[\s\S]*?<\/View>/)[0];
  assert.ok(row.includes('vto-consent-continue') && row.includes('vto-close'), 'no nested View inside the row');
});

test('sheet: a retry asked for from the result screen keeps its step open instead of going dead', () => {
  // Success is normally a state the step is NOT shown in (a result arrived, so
  // the step follows it away). A retry from that screen is the exception: if
  // consent is not visible by then, dismissing the step would turn "Try again"
  // into a button that silently does nothing.
  const code = stripComments(read(FILES.sheet));
  const match = code.match(/const consentOpen = ([\s\S]*?);\r?\n/);
  assert.ok(match, 'consentOpen must be derived in a single expression');
  assert.match(match[1], /vto\.status !== 'success' \|\| consentStep === 'retry'/);
  assert.match(match[1], /!isGenerating/, 'and it never opens over a running generation');
  assert.match(match[1], /!!vto\.person/, 'nor without a chosen photo');
});

test('sheet: only user handlers reach consent or generation -- no effect grants or generates', () => {
  const code = stripComments(read(FILES.sheet));
  const effects = code.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/g) || [];
  assert.ok(effects.length >= 8, 'expected the sheet effects to be found');
  let warmsCache = false;
  for (const effect of effects) {
    for (const forbidden of ['grantVtoConsent', 'requestGenerate', 'requestRetry', 'vto.generate', 'vto.retry']) {
      assert.ok(!effect.includes(forbidden), `an effect must never call ${forbidden}`);
    }
    if (effect.includes('loadVtoConsent()')) warmsCache = true;
  }
  assert.ok(warmsCache, 'the consent cache is warmed when the sheet becomes visible');
  assert.match(code, /if \(!visible\) return;\s*void loadVtoConsent\(\);/);
});

test('step: presentational -- header title, policy link, single source of copy, no gate logic', () => {
  const step = stripComments(read(FILES.step));
  assert.match(step, /accessibilityRole="header"/, 'the title is a header');
  assert.match(step, /accessibilityRole="link"/, 'the policy control is a link');
  assert.match(step, /openExternalUrl\(VTO_PRIVACY_POLICY_URL\)/, 'the link opens the exact policy URL through the guarded opener');
  assert.match(step, /Alert\.alert\(\s*'Privacy Policy unavailable'/, 'a link that cannot open says so');
  for (const key of ['title', 'intro', 'points', 'policyLinkLabel']) {
    assert.ok(step.includes(`VTO_CONSENT_COPY.${key}`), `the step renders VTO_CONSENT_COPY.${key}`);
  }
  assert.ok(!/AILabTools|RapidAPI/.test(step), 'provider names live only in VTO_PROVIDER_DISCLOSURES');
  assert.ok(
    !/AsyncStorage|grantVtoConsent|loadVtoConsent|hasVtoConsent/.test(step),
    'the step is presentational: no persistence and no gate logic',
  );
});

// ── 6. Copy (BEHAVIOURAL over the single source of copy) ─────────────────────

const FORBIDDEN_CLAIMS = [
  /not stored/i,
  /deleted immediately/i,
  /not retained/i,
  /never used for training/i,
  /not kept/i,
  /zero-knowledge/i,
  /anonymous/i,
  /never leaves/i,
  /face is blurred/i,
  // No specific retention period: this repo does not hold a contract that states one.
  /\b\d+\s*[- ]?(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i,
];

function copyStrings(copy) {
  return [copy.title, copy.intro, ...copy.points, copy.policyLinkLabel, copy.continueLabel, copy.continueA11yLabel, copy.cancelLabel, copy.persistFailure];
}

test('copy: the disclosure says exactly what the lead-approved neutral wording says', () => {
  const consent = consentModule();
  const copy = JSON.parse(JSON.stringify(consent.VTO_CONSENT_COPY));
  assert.equal(copy.title, 'Send your photo to an AI service?');
  assert.equal(
    copy.intro,
    'To create your try-on, K Scan AI sends the photo you chose, together with the product image, to an external AI service: AILabTools, through RapidAPI.',
  );
  assert.deepEqual(copy.points, [
    'Purpose: to generate an AI visualization of this item on your photo.',
    'Your photo may show your face or body. K Scan AI removes its metadata first, but does not blur or mask it.',
    'K Scan AI does not add your photo or the result to your Closet. How long the service keeps them is set by its own privacy policy.',
  ]);
  assert.equal(copy.policyLinkLabel, 'Read the K Scan AI Privacy Policy');
  assert.equal(copy.continueLabel, 'Continue');
  assert.equal(copy.continueA11yLabel, 'Continue and send my photo');
  assert.equal(copy.cancelLabel, 'Cancel');
  assert.equal(copy.persistFailure, 'We could not save your choice, so nothing was sent. Please try again.');
  assert.equal(consent.VTO_PRIVACY_POLICY_URL, 'https://kscan.app/legal/privacy');
});

test('copy: it says the photo is SENT, to whom, and why -- from the provider map', () => {
  const consent = consentModule();
  const copy = JSON.parse(JSON.stringify(consent.VTO_CONSENT_COPY));
  const disclosures = JSON.parse(JSON.stringify(consent.VTO_PROVIDER_DISCLOSURES));
  assert.match(copy.intro, /sends the photo you chose/);
  assert.match(copy.intro, /external AI service/);
  assert.match(copy.points[0], /^Purpose: /);
  for (const [id, { vendor, gateway }] of Object.entries(disclosures)) {
    assert.ok(copy.intro.includes(`${vendor}, through ${gateway}`), `the intro names ${id}'s vendor and gateway`);
  }
});

test('copy: adding a provider changes the copy (the intro is built from the map)', () => {
  const consent = consentModule();
  const one = consent.buildVtoConsentIntro({ a: { vendor: 'VendorA', gateway: 'GatewayA' } });
  const two = consent.buildVtoConsentIntro({
    a: { vendor: 'VendorA', gateway: 'GatewayA' },
    b: { vendor: 'VendorB', gateway: 'GatewayB' },
  });
  assert.notEqual(one, two);
  assert.ok(one.includes('VendorA, through GatewayA') && !one.includes('VendorB'));
  assert.ok(two.includes('VendorA, through GatewayA') && two.includes('VendorB, through GatewayB'));
});

test('copy: no unsupported retention, deletion, training or privacy-strength claim anywhere', () => {
  const consent = consentModule();
  const copy = JSON.parse(JSON.stringify(consent.VTO_CONSENT_COPY));
  const surfaces = [
    ['VTO_CONSENT_COPY', copyStrings(copy).join('\n')],
    ['VtoConsentStep.tsx', read(FILES.step)],
    ['VirtualTryOnSheet.tsx', read(FILES.sheet)],
  ];
  for (const [label, text] of surfaces) {
    for (const claim of FORBIDDEN_CLAIMS) {
      assert.ok(!claim.test(text), `${label} must not contain ${claim}`);
    }
  }
});

test('copy: the passive note keeps its metadata prefix, names the external service, drops the unsupported claim', () => {
  const sheet = stripComments(read(FILES.sheet));
  const match = sheet.match(/<Text style=\{styles\.privacyNote\}>([\s\S]*?)<\/Text>/);
  assert.ok(match, 'the passive privacy note must exist');
  const note = match[1].replace(/\s+/g, ' ').trim();
  assert.ok(note.startsWith('Your photo is stripped of its metadata'), 'prefix pinned by vtoAiPhotoRegression.test.js');
  assert.ok(note.includes('external AI service'), 'it names the kind of recipient');
  assert.ok(!note.includes('not kept afterwards'), 'the unsupported retention claim is gone');
  assert.ok(!note.includes('sent for this try-on only'), 'so is the unsupported "only"');
  assert.ok(note.includes('It is not added to your Closet.'), 'the supported statement remains');
});

// ── 7. Governance (digest pin + provider parity) ─────────────────────────────

/**
 * Append-only history: one digest per consent version. To change the wording,
 * the provider disclosures or anything else the customer is shown, BUMP
 * VTO_CONSENT_VERSION and ADD a new entry. An existing entry is never edited --
 * that is the entire point: an edited entry would mean customers who accepted
 * the old wording are treated as having accepted the new one.
 */
const PINNED_CONSENT_DIGESTS = Object.freeze({
  // v1 is introduced by this change and has never shipped, so its digest was still
  // being defined when the Privacy Policy URL joined the pinned parts.
  'vto-third-party-v1': '373b48449062ee00477fb94eb6bd7cc7b0fe81589c99945fc01ee71415589489',
});

function consentDigest({ version, copy, disclosures, privacyPolicyUrl }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ version, copy, disclosures, privacyPolicyUrl }))
    .digest('hex');
}

// Everything the customer is shown or linked to when they say yes. The policy URL
// is part of it: it is what "set by its own privacy policy" points at.
function consentParts(consent) {
  return {
    version: consent.VTO_CONSENT_VERSION,
    copy: consent.VTO_CONSENT_COPY,
    disclosures: consent.VTO_PROVIDER_DISCLOSURES,
    privacyPolicyUrl: consent.VTO_PRIVACY_POLICY_URL,
  };
}

function assertConsentDigestPinned(parts) {
  const pinned = PINNED_CONSENT_DIGESTS[parts.version];
  assert.ok(
    pinned,
    `VTO_CONSENT_VERSION "${parts.version}" has no pinned digest: add it to PINNED_CONSENT_DIGESTS in this file`,
  );
  assert.equal(
    consentDigest(parts),
    pinned,
    'The VTO consent wording (VTO_CONSENT_COPY), provider disclosures (VTO_PROVIDER_DISCLOSURES), Privacy Policy link (VTO_PRIVACY_POLICY_URL) or version changed. '
      + 'If this is intentional you MUST bump VTO_CONSENT_VERSION in services/vto/vtoConsent.ts so every customer who '
      + 'accepted the old wording is asked again, and then ADD the new version and its digest to PINNED_CONSENT_DIGESTS. '
      + 'Never edit an existing digest to make this pass.',
  );
}

test('governance: the consent wording, disclosures and version are pinned by digest', () => {
  assertConsentDigestPinned(consentParts(consentModule()));
});

/** Provider ids the Edge Function can actually call: everything providers/index.ts
 *  resolves except the development mock. Resolved from source, not hard-coded. */
function registeredNonMockProviderIds() {
  const indexCode = stripComments(read(FILES.providers));
  const identifiers = [...indexCode.matchAll(/selection\.providerId === (\w+)/g)]
    .map((match) => match[1])
    .filter((identifier) => identifier !== 'MOCK_VTO_PROVIDER_ID');
  assert.ok(identifiers.length > 0, 'providers/index.ts must register at least one real provider');
  const dir = path.join(ROOT, 'supabase', 'functions', 'vto-generate', 'providers');
  const sources = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));
  return identifiers.map((identifier) => {
    for (const source of sources) {
      const match = source.match(new RegExp(`export const ${identifier}\\s*=\\s*'([^']+)'`));
      if (match) return match[1];
    }
    return assert.fail(`could not resolve the provider id constant ${identifier}`);
  });
}

test('governance: every provider the server can call has a disclosure (and the map is well formed)', () => {
  const consent = consentModule();
  const disclosures = JSON.parse(JSON.stringify(consent.VTO_PROVIDER_DISCLOSURES));
  const registered = registeredNonMockProviderIds();
  assert.deepEqual(registered, ['ailabtools_tryon_clothes_pro'], 'the registry the disclosures must cover');
  for (const id of registered) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(disclosures, id),
      `provider "${id}" is registered on the server but has no entry in VTO_PROVIDER_DISCLOSURES: `
        + 'customers would send their photo to a recipient the consent copy never named',
    );
  }
  assert.deepEqual(disclosures, { ailabtools_tryon_clothes_pro: { vendor: 'AILabTools', gateway: 'RapidAPI' } });
  for (const [id, entry] of Object.entries(disclosures)) {
    assert.ok(typeof entry.vendor === 'string' && entry.vendor.trim(), `${id}: vendor`);
    assert.ok(typeof entry.gateway === 'string' && entry.gateway.trim(), `${id}: gateway`);
  }
});

test('governance: the persistence service is deliberately NOT a VTO-owned path', () => {
  // VTO-NC-010 bans device storage in every enrolled VTO file, and "a try-on
  // persists nothing" must stay true of VTO surfaces. The consent record lives
  // in a shared service so that stays true, and the VTO scope guard does not
  // judge it as VTO code.
  const guard = require('../scripts/check-vto-live-integration-scope.js');
  assert.equal(guard.isVtoOwnedPath(FILES.service), false);
  assert.equal(guard.isVtoOwnedPath(FILES.consent), true);
  assert.equal(guard.isVtoOwnedPath(FILES.step), true);
  for (const dir of ['services/vto', 'components/vto']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const code = stripComments(read(`${dir}/${name}`));
      assert.ok(!/AsyncStorage|SecureStore/.test(code), `${dir}/${name} must not touch device storage`);
    }
  }
  assert.ok(!/AsyncStorage|SecureStore/.test(stripComments(read(FILES.hook))));
});

// ── 8. NEGATIVE CONTROLS: every guard is proven able to fail ─────────────────

const STORE_GUARD_LINE = /^[ \t]*if \(!options\.generate && options\.consentGranted !== true\) return;\r?\n/gm;

test('NEGATIVE CONTROL (a): deleting the store guard lets the real transport run without consent', async (t) => {
  const mutated = mutate(read(FILES.store), STORE_GUARD_LINE, '', 2);
  const failure = await observeFailure(() => assertStoreRefusesWithoutConsent(mutated));
  assert.ok(failure, 'the checker must REJECT a store with no consent guard');
  assert.match(failure.message, /real transport was reached without a consent proof/);
  t.diagnostic(`observed failure: ${failure.message}`);
});

test('NEGATIVE CONTROL (a2): deleting only the retry guard lets a refused retry advance state', async (t) => {
  const source = read(FILES.store);
  const retryStart = source.indexOf('export async function retryVtoGeneration');
  assert.ok(retryStart > 0, 'retryVtoGeneration must exist');
  const head = source.slice(0, retryStart);
  const tail = mutate(source.slice(retryStart), STORE_GUARD_LINE, '', 1);
  const failure = await observeFailure(() => assertStoreRefusesWithoutConsent(head + tail));
  assert.ok(failure, 'the checker must REJECT a retry that has no guard of its own');
  assert.match(failure.message, /refused retry must not advance/);
  t.diagnostic(`observed failure: ${failure.message}`);
});

test('NEGATIVE CONTROL (b): a sheet button that calls vto.generate directly is rejected by the gate check', async (t) => {
  const mutated = mutate(
    read(FILES.sheet),
    /onPress=\{vto\.status === 'failed' \? requestRetry : requestGenerate\}/g,
    "onPress={vto.status === 'failed' ? vto.retry : vto.generate}",
    1,
  );
  const failure = await observeFailure(() => assertSheetGated(mutated));
  assert.ok(failure, 'the checker must REJECT a button wired around the gate');
  assert.match(failure.message, /bypasses the consent gate/);
  t.diagnostic(`observed failure: ${failure.message}`);
});

test('NEGATIVE CONTROL (b2): a hook that stops passing the consent proof is rejected', async (t) => {
  const mutated = mutate(read(FILES.hook), /^[ \t]*consentGranted: hasVtoConsent\(\),\r?\n/gm, '', 2);
  const failure = await observeFailure(() => assertHookPassesProof(mutated));
  assert.ok(failure, 'the checker must REJECT a hook that omits the proof');
  assert.match(failure.message, /must pass the consent proof to the store/);
  t.diagnostic(`observed failure: ${failure.message}`);
});

test('NEGATIVE CONTROL (b3): Continue that generates before consent is persisted is rejected', async (t) => {
  const mutated = mutate(
    read(FILES.sheet),
    /await grantVtoConsent\(\)/g,
    'grantVtoConsent()',
    1,
  );
  const failure = await observeFailure(() => assertConsentHandlers(mutated));
  assert.ok(failure, 'the checker must REJECT a Continue that does not await the save');
  assert.match(failure.message, /Continue must await grantVtoConsent\(\)/);
  t.diagnostic(`observed failure: ${failure.message}`);
});

// Each race guard is deleted on its own; the checker must name exactly that guard.
const RACE_GUARD_MUTATIONS = [
  {
    label: 'the stale-save check after the await',
    pattern: /if \(token !== consentTokenRef\.current\) return;/g,
    replacement: '',
    expected: /BEFORE it runs anything/,
  },
  {
    label: 'the re-entry guard on a second Continue tap',
    pattern: /if \(pending === null \|\| consentInFlightRef\.current\) return;/g,
    replacement: 'if (pending === null) return;',
    expected: /refuse a second tap/,
  },
  {
    label: 'the token bump when the sheet unmounts',
    pattern: /return \(\) => \{\s*consentTokenRef\.current \+= 1;\s*\};/g,
    replacement: 'return () => {};',
    expected: /closing the sheet must void/,
  },
  {
    label: 'the token bump when the step is dismissed',
    pattern: /(const dismissConsentStep = useCallback\(\(\) => \{\s*)consentTokenRef\.current \+= 1;\s*/g,
    replacement: (_match, head) => head,
    expected: /dismissing the step must void/,
  },
  {
    label: 'the cancel-while-saving guard',
    pattern: /if \(consentInFlightRef\.current\) return;\s*dismissConsentStep\(\);/g,
    replacement: 'dismissConsentStep();',
    expected: /Cancel must not race/,
  },
];

for (const { label, pattern, replacement, expected } of RACE_GUARD_MUTATIONS) {
  test(`NEGATIVE CONTROL (b4): deleting ${label} lets a walked-back Continue send the photo, and is rejected`, async (t) => {
    const mutated = mutate(read(FILES.sheet), pattern, replacement, 1);
    const failure = await observeFailure(() => assertConsentRaceGuards(mutated));
    assert.ok(failure, `the checker must REJECT a sheet without ${label}`);
    assert.match(failure.message, expected);
    t.diagnostic(`observed failure: ${failure.message}`);
  });
}

test('NEGATIVE CONTROL (c): a second <Modal> in the consent step is rejected by the single-Modal check', async (t) => {
  const withModalInStep = `${read(FILES.step)}\n// mutated: a Modal inside the step\nexport const Broken = () => (<Modal visible transparent><View /></Modal>);\n`;
  const failureInStep = await observeFailure(() => assertSingleModal(read(FILES.sheet), withModalInStep));
  assert.ok(failureInStep, 'the checker must REJECT a Modal in the step');
  assert.match(failureInStep.message, /VtoConsentStep must not render a <Modal/);

  const withSecondSheetModal = `${read(FILES.sheet)}\nexport const Broken = () => (<Modal visible><View /></Modal>);\n`;
  const failureInSheet = await observeFailure(() => assertSingleModal(withSecondSheetModal, read(FILES.step)));
  assert.ok(failureInSheet, 'the checker must REJECT a second Modal in the sheet');
  assert.match(failureInSheet.message, /exactly one <Modal/);
  t.diagnostic(`observed failure (step): ${failureInStep.message}`);
  t.diagnostic(`observed failure (sheet): ${failureInSheet.message}`);
});

test('NEGATIVE CONTROL (d): dropping the actor from the storage and cache keys breaks isolation', async (t) => {
  const mutated = mutate(read(FILES.service), /:\$\{actorId\}/g, '', 2);
  const failure = await observeFailure(() => assertPerActorIsolation(mutated));
  assert.ok(failure, 'the checker must REJECT a service whose keys ignore the actor');
  assert.match(failure.message, /must not inherit account A's consent/);
  t.diagnostic(`observed failure: ${failure.message}`);
});

test('NEGATIVE CONTROL (e2): pointing the consent at another Privacy Policy without bumping the version breaks the digest pin', async (t) => {
  const parts = { ...consentParts(consentModule()), privacyPolicyUrl: 'https://example.invalid/privacy' };
  const failure = await observeFailure(() => assertConsentDigestPinned(parts));
  assert.ok(failure, 'the pin must REJECT a changed Privacy Policy URL under an unchanged version');
  assert.match(failure.message, /MUST bump VTO_CONSENT_VERSION/);
  t.diagnostic(`observed failure: ${failure.message.split('. ')[0]}.`);
});

test('NEGATIVE CONTROL (e): editing the wording without bumping the version breaks the digest pin', async (t) => {
  const consent = consentModule();
  const parts = JSON.parse(JSON.stringify(consentParts(consent)));
  parts.copy.points[2] = `${parts.copy.points[2]} `;
  const failure = await observeFailure(() => assertConsentDigestPinned(parts));
  assert.ok(failure, 'the pin must REJECT changed wording under an unchanged version');
  assert.match(failure.message, /MUST bump VTO_CONSENT_VERSION/);
  t.diagnostic(`observed failure: ${failure.message.split('. ')[0]}.`);
});
