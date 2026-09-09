// K SCAN AI — Repair 06 <-> Repair 07/09 cross-contract certification.
//
// WHAT THIS LOCKS, AND WHY IT IS NOT A DUPLICATE OF
// __tests__/terminalDeletionCleanup.test.js. That suite certifies the client
// half in isolation: given a PUBLIC state ('pending' | 'restored' | 'failed' |
// 'purged') it proves the double lock holds. It cannot see the step before
// that one — the backend's mapping from the database's ELEVEN internal
// lifecycle statuses down to those four public states. That mapping is where a
// terminal-purge authorisation is actually born, and nothing else on this
// branch asserts the client's end of it: the backend's own suite
// (__tests__/deletionStatusContract.test.js, arrived with PR #375) proves the
// backend produces the mapping, and this file proves the shipped iOS/Android
// client modules consume it correctly, all the way to retain/release/purge.
//
// So this file certifies the FULL chain the device really experiences:
//
//     internal deletion_requests.status
//        -> Repair 06 public state + purgeAuthorized      (backend contract)
//        -> normalizeDeletionStatusResponse               (real client parser)
//        -> decideTerminalAction                          (real client rule)
//        -> retain | release | purge
//
// The single most important property it enforces: across the entire internal
// status vocabulary, plus inconsistent rows, plus unknown future statuses,
// plus every transport failure, EXACTLY ONE case may reach `purge`.
//
// PROVENANCE — every fixture below is recorded fact, not invention:
//   * Internal status vocabulary: read live on 2026-09-09 from the staging
//     project's `deletion_requests_status_check` constraint
//     (11 values, reproduced in DB_STATUS_VOCABULARY).
//   * Internal -> public mapping and purgeAuthorized rule: the deployed Repair
//     06 backend, `supabase/functions/deletion-status/index.ts` on the
//     canonical backend deployment authority branch
//     `rebuild/backend-authority-v2` @ 323a3c86, and
//     `docs/deletion/terminal-status-client-contract.md` §6/§7 on that branch.
//   * Both were executed against the real client modules end-to-end during
//     Repair 06 certification (16/16), recorded in
//     docs/deletion/repair06-cross-contract-certification-2026-09-09.md.
//
// A note on coupling, updated after PR #375. When this file was first written
// the backend was not on this branch, so the mapping below was recorded as
// fixtures with documented provenance. PR #375 has since converged the Repair
// 06 backend onto this line, so `supabase/functions/deletion-status/index.ts`
// is now present here. The fixtures are deliberately KEPT — they are stable,
// readable, and independent of how the backend is structured — but they are no
// longer trusted on their word: the final test in this file loads the real
// backend module and proves every fixture matches what it actually returns, so
// fixture drift fails loudly instead of silently certifying a stale contract.

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

const RECEIPT_REL = 'services/deletion/statusReceipt.ts';
const CLIENT_REL = 'services/deletion/deletionStatusClient.ts';
const DECISION_REL = 'services/deletion/terminalDeletionDecision.ts';

const nodeCrypto = require('node:crypto');

const RECEIPT = evaluate(RECEIPT_REL, (spec) => {
  if (spec === 'expo-crypto') {
    return { getRandomValues: (a) => nodeCrypto.webcrypto.getRandomValues(a) };
  }
  throw new Error(`unexpected statusReceipt import: ${spec}`);
});

const DECISION = evaluate(DECISION_REL, (spec) => {
  throw new Error(`terminalDeletionDecision must stay pure; got import: ${spec}`);
});

/** The real client, wired to a supplied `functions.invoke` implementation. */
function loadClient(invokeImpl) {
  return evaluate(CLIENT_REL, (spec) => {
    if (spec === './statusReceipt') return RECEIPT;
    if (spec === '../supabaseClient') {
      return { supabase: { functions: { invoke: invokeImpl } } };
    }
    throw new Error(`unexpected deletionStatusClient import: ${spec}`);
  });
}

/**
 * The exact internal status vocabulary the staging database accepts, read from
 * `deletion_requests_status_check` on 2026-09-09. Recorded here so that a
 * future migration widening the vocabulary makes this test's coverage
 * assertion fail rather than silently leaving a new status uncertified.
 */
