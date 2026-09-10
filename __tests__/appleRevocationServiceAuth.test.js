// Issue #390 — the nested apple-revoke-credential call must carry the service
// credential the deployed function actually requires.
//
// WHAT BROKE. `apple-revoke-credential` runs with verify_jwt = false and
// enforces its own check: `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`
// (requireServiceRole). Both deletion pipelines reach it through
// `supabase.functions.invoke(...)` on a client constructed with the service
// key, and both assumed that key would be forwarded as the Bearer token.
//
// It is not. supabase-js documents the Authorization header as "reserved for
// the signed-in user's JWT", and from 2.111.0 onward a new-format API key
// (`sb_publishable_…` / `sb_secret_…`) is deliberately NOT sent as a Bearer
// token when the client holds no session — only `apikey` is. The Edge worker
// imports `npm:@supabase/supabase-js@2`, a floating major with no lockfile, so
// it crossed that boundary with no source change: the nested call began
// arriving unauthenticated, was answered 403, and every purge — including for
// accounts that have no Apple credential at all — dead-ended in
// `apple_revocation_blocked:failed`.
//
// WHY THESE TESTS ARE SHAPED THIS WAY. A double that returns `no_credential`
// regardless of what it was sent cannot distinguish an authenticated call from
// an unauthenticated one — which is exactly why the regression reached staging
// with the existing suites green. The double below therefore reimplements the
// deployed function's real gate (requireServiceRole → userId validation →
// credential lookup → no_credential) so the authorization contract itself is
// under test, on BOTH mirrors.

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

// New-format shaped on purpose: this is the key format whose Bearer forwarding
// supabase-js dropped, and the one staging is affected by.
const SERVICE_KEY = 'sb_secret_TESTONLYNOTAREALKEY0000000000';
const USER_ID = '11111111-2222-3333-4444-555555555555';

/**
 * A faithful stand-in for the DEPLOYED apple-revoke-credential function:
 * the same authorization gate, the same userId validation, and the same
 * no-credential short-circuit that returns before any Apple configuration is
 * resolved. `appleCredentialRows` models public.apple_auth_credentials.
 */
function createDeployedFunctionDouble({ appleCredentialRows = [] } = {}) {
  const received = [];
  let appleConfigResolved = false;
  return {
    received,
    get appleConfigResolved() {
      return appleConfigResolved;
    },
    functions: {
      invoke: async (name, options) => {
        received.push({ name, options });

        // requireServiceRole(): bearer must equal SUPABASE_SERVICE_ROLE_KEY.
        const authorization = options?.headers?.Authorization ?? '';
        if (!String(authorization).toLowerCase().startsWith('bearer ')) {
          return { data: null, error: { name: 'FunctionsHttpError', status: 403 } };
        }
        if (String(authorization).slice('bearer '.length).trim() !== SERVICE_KEY) {
          return { data: null, error: { name: 'FunctionsHttpError', status: 403 } };
        }

        const userId = options?.body?.userId;
        if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) {
          return { data: null, error: { name: 'FunctionsHttpError', status: 400 } };
        }

        // loadEncryptedCredential(): no row -> no_credential, returned BEFORE
        // resolveAppleConfig() is ever reached.
        const row = appleCredentialRows.find((r) => r.user_id === userId);
        if (!row) {
          return { data: { status: 'no_credential', retryable: false }, error: null };
        }

        appleConfigResolved = true;
        return { data: { status: 'revoked', retryable: false }, error: null };
      },
    },
  };
}

let mirror; // Deno/Edge mirror
let core; // Node/manual canonical side

test.before(async () => {
  mirror = loadTsModule('supabase/functions/_shared/deletion/appleRevocation.ts');
  core = await import('../lib/account-deletion/processorCore.mjs');
});

const SIDES = () => [
  ['edge mirror (appleRevocation.ts)', mirror.requestAppleRevocation, mirror.isBlockingAppleRevocationStatus],
  ['node canonical (processorCore.mjs)', core.requestAppleRevocation, core.isBlockingAppleRevocationStatus],
];

// ── THE #390 REGRESSION. Fails on the pre-repair code on both sides. ─────────

test('#390: a no-credential actor settles as no_credential through an authenticating callee', async () => {
  for (const [label, requestAppleRevocation, isBlocking] of SIDES()) {
    const supabase = createDeployedFunctionDouble({ appleCredentialRows: [] });
    const result = await requestAppleRevocation(supabase, USER_ID, SERVICE_KEY);

    assert.equal(result.status, 'no_credential', `${label}: must settle, not block`);
    assert.equal(isBlocking(result.status), false, `${label}: must not block the purge`);
    assert.equal(
      supabase.appleConfigResolved,
      false,
      `${label}: Apple configuration must never be resolved for a no-credential actor`,
    );
  }
});

test('#390: the nested call actually carries Authorization: Bearer <service key>', async () => {
  for (const [label, requestAppleRevocation] of SIDES()) {
    const supabase = createDeployedFunctionDouble();
    await requestAppleRevocation(supabase, USER_ID, SERVICE_KEY);

    assert.equal(supabase.received.length, 1, `${label}: exactly one nested call`);
    const { name, options } = supabase.received[0];
    assert.equal(name, 'apple-revoke-credential', `${label}: target function`);
    assert.equal(
      options?.headers?.Authorization,
      `Bearer ${SERVICE_KEY}`,
      `${label}: the service credential must be stated explicitly, not inherited from the client`,
    );
  }
});

