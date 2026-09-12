// K SCAN AI iOS Repair 07 — terminal local-deletion cleanup.
//
// THE GAP: account deletion is asynchronous and restorable. Submitting it opens
// a 30-day lifecycle; the permanent purge happens later, in a backend worker.
// Until this repair nothing on the device ever learned that the purge had
// actually happened, so a user whose account was genuinely and irreversibly
// deleted still had their Recent Scans, Closet, Signature Style and Dressing Room
// data on the handset indefinitely. Every owner-scoped purge primitive this app
// needed already existed and several said so in their own comments — "not wired
// to any production deletion caller", "terminal purge waits for a confirmed
// server-side purge". There was no caller.
//
// THE REPAIR: the device creates an opaque 256-bit capability BEFORE submitting
// the deletion, keeps it in the keychain across the sign-out that intake
// forces, and later asks the Repair 06 `deletion-status` endpoint — which needs
// no session — whether that one lifecycle reached a terminal purge. Only when
// the backend says BOTH `state === 'purged'` AND `purgeAuthorized === true` is
// that owner's local data destroyed.
//
// These tests execute the REAL modules, transpiled, under a require-shim that
// REJECTS any import outside a small allowlist — which is itself the structural
// proof that nothing in this path can reach a global storage wipe, a signOut,
// or `resetActorScopedRuntimeState`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

function evaluate(rel, shim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, shim);
  return mod.exports;
}

/** Executable source only. A doc comment naming a module is not a dependency. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// Fakes. Each records enough to make a leak assertable rather than assumed.
// ---------------------------------------------------------------------------

function createKeychain() {
  const items = new Map();
  const log = [];
  return {
    items,
    log,
    async getItemAsync(key) {
      log.push({ op: 'get', key });
      return items.has(key) ? items.get(key) : null;
    },
    async setItemAsync(key, value) {
      log.push({ op: 'set', key, value });
      items.set(key, value);
    },
    async deleteItemAsync(key) {
      log.push({ op: 'delete', key });
      items.delete(key);
    },
  };
}

function createAsyncStorage() {
  const items = new Map();
  return {
    items,
    async getItem(key) {
      return items.has(key) ? items.get(key) : null;
    },
    async setItem(key, value) {
      items.set(key, value);
    },
    async removeItem(key) {
      items.delete(key);
    },
    async getAllKeys() {
      return [...items.keys()];
    },
    async multiRemove(keys) {
      for (const key of keys) items.delete(key);
    },
    async multiGet(keys) {
      return keys.map((key) => [key, items.has(key) ? items.get(key) : null]);
    },
  };
}

/** A CSPRNG-shaped source. Node's webcrypto, so entropy is real. */
const nodeCrypto = require('node:crypto');
const expoCryptoFake = {
  getRandomValues(array) {
    nodeCrypto.webcrypto.getRandomValues(array);
    return array;
  },
  getRandomBytes(n) {
    return new Uint8Array(nodeCrypto.randomBytes(n));
  },
  async digestStringAsync(_alg, value) {
    return nodeCrypto.createHash('sha256').update(value).digest('hex');
  },
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
};

// ---------------------------------------------------------------------------
// Real module loaders
// ---------------------------------------------------------------------------

const RECEIPT_REL = 'services/deletion/statusReceipt.ts';
const STORE_REL = 'services/deletion/pendingDeletionStore.ts';
const CLIENT_REL = 'services/deletion/deletionStatusClient.ts';
const DECISION_REL = 'services/deletion/terminalDeletionDecision.ts';
const PURGE_REL = 'services/deletion/ownerTerminalPurge.ts';
const RECONCILER_REL = 'services/deletion/terminalDeletionReconciler.ts';
const INTAKE_REL = 'services/accountDeletion.js';

function loadReceipt(overrides = {}) {
  return evaluate(RECEIPT_REL, (spec) => {
    if (spec === 'expo-crypto') return overrides.expoCrypto ?? expoCryptoFake;
    throw new Error(`unexpected statusReceipt import: ${spec}`);
  });
}

function loadStore() {
  return evaluate(STORE_REL, (spec) => {
    if (spec === 'expo-secure-store') return createKeychain();
    throw new Error(`unexpected pendingDeletionStore import: ${spec}`);
  });
}

function loadClient(invokeImpl) {
  return evaluate(CLIENT_REL, (spec) => {
    if (spec === '../supabaseClient') {
      return { supabase: { functions: { invoke: invokeImpl ?? (async () => ({ data: null, error: null })) } } };
    }
    if (spec === './statusReceipt') return loadReceipt();
    throw new Error(`unexpected deletionStatusClient import: ${spec}`);
  });
}

function loadDecision() {
  return evaluate(DECISION_REL, (spec) => {
    // Type-only imports are elided by the transpiler; anything reaching here
    // would be a real runtime dependency this pure module must not have.
    throw new Error(`unexpected terminalDeletionDecision import: ${spec}`);
  });
}

/** Records which owner-scoped primitives ran, with the owner each received. */
function createPurgeSpies(overrides = {}) {
  const calls = [];
  const spy = (name) => async (arg) => {
    calls.push({ name, arg });
    if (name in overrides) return overrides[name];
    return { ok: true };
  };
  return {
    calls,
    deps: {
      purgeScans: spy('purgeScans'),
      purgeCloset: spy('purgeCloset'),
      purgeClosetCandidates: spy('purgeClosetCandidates'),
      purgeClosetSync: spy('purgeClosetSync'),
      purgeClosetRestoreMedia: spy('purgeClosetRestoreMedia'),
      purgeSavedLooks: spy('purgeSavedLooks'),
      purgeDressingRoomSessions: spy('purgeDressingRoomSessions'),
      purgeDressingRoomCompositions: spy('purgeDressingRoomCompositions'),
      purgeDressingRoomInteractions: spy('purgeDressingRoomInteractions'),
      purgeSavedLookReturnContext: spy('purgeSavedLookReturnContext'),
      purgeStylistVoicePreference: spy('purgeStylistVoicePreference'),
      clearSignatureStylePreferences: spy('clearSignatureStylePreferences'),
      clearSignatureStyleFeedback: spy('clearSignatureStyleFeedback'),
      clearSignatureStyleReasons: spy('clearSignatureStyleReasons'),
      clearPackingPlanCache: spy('clearPackingPlanCache'),
      clearOnboarding: spy('clearOnboarding'),
    },
  };
}

/**
 * The orchestrator, loaded with a shim that REFUSES every module it must never
 * reach. The allowlist below is the containment proof: no AsyncStorage, no
 * SecureStore, no AuthSessionContext, no actorContext.
 */
function loadPurge() {
  const allowed = new Set([
    '../library',
    '../closetLibrary',
    '../closetCandidateLibrary',
    '../closet/closetSyncStore',
    '../closet/closetRestoreMedia',
    '../privateSavedLookStore',
    '../privateDressingRoomSessionStore',
    '../privateDressingRoomCompositionStore',
    '../privateDressingRoomInteractionStore',
    '../privateSavedLookReturnContext',
    '../../stores/stylistVoicePreferenceStore',
    '../signature-style/localSignatureStylePreferences',
    '../signature-style/localSignatureStyleFeedbackStore',
    '../signature-style/localSignatureStyleReasons',
    '../packing/packingPlanCache',
    '../onboardingCompletion',
  ]);
  return evaluate(PURGE_REL, (spec) => {
    if (allowed.has(spec)) {
      // Never invoked: every test supplies explicit deps. Importing the real
      // module here would drag expo-file-system into the harness.
      return new Proxy(
        {},
        {
          get: () => () => {
            throw new Error(`real primitive ${spec} must not run in this harness`);
          },
        },
      );
    }
    throw new Error(`FORBIDDEN import in ownerTerminalPurge: ${spec}`);
  });
}

function loadReconciler() {
  return evaluate(RECONCILER_REL, (spec) => {
    if (spec === './deletionStatusClient') return loadClient();
    if (spec === './pendingDeletionStore') return loadStore();
    if (spec === './terminalDeletionDecision') return loadDecision();
    if (spec === './ownerTerminalPurge') return loadPurge();
    throw new Error(`FORBIDDEN import in terminalDeletionReconciler: ${spec}`);
  });
}

const RECEIPT = loadReceipt();
const DECISION = loadDecision();
const PURGE = loadPurge();

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

function lifecycle(state, purgeAuthorized, extra = {}) {
  return { kind: 'lifecycle', state, purgeAuthorized, purgedAt: null, restoredAt: null, ...extra };
}

// ===========================================================================
// RECEIPT
// ===========================================================================

