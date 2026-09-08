// RP-06C — privacy-correction-request / privacy-data-export account-state
// reconciliation.
//
// Neither file can be executed directly under Node: both are Deno.serve()
// Edge Functions (Deno.env, npm: specifiers). This is the same constraint
// documented in __tests__/automatedDeletionAppleRevocation.test.js and
// __tests__/kplusEdgeContract.test.js (kplus-activate -- which already calls
// this exact assertAccountActive primitive the same way these two functions
// now do) -- and this file follows that established, already-governed
// convention: source-order and wiring assertions prove the CALL SITE, while
// __tests__/assertAccountActiveBehavior.test.js proves the actual security
// DECISION by real execution of the real _shared/deletion/common.ts module.
//
// Order-of-operations / zero-side-effect proof: assertAccountActive() throws
// (a Response) synchronously into the surrounding try/catch. Structurally,
// nothing after its call site in source order can execute for a blocked
// actor -- there is no other statement between requireUser() and
// assertAccountActive() that could itself be a side effect, so "the guard
// runs before every durable write" is provable from source order alone for
// this shape of file, exactly as the pre-existing Apple-revocation ordering
// tests already rely on for process-account-deletions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const FUNCTIONS = [
  {
    name: 'privacy-correction-request',
    source: read('supabase', 'functions', 'privacy-correction-request', 'index.ts'),
    rateLimitAction: 'privacy_correction',
    insertTable: 'privacy_correction_requests',
  },
  {
    name: 'privacy-data-export',
    source: read('supabase', 'functions', 'privacy-data-export', 'index.ts'),
    rateLimitAction: 'privacy_export',
    insertTable: 'privacy_export_requests',
  },
];

for (const fn of FUNCTIONS) {
  test(`${fn.name}: imports the governed account-state guard, not a second definition of "active"`, () => {
    assert.match(
      fn.source,
      /import \{ assertAccountActive \} from '\.\.\/_shared\/deletion\/common\.ts';/,
      'must reuse the governed canonical assertAccountActive helper',
    );
    // No inline re-implementation of the production-style check -- this
    // reconciliation is a reuse, not a second competing authority. Matched as
    // code usage (a property access), not as a bare word, so this survives
    // prose in an explanatory comment that names the same column.
    assert.doesNotMatch(fn.source, /account_status\s*!==\s*['"]active['"]/);
    assert.doesNotMatch(fn.source, /\.\s*account_locked_at\b/);
  });

  test(`${fn.name}: exactly one assertAccountActive call site`, () => {
    const matches = fn.source.match(/assertAccountActive\(user\.id\)/g) ?? [];
    assert.equal(matches.length, 1, 'exactly one call to assertAccountActive(user.id)');
  });

  test(`${fn.name}: account-state gate runs immediately after requireUser, before rate limiting and before any durable write`, () => {
    const requireIdx = fn.source.indexOf('const user = await requireUser(req);');
    const gateIdx = fn.source.indexOf('await assertAccountActive(user.id);');
    const rateIdx = fn.source.indexOf(`reservePrivacyRequestRateLimit(user.id, '${fn.rateLimitAction}')`);
    const insertIdx = fn.source.indexOf(`serviceRest('${fn.insertTable}'`);

    assert.ok(requireIdx > -1, 'requireUser call not found');
    assert.ok(gateIdx > -1, 'assertAccountActive call not found');
    assert.ok(rateIdx > -1, 'rate-limit reservation not found');
    assert.ok(insertIdx > -1, 'durable insert not found');

    assert.ok(requireIdx < gateIdx, 'the account-state gate must run after identity is established');
    assert.ok(gateIdx < rateIdx, 'the account-state gate must run before the rate-limit reservation is even attempted');
    assert.ok(rateIdx < insertIdx, 'the rate-limit reservation must still run before the durable insert');
    assert.ok(gateIdx < insertIdx, 'the account-state gate must run before the durable insert');
  });

  test(`${fn.name}: canonical rate limiting is preserved unweakened`, () => {
    assert.match(fn.source, /import \{\s*rateLimitedResponse,\s*reservePrivacyRequestRateLimit,\s*\} from '\.\.\/_shared\/privacyRequestRateLimit\.ts';/);
    assert.match(fn.source, new RegExp(`reservePrivacyRequestRateLimit\\(user\\.id, '${fn.rateLimitAction}'\\)`));
    assert.match(fn.source, /if \(!rate\.allowed\) \{\s*return rateLimitedResponse\(corsHeaders, rate\.retry_after_seconds\);\s*\}/);
  });

  test(`${fn.name}: a thrown Response (401 from requireUser, or 403 from assertAccountActive) is returned as-is`, () => {
    assert.match(fn.source, /catch \(error\) \{\s*if \(error instanceof Response\) return error;/);
  });

  test(`${fn.name}: identity for the durable write comes only from the verified JWT, never the request body (actor isolation unchanged)`, () => {
    assert.match(fn.source, new RegExp(`user_id: user\\.id,`));
    assert.doesNotMatch(fn.source, /body\.(userId|user_id)/, 'must never read identity from the client body');
  });

  test(`${fn.name}: no protected durable side effect exists before the account-state gate in source order`, () => {
    // Enumerate every side-effecting call in the file (fetch-based network
    // calls) and assert none of them appear between requireUser and the gate.
    const gateIdx = fn.source.indexOf('await assertAccountActive(user.id);');
    const before = fn.source.slice(fn.source.indexOf('const user = await requireUser(req);'), gateIdx);
    assert.doesNotMatch(before, /serviceRest\(/, 'no durable write may precede the account-state gate');
    assert.doesNotMatch(before, /reservePrivacyRequestRateLimit\(/, 'no rate-limit reservation may precede the account-state gate');
  });
}

// ── Manifest / governance: only the two target bundles should have grown ────

test('the shared account-state helper is already governed and reused by other functions -- no second authority created', () => {
  const manifestLib = read('scripts', 'edge-function-manifest-lib.js');
  assert.match(manifestLib, /'privacy-correction-request'/);
  assert.match(manifestLib, /'privacy-data-export'/);

  const otherConsumers = [
    'supabase/functions/stylechat-generate/index.ts',
    'supabase/functions/kplus-activate/index.ts',
    'supabase/functions/vto-generate/vtoHandler.ts',
  ];
  for (const consumer of otherConsumers) {
    const src = read(...consumer.split('/'));
    assert.match(
      src,
      /assertAccountActive/,
      `${consumer} was expected to already depend on assertAccountActive (regression coverage for this shared helper extends to it too, since its content is unchanged by this repair)`,
    );
  }
});

test('privacy_correction_requests / privacy_export_requests inserts still only run after both the account-state gate and an allowed rate-limit result', () => {
  for (const fn of FUNCTIONS) {
    const gateIdx = fn.source.indexOf('await assertAccountActive(user.id);');
    const rateCheckIdx = fn.source.indexOf('if (!rate.allowed)');
    const insertIdx = fn.source.indexOf(`serviceRest('${fn.insertTable}'`);
    assert.ok(gateIdx < rateCheckIdx && rateCheckIdx < insertIdx, `${fn.name}: gate -> rate check -> insert ordering must hold`);
  }
});
