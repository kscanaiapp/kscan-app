// Build 34 Phase 3A — deletion worker activation safety.
//
// FINDING A. The worker chose its destructive mode with
//
//     dryRun = envDryRun || dryRunFlag || !enabled
//
// where `dryRunFlag` came from readAppConfigFlag(), which collapses "row
// absent", "value malformed" and "lookup failed" all into `false`. For the
// kill switch (`*_worker_enabled`) that collapse is correct -- uncertainty
// means "do not run". For the INVERTED safety flag it was backwards: an
// enabled worker whose dry-run row could not be positively read resolved to
// LIVE and began permanently erasing accounts. Uncertainty about the
// destructive-mode control authorized destruction.
//
// FINDING B. The backend authority's deletion registry was one entry behind
// the contract certified in staging: `watchlist_push_receipts` was present in
// the release tree and in the staging-deployed worker, and absent here.
// Promoting backend authority verbatim would have deployed a deletion
// contract smaller than the one that was actually certified.
//
// HOW THIS FILE PROVES IT. The mode decision is exercised by EXECUTING the
// real `resolveDeletionWorkerMode` and the real `readAppConfigFlagState` out
// of _shared/deletion/workerMode.ts (layered on the real common.ts, so the
// genuine rest() call path runs), transpiled into a vm sandbox -- the same
// seam __tests__/appleRevocationParity.test.js uses to prove the real Apple
// module. The Boolean is deliberately NOT restated here: a second copy of the
// formula would only prove the test agrees with itself. The worker's own
// index.ts cannot execute under Node (Deno.serve, npm: specifiers), so its
// WIRING is asserted from source, exactly as
// __tests__/automatedDeletionAppleRevocation.test.js documents and does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const DELETION_DIR = path.join(ROOT, 'supabase', 'functions', '_shared', 'deletion');
const COMMON_PATH = path.join(DELETION_DIR, 'common.ts');
const WORKER_MODE_PATH = path.join(DELETION_DIR, 'workerMode.ts');
const WORKER = read('supabase', 'functions', 'process-account-deletions', 'index.ts');

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

function runModule(file, fetchImpl, requireMap = {}) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (spec) => (spec in requireMap ? requireMap[spec] : {}),
    console: { log() {}, warn() {}, error() {} },
    fetch: fetchImpl,
    Deno: {
      env: {
        get: (k) => ({ SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' })[k],
      },
    },
    Response,
    TextEncoder,
    JSON,
    Array,
    Object,
    String,
    Boolean,
    Number,
    Promise,
    Date,
    Math,
    URL,
    crypto,
    encodeURIComponent,
  };
  sandbox.module.exports = sandbox.exports;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(transpile(file), sandbox, { filename: path.relative(ROOT, file) });
  return sandbox.module.exports;
}

/**
 * Loads the REAL workerMode.ts on top of the REAL common.ts, so
 * readAppConfigFlagState runs through the genuine rest() call path rather
 * than a stub of the code under test.
 */
function loadCommon(fetchImpl) {
  const common = runModule(COMMON_PATH, fetchImpl);
  return runModule(WORKER_MODE_PATH, fetchImpl, { './common.ts': common });
}

/** A fetch that answers the app_config lookup with a chosen body/status. */
function respondWith({ status = 200, body = [], invalidJson = false, throws = false } = {}) {
  return async () => {
    if (throws) throw new Error('network down');
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (invalidJson) throw new Error('not json');
        return body;
      },
    };
  };
}

const OK = (value) => ({ body: [{ value }] });

// ── The real resolver: the full §7 activation-safety matrix ─────────────────

const STATES = ['explicit_true', 'explicit_false', 'missing', 'malformed', 'read_error'];

test('resolver: LIVE requires explicit enabled=true AND explicit dry_run=false', () => {
  const { resolveDeletionWorkerMode } = loadCommon(respondWith());
  assert.equal(
    resolveDeletionWorkerMode({ enabled: 'explicit_true', dryRun: 'explicit_false', envDryRun: false }),
    'live',
  );
});

