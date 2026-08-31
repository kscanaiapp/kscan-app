// VTO-QUOTA-001 / VTO-QUOTA-002 -- the paid-generation cap must actually cap.
//
// WHAT WENT WRONG
//
// SEC-KPLUS-004 declared its own invariant: "Quota is counted over ATTEMPTS
// today, not successes: a provider failure still consumed a paid call, so
// counting only successes would let a failing key be retried without bound."
// Neither half of the system delivered it.
//
//   * reserve_vto_generation derived `used` from count(*) over today's ROWS,
//     while a re-reservation of an existing key updates that row IN PLACE via
//     `on conflict ... do update`. The count never moved.
//
//   * services/vto/vtoClient.ts never sent `requestGeneration`, so
//     buildVtoIdempotencyKey resolved it to 'default' and produced ONE CONSTANT
//     key per (actor, product, photo) -- including across the user's own Retry.
//
// Together those made the shipped Retry button an unbounded paid-provider loop.
// Proven live on staging 2026-08-31: 30 reserve calls, one constant key,
// p_daily_limit = 10 -> 30 'reserved', 0 'quota_exceeded', 1 row.
//
// The pre-existing suite went green over all of it: vtoPaidBoundary.test.ts
// asserts only that DIFFERENT requestGeneration values produce different keys,
// which was true and irrelevant, because nothing ever sent one.
//
// These tests pin both halves. They are deliberately behavioural where they can
// be (the client body is built by the real transport) and source-level only for
// the SQL, which node cannot execute.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function loadModule(relative, requireMap = {}) {
  const absPath = path.join(ROOT, relative);
  const output = ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(absPath)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: absPath }).runInContext(sandbox);
  return mod.exports;
}

const clientTypes = loadModule('types/vto.ts');
const failures = loadModule('services/vto/vtoFailures.ts', { '../../types/vto': clientTypes });

function loadClient(invoke) {
  return loadModule('services/vto/vtoClient.ts', {
    '../supabaseClient': { supabase: { functions: { invoke: () => {} } } },
    '../authenticatedFunctionSession': {
      resolveAuthenticatedFunctionSession: () => Promise.resolve({ ok: true, accessToken: 't' }),
    },
    './vtoFailures': failures,
    '../../types/vto': clientTypes,
  });
}

const GARMENT = {
  productRef: 'prod-1',
  imageUrl: 'https://retailer.example/g.jpg',
  category: 'top',
  brand: 'Brand',
  commerceSource: 'serper',
};

/** Runs the real transport and hands back the body it actually posted. */
async function capturedBody(extraArgs) {
  let seen = null;
  const client = loadClient();
  await client.requestVtoGeneration(
    {
      requestId: 'req-1',
      origin: 'commerce_product',
      garment: GARMENT,
      personDataUri: 'AAAA',
      ...extraArgs,
    },
    {
      invoke: async (_slug, options) => {
        seen = options.body;
        return { data: { requestId: 'req-1', status: 'success' }, error: null };
      },
      resolveSession: async () => ({ ok: true, accessToken: 't' }),
    },
  );
  return seen;
}

// ── The client half ─────────────────────────────────────────────────────────

test('VTO-QUOTA-001: the transport SENDS requestGeneration when given one', async () => {
  const body = await capturedBody({ requestGeneration: '2' });
  assert.equal(
    body.requestGeneration,
    '2',
    'the server derives its idempotency identity from this field; omitting it collapses every attempt onto one key',
  );
});

test('an absent requestGeneration is omitted rather than sent as undefined', async () => {
  const body = await capturedBody({});
  assert.equal(
    Object.prototype.hasOwnProperty.call(body, 'requestGeneration'),
    false,
    'an explicit undefined would serialize into the body and defeat the server default',
  );
});