const DB_STATUS_VOCABULARY = [
  'pending',
  'processing',
  'completed',
  'rejected',
  'cancelled',
  'deactivated',
  'restored',
  'purging',
  'purged',
  'failed',
  'legal_hold',
];

const PURGED_AT = '2026-09-09T01:00:00.000Z';
const RESTORED_AT = '2026-09-09T02:00:00.000Z';

/**
 * The Repair 06 response for a given internal status, exactly as the deployed
 * backend produces it. `purged` is the only status that yields a body whose
 * `purgeAuthorized` is true, and only when `purged_at` is present.
 */
function repair06ResponseFor(internalStatus) {
  switch (internalStatus) {
    case 'purged':
      return { state: 'purged', purgeAuthorized: true, purgedAt: PURGED_AT };
    case 'restored':
      return { state: 'restored', purgeAuthorized: false, restoredAt: RESTORED_AT };
    case 'cancelled':
    case 'rejected':
      return { state: 'restored', purgeAuthorized: false };
    case 'failed':
      return { state: 'failed', purgeAuthorized: false };
    // pending / processing / deactivated / purging / legal_hold / completed
    default:
      return { state: 'pending', purgeAuthorized: false };
  }
}

/** supabase-js `functions.invoke` semantics for a 2xx body. */
function okInvoker(body) {
  return async () => ({ data: body, error: null });
}

/** supabase-js surfaces a non-2xx as an error carrying the raw Response. */
function httpInvoker(status, errorCode) {
  return async () => {
    const error = new Error('FunctionsHttpError');
    error.context = {
      status,
      json: async () => (errorCode === undefined ? {} : { error: errorCode }),
    };
    return { data: null, error };
  };
}

async function resolveAction(invokeImpl, binding = 'bound') {
  const client = loadClient(invokeImpl);
  const outcome = await client.fetchDeletionStatus(RECEIPT.generateStatusReceipt());
  return { outcome, decision: DECISION.decideTerminalAction(outcome, binding) };
}

// ===========================================================================
// THE FULL CHAIN — internal status through to the client's action
// ===========================================================================

test('CHAIN: every internal deletion status resolves to the correct client action', async () => {
  const expectedAction = {
    pending: 'retain',
    processing: 'retain',
    completed: 'retain',
    deactivated: 'retain',
    purging: 'retain',
    legal_hold: 'retain',
    failed: 'retain',
    restored: 'release',
    cancelled: 'release',
    rejected: 'release',
    purged: 'purge',
  };

  // Coverage is asserted against the recorded database vocabulary, so a new
  // status added by a later migration cannot slip through uncertified.
  assert.deepEqual(
    Object.keys(expectedAction).sort(),
    [...DB_STATUS_VOCABULARY].sort(),
    'every internal status in the database vocabulary must be certified here',
  );

  for (const status of DB_STATUS_VOCABULARY) {
    const { decision } = await resolveAction(okInvoker(repair06ResponseFor(status)));
    assert.equal(
      decision.action,
      expectedAction[status],
      `internal status '${status}' must resolve to '${expectedAction[status]}'`,
    );
  }
});

test('CHAIN: exactly one internal status in the whole vocabulary can authorise destruction', async () => {
  const authorising = [];
  for (const status of DB_STATUS_VOCABULARY) {
    const { decision } = await resolveAction(okInvoker(repair06ResponseFor(status)));
    if (decision.action === 'purge') authorising.push(status);
  }
  assert.deepEqual(
    authorising,
    ['purged'],
    'only a genuinely purged lifecycle may ever authorise local destruction',
  );
});

test('CHAIN: a purged lifecycle that cannot say WHEN it purged is refused', async () => {
  // The backend reports `purged` with purgeAuthorized false when purged_at is
  // absent. The database constraint currently makes that row unreachable, but
  // a later migration could drop the constraint, so the client must refuse it
  // on the boolean alone.
  const { outcome, decision } = await resolveAction(
    okInvoker({ state: 'purged', purgeAuthorized: false }),
  );
  assert.equal(outcome.kind, 'lifecycle');
  assert.equal(outcome.state, 'purged');
  assert.equal(decision.action, 'retain');
  assert.equal(decision.reason, 'purged_unauthorized');
});

