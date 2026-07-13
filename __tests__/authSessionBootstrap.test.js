const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { exports: module.exports, module, Set }, { filename });
  return module.exports;
}

const { createAuthBootstrapGenerationGuard, isHandledStaleRefreshTokenError } = loadTsModule(
  'services/authSessionBootstrap.ts',
);

test('a newer auth event makes an older bootstrap result ineligible to update session state', () => {
  const guard = createAuthBootstrapGenerationGuard();
  const bootstrapGeneration = guard.beginBootstrap();

  guard.noteAuthEvent();

  assert.equal(guard.isBootstrapCurrent(bootstrapGeneration), false);
});

test('a bootstrap result remains current when no auth event arrived after it started', () => {
  const guard = createAuthBootstrapGenerationGuard();
  const bootstrapGeneration = guard.beginBootstrap();

  assert.equal(guard.isBootstrapCurrent(bootstrapGeneration), true);
});

test('expected stale refresh token errors are handled quietly', () => {
  assert.equal(
    isHandledStaleRefreshTokenError({
      name: 'AuthApiError',
      status: 400,
      code: 'refresh_token_not_found',
      message: 'Invalid Refresh Token: Refresh Token Not Found',
    }),
    true,
  );
  assert.equal(
    isHandledStaleRefreshTokenError({
      name: 'AuthApiError',
      status: 400,
      message: 'Invalid Refresh Token: Refresh Token Already Used',
    }),
    true,
  );
});

test('unexpected auth failures remain reportable', () => {
  assert.equal(
    isHandledStaleRefreshTokenError({
      name: 'AuthRetryableFetchError',
      status: 0,
      message: 'Network request failed',
    }),
    false,
  );
  assert.equal(
    isHandledStaleRefreshTokenError({
      name: 'AuthApiError',
      status: 500,
      message: 'Unexpected auth failure',
    }),
    false,
  );
});

test('auth bootstrap defers background refresh until handled session recovery completes', () => {
  const clientSource = fs.readFileSync(path.join(ROOT, 'services/supabaseClient.ts'), 'utf8');
  const contextSource = fs.readFileSync(path.join(ROOT, 'contexts/AuthSessionContext.tsx'), 'utf8');

  assert.match(clientSource, /autoRefreshToken:\s*false/);
  assert.match(contextSource, /await supabase\.auth\.getSession\(\)/);
  assert.match(contextSource, /isHandledStaleRefreshTokenError\(error\)/);
  assert.match(contextSource, /await supabase\.auth\.startAutoRefresh\(\)/);
  assert.match(contextSource, /isBootstrapCurrent\(startGeneration\)/);
  assert.doesNotMatch(contextSource, /signOut\(\{ scope: 'local' \}\)/);
});

test('auth lifecycle trace schema cannot accept secret-bearing fields from callers', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/authLifecycleTrace.ts'), 'utf8');
  assert.match(source, /Development-only auth trace/);
  assert.doesNotMatch(source, /^\s*(?:accessToken|refreshToken|authorizationCode|email|userId)\??:/m);
});

test('expected feature-freeze fallback remains observable without a warning badge', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/featureFreeze.ts'), 'utf8');
  assert.match(source, /console\.info\('\[K-SCAN FeatureFreeze\] remote fetch failed/);
  assert.doesNotMatch(source, /console\.warn\('\[K-SCAN FeatureFreeze\] remote fetch failed/);
});