test('NEGATIVE CONTROL: the store passes its RETRY COUNT as the attempt generation', () => {
  const store = read('services/vto/vtoRequestStore.ts');
  // The store token (`generation`) changes on every start/cancel/reset. Using it
  // would give two rapid taps two different keys and defeat duplicate
  // suppression -- the opposite defect. Only the retry count marks a deliberate
  // new attempt, so that is what must be sent.
  assert.match(
    store,
    /requestGeneration:\s*String\(current\.retryCount\)/,
    'vtoRequestStore must send the retry count as requestGeneration',
  );
  assert.doesNotMatch(
    store,
    /requestGeneration:\s*String\(token\)/,
    'the monotonic store token must NOT be used: it would break two-tap collapsing',
  );
});

test('retryVtoGeneration increments the count BEFORE the attempt reads it', () => {
  const store = read('services/vto/vtoRequestStore.ts');
  const retryBody = store.slice(store.indexOf('export async function retryVtoGeneration'));
  const bumpAt = retryBody.indexOf('retryCount: current.retryCount + 1');
  const startAt = retryBody.indexOf('await startVtoGeneration(options)');
  assert.ok(bumpAt > -1 && startAt > -1, 'retry must bump the count and then start a generation');
  assert.ok(
    bumpAt < startAt,
    'the bump must be committed to the snapshot before startVtoGeneration reads it, or a Retry reuses the previous key',
  );
});

// ── The SQL half ────────────────────────────────────────────────────────────

const REPAIR = 'supabase/migrations/20260831160000_vto_paid_quota_attempt_counting.sql';

test('VTO-QUOTA-001: the daily cap counts ATTEMPTS, never rows', () => {
  const sql = read(REPAIR);
  assert.match(
    sql,
    /select\s+coalesce\(sum\(attempts\),\s*0\)::int\s+into\s+v_used/,
    'the quota read must sum attempts',
  );
  assert.doesNotMatch(
    sql,
    /count\(\*\)::int\s+into\s+v_used/,
    'counting rows is the original defect: an in-place update never grows the row count',
  );
  assert.match(
    sql,
    /attempts\s*=\s*case[\s\S]*?attempts\s*\+\s*1[\s\S]*?else\s*1[\s\S]*?end/i,
    're-reserving a key must increment attempts, and a key carried over from an earlier day must restart at 1',
  );
});

test('VTO-QUOTA-002: the advisory lock is ACTOR-scoped, not key-scoped', () => {
  const sql = read(REPAIR);
  assert.match(
    sql,
    /pg_advisory_xact_lock\(hashtextextended\(p_user_id::text,\s*0\)\)/,
    'the lock must cover the whole actor so the quota read and the insert are atomic against sibling requests',
  );
  assert.doesNotMatch(
    sql,
    /hashtextextended\(p_user_id::text\s*\|\|\s*':'\s*\|\|\s*v_key/,
    'a (actor, key) lock leaves distinct-key requests unserialized against the quota count',
  );
});

test('the repair does not weaken any control SEC-KPLUS-004 already established', () => {
  const sql = read(REPAIR);
  // Fail-closed posture, lease semantics and the service_role-only grant are
  // load-bearing and must survive this migration untouched.
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public/);
  assert.match(sql, /make_interval\(mins => v_lease\)/, 'the lease window must be preserved');
  assert.match(sql, /v_existing\.status = 'succeeded'/, 'succeeded still replays rather than re-runs');
  assert.match(
    sql,
    /revoke all on function public\.reserve_vto_generation\(uuid, text, integer, integer\) from public, anon, authenticated/,
  );
  assert.match(
    sql,
    /grant execute on function public\.reserve_vto_generation\(uuid, text, integer, integer\) to service_role/,
  );
  // The table must stay a digest-only store.
  assert.doesNotMatch(sql, /person_data_uri|personDataUri|base64/i);
});

test('the attempts column is constrained to a real count', () => {
  const sql = read(REPAIR);
  assert.match(sql, /add column if not exists attempts integer not null default 1/);
  assert.match(sql, /check \(attempts >= 1\)/);
});
