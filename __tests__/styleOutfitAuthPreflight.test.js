'use strict';

/**
 * Auth preflight for style-outfit-generate callers.
 *
 * Reproduces the Phase 2 matrix locally without contacting production or
 * printing tokens: signed-out / expired / refresh-failure never invoke, and a
 * fresh session may proceed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadAuthenticatedSessionModule() {
  const filename = path.join(ROOT, 'services/authenticatedFunctionSession.ts');
  const source = fs.readFileSync(filename, 'utf8');
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
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier === './supabaseClient') {
        return {
          supabase: {
            auth: {
              getSession: async () => {
                throw new Error('default getSession must be injected in tests');
              },
              refreshSession: async () => {
                throw new Error('default refreshSession must be injected in tests');
              },
            },
          },
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const {
  resolveAuthenticatedFunctionSession,
  FUNCTION_SESSION_REFRESH_MARGIN_SECONDS,
} = loadAuthenticatedSessionModule();

test('signed-out session refuses before any function invoke', async () => {
  const result = await resolveAuthenticatedFunctionSession({
    getSession: async () => ({ data: { session: null }, error: null }),
    refreshSession: async () => {
      assert.fail('refresh must not run when signed out');
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'signed_out');
});

test('fresh authenticated session passes the auth gate', async () => {
  const now = 1_700_000_000;
  const result = await resolveAuthenticatedFunctionSession({
    nowSeconds: now,
    getSession: async () => ({
      data: {
        session: {
          access_token: 'access-token-fresh',
          refresh_token: 'refresh-token',
          expires_at: now + 3600,
        },
      },
      error: null,
    }),
    refreshSession: async () => {
      assert.fail('refresh must not run for a fresh token');
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.accessToken, 'access-token-fresh');
});

test('near-expiry session attempts one controlled refresh', async () => {
  const now = 1_700_000_000;
  let refreshCalls = 0;
  const result = await resolveAuthenticatedFunctionSession({
    nowSeconds: now,
    marginSeconds: FUNCTION_SESSION_REFRESH_MARGIN_SECONDS,
    getSession: async () => ({
      data: {
        session: {
          access_token: 'access-token-stale',
          refresh_token: 'refresh-token',
          expires_at: now + 30,
        },
      },
      error: null,
    }),
    refreshSession: async ({ refresh_token }) => {
      refreshCalls += 1;
      assert.equal(refresh_token, 'refresh-token');
      return {
        data: {
          session: {
            access_token: 'access-token-refreshed',
            refresh_token: 'refresh-token',
            expires_at: now + 3600,
          },
        },
        error: null,
      };
    },
  });
  assert.equal(refreshCalls, 1);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.accessToken, 'access-token-refreshed');
});

test('failed refresh produces session_expired and does not invent a token', async () => {
  const now = 1_700_000_000;
  const result = await resolveAuthenticatedFunctionSession({
    nowSeconds: now,
    getSession: async () => ({
      data: {
        session: {
          access_token: 'access-token-stale',
          refresh_token: 'refresh-token',
          expires_at: now - 5,
        },
      },
      error: null,
    }),
    refreshSession: async () => ({ data: { session: null }, error: { message: 'refresh failed' } }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'session_expired');
});

test('Elise client refuses invoke when auth preflight fails', () => {
  const clientSource = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomEliseClient.ts'),
    'utf8',
  );
  assert.match(clientSource, /resolveAuthenticatedFunctionSession/);
  assert.match(clientSource, /kind: 'session_expired'/);
  assert.ok(
    clientSource.indexOf('resolveAuthenticatedFunctionSession') <
      clientSource.indexOf('invoke(ELISE_FUNCTION_NAME'),
    'auth preflight must precede the protected invoke',
  );
});

test('styleOutfits refuses invoke when auth preflight fails', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/styleOutfits.ts'), 'utf8');
  assert.match(source, /resolveAuthenticatedFunctionSession/);
  assert.match(source, /status: 'session_expired'/);
  assert.match(source, /AI_SESSION_EXPIRED_MESSAGE/);
  assert.ok(
    source.indexOf('resolveAuthenticatedFunctionSession') <
      source.indexOf('functions.invoke(STYLE_OUTFIT_FUNCTION_NAME'),
    'auth preflight must precede the protected invoke',
  );
});