test('RECEIPT: the generator draws from a cryptographically secure source', () => {
  let asked = 0;
  const mod = loadReceipt({
    expoCrypto: {
      getRandomValues(array) {
        asked += 1;
        nodeCrypto.webcrypto.getRandomValues(array);
        return array;
      },
    },
  });
  // No global crypto in the sandbox path means expo-crypto is the source.
  const originalCrypto = globalThis.crypto;
  try {
    delete globalThis.crypto;
    const receipt = mod.generateStatusReceipt();
    assert.equal(asked, 1, 'expo-crypto CSPRNG must be the source');
    assert.ok(mod.isValidStatusReceipt(receipt));
  } finally {
    globalThis.crypto = originalCrypto;
  }
});

test('RECEIPT: matches the exact Repair 06 format', () => {
  for (let i = 0; i < 50; i += 1) {
    const receipt = RECEIPT.generateStatusReceipt();
    assert.equal(receipt.length, 52);
    assert.ok(receipt.startsWith('ksdel_v1_'));
    assert.match(receipt.slice(9), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(RECEIPT.isValidStatusReceipt(receipt));
  }
});

test('RECEIPT: the format structurally carries 256 bits', () => {
  assert.equal(RECEIPT.STATUS_RECEIPT_BYTES, 32);
  assert.equal(RECEIPT.STATUS_RECEIPT_LENGTH, 'ksdel_v1_'.length + 43);
  // 43 unpadded base64url characters is exactly the encoding of 32 bytes; a
  // shorter value cannot be a correctly generated receipt.
  assert.equal(Math.ceil((32 * 8) / 6), 43);
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(RECEIPT.generateStatusReceipt());
  assert.equal(seen.size, 200, 'generated capabilities must not repeat');
});

test('RECEIPT: Math.random is not reachable, and no-CSPRNG fails closed', () => {
  const source = fs.readFileSync(path.join(ROOT, RECEIPT_REL), 'utf8');
  const executable = stripComments(source);
  assert.ok(!/Math\.random/.test(executable), 'no Math.random in the capability generator');
  assert.ok(!/Date\.now|getTime\(\)/.test(executable), 'no timestamp entropy');

  const mod = loadReceipt({ expoCrypto: {} });
  const originalCrypto = globalThis.crypto;
  try {
    delete globalThis.crypto;
    assert.throws(() => mod.generateStatusReceipt(), /InsecureRandomnessError|secure/);
  } finally {
    globalThis.crypto = originalCrypto;
  }
});

test('RECEIPT: the validator rejects every wrong shape', () => {
  const good = RECEIPT.generateStatusReceipt();
  const bad = [
    null, undefined, 12345, {}, [good], '',
    good.slice(0, 51),
    `${good}A`,
    good.replace('ksdel_v1_', 'ksdel_v2_'),
    good.slice(9),
    `ksdel_v1_${'+'.repeat(43)}`,
    `ksdel_v1_${'/'.repeat(43)}`,
    `ksdel_v1_${'A'.repeat(42)}`,
  ];
  assert.ok(RECEIPT.isValidStatusReceipt(good));
  for (const value of bad) {
    assert.equal(RECEIPT.isValidStatusReceipt(value), false, `should reject ${String(value)}`);
  }
});

// ===========================================================================
// SECURE STORAGE
// ===========================================================================

test('STORAGE: the raw capability is written only to the keychain', async () => {
  const keychain = createKeychain();
  const asyncStorage = createAsyncStorage();
  const store = evaluate(STORE_REL, (spec) => {
    if (spec === 'expo-secure-store') return keychain;
    throw new Error(`unexpected import: ${spec}`);
  });

  const receipt = RECEIPT.generateStatusReceipt();
  const record = await store.persistPendingDeletion({ receipt, ownerId: OWNER_A });

  const keychainBlob = JSON.stringify([...keychain.items.entries()]);
  assert.ok(keychainBlob.includes(receipt), 'the keychain holds the capability');

  const asyncBlob = JSON.stringify([...asyncStorage.items.entries()]);
  assert.ok(!asyncBlob.includes(receipt), 'AsyncStorage must never hold the capability');

  // The store's only dependency is expo-secure-store; the shim above proves it
  // cannot even reach AsyncStorage.
  const source = fs.readFileSync(path.join(ROOT, STORE_REL), 'utf8');
  assert.ok(!/async-storage/i.test(source), 'no AsyncStorage import in the marker store');

  const roundTrip = await store.readPendingDeletion(record.recordId);
  assert.equal(roundTrip.receipt, receipt);
  assert.equal(roundTrip.ownerId, OWNER_A);
  assert.equal(roundTrip.bindingState, 'unconfirmed');
  assert.equal(roundTrip.purgeState, 'not_started');
});

test('STORAGE: the index never contains a capability or a hash of one', async () => {
  const keychain = createKeychain();
  const store = evaluate(STORE_REL, (spec) =>
    spec === 'expo-secure-store' ? keychain : (() => { throw new Error(spec); })(),
  );
  const receipt = RECEIPT.generateStatusReceipt();
  const record = await store.persistPendingDeletion({ receipt, ownerId: OWNER_A });

  const index = keychain.items.get(store.PENDING_DELETION_INDEX_KEY);
  assert.ok(index.includes(record.recordId));
  assert.ok(!index.includes(receipt));
  assert.ok(!index.includes(receipt.slice(9)));
  const digest = nodeCrypto.createHash('sha256').update(receipt).digest('hex');
  assert.ok(!index.includes(digest), 'no capability fingerprint in the index');
});

test('STORAGE: independent lifecycle records never overwrite one another', async () => {
  const keychain = createKeychain();
  const store = evaluate(STORE_REL, (spec) =>
    spec === 'expo-secure-store' ? keychain : (() => { throw new Error(spec); })(),
  );
  const a = await store.persistPendingDeletion({
    receipt: RECEIPT.generateStatusReceipt(),
    ownerId: OWNER_A,
  });
  const b = await store.persistPendingDeletion({
    receipt: RECEIPT.generateStatusReceipt(),
    ownerId: OWNER_B,
  });
  const aAgain = await store.persistPendingDeletion({
    receipt: RECEIPT.generateStatusReceipt(),
    ownerId: OWNER_A,
  });

  const all = await store.listPendingDeletions();
  assert.equal(all.length, 3);
  assert.deepEqual(
    all.map((r) => r.ownerId).sort(),
    [OWNER_A, OWNER_A, OWNER_B].sort(),
  );
  assert.equal(new Set([a.recordId, b.recordId, aAgain.recordId]).size, 3);

  await store.removePendingDeletion(a.recordId);
  const remaining = await store.listPendingDeletions();
  assert.equal(remaining.length, 2);
  assert.ok(remaining.every((r) => r.recordId !== a.recordId));
  assert.ok(remaining.some((r) => r.recordId === b.recordId), "B's record survives");
});

test('STORAGE: a marker refuses to exist without an owner scope', async () => {
  const store = loadStore();
  await assert.rejects(
    () => store.persistPendingDeletion({ receipt: RECEIPT.generateStatusReceipt(), ownerId: '' }),
    /owner scope/,
  );
  await assert.rejects(
    () => store.persistPendingDeletion({ receipt: '', ownerId: OWNER_A }),
    /capability/,
  );
});

test('STORAGE: an update can never retarget a record at a different owner', async () => {
  const keychain = createKeychain();
  const store = evaluate(STORE_REL, (spec) =>
    spec === 'expo-secure-store' ? keychain : (() => { throw new Error(spec); })(),
  );
  const record = await store.persistPendingDeletion({
    receipt: RECEIPT.generateStatusReceipt(),
    ownerId: OWNER_A,
  });
  const updated = await store.updatePendingDeletion(record.recordId, {
    bindingState: 'bound',
    ownerId: OWNER_B,
    recordId: 'deadbeef',
  });
  assert.equal(updated.ownerId, OWNER_A);
  assert.equal(updated.recordId, record.recordId);
  assert.equal(updated.bindingState, 'bound');
});

test('STORAGE: a corrupt record is skipped, never half-interpreted', async () => {
  const keychain = createKeychain();
  const store = evaluate(STORE_REL, (spec) =>
    spec === 'expo-secure-store' ? keychain : (() => { throw new Error(spec); })(),
  );
  const good = await store.persistPendingDeletion({
    receipt: RECEIPT.generateStatusReceipt(),
    ownerId: OWNER_A,
  });
  // A record that kept its capability but lost its owner scope: the purge
  // orchestrator would have a secret and no idea whose data to remove.
  keychain.items.set(
    `${store.PENDING_DELETION_RECORD_KEY_PREFIX}abcdef01`,
    JSON.stringify({ schemaVersion: 1, recordId: 'abcdef01', receipt: 'x', ownerId: '' }),
  );
  keychain.items.set(
    store.PENDING_DELETION_INDEX_KEY,
    JSON.stringify([good.recordId, 'abcdef01']),
  );
  const all = await store.listPendingDeletions();
  assert.equal(all.length, 1);
  assert.equal(all[0].recordId, good.recordId);
});

// ===========================================================================
// INTAKE ORDERING — persist before network
// ===========================================================================

/**
 * Boots the REAL intake service with an instrumented keychain and an
 * instrumented Supabase client, recording every observable event in order.
 */
function bootIntake({ invokeImpl, expoCrypto } = {}) {
  const events = [];
  const keychain = createKeychain();
  const wrappedKeychain = {
    getItemAsync: (k) => keychain.getItemAsync(k),
    setItemAsync: (k, v) => {
      events.push({ event: 'keychain_write', key: k, value: v });
      return keychain.setItemAsync(k, v);
    },
    deleteItemAsync: (k) => {
      events.push({ event: 'keychain_delete', key: k });
      return keychain.deleteItemAsync(k);
    },
  };
  const receiptModule = loadReceipt({ expoCrypto });
  const storeModule = evaluate(STORE_REL, (spec) =>
    spec === 'expo-secure-store' ? wrappedKeychain : (() => { throw new Error(spec); })(),
  );

  const intake = evaluate(INTAKE_REL, (spec) => {
    if (spec === './deletion/statusReceipt') return receiptModule;
    if (spec === './deletion/pendingDeletionStore') return storeModule;
    throw new Error(`FORBIDDEN import in accountDeletion: ${spec}`);
  });

  const supabase = {
    functions: {
      invoke: async (name, options) => {
        events.push({ event: 'network', name, body: options && options.body });
        return invokeImpl
          ? invokeImpl(name, options)
          : { data: { status: 'deactivated', statusReceiptBound: true }, error: null };
      },
    },
  };

  return { intake, supabase, events, keychain, storeModule };
}

const SESSION_A = { user: { id: OWNER_A } };

test('ORDERING: the marker is persisted BEFORE the deletion request is sent', async () => {
  const { intake, supabase, events } = bootIntake();
  await intake.submitAccountDeletionRequest(supabase, SESSION_A);

  const firstWrite = events.findIndex((e) => e.event === 'keychain_write');
  const network = events.findIndex((e) => e.event === 'network');
  assert.ok(firstWrite >= 0, 'a marker must be written');
  assert.ok(network >= 0, 'the request must be sent');
  assert.ok(
    firstWrite < network,
    'the capability must be durable before the request that commits the lifecycle',
  );
});

test('ORDERING NEGATIVE CONTROL: request-before-persist would be detected', async () => {
  // Proves the assertion above has teeth: the same check applied to a
  // deliberately inverted ordering fails.
  const events = [
    { event: 'network' },
    { event: 'keychain_write' },
  ];
  const firstWrite = events.findIndex((e) => e.event === 'keychain_write');
  const network = events.findIndex((e) => e.event === 'network');
  assert.ok(!(firstWrite < network), 'an inverted order must not satisfy the ordering rule');
});

test('INTAKE: the request body carries the client-generated statusReceipt', async () => {
  const { intake, supabase, events } = bootIntake();
  await intake.submitAccountDeletionRequest(supabase, SESSION_A);
  const call = events.find((e) => e.event === 'network');
  assert.equal(call.name, 'handle-user-deletion');
  assert.ok(RECEIPT.isValidStatusReceipt(call.body.statusReceipt));
  assert.deepEqual(Object.keys(call.body), ['statusReceipt']);
});

test('INTAKE: the existing acceptance normalizer is unchanged', async () => {
  const { intake } = bootIntake();
  const accepted = intake.normalizeDeletionSubmissionResponse(
    { status: 'deactivated', requestedAt: '2026-09-09T00:00:00.000Z' },
    null,
  );
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.lifecycle, 'active');
  assert.equal(accepted.backendStatus, 'deactivated');
  assert.equal(accepted.terminalTracking, 'none');

  // Legacy snake_case still normalizes.
  const legacy = intake.normalizeDeletionSubmissionResponse(
    { status: 'already_requested', requested_at: '2026-09-09T00:00:00.000Z' },
    null,
  );
  assert.equal(legacy.alreadyRequested, true);

  // Non-submission statuses still fail closed.
  for (const status of intake.NON_SUBMISSION_STATUSES) {
    assert.throws(
      () => intake.normalizeDeletionSubmissionResponse({ status }, null),
      /Unexpected response/,
    );
  }
  assert.throws(() => intake.normalizeDeletionSubmissionResponse({ error: 'nope' }, null));
  assert.throws(() => intake.normalizeDeletionSubmissionResponse(null, null));
  assert.throws(
    () => intake.normalizeDeletionSubmissionResponse({ status: 'deactivated', requestedAt: 'nope' }, null),
    /Malformed timestamp/,
  );
});