test('resolver: with the kill switch off, EVERY dry-run state is non-destructive', () => {
  const { resolveDeletionWorkerMode } = loadCommon(respondWith());
  for (const enabled of ['explicit_false', 'missing', 'malformed', 'read_error']) {
    for (const dryRun of STATES) {
      assert.equal(
        resolveDeletionWorkerMode({ enabled, dryRun, envDryRun: false }),
        'dry_run',
        `enabled=${enabled} dry_run=${dryRun} must not be live`,
      );
    }
  }
});

test('resolver: THE REPAIR — enabled=true plus an uncertain dry-run state resolves to dry-run', () => {
  const { resolveDeletionWorkerMode } = loadCommon(respondWith());
  for (const dryRun of ['missing', 'malformed', 'read_error']) {
    assert.equal(
      resolveDeletionWorkerMode({ enabled: 'explicit_true', dryRun, envDryRun: false }),
      'dry_run',
      `an uncertain dry-run state (${dryRun}) must never authorize erasure`,
    );
  }
});

test('resolver: enabled=true with an explicit dry_run=true stays dry-run', () => {
  const { resolveDeletionWorkerMode } = loadCommon(respondWith());
  assert.equal(
    resolveDeletionWorkerMode({ enabled: 'explicit_true', dryRun: 'explicit_true', envDryRun: false }),
    'dry_run',
  );
});

test('resolver: the environment override can force safety from ANY state', () => {
  const { resolveDeletionWorkerMode } = loadCommon(respondWith());
  for (const enabled of STATES) {
    for (const dryRun of STATES) {
      assert.equal(
        resolveDeletionWorkerMode({ enabled, dryRun, envDryRun: true }),
        'dry_run',
        `env override must dominate (enabled=${enabled} dry_run=${dryRun})`,
      );
    }
  }
});

test('resolver: exactly ONE of the 25 flag combinations is destructive', () => {
  const { resolveDeletionWorkerMode } = loadCommon(respondWith());
  const live = [];
  for (const enabled of STATES) {
    for (const dryRun of STATES) {
      if (resolveDeletionWorkerMode({ enabled, dryRun, envDryRun: false }) === 'live') {
        live.push(`${enabled}/${dryRun}`);
      }
    }
  }
  assert.deepEqual(live, ['explicit_true/explicit_false']);
});

// ── The real reader: uncertainty is classified, never collapsed ─────────────

test('reader: an explicit boolean is reported as explicit', async () => {
  assert.equal(
    await loadCommon(respondWith(OK({ enabled: true }))).readAppConfigFlagState('k'),
    'explicit_true',
  );
  assert.equal(
    await loadCommon(respondWith(OK({ enabled: false }))).readAppConfigFlagState('k'),
    'explicit_false',
  );
});

test('reader: an absent row or null value is MISSING, not false', async () => {
  assert.equal(await loadCommon(respondWith({ body: [] })).readAppConfigFlagState('k'), 'missing');
  assert.equal(await loadCommon(respondWith(OK(null))).readAppConfigFlagState('k'), 'missing');
});

test('reader: a failed lookup is READ_ERROR, not false', async () => {
  assert.equal(
    await loadCommon(respondWith({ status: 500 })).readAppConfigFlagState('k'),
    'read_error',
  );
  assert.equal(
    await loadCommon(respondWith({ throws: true })).readAppConfigFlagState('k'),
    'read_error',
  );
});

test('reader: truthy non-booleans are MALFORMED and are never coerced', async () => {
  // The old reader used Boolean(value.enabled), so "false" (a non-empty
  // string) would have read as TRUE. Intent that was never expressed as a
  // boolean must not become an instruction.
  for (const enabled of ['true', 'false', 1, 0, 'yes', {}, []]) {
    assert.equal(
      await loadCommon(respondWith(OK({ enabled }))).readAppConfigFlagState('k'),
      'malformed',
      `enabled=${JSON.stringify(enabled)} must be malformed`,
    );
  }
});