test('#390: the credential is NOT left to supabase-js client-key forwarding', () => {
  // The durable assertion: both mirrors must set the header themselves. This
  // is what makes the call correct regardless of SDK version or key format.
  for (const relativePath of [
    'supabase/functions/_shared/deletion/appleRevocation.ts',
    'lib/account-deletion/processorCore.mjs',
  ]) {
    const source = read(...relativePath.split('/'));
    const invokeIdx = source.indexOf("functions.invoke('apple-revoke-credential'");
    assert.ok(invokeIdx > -1, `${relativePath}: must still delegate to the deployed function`);
    const callSnippet = source.slice(invokeIdx, invokeIdx + 400);
    assert.match(
      callSnippet,
      /headers:\s*\{\s*Authorization:\s*`Bearer \$\{serviceRoleKey\}`/,
      `${relativePath}: the nested invoke must set Authorization explicitly`,
    );
  }
});

// ── Fail-closed on a missing credential, rather than calling unauthenticated ──

test('#390: a missing or blank service credential fails closed and never calls the function', async () => {
  for (const [label, requestAppleRevocation, isBlocking] of SIDES()) {
    for (const bad of [undefined, null, '', '   ', 42]) {
      const supabase = createDeployedFunctionDouble();
      const result = await requestAppleRevocation(supabase, USER_ID, bad);

      assert.equal(result.status, 'failed', `${label}: ${JSON.stringify(bad)} must fail`);
      assert.equal(result.detail, 'missing_service_credential', `${label}: distinct detail`);
      assert.equal(isBlocking(result.status), true, `${label}: must block the purge`);
      assert.equal(
        supabase.received.length,
        0,
        `${label}: must not emit an unauthenticated request that would 403 downstream`,
      );
    }
  }
});

// ── Retained coverage: the callee's own protections are still respected ──────

test('#390: a wrong service credential is rejected and surfaces as a blocking failure', async () => {
  for (const [label, requestAppleRevocation, isBlocking] of SIDES()) {
    const supabase = createDeployedFunctionDouble();
    const result = await requestAppleRevocation(supabase, USER_ID, 'sb_secret_WRONGKEY000000000000000000');

    assert.equal(result.status, 'failed', `${label}: a 403 must not be read as success`);
    assert.equal(result.detail, 'http_error', `${label}: surfaced as an HTTP-level error`);
    assert.equal(isBlocking(result.status), true, `${label}: must block the purge`);
  }
});

test('#390: a user JWT cannot drive Apple revocation — only the service key is accepted', async () => {
  const userJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.sig';
  for (const [label, requestAppleRevocation, isBlocking] of SIDES()) {
    const supabase = createDeployedFunctionDouble();
    const result = await requestAppleRevocation(supabase, USER_ID, userJwt);

    assert.equal(result.status, 'failed', `${label}: a user JWT must be rejected`);
    assert.equal(isBlocking(result.status), true, `${label}: must block the purge`);
  }
});

test('#390: a malformed userId is rejected by the callee and blocks, never settles', async () => {
  for (const [label, requestAppleRevocation, isBlocking] of SIDES()) {
    const supabase = createDeployedFunctionDouble();
    const result = await requestAppleRevocation(supabase, 'not-a-uuid', SERVICE_KEY);

    assert.equal(result.status, 'failed', `${label}: malformed id must not settle`);
    assert.equal(isBlocking(result.status), true, `${label}: must block the purge`);
  }
});

test('#390: the credential-present flow is unchanged and still reaches Apple configuration', async () => {
  for (const [label, requestAppleRevocation, isBlocking] of SIDES()) {
    const supabase = createDeployedFunctionDouble({
      appleCredentialRows: [{ user_id: USER_ID, encrypted_refresh_token: 'v1.iv.ct' }],
    });
    const result = await requestAppleRevocation(supabase, USER_ID, SERVICE_KEY);

    assert.equal(result.status, 'revoked', `${label}: an Apple-linked actor still revokes`);
    assert.equal(isBlocking(result.status), false, `${label}: revoked settles`);
    assert.equal(
      supabase.appleConfigResolved,
      true,
      `${label}: Apple configuration IS resolved when a credential exists`,
    );
  }
});

test('#390: an unknown status still blocks deletion on both sides', async () => {
  for (const [label, requestAppleRevocation, isBlocking] of SIDES()) {
    const supabase = {
      functions: {
        invoke: async () => ({ data: { status: 'surprise_future_status' }, error: null }),
      },
    };
    const result = await requestAppleRevocation(supabase, USER_ID, SERVICE_KEY);
    assert.equal(result.status, 'failed', `${label}: unknown status is never benign`);
    assert.equal(isBlocking(result.status), true, `${label}: must block the purge`);
  }
});

// ── Both call sites must actually supply the credential ─────────────────────

test('#390: both pipelines pass a service credential at the call site', () => {
  const worker = read('supabase', 'functions', 'process-account-deletions', 'index.ts');
  const workerCall = worker.slice(
    worker.indexOf('await requestAppleRevocation('),
    worker.indexOf('await requestAppleRevocation(') + 200,
  );
  assert.match(
    workerCall,
    /SUPABASE_SERVICE_ROLE_KEY/,
    'the Edge worker must pass the service role key into the revocation call',
  );

  const nodeCore = read('lib', 'account-deletion', 'processorCore.mjs');
  const nodeCall = nodeCore.slice(
    nodeCore.indexOf('await requestAppleRevocation('),
    nodeCore.indexOf('await requestAppleRevocation(') + 250,
  );
  assert.match(
    nodeCall,
    /serviceRoleKey|SUPABASE_SERVICE_ROLE_KEY/,
    'the Node pipeline must pass the service role key into the revocation call',
  );
});