test('CHAIN: purgeAuthorized beside a non-terminal state is an inconsistency, never a permission', async () => {
  for (const state of ['pending', 'restored', 'failed']) {
    const { decision } = await resolveAction(okInvoker({ state, purgeAuthorized: true }));
    assert.notEqual(
      decision.action,
      'purge',
      `purgeAuthorized beside '${state}' must never authorise destruction`,
    );
  }
});

// ===========================================================================
// CONTRACT SURFACE — the client must reject anything outside the agreed shape
// ===========================================================================

test('CONTRACT: the client accepts exactly the four public states and nothing else', async () => {
  const client = loadClient(okInvoker(null));
  assert.deepEqual(
    [...client.PUBLIC_DELETION_STATES],
    ['pending', 'restored', 'failed', 'purged'],
    'the public vocabulary is the Repair 06 contract and must not drift',
  );

  // An internal status leaking through unmapped would be a backend contract
  // break; the client must fail closed rather than guess at it.
  for (const leaked of ['deactivated', 'purging', 'legal_hold', 'completed', 'cancelled']) {
    const { outcome, decision } = await resolveAction(
      okInvoker({ state: leaked, purgeAuthorized: false }),
    );
    assert.equal(outcome.kind, 'malformed', `a leaked internal status '${leaked}' is malformed`);
    assert.equal(decision.action, 'retain');
  }
});

test('CONTRACT: purgeAuthorized must be a real boolean — no truthy stand-ins', async () => {
  for (const value of ['true', 1, 'yes', [], {}]) {
    const { outcome, decision } = await resolveAction(
      okInvoker({ state: 'purged', purgeAuthorized: value }),
    );
    assert.equal(outcome.kind, 'malformed', `purgeAuthorized=${JSON.stringify(value)} is malformed`);
    assert.equal(decision.action, 'retain');
  }
});

test('CONTRACT: every Repair 06 error status maps to a non-destructive client outcome', async () => {
  const cases = [
    [httpInvoker(400, 'invalid_request'), 'invalid_request'],
    [httpInvoker(404, 'not_found'), 'not_found'],
    [httpInvoker(405, 'method_not_allowed'), 'endpoint_unavailable'],
    [httpInvoker(503, 'unavailable'), 'unavailable'],
  ];
  for (const [invoker, expectedKind] of cases) {
    const { outcome, decision } = await resolveAction(invoker);
    assert.equal(outcome.kind, expectedKind);
    assert.equal(decision.action, 'retain', `${expectedKind} must never destroy local data`);
  }
});

test('CONTRACT: a project without Repair 06 deployed degrades to endpoint_unavailable, never a purge', async () => {
  // The gateway answers 404 WITHOUT the endpoint's own `not_found` code when
  // the function is not deployed at all. That is a deployment fact, not a
  // lifecycle answer, and it must be distinguishable from a real miss.
  const { outcome, decision } = await resolveAction(httpInvoker(404, undefined));
  assert.equal(outcome.kind, 'endpoint_unavailable');
  assert.equal(decision.action, 'retain');
});

test('CONTRACT: an unbound or unsupported binding refuses even a valid terminal answer', async () => {
  for (const binding of ['unbound', 'unsupported']) {
    const { decision } = await resolveAction(
      okInvoker({ state: 'purged', purgeAuthorized: true, purgedAt: PURGED_AT }),
      binding,
    );
    assert.equal(decision.action, 'retain');
    assert.equal(decision.reason, `binding_${binding}`);
  }
});

// ===========================================================================
// RECEIPT FORMAT — the two sides must agree byte for byte
// ===========================================================================