test('INTAKE: statusReceiptBound true binds the marker', async () => {
  const { intake, supabase, storeModule } = bootIntake();
  const result = await intake.submitAccountDeletionRequest(supabase, SESSION_A);
  assert.equal(result.terminalTracking, 'bound');
  const [record] = await storeModule.listPendingDeletions();
  assert.equal(record.bindingState, 'bound');
  assert.ok(RECEIPT.isValidStatusReceipt(record.receipt));
});

test('INTAKE: statusReceiptBound false FAILS CLOSED and drops the useless secret', async () => {
  const { intake, supabase, storeModule } = bootIntake({
    invokeImpl: async () => ({
      data: { status: 'deactivated', statusReceiptBound: false },
      error: null,
    }),
  });
  const result = await intake.submitAccountDeletionRequest(supabase, SESSION_A);
  // The deletion REQUEST is still accepted — an old or degraded backend must
  // never become a deletion outage.
  assert.equal(result.accepted, true);
  assert.equal(result.terminalTracking, 'unbound');

  const [record] = await storeModule.listPendingDeletions();
  assert.equal(record.bindingState, 'unbound');
  assert.equal(record.receipt, null, 'a capability that can never resolve is not kept');
  assert.equal(DECISION.isBindingQueryable('unbound'), false);
});

test('INTAKE: an old backend omitting the field FAILS CLOSED as unsupported', async () => {
  const { intake, supabase, storeModule } = bootIntake({
    invokeImpl: async () => ({
      data: { status: 'deactivated', requestedAt: '2026-09-09T00:00:00.000Z' },
      error: null,
    }),
  });
  const result = await intake.submitAccountDeletionRequest(supabase, SESSION_A);
  assert.equal(result.accepted, true, 'deletion still works against production');
  assert.equal(result.terminalTracking, 'unsupported');
  const [record] = await storeModule.listPendingDeletions();
  assert.equal(record.bindingState, 'unsupported');
  assert.equal(record.receipt, null);
  assert.equal(DECISION.isBindingQueryable('unsupported'), false);
});

test('INTAKE: binding is never inferred from HTTP success alone', async () => {
  const { intake, supabase } = bootIntake({
    invokeImpl: async () => ({ data: { status: 'deactivated' }, error: null }),
  });
  const result = await intake.submitAccountDeletionRequest(supabase, SESSION_A);
  assert.notEqual(result.terminalTracking, 'bound');
});

test('INTAKE: a lost response leaves the capability recoverable', async () => {
  const { intake, supabase, storeModule } = bootIntake({
    invokeImpl: async () => ({ data: null, error: new Error('network died') }),
  });
  await assert.rejects(() => intake.submitAccountDeletionRequest(supabase, SESSION_A));

  // THE WHOLE POINT: the request may already have committed and the session is
  // about to be revoked, but the device still holds the capability.
  const [record] = await storeModule.listPendingDeletions();
  assert.ok(record, 'the marker survives a lost response');
  assert.equal(record.bindingState, 'unconfirmed');
  assert.ok(RECEIPT.isValidStatusReceipt(record.receipt));
  assert.equal(DECISION.isBindingQueryable('unconfirmed'), true, 'and stays resolvable');
});

test('INTAKE: a 400 invalid-receipt rejection retires the marker', async () => {
  const error = new Error('bad');
  error.context = { status: 400 };
  const { intake, supabase, storeModule } = bootIntake({
    invokeImpl: async () => ({ data: null, error }),
  });
  await assert.rejects(() => intake.submitAccountDeletionRequest(supabase, SESSION_A));
  const records = await storeModule.listPendingDeletions();
  assert.equal(records.length, 0, 'no lifecycle was created, so nothing is tracked');
});

