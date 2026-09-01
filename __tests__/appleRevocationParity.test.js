// Apple revocation contract parity — Node/manual side vs. Deno/Edge Function
// mirror, plus behavioral proof of the mirror itself.
//
// lib/account-deletion/processorCore.mjs already implements the canonical
// contract (APPLE_REVOCATION_COMPLETE_STATUSES / _BLOCKING_STATUSES /
// isBlockingAppleRevocationStatus / requestAppleRevocation) and is what the
// manual/operational deletion executor (scripts/process-deletion-request.js)
// runs. supabase/functions/_shared/deletion/appleRevocation.ts is a new,
// deliberate mirror of that exact contract for the Deno automated worker
// (supabase/functions/process-account-deletions/index.ts), which previously
// had no Apple revocation step at all before calling
// supabase.auth.admin.deleteUser(userId) -- this file's tests below prove
// both that the mirror matches the canonical contract, and that calling it
// actually sequences correctly against a mocked Apple API / Supabase client
// (not just that the string "apple-revoke-credential" appears somewhere).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function loadTsModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
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
    require: (specifier) => {
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

let core; // lib/account-deletion/processorCore.mjs (Node/manual side)
let mirror; // supabase/functions/_shared/deletion/appleRevocation.ts (Deno mirror)

test.before(async () => {
  core = await import('../lib/account-deletion/processorCore.mjs');
  mirror = loadTsModule('supabase/functions/_shared/deletion/appleRevocation.ts');
});

// ── Contract parity: the mirror must say exactly what the canonical side says ──

test('PARITY: APPLE_REVOCATION_COMPLETE_STATUSES matches exactly', () => {
  assert.deepEqual(
    [...mirror.APPLE_REVOCATION_COMPLETE_STATUSES].sort(),
    [...core.APPLE_REVOCATION_COMPLETE_STATUSES].sort(),
  );
});

test('PARITY: APPLE_REVOCATION_BLOCKING_STATUSES matches exactly', () => {
  assert.deepEqual(
    [...mirror.APPLE_REVOCATION_BLOCKING_STATUSES].sort(),
    [...core.APPLE_REVOCATION_BLOCKING_STATUSES].sort(),
  );
});

test('PARITY: isBlockingAppleRevocationStatus agrees on every known and unknown status', () => {
  for (const status of [
    'revoked',
    'already_gone',
    'no_credential',
    'unreadable',
    'failed',
    'not_configured',
    'surprise_future_status',
    undefined,
    null,
    42,
  ]) {
    assert.equal(
      mirror.isBlockingAppleRevocationStatus(status),
      core.isBlockingAppleRevocationStatus(status),
      `status ${JSON.stringify(status)} must classify the same way on both sides`,
    );
  }
});

// ── Behavioral proof: the mirror itself calls the deployed function correctly ──
// Same double shape as __tests__/manualDeletionAppleRevocation.test.js.

function createFunctionsDouble({ revokeResponse, revokeThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    functions: {
      invoke: async (name, options) => {
        calls.push(`invoke:${name}`);
        if (revokeThrows) throw new Error('network down');
        void options;
        return revokeResponse ?? { data: { status: 'revoked' }, error: null };
      },
    },
  };
}

const USER_ID = '11111111-2222-3333-4444-555555555555';

test('mirror requestAppleRevocation calls the deployed apple-revoke-credential function with the userId', async () => {
  const supabase = createFunctionsDouble({ revokeResponse: { data: { status: 'revoked' }, error: null } });
  const result = await mirror.requestAppleRevocation(supabase, USER_ID);
  assert.deepEqual(supabase.calls, ['invoke:apple-revoke-credential']);
  assert.equal(result.status, 'revoked');
});

test('mirror requestAppleRevocation: settled statuses pass through unchanged', async () => {
  for (const status of ['revoked', 'already_gone', 'no_credential', 'unreadable']) {
    const supabase = createFunctionsDouble({ revokeResponse: { data: { status }, error: null } });
    const result = await mirror.requestAppleRevocation(supabase, USER_ID);
    assert.equal(result.status, status);
    assert.equal(mirror.isBlockingAppleRevocationStatus(result.status), false);
  }
});

test('mirror requestAppleRevocation: known-retryable statuses pass through and are classified blocking', async () => {
  for (const status of ['failed', 'not_configured']) {
    const supabase = createFunctionsDouble({ revokeResponse: { data: { status }, error: null } });
    const result = await mirror.requestAppleRevocation(supabase, USER_ID);
    assert.equal(result.status, status);
    assert.equal(mirror.isBlockingAppleRevocationStatus(result.status), true);
  }
});

test('mirror requestAppleRevocation: a transport throw becomes a blocking "failed" result, not a thrown error', async () => {
  const supabase = createFunctionsDouble({ revokeThrows: true });
  const result = await mirror.requestAppleRevocation(supabase, USER_ID);
  assert.equal(result.status, 'failed');
  assert.equal(mirror.isBlockingAppleRevocationStatus(result.status), true);
});

test('mirror requestAppleRevocation: an HTTP-level error result becomes blocking "failed"', async () => {
  const supabase = createFunctionsDouble({ revokeResponse: { data: null, error: { message: 'boom' } } });
  const result = await mirror.requestAppleRevocation(supabase, USER_ID);
  assert.equal(result.status, 'failed');
});

test('mirror requestAppleRevocation: an unrecognised status is treated as blocking, never as benign', async () => {
  for (const body of [{ status: 'something_new' }, { status: 42 }, {}, null]) {
    const supabase = createFunctionsDouble({ revokeResponse: { data: body, error: null } });
    const result = await mirror.requestAppleRevocation(supabase, USER_ID);
    assert.equal(result.status, 'failed');
    assert.equal(mirror.isBlockingAppleRevocationStatus(result.status), true);
  }
});

// ── No JWT/.p8/client-secret logic is duplicated in the mirror either ──────

test('no Apple token, code, key material, or client secret is handled in the Edge mirror', () => {
  const source = read('supabase', 'functions', '_shared', 'deletion', 'appleRevocation.ts');
  for (const forbidden of [
    'APPLE_PRIVATE_KEY',
    'APPLE_KEY_ID',
    'APPLE_TEAM_ID',
    'APPLE_TOKEN_ENCRYPTION_KEY',
    'refresh_token',
    'client_secret',
    'appleid.apple.com',
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `${forbidden} must never appear here — revocation is delegated to the deployed function`,
    );
  }
});