test('RECEIPT: the client format matches the Repair 06 backend format exactly', () => {
  // ksdel_v1_ + 43 unpadded base64url chars = 52. Asserted against the values
  // recorded in the backend's own statusReceipt.ts on the authority branch.
  assert.equal(RECEIPT.STATUS_RECEIPT_PREFIX, 'ksdel_v1_');
  assert.equal(RECEIPT.STATUS_RECEIPT_BYTES, 32);
  assert.equal(RECEIPT.STATUS_RECEIPT_LENGTH, 52);

  const receipt = RECEIPT.generateStatusReceipt();
  assert.equal(receipt.length, 52);
  assert.match(receipt, /^ksdel_v1_[A-Za-z0-9_-]{43}$/);

  // The backend hashes with SHA-256 lowercase hex and stores only that. The
  // client must never need to reproduce the hash, but the receipt it generates
  // must be hashable to the same 64-char digest the backend indexes on.
  const digest = nodeCrypto.createHash('sha256').update(receipt).digest('hex');
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('RECEIPT: a locally malformed capability never reaches the network', async () => {
  let calls = 0;
  const client = loadClient(async () => {
    calls += 1;
    return { data: null, error: null };
  });
  const outcome = await client.fetchDeletionStatus('ksdel_v1_not-a-valid-capability');
  assert.equal(outcome.kind, 'invalid_request');
  assert.equal(calls, 0, 'a malformed receipt must be rejected before any request is sent');
});

// ===========================================================================
// FIXTURE FIDELITY — the fixtures above must equal the real backend's output
// ===========================================================================

test('FIDELITY: every fixture matches what the real deployed backend actually returns', async () => {
  // PR #375 converged the Repair 06 backend onto this branch, so the real
  // handler can be executed here. This test is what stops `repair06ResponseFor`
  // from quietly drifting away from `evaluateLifecycle`: it runs the REAL
  // backend module over the same 11-status vocabulary and asserts the bodies
  // are identical, field for field.
  //
  // The backend targets Deno and calls `Deno.serve` at module load, so a
  // minimal stub is installed for the duration of the load. Nothing else about
  // the module is substituted — `evaluateLifecycle` is the real exported
  // function, and the lookup seam is the module's own documented override.
  const backendRel = 'supabase/functions/deletion-status/index.ts';
  const receiptRel = 'supabase/functions/_shared/deletion/statusReceipt.ts';
  assert.ok(fs.existsSync(path.join(ROOT, backendRel)), 'Repair 06 backend source must be present');

  const previousDeno = globalThis.Deno;
  globalThis.Deno = { serve: () => {}, env: { get: () => undefined } };
  let backend;
  try {
    const backendReceipt = evaluate(receiptRel, () => {
      throw new Error('the backend receipt module must have zero imports');
    });
    backend = evaluate(backendRel, (spec) => {
      if (spec === '../_shared/deletion/statusReceipt.ts') return backendReceipt;
      throw new Error(`unexpected backend import: ${spec}`);
    });
  } finally {
    if (previousDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = previousDeno;
  }

  for (const status of DB_STATUS_VOCABULARY) {
    const row = {
      status,
      purged_at: status === 'purged' ? PURGED_AT : null,
      restored_at: status === 'restored' ? RESTORED_AT : null,
    };
    const real = backend.evaluateLifecycle(row);
    const fixture = repair06ResponseFor(status);
    assert.deepEqual(
      real,
      fixture,
      `fixture for internal status '${status}' has drifted from the real backend`,
    );
  }

  // And the two inconsistent rows the decision table depends on.
  assert.deepEqual(
    backend.evaluateLifecycle({ status: 'purged', purged_at: null, restored_at: null }),
    { state: 'purged', purgeAuthorized: false },
    'a purged row with no purged_at must not authorise a purge',
  );
  assert.deepEqual(
    backend.evaluateLifecycle({ status: 'purging', purged_at: PURGED_AT, restored_at: null }),
    { state: 'pending', purgeAuthorized: false },
    'purged_at under a non-purged status must fail closed',
  );

  // The receipt format the two sides agree on is one constant, not two.
  const clientLength = RECEIPT.STATUS_RECEIPT_LENGTH;
  assert.equal(backend.STATUS_RECEIPT_LENGTH, clientLength, 'receipt length must not diverge');
});