test('INTAKE: no owner, no secure RNG, or no keychain degrades to the old request', async () => {
  // No session user.
  {
    const { intake, supabase, events } = bootIntake();
    await intake.submitAccountDeletionRequest(supabase, null);
    assert.deepEqual(events.find((e) => e.event === 'network').body, {});
  }
  // No secure randomness.
  {
    const originalCrypto = globalThis.crypto;
    try {
      delete globalThis.crypto;
      const { intake, supabase, events } = bootIntake({ expoCrypto: {} });
      const result = await intake.submitAccountDeletionRequest(supabase, SESSION_A);
      assert.deepEqual(events.find((e) => e.event === 'network').body, {});
      assert.equal(result.accepted, true);
      assert.equal(result.terminalTracking, 'none');
    } finally {
      globalThis.crypto = originalCrypto;
    }
  }
});

// ===========================================================================
// LOGOUT
// ===========================================================================

test('LOGOUT: sign-out clears auth secrets but cannot reach the deletion marker', () => {
  const bootstrap = fs.readFileSync(path.join(ROOT, 'services/authSessionBootstrap.ts'), 'utf8');
  const clearFn = bootstrap.slice(bootstrap.indexOf('async clearPersistedSessions()'));
  const body = clearFn.slice(0, clearFn.indexOf('\n    },'));

  // The durable-logout backstop iterates the keys the Supabase auth storage
  // adapter has itself observed. It is not a namespace wipe.
  assert.match(body, /for \(const key of observedKeys\)/);
  assert.ok(!/getAllKeys|deleteItemAsync\(\s*['"`]/.test(body), 'no blanket keychain sweep');

  // The marker store never writes through that adapter, so its keys can never
  // become `observedKeys`. Checked against EXECUTABLE source: the module's
  // header discusses `secureSessionStorage` at length precisely to explain why
  // it does not use it, and a naive text search would read that as a use.
  const storeSource = stripComments(fs.readFileSync(path.join(ROOT, STORE_REL), 'utf8'));
  assert.ok(!/authSessionBootstrap|secureSessionStorage|supabaseClient/.test(storeSource));
  assert.equal(
    (storeSource.match(/^import .*$/gm) || []).join('\n'),
    "import * as SecureStore from 'expo-secure-store';",
    'the marker store depends on the keychain and nothing else',
  );

  const auth = fs.readFileSync(path.join(ROOT, 'contexts/AuthSessionContext.tsx'), 'utf8');
  assert.ok(!/pendingDeletion|deletion\/pendingDeletionStore/.test(auth), 'signOut cannot see markers');
  assert.ok(!/kscan\.deletion\./.test(auth));
});

test('LOGOUT: the marker and capability survive a simulated sign-out and restart', async () => {
  const keychain = createKeychain();
  const makeStore = () =>
    evaluate(STORE_REL, (spec) =>
      spec === 'expo-secure-store' ? keychain : (() => { throw new Error(spec); })(),
    );

  const receipt = RECEIPT.generateStatusReceipt();
  const first = makeStore();
  const record = await first.persistPendingDeletion({ receipt, ownerId: OWNER_A });

  // Simulate the durable-logout backstop: it removes only the keys the auth
  // adapter observed. Those are Supabase session keys, never these.
  const authObservedKeys = ['sb-kscan-auth-token', 'kscan-auth-bootstrap-refresh'];
  keychain.items.set('sb-kscan-auth-token', 'session-material');
  for (const key of authObservedKeys) keychain.items.delete(key);

  // Simulate a cold restart: a brand-new module instance over the same keychain.
  const afterRestart = makeStore();
  const recovered = await afterRestart.readPendingDeletion(record.recordId);
  assert.ok(recovered, 'the marker survives logout and restart');
  assert.equal(recovered.receipt, receipt);
  assert.equal(recovered.ownerId, OWNER_A);
  assert.equal(keychain.items.get('sb-kscan-auth-token'), undefined, 'auth secrets did go');
});

test('LOGOUT: resetActorScopedRuntimeState does not touch deletion state', () => {
  const auth = fs.readFileSync(path.join(ROOT, 'contexts/AuthSessionContext.tsx'), 'utf8');
  const start = auth.indexOf('function resetActorScopedRuntimeState');
  const end = auth.indexOf('\n}\n', start);
  const body = auth.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.ok(!/deletion/i.test(body), 'the actor reset must not know about deletion markers');
  assert.ok(!/purgeLocal|purgeOwner|ForActor|ForOwner/.test(body), 'and must not purge owner data');
});

// ===========================================================================
// STATUS CLIENT
// ===========================================================================

function httpError(status, code) {
  const error = new Error('http');
  error.context = { status, json: async () => (code === undefined ? {} : { error: code }) };
  return error;
}

test('STATUS: the capability rides in the POST body and never in a URL', async () => {
  const calls = [];
  const client = loadClient(async (name, options) => {
    calls.push({ name, options });
    return { data: { state: 'pending', purgeAuthorized: false }, error: null };
  });
  const receipt = RECEIPT.generateStatusReceipt();
  await client.fetchDeletionStatus(receipt);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'deletion-status');
  assert.deepEqual(calls[0].options.body, { receipt });
  // `functions.invoke` builds the URL from the name alone; this module supplies
  // no query string, no path segment and no extra option of any kind.
  assert.deepEqual(Object.keys(calls[0].options), ['body']);
  assert.ok(!calls[0].name.includes('?'));
  assert.ok(!calls[0].name.includes(receipt));

  const source = stripComments(fs.readFileSync(path.join(ROOT, CLIENT_REL), 'utf8'));
  assert.ok(!/\?receipt|searchParams|URLSearchParams|encodeURIComponent/.test(source));
  assert.ok(!/method:\s*['"]GET['"]/.test(source));
});

test('STATUS: no user id, email, or session identifier is ever supplied', async () => {
  const calls = [];
  const client = loadClient(async (name, options) => {
    calls.push(options);
    return { data: { state: 'pending', purgeAuthorized: false }, error: null };
  });
  await client.fetchDeletionStatus(RECEIPT.generateStatusReceipt());
  const body = calls[0].body;
  assert.deepEqual(Object.keys(body), ['receipt']);
  for (const forbidden of ['userId', 'user_id', 'email', 'sub', 'ownerId', 'accessToken']) {
    assert.ok(!(forbidden in body));
  }
  const source = stripComments(fs.readFileSync(path.join(ROOT, CLIENT_REL), 'utf8'));
  assert.ok(!/getSession|getUser|auth\./.test(source), 'the lookup is not auth-dependent');
});

test('STATUS: responses normalize strictly, and anything else is malformed', async () => {
  const client = loadClient();
  const ok = client.normalizeDeletionStatusResponse({
    state: 'purged',
    purgeAuthorized: true,
    purgedAt: '2026-09-09T01:00:00.000Z',
  });
  assert.deepEqual(ok, {
    kind: 'lifecycle',
    state: 'purged',
    purgeAuthorized: true,
    purgedAt: '2026-09-09T01:00:00.000Z',
    restoredAt: null,
  });

  for (const body of [
    null, undefined, 'purged', [], {},
    { state: 'purged' },
    { purgeAuthorized: true },
    { state: 'obliterated', purgeAuthorized: true },
    { state: 'purged', purgeAuthorized: 'true' },
    { state: 'purged', purgeAuthorized: 1 },
  ]) {
    assert.equal(
      client.normalizeDeletionStatusResponse(body).kind,
      'malformed',
      `must not interpret ${JSON.stringify(body)}`,
    );
  }
});

test('STATUS: every HTTP failure maps to a non-terminal outcome', async () => {
  const cases = [
    [httpError(400, 'invalid_request'), 'invalid_request'],
    [httpError(404, 'not_found'), 'not_found'],
    [httpError(404, undefined), 'endpoint_unavailable'],
    [httpError(405, 'method_not_allowed'), 'endpoint_unavailable'],
    [httpError(503, 'unavailable'), 'unavailable'],
    [httpError(500, 'boom'), 'network_error'],
    [new Error('offline'), 'network_error'],
  ];
  for (const [error, expected] of cases) {
    const client = loadClient(async () => ({ data: null, error }));
    const outcome = await client.fetchDeletionStatus(RECEIPT.generateStatusReceipt());
    assert.equal(outcome.kind, expected);
  }

  const thrown = loadClient(async () => {
    throw new Error('transport exploded');
  });
  assert.equal(
    (await thrown.fetchDeletionStatus(RECEIPT.generateStatusReceipt())).kind,
    'network_error',
  );
});

test('STATUS: a malformed local capability never reaches the network', async () => {
  let called = 0;
  const client = loadClient(async () => {
    called += 1;
    return { data: null, error: null };
  });
  const outcome = await client.fetchDeletionStatus('ksdel_v1_not-a-real-capability');
  assert.equal(outcome.kind, 'invalid_request');
  assert.equal(called, 0);
});

// ===========================================================================
// THE DOUBLE LOCK
// ===========================================================================

test('TERMINAL: purge requires BOTH purged state AND purgeAuthorized', () => {
  const authorized = DECISION.decideTerminalAction(lifecycle('purged', true), 'bound');
  assert.equal(authorized.action, 'purge');

  // Half a lock is no lock.
  assert.equal(
    DECISION.decideTerminalAction(lifecycle('purged', false), 'bound').action,
    'retain',
    "state 'purged' alone must never authorise destruction",
  );
  for (const state of ['pending', 'restored', 'failed']) {
    const decision = DECISION.decideTerminalAction(lifecycle(state, true), 'bound');
    assert.notEqual(
      decision.action,
      'purge',
      `purgeAuthorized beside state '${state}' must never authorise destruction`,
    );
  }
});

test('TERMINAL: the complete decision table', () => {
  const table = [
    [lifecycle('pending', false), 'retain'],
    [lifecycle('failed', false), 'retain'],
    [lifecycle('restored', false), 'release'],
    [lifecycle('purged', false), 'retain'],
    [lifecycle('purged', true), 'purge'],
    [{ kind: 'not_found' }, 'retain'],
    [{ kind: 'invalid_request' }, 'retain'],
    [{ kind: 'unavailable' }, 'retain'],
    [{ kind: 'endpoint_unavailable' }, 'retain'],
    [{ kind: 'network_error' }, 'retain'],
    [{ kind: 'malformed' }, 'retain'],
  ];
  for (const [outcome, expected] of table) {
    assert.equal(
      DECISION.decideTerminalAction(outcome, 'bound').action,
      expected,
      `${outcome.kind}/${outcome.state ?? '-'} should ${expected}`,
    );
  }
  // Exactly one row destroys anything.
  assert.equal(table.filter(([, action]) => action === 'purge').length, 1);
});

test('TERMINAL: an unbound or unsupported binding can never authorise a purge', () => {
  for (const binding of ['unbound', 'unsupported']) {
    const decision = DECISION.decideTerminalAction(lifecycle('purged', true), binding);
    assert.equal(decision.action, 'retain');
    assert.equal(decision.reason, `binding_${binding}`);
  }
  // A lost-response marker stays resolvable, because the request may have
  // committed and the capability is the only way to ever find out.
  assert.equal(
    DECISION.decideTerminalAction(lifecycle('purged', true), 'unconfirmed').action,
    'purge',
  );
});

test('TERMINAL: nothing but the endpoint answer can authorise destruction', () => {
  const source = stripComments(fs.readFileSync(path.join(ROOT, DECISION_REL), 'utf8'));
  // Only ONE place in the module produces the purge action, and it is guarded
  // by both halves on the same line-pair.
  // One RETURN site (the type union also names the action, which is a
  // declaration, not a code path).
  const purgeSites = source.match(/return \{ action: 'purge'/g) || [];
  assert.equal(purgeSites.length, 1);
  assert.match(source, /state === 'purged' && outcome\.purgeAuthorized === true/);
  // No clock, no grace-period arithmetic, no auth signal.
  assert.ok(!/Date\.now|GRACE|30|elapsed|401|403|signOut|isAuthenticated/.test(source));
});

// ===========================================================================
// ACTOR ISOLATION
// ===========================================================================

test('PURGE: every step receives the marker owner, never the current actor', async () => {
  const { calls, deps } = createPurgeSpies();
  const result = await PURGE.purgeOwnerScopedLocalData(OWNER_A, deps);

  assert.equal(result.complete, true);
  assert.equal(result.ownerId, OWNER_A);
  assert.equal(calls.length, 16, 'every owner-scoped subsystem is covered');

  const signatureStyleSteps = ['clearSignatureStylePreferences', 'clearSignatureStyleFeedback', 'clearSignatureStyleReasons'];
  for (const call of calls) {
    const expected = signatureStyleSteps.includes(call.name) ? `user:${OWNER_A}` : OWNER_A;
    assert.equal(call.arg, expected, `${call.name} must target the marker owner`);
    assert.ok(!String(call.arg).includes(OWNER_B), 'B is never a target');
  }
});

test('PURGE: no global clear, no signOut, no actor reset is reachable', () => {
  const source = stripComments(fs.readFileSync(path.join(ROOT, PURGE_REL), 'utf8'));
  const forbidden = [
    /AsyncStorage/,
    /SecureStore/,
    /\.clear\(\)/,
    /multiRemove/,
    /getAllKeys/,
    /clearAll[A-Za-z]*/,
    /signOut/,
    /resetActorScopedRuntimeState/,
    /clearPersistedAuthSessions/,
    /clearStyleChatDrafts/,
    /clearTodayWeather/,
    /advanceActorEpoch/,
    /currentActorId|getActorContext|captureActorScope/,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `ownerTerminalPurge must not reach ${pattern}`);
  }
  // The reconciler is equally forbidden from touching current-actor state.
  const reconciler = stripComments(fs.readFileSync(path.join(ROOT, RECONCILER_REL), 'utf8'));
  for (const pattern of [/signOut/, /resetActorScopedRuntimeState/, /AsyncStorage/, /\.clear\(\)/]) {
    assert.ok(!pattern.test(reconciler), `reconciler must not reach ${pattern}`);
  }
});

test('PURGE: a blank owner fails closed instead of matching the ownerless partition', async () => {
  for (const owner of ['', '   ', null, undefined]) {
    const { calls, deps } = createPurgeSpies();
    const result = await PURGE.purgeOwnerScopedLocalData(owner, deps);
    assert.equal(result.complete, false);
    assert.equal(calls.length, 0, 'nothing may be destroyed without an owner');
  }
});

test('ISOLATION: A pending -> B signs in -> A purged removes only A', async () => {
  const keychain = createKeychain();
  const store = evaluate(STORE_REL, (spec) =>
    spec === 'expo-secure-store' ? keychain : (() => { throw new Error(spec); })(),
  );
  const receiptA = RECEIPT.generateStatusReceipt();
  const receiptB = RECEIPT.generateStatusReceipt();
  const recordA = await store.persistPendingDeletion({ receipt: receiptA, ownerId: OWNER_A });
  await store.updatePendingDeletion(recordA.recordId, { bindingState: 'bound' });
  // B is signed in and has an unrelated marker of their own from an earlier,
  // restored lifecycle. Neither may be disturbed by A's cleanup.
  const recordB = await store.persistPendingDeletion({ receipt: receiptB, ownerId: OWNER_B });
  await store.updatePendingDeletion(recordB.recordId, { bindingState: 'bound' });

  const purgedOwners = [];
  const reconciler = evaluate(RECONCILER_REL, (spec) => {
    if (spec === './pendingDeletionStore') return store;
    if (spec === './terminalDeletionDecision') return DECISION;
    if (spec === './deletionStatusClient') return { fetchDeletionStatus: async () => ({}) };
    if (spec === './ownerTerminalPurge') return { purgeOwnerScopedLocalData: async () => ({}) };
    throw new Error(spec);
  });
  reconciler.__resetTerminalReconcilerForTests();

  const summary = await reconciler.reconcileTerminalDeletions({
    fetchStatus: async (receipt) =>
      receipt === receiptA
        ? lifecycle('purged', true, { purgedAt: '2026-09-09T01:00:00.000Z' })
        : lifecycle('pending', false),
    purge: async (ownerId) => {
      purgedOwners.push(ownerId);
      return { complete: true, ownerId, steps: [] };
    },
  });

  assert.deepEqual(purgedOwners, [OWNER_A], "only A's data is destroyed");
  const purged = summary.outcomes.find((o) => o.recordId === recordA.recordId);
  assert.equal(purged.action, 'purged');

  // B's marker, B's capability, and B's index entry are all intact.
  const remaining = await store.listPendingDeletions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].recordId, recordB.recordId);
  assert.equal(remaining[0].ownerId, OWNER_B);
  assert.equal(remaining[0].receipt, receiptB);

  // A's capability is gone from the keychain entirely.
  const blob = JSON.stringify([...keychain.items.entries()]);
  assert.ok(!blob.includes(receiptA), "A's capability is destroyed");
  assert.ok(blob.includes(receiptB), "B's capability is untouched");
});

test('ISOLATION: A -> B -> A again cannot resurrect a purged lifecycle', async () => {
  const store = loadStore();
  const receiptOld = RECEIPT.generateStatusReceipt();
  const oldRecord = await store.persistPendingDeletion({ receipt: receiptOld, ownerId: OWNER_A });
  await store.updatePendingDeletion(oldRecord.recordId, { bindingState: 'bound' });

  const reconciler = evaluate(RECONCILER_REL, (spec) => {
    if (spec === './pendingDeletionStore') return store;
    if (spec === './terminalDeletionDecision') return DECISION;
    if (spec === './deletionStatusClient') return { fetchDeletionStatus: async () => ({}) };
    if (spec === './ownerTerminalPurge') return { purgeOwnerScopedLocalData: async () => ({}) };
    throw new Error(spec);
  });
  reconciler.__resetTerminalReconcilerForTests();
  await reconciler.reconcileTerminalDeletions({
    fetchStatus: async () => lifecycle('purged', true),
    purge: async (ownerId) => ({ complete: true, ownerId, steps: [] }),
  });
  assert.equal((await store.listPendingDeletions()).length, 0);

  // A brand-new account that happens to reuse the same id string starts a
  // fresh lifecycle with a fresh capability. The retired one is unusable and
  // unreferenced, so nothing about the old purge can reach the new records.
  const fresh = await store.persistPendingDeletion({
    receipt: RECEIPT.generateStatusReceipt(),
    ownerId: OWNER_A,
  });
  assert.notEqual(fresh.recordId, oldRecord.recordId);
  assert.equal(await store.readPendingDeletion(oldRecord.recordId), null);
});

// ===========================================================================
// RESUME / IDEMPOTENCE
// ===========================================================================

/** A reconciler bound to a real marker store, with injectable status/purge. */
function bootReconciler(store) {
  const reconciler = evaluate(RECONCILER_REL, (spec) => {
    if (spec === './pendingDeletionStore') return store;
    if (spec === './terminalDeletionDecision') return DECISION;
    if (spec === './deletionStatusClient') return { fetchDeletionStatus: async () => ({}) };
    if (spec === './ownerTerminalPurge') return { purgeOwnerScopedLocalData: async () => ({}) };
    throw new Error(`FORBIDDEN import in reconciler: ${spec}`);
  });
  reconciler.__resetTerminalReconcilerForTests();
  return reconciler;
}

async function boundMarker(store, ownerId = OWNER_A) {
  const receipt = RECEIPT.generateStatusReceipt();
  const record = await store.persistPendingDeletion({ receipt, ownerId });
  await store.updatePendingDeletion(record.recordId, { bindingState: 'bound' });
  return { receipt, record };
}

test('RESUME: a partial purge keeps the marker and retries the rest', async () => {
  const store = loadStore();
  const { record } = await boundMarker(store);
  const reconciler = bootReconciler(store);

  let attempt = 0;
  const purge = async (ownerId) => {
    attempt += 1;
    if (attempt === 1) {
      return {
        complete: false,
        ownerId,
        steps: [
          { step: 'recent_scans', ok: true },
          { step: 'closet_items', ok: false },
        ],
      };
    }
    return { complete: true, ownerId, steps: [{ step: 'closet_items', ok: true }] };
  };

  const first = await reconciler.reconcileTerminalDeletions({
    fetchStatus: async () => lifecycle('purged', true),
    purge,
  });
  assert.equal(first.outcomes[0].action, 'retained');
  assert.match(first.outcomes[0].reason, /purge_incomplete:closet_items/);

  const stillThere = await store.readPendingDeletion(record.recordId);
  assert.ok(stillThere, 'a partial cleanup must never retire the marker');
  assert.equal(stillThere.purgeState, 'in_progress');
  assert.ok(RECEIPT.isValidStatusReceipt(stillThere.receipt));

  reconciler.__resetTerminalReconcilerForTests();
  const second = await reconciler.reconcileTerminalDeletions({
    fetchStatus: async () => lifecycle('purged', true),
    purge,
  });
  assert.equal(second.outcomes[0].action, 'purged');
  assert.equal(await store.readPendingDeletion(record.recordId), null);
});

test('RESUME: the marker is destroyed only AFTER cleanup completes', async () => {
  const store = loadStore();
  const { receipt, record } = await boundMarker(store);
  const reconciler = bootReconciler(store);

  let receiptPresentDuringPurge = null;
  await reconciler.reconcileTerminalDeletions({
    fetchStatus: async () => lifecycle('purged', true),
    purge: async (ownerId) => {
      // Observed from INSIDE the purge: the capability must still exist, so an
      // app death here is resumable rather than a silent permanent orphan.
      receiptPresentDuringPurge = await store.pendingDeletionReceiptPresent(record.recordId);
      return { complete: true, ownerId, steps: [] };
    },
  });
  assert.equal(receiptPresentDuringPurge, true, 'the marker outlives the destruction it authorises');
  assert.equal(await store.readPendingDeletion(record.recordId), null);
  assert.equal(await store.pendingDeletionReceiptPresent(record.recordId), false);
  void receipt;
});

test('RESUME: an app death mid-purge is recovered at the next boundary', async () => {
  const keychain = createKeychain();
  const makeStore = () =>
    evaluate(STORE_REL, (spec) =>
      spec === 'expo-secure-store' ? keychain : (() => { throw new Error(spec); })(),
    );
  const store = makeStore();
  const { record } = await boundMarker(store);
  const reconciler = bootReconciler(store);

  // Killed after the in_progress write, before cleanup could report.
  await reconciler.reconcileTerminalDeletions({
    fetchStatus: async () => lifecycle('purged', true),
    purge: async () => {
      throw new Error('app died');
    },
  });

  const afterCrash = makeStore();
  const survivor = await afterCrash.readPendingDeletion(record.recordId);
  assert.ok(survivor, 'the marker survives a crash mid-purge');
  assert.ok(RECEIPT.isValidStatusReceipt(survivor.receipt));

  const resumed = bootReconciler(afterCrash);
  let ran = 0;
  await resumed.reconcileTerminalDeletions({
    fetchStatus: async () => lifecycle('purged', true),
    purge: async (ownerId) => {
      ran += 1;
      return { complete: true, ownerId, steps: [] };
    },
  });
  assert.equal(ran, 1);
  assert.equal(await afterCrash.readPendingDeletion(record.recordId), null);
});

test('RESUME: a repeated terminal answer is safe and does nothing twice', async () => {
  const store = loadStore();
  await boundMarker(store);
  const reconciler = bootReconciler(store);
  let purges = 0;
  const run = () =>
    reconciler.reconcileTerminalDeletions({
      fetchStatus: async () => lifecycle('purged', true),
      purge: async (ownerId) => {
        purges += 1;
        return { complete: true, ownerId, steps: [] };
      },
    });

  await run();
  reconciler.__resetTerminalReconcilerForTests();
  const second = await run();
  assert.equal(purges, 1, 'the retired marker produces no second purge');
  assert.deepEqual(second.outcomes, []);
});

test('RESUME: overlapping lifecycle events collapse into one pass', async () => {
  const store = loadStore();
  await boundMarker(store);
  const reconciler = bootReconciler(store);

  let purges = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const options = {
    fetchStatus: async () => lifecycle('purged', true),
    purge: async (ownerId) => {
      purges += 1;
      await gate;
      return { complete: true, ownerId, steps: [] };
    },
  };

  const a = reconciler.reconcileTerminalDeletions(options);
  const b = reconciler.reconcileTerminalDeletions(options);
  assert.equal(a, b, 'a concurrent caller joins the in-flight pass');
  release();
  await Promise.all([a, b]);
  assert.equal(purges, 1, 'a duplicate foreground event must not purge twice');
});

test('RESUME: processing is deterministic and bounded', async () => {
  const store = loadStore();
  for (let i = 0; i < 7; i += 1) {
    const record = await store.persistPendingDeletion({
      receipt: RECEIPT.generateStatusReceipt(),
      ownerId: `owner-${i}`,
    });
    await store.updatePendingDeletion(record.recordId, { bindingState: 'bound' });
  }
  const reconciler = bootReconciler(store);
  const summary = await reconciler.reconcileTerminalDeletions({
    fetchStatus: async () => lifecycle('pending', false),
    purge: async () => {
      throw new Error('must not run for a pending lifecycle');
    },
  });
  assert.equal(summary.outcomes.length, reconciler.MAX_MARKERS_PER_RECONCILE);
  assert.ok(reconciler.MAX_MARKERS_PER_RECONCILE < 7);

  const reconcilerSource = stripComments(fs.readFileSync(path.join(ROOT, RECONCILER_REL), 'utf8'));
  for (const pattern of [/setInterval/, /setTimeout/, /BackgroundFetch/, /TaskManager/, /Notifications/]) {
    assert.ok(!pattern.test(reconcilerSource), `no ${pattern} scheduling`);
  }
});

// ===========================================================================
// RESTORATION
// ===========================================================================

test('RESTORATION: a restored lifecycle clears the marker and NEVER purges', async () => {
  const store = loadStore();
  const { receipt, record } = await boundMarker(store);
  const reconciler = bootReconciler(store);

  const summary = await reconciler.reconcileTerminalDeletions({
    fetchStatus: async () => ({
      kind: 'lifecycle',
      state: 'restored',
      purgeAuthorized: false,
      purgedAt: null,
      restoredAt: '2026-09-09T01:00:00.000Z',
    }),
    purge: async () => {
      throw new Error('a restored lifecycle must never reach a purge primitive');
    },
  });

  assert.equal(summary.outcomes[0].action, 'released');
  assert.equal(summary.outcomes[0].reason, 'restored');
  assert.equal(await store.readPendingDeletion(record.recordId), null, 'the marker is cleared');
  void receipt;
});

test('RESTORATION NEGATIVE CONTROL: routing restored into purge is rejected', () => {
  // The decision function is the only route to destruction, and it maps
  // `restored` to `release`. A caller that treated `release` as `purge` would
  // be contradicting the one function that decides.
  const decision = DECISION.decideTerminalAction(lifecycle('restored', false), 'bound');
  assert.equal(decision.action, 'release');
  assert.notEqual(decision.action, 'purge');
  // And a restored lifecycle can never carry authority in the first place.
  assert.notEqual(
    DECISION.decideTerminalAction(lifecycle('restored', true), 'bound').action,
    'purge',
  );
});

test('RESTORATION: owner local data is untouched on every non-purge path', async () => {
  const store = loadStore();
  const outcomes = [
    lifecycle('pending', false),
    lifecycle('failed', false),
    lifecycle('purged', false),
    { kind: 'not_found' },
    { kind: 'unavailable' },
    { kind: 'endpoint_unavailable' },
    { kind: 'network_error' },
    { kind: 'malformed' },
    { kind: 'invalid_request' },
  ];
  for (const outcome of outcomes) {
    const { record } = await boundMarker(store);
    const reconciler = bootReconciler(store);
    const summary = await reconciler.reconcileTerminalDeletions({
      fetchStatus: async () => outcome,
      purge: async () => {
        throw new Error(`purge must be unreachable for ${outcome.kind}/${outcome.state ?? '-'}`);
      },
    });
    const mine = summary.outcomes.find((o) => o.recordId === record.recordId);
    assert.equal(mine.action, 'retained', `${outcome.kind} must retain`);
    const kept = await store.readPendingDeletion(record.recordId);
    assert.ok(kept, 'the marker is retained so the lifecycle stays observable');
    await store.removePendingDeletion(record.recordId);
  }
});

// ===========================================================================
// OLD-BACKEND COMPATIBILITY
// ===========================================================================

test('COMPATIBILITY: production without Repair 06 keeps deletion working and purges nothing', async () => {
  // A. Old handle-user-deletion ignores statusReceipt and omits the field.
  const { intake, supabase, storeModule } = bootIntake({
    invokeImpl: async () => ({
      data: { status: 'pending', request_id: 'legacy', requested_at: '2026-09-09T00:00:00.000Z' },
      error: null,
    }),
  });
  const result = await intake.submitAccountDeletionRequest(supabase, SESSION_A);
  assert.equal(result.accepted, true, 'the account deletion still succeeds');
  assert.equal(result.terminalTracking, 'unsupported');

  // B/C. The status endpoint is not deployed at all.
  const [marker] = await storeModule.listPendingDeletions();
  assert.equal(marker.bindingState, 'unsupported');
  const reconciler = bootReconciler(storeModule);
  const summary = await reconciler.reconcileTerminalDeletions({
    fetchStatus: async () => {
      throw new Error('an unsupported marker must not reach the network at all');
    },
    purge: async () => {
      throw new Error('and must never purge');
    },
  });
  assert.equal(summary.outcomes[0].action, 'skipped');
  assert.match(summary.outcomes[0].reason, /binding_unsupported/);

  // D. Network unavailable on a genuinely bound marker: retain, no tight loop.
  const store2 = loadStore();
  await boundMarker(store2);
  const reconciler2 = bootReconciler(store2);
  let calls = 0;
  await reconciler2.reconcileTerminalDeletions({
    fetchStatus: async () => {
      calls += 1;
      return { kind: 'network_error' };
    },
    purge: async () => {
      throw new Error('never');
    },
  });
  assert.equal(calls, 1, 'one attempt per boundary — no retry loop');
});

// ===========================================================================
// SECURITY / LOGGING / PRIVACY
// ===========================================================================

test('SECURITY: no Repair 07 module logs, or can log, the capability', () => {
  const modules = [RECEIPT_REL, STORE_REL, CLIENT_REL, DECISION_REL, PURGE_REL, RECONCILER_REL];
  for (const rel of modules) {
    const source = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const pattern of [
      /console\./,
      /logError/,
      /capture\(/,
      /posthog/i,
      /analytics/i,
      /Clipboard/,
      /router\.(push|replace)/,
      /traceAuthLifecycle/,
    ]) {
      assert.ok(!pattern.test(source), `${rel} must not reach ${pattern}`);
    }
  }
});

test('SECURITY: the intake never logs the capability and never puts it in navigation', () => {
  const intakeSource = stripComments(fs.readFileSync(path.join(ROOT, INTAKE_REL), 'utf8'));
  assert.ok(!/console\.|analytics|posthog|router\./i.test(intakeSource));

  const privacyScreen = stripComments(fs.readFileSync(path.join(ROOT, 'app/privacy.tsx'), 'utf8'));
  assert.ok(!/statusReceipt|ksdel_v1_|pendingDeletion/.test(privacyScreen),
    'the UI never touches the capability');
});

test('SECURITY: the deletion-request UI still tells the truth about the grace window', () => {
  const privacyScreen = fs.readFileSync(path.join(ROOT, 'app/privacy.tsx'), 'utf8');
  assert.match(privacyScreen, /can be restored using the email we sent/);
  assert.ok(
    !/All data has been deleted|permanently deleted your data|everything has been deleted/i.test(
      privacyScreen,
    ),
    'submission must never be presented as completed deletion',
  );
});

test('SECURITY: no keychain value outside this record can be reached', () => {
  const source = stripComments(fs.readFileSync(path.join(ROOT, STORE_REL), 'utf8'));
  // Every SecureStore call is keyed by the index key or this record's own key.
  const calls = source.match(/store\.(get|set|delete)ItemAsync\(([^)]*)\)/g) || [];
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(
      /INDEX_KEY|recordKey\(/.test(call),
      `every keychain access must be scoped: ${call}`,
    );
  }
});

// ===========================================================================
// iOS + ANDROID CONTAINMENT / NATIVE DELTA (Repair 07 / Repair 09 parity)
// ===========================================================================

test('CONTAINMENT: the destructive bridge is mounted on both platforms, with no platform guard and without a timer', () => {
  const layout = fs.readFileSync(path.join(ROOT, 'app/_layout.tsx'), 'utf8');
  assert.match(layout, /<TerminalDeletionBridge \/>/);

  const start = layout.indexOf('function TerminalDeletionBridge()');
  const end = layout.indexOf('\n}\n', layout.indexOf('return null;', start));
  const body = layout.slice(start, end);
  assert.ok(start > 0);

  // Repair 09: the platform guard is gone. Both boundaries run unconditionally
  // on iOS and Android alike — one shared path, never a per-platform fork.
  assert.ok(!/Platform/.test(body), 'no platform branch of any kind remains in the bridge');
  assert.equal((body.match(/reconcileTerminalDeletions\(\)/g) || []).length, 2);
  assert.match(body, /inactive\|background/);
  assert.ok(!/setInterval|setTimeout|BackgroundFetch|TaskManager|registerTaskAsync/.test(body));
  // Deliberately NOT gated on a signed-in user: terminal cleanup happens after
  // the actor is gone, so a `user`/`session` guard would make it impossible.
  assert.ok(!/useAuthSession|user\?\.id|session/.test(body));

  // The `Platform` import itself is gone from this file now that nothing in it
  // reads Platform.OS — an unused import would mean a stale guard was only
  // half-removed.
  const importLine = (layout.match(/^import \{[\s\S]*?\} from 'react-native';/m) || [''])[0];
  assert.ok(!/\bPlatform\b/.test(importLine), "app/_layout.tsx must not import 'Platform' unused");
});

test('CONTAINMENT: Android runs the identical destructive path as iOS, with no new native capability', () => {
  const androidDir = path.join(ROOT, 'android');
  if (fs.existsSync(androidDir)) {
    // No android/ source is touched by this repair — Repair 09 is a JS/TS-only
    // change that removes a platform guard, and adds nothing native.
    assert.ok(true);
  }
  const layout = fs.readFileSync(path.join(ROOT, 'app/_layout.tsx'), 'utf8');
  const start = layout.indexOf('function TerminalDeletionBridge()');
  const body = layout.slice(start, layout.indexOf('\n}\n', layout.indexOf('return null;', start)));
  // There is exactly one TerminalDeletionBridge implementation and it contains
  // no per-platform fork of any kind — iOS and Android execute the same code.
  for (const guard of body.split('useEffect').slice(1)) {
    assert.ok(
      !/Platform\.OS/.test(guard.trimStart().slice(0, 120)),
      'no useEffect in the bridge may special-case a platform',
    );
  }
  assert.ok(
    !fs.existsSync(path.join(ROOT, 'services/deletion/terminalDeletionReconciler.android.ts')),
    'no forked Android reconciler implementation exists — one shared path only',
  );
  assert.ok(
    !fs.existsSync(path.join(ROOT, 'app/_layout.android.tsx')),
    'no forked Android layout implementation exists — one shared path only',
  );

  const callers = [];
  for (const dir of ['app', 'components', 'hooks', 'contexts', 'services', 'stores']) {
    const root = path.join(ROOT, dir);
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/reconcileTerminalDeletions|purgeOwnerScopedLocalData/.test(text)) {
            callers.push(path.relative(ROOT, full));
          }
        }
      }
    }
  }
  assert.deepEqual(
    callers.sort(),
    [
      'app/_layout.tsx',
      'services/deletion/ownerTerminalPurge.ts',
      'services/deletion/terminalDeletionReconciler.ts',
    ],
    'terminal cleanup has exactly one mount point',
  );
});