test('reader: a value with no enabled field, a non-object value, or unparseable JSON is MALFORMED', async () => {
  assert.equal(await loadCommon(respondWith(OK({}))).readAppConfigFlagState('k'), 'malformed');
  assert.equal(await loadCommon(respondWith(OK('enabled'))).readAppConfigFlagState('k'), 'malformed');
  assert.equal(await loadCommon(respondWith(OK([1]))).readAppConfigFlagState('k'), 'malformed');
  assert.equal(
    await loadCommon(respondWith({ body: { not: 'an array' } })).readAppConfigFlagState('k'),
    'malformed',
  );
  assert.equal(
    await loadCommon(respondWith({ invalidJson: true })).readAppConfigFlagState('k'),
    'malformed',
  );
});

// ── Reader composed with resolver: the end-to-end activation decision ───────

async function modeFor(enabledResponse, dryRunResponse, envDryRun = false) {
  // One sandbox, answering each key from the real rest() call path.
  const fetchImpl = async (url) => {
    const which = String(url).includes('worker_enabled') ? enabledResponse : dryRunResponse;
    return respondWith(which)();
  };
  const mod = loadCommon(fetchImpl);
  const enabled = await mod.readAppConfigFlagState('account_deletion_worker_enabled');
  const dryRun = await mod.readAppConfigFlagState('account_deletion_worker_dry_run');
  return mod.resolveDeletionWorkerMode({ enabled, dryRun, envDryRun });
}

test('end-to-end: the production posture today (enabled=false, dry_run=true) is non-destructive', async () => {
  assert.equal(await modeFor(OK({ enabled: false }), OK({ enabled: true })), 'dry_run');
});

test('end-to-end: an owner-authorized explicit live configuration still reaches LIVE', async () => {
  // The repair must not make permanent deletion impossible.
  assert.equal(await modeFor(OK({ enabled: true }), OK({ enabled: false })), 'live');
});

test('end-to-end: enabled=true with a MISSING dry-run row is dry-run', async () => {
  assert.equal(await modeFor(OK({ enabled: true }), { body: [] }), 'dry_run');
});

test('end-to-end: enabled=true with an UNREADABLE dry-run lookup is dry-run', async () => {
  assert.equal(await modeFor(OK({ enabled: true }), { status: 500 }), 'dry_run');
  assert.equal(await modeFor(OK({ enabled: true }), { throws: true }), 'dry_run');
});

test('end-to-end: enabled=true with a MALFORMED dry-run value is dry-run', async () => {
  assert.equal(await modeFor(OK({ enabled: true }), OK({})), 'dry_run');
  assert.equal(await modeFor(OK({ enabled: true }), OK({ enabled: 'false' })), 'dry_run');
});

test('end-to-end: the emergency environment override forces dry-run over a live configuration', async () => {
  assert.equal(await modeFor(OK({ enabled: true }), OK({ enabled: false }), true), 'dry_run');
});

// ── Worker wiring (source, per the established Edge-function precedent) ─────