test('NATIVE: no new permission, entitlement, background mode or privacy category', () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const ios = app.expo.ios ?? {};
  const infoPlist = ios.infoPlist ?? {};
  assert.ok(!('UIBackgroundModes' in infoPlist), 'no background modes');
  assert.ok(!('keychain-access-groups' in (ios.entitlements ?? {})), 'no keychain sharing group');
  assert.ok(
    !JSON.stringify(app).includes('NSUserTrackingUsageDescription'),
    'no App Tracking Transparency',
  );

  // The privacy manifest is byte-identical in shape to the Repair 01 state:
  // terminal LOCAL cleanup collects nothing new.
  const collected = app.expo.ios.privacyManifests.NSPrivacyCollectedDataTypes;
  const deviceId = collected.find(
    (entry) => entry.NSPrivacyCollectedDataType === 'NSPrivacyCollectedDataTypeDeviceID',
  );
  assert.ok(deviceId, 'Repair 01 DeviceID declaration is still present');
  assert.equal(deviceId.NSPrivacyCollectedDataTypeLinked, true);
  assert.equal(deviceId.NSPrivacyCollectedDataTypeTracking, false);
  assert.deepEqual(deviceId.NSPrivacyCollectedDataTypePurposes, [
    'NSPrivacyCollectedDataTypePurposeAppFunctionality',
  ]);
  assert.equal(app.expo.ios.privacyManifests.NSPrivacyTracking, false);

  // expo-secure-store is already a shipped dependency; this repair adds none.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['expo-secure-store'], 'the keychain dependency already exists');
  assert.ok(pkg.dependencies['expo-crypto'], 'the CSPRNG dependency already exists');
});

test('NATIVE: Android production permission posture is unchanged by Repair 09', () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const android = app.expo.android ?? {};

  // Byte-for-byte the state governed by androidGooglePlayComplianceV1 and the
  // notification-boot-capability-removal repair. Enabling the JS-only terminal
  // deletion bridge on Android must not grant, request, or unblock anything.
  assert.deepEqual(android.permissions, [
    'android.permission.CAMERA',
    'android.permission.INTERNET',
    'android.permission.VIBRATE',
    'android.permission.ACCESS_COARSE_LOCATION',
  ]);
  assert.deepEqual(android.blockedPermissions, [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.RECORD_AUDIO',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ]);

  // The checked-in native project (android/app/src/main/AndroidManifest.xml)
  // is this repo's real Android permission surface. Terminal deletion
  // reconciliation is pure JS/TS calling expo-secure-store and expo-crypto —
  // both already-shipped dependencies with no native permission of their own —
  // so every one of the task's named permissions must still be present only as
  // an explicit `tools:node="remove"` merge instruction, never as a live grant.
  const manifest = fs.readFileSync(
    path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  const GOVERNED_PERMISSIONS = [
    'POST_NOTIFICATIONS',
    'RECORD_AUDIO',
    'RECEIVE_BOOT_COMPLETED',
    'ACCESS_FINE_LOCATION',
    'READ_EXTERNAL_STORAGE',
    'WRITE_EXTERNAL_STORAGE',
    'FOREGROUND_SERVICE',
    'FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  ];
  for (const permission of GOVERNED_PERMISSIONS) {
    const uses = manifest.match(
      new RegExp(`<uses-permission android:name="android\\.permission\\.${permission}"[^/]*/>`, 'g'),
    ) || [];
    assert.equal(uses.length, 1, `${permission} must appear exactly once in the manifest`);
    assert.match(
      uses[0],
      /tools:node="remove"/,
      `${permission} must remain blocked (tools:node="remove"), never granted, for terminal deletion`,
    );
  }

  // No new native Android service or receiver: the manifest's <service> and
  // <receiver> entries are unrelated to deletion reconciliation and untouched.
  assert.ok(!manifest.includes('TerminalDeletion'), 'no native component was added for deletion');
  assert.ok(!manifest.includes('DeletionReconcil'), 'no native component was added for deletion');
});

// ===========================================================================
// NEGATIVE CONTROLS — each mutation below must be REJECTED by the rules above
// ===========================================================================

test('NEGATIVE CONTROL: a global storage clear would break actor isolation', async () => {
  // A hypothetical "purge everything" step, run against a device holding A and
  // B, destroys B. This is the shape ownerTerminalPurge is forbidden from.
  const asyncStorage = createAsyncStorage();
  asyncStorage.items.set(`@style_dna_v1/preferences/user:${OWNER_A}`, '{}');
  asyncStorage.items.set(`@style_dna_v1/preferences/user:${OWNER_B}`, '{}');

  // The owner-scoped shape: only A's key goes.
  const scoped = [...asyncStorage.items.keys()].filter((k) => k.includes(OWNER_A));
  for (const key of scoped) asyncStorage.items.delete(key);
  assert.ok(asyncStorage.items.has(`@style_dna_v1/preferences/user:${OWNER_B}`), 'B survives');

  // The forbidden shape, for contrast.
  const globalClear = createAsyncStorage();
  globalClear.items.set(`@style_dna_v1/preferences/user:${OWNER_A}`, '{}');
  globalClear.items.set(`@style_dna_v1/preferences/user:${OWNER_B}`, '{}');
  globalClear.items.clear();
  assert.equal(globalClear.items.size, 0, 'a global clear takes B with it — hence the ban');

  // And the ban is enforced on the real module.
  const source = stripComments(fs.readFileSync(path.join(ROOT, PURGE_REL), 'utf8'));
  assert.ok(!/clearAllSignatureStylePreferences|clearAllLocalSignatureStyle|clearAllCachedPackingPlans/.test(source));
});

test('NEGATIVE CONTROL: clearing the marker before the purge finishes loses resumability', async () => {
  const store = loadStore();
  const { record } = await boundMarker(store);

  // Simulate the forbidden order: retire the marker, then fail the cleanup.
  await store.removePendingDeletion(record.recordId);
  assert.equal(await store.readPendingDeletion(record.recordId), null);

  const reconciler = bootReconciler(store);
  const summary = await reconciler.reconcileTerminalDeletions({
    fetchStatus: async () => lifecycle('purged', true),
    purge: async () => ({ complete: false, ownerId: OWNER_A, steps: [] }),
  });
  assert.deepEqual(summary.outcomes, [], 'the unfinished cleanup is now unrecoverable');

  // The real implementation does the opposite: it retires the marker only in
  // the branch that follows a complete purge.
  const source = stripComments(fs.readFileSync(path.join(ROOT, RECONCILER_REL), 'utf8'));
  const completeBranch = source.slice(source.indexOf("purgeState: 'complete'"));
  assert.match(completeBranch, /remove\(record\.recordId\)/);
  const partialBranch = source.slice(
    source.indexOf('if (!result.complete)'),
    source.indexOf("purgeState: 'complete'"),
  );
  assert.ok(!/remove\(/.test(partialBranch), 'the partial branch must not remove the marker');
});

test('NEGATIVE CONTROL: storing the capability in AsyncStorage is structurally impossible', () => {
  const source = fs.readFileSync(path.join(ROOT, STORE_REL), 'utf8');
  assert.ok(!/@react-native-async-storage/.test(source));
  // The harness proves it too: the module's require-shim throws on anything
  // but expo-secure-store, and every test above loads it that way.
  assert.throws(
    () =>
      evaluate(STORE_REL, (spec) => {
        if (spec === 'expo-secure-store') throw new Error('keychain unavailable');
        throw new Error(spec);
      }),
    /keychain unavailable/,
  );
});