test('worker: selects its mode through the fail-safe reader and resolver', () => {
  assert.match(
    WORKER,
    /import \{\s*readAppConfigFlagState,\s*resolveDeletionWorkerMode,?\s*\} from '\.\.\/_shared\/deletion\/workerMode\.ts';/,
  );
  assert.match(WORKER, /readAppConfigFlagState\('account_deletion_worker_enabled'\)/);
  assert.match(WORKER, /readAppConfigFlagState\('account_deletion_worker_dry_run'\)/);
  assert.match(WORKER, /resolveDeletionWorkerMode\(\{/);
});

test('worker: the collapsed boolean form is gone from executable code', () => {
  // The old formula survives only inside the explanatory comment above the
  // repair; it must not be reachable code.
  const executable = WORKER.split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  assert.ok(
    !/dryRunFlag/.test(executable),
    'the collapsed dry-run boolean must not survive in executable worker code',
  );
  assert.ok(
    !/readAppConfigFlag\(/.test(executable),
    'the worker must not read its safety flags through the collapsing reader',
  );
});

test('worker: there is no environment variable that can force LIVE mode', () => {
  const envReads = [...WORKER.matchAll(/Deno\.env\.get\('([A-Z0-9_]+)'\)/g)].map((m) => m[1]);
  assert.ok(envReads.includes('DELETION_WORKER_DRY_RUN'), 'the safety override must still exist');
  for (const name of envReads) {
    assert.ok(
      !/LIVE|FORCE|ENABLE/.test(name),
      `${name} looks like an environment path to live mode, which must not exist`,
    );
  }
});

test('worker: the dry-run branch returns before any destructive step', () => {
  const start = WORKER.indexOf('if (dryRun) {');
  assert.ok(start > 0, 'could not locate the dry-run branch');
  const end = WORKER.indexOf("mode: 'dry_run'", start);
  assert.ok(end > start, 'could not locate the dry-run response');
  const branch = WORKER.slice(start, end);
  for (const destructive of [
    'claim_deletion_requests_for_purge',
    'auth.admin.deleteUser',
    'requestAppleRevocation',
    'retireMirroredEntitlement',
    'deleteOwnedStorage',
    'schedule_deletion_retry_or_fail',
    'mark_deletion_request_purged',
  ]) {
    assert.ok(
      !branch.includes(destructive),
      `the dry-run branch must never reach ${destructive}`,
    );
  }
  // The orphan sweep is reached, but only in its non-mutating form.
  assert.match(branch, /sweepOrphanedOwnerMedia\(supabase, \{ dryRun: true \}\)/);
});

// ── Finding B: the registry reproduces the certified contract ───────────────

const EDGE_REGISTRY = read('supabase', 'functions', '_shared', 'deletion', 'userDataResources.ts');
const NODE_REGISTRY = JSON.parse(read('lib', 'account-deletion', 'user-data-resources.json'));

const CERTIFIED_ENTRY = {
  table: 'watchlist_push_receipts',
  column: 'user_id',
  action: 'auth_delete_cascade',
  optional: true,
};

test('registry: the staging-certified watchlist_push_receipts resource is covered', () => {
  // Recovered from the tree that the staging-certified worker was built from
  // (release/kscan-pre-freeze-v1, provenance faa02c39), not written from
  // memory. Backend authority is the production-promotion source, so a
  // deletion contract SMALLER than the certified one must not ship from here.
  const entry = NODE_REGISTRY.tables.find((t) => t.table === CERTIFIED_ENTRY.table);
  assert.ok(entry, 'watchlist_push_receipts is missing from the deletion registry');
  assert.deepEqual(entry, CERTIFIED_ENTRY);
  assert.match(
    EDGE_REGISTRY,
    /\{ table: 'watchlist_push_receipts', column: 'user_id', action: 'auth_delete_cascade', optional: true \},/,
  );
});

test('registry: the resource is OPTIONAL, so an environment without the table still purges', () => {
  // Watchlist is not promoted to production, so the table is absent there.
  // `optional: true` is what lets countResourceRows treat a missing table as
  // covered instead of failing the purge -- see the optional_missing branch.
  const entry = NODE_REGISTRY.tables.find((t) => t.table === CERTIFIED_ENTRY.table);
  assert.equal(entry.optional, true);
  assert.match(WORKER, /if \(resource\.optional && isMissingResourceError\(result\.error\)\)/);
  assert.match(WORKER, /notes: 'optional_missing'/);
});

test('registry: where the table DOES exist it is really covered, not merely listed', () => {
  // A registry entry only participates in counting and post-purge residual
  // verification if it names a column; a null column is excluded from both.
  const entry = NODE_REGISTRY.tables.find((t) => t.table === CERTIFIED_ENTRY.table);
  assert.equal(entry.column, 'user_id');
  assert.notEqual(entry.action, 'survive_auth_delete');
  // Residual verification counts every non-surviving resource with a column,
  // so a table that exists and still holds rows fails the purge rather than
  // being quietly recorded as complete.
  assert.match(
    WORKER,
    /resource\.action !== 'survive_auth_delete'\s*&&\s*typeof row\.count === 'number'\s*&&\s*row\.count > 0/,
  );
});
