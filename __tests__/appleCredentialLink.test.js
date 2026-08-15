/**
 * IOS29-NEW-003 — client side of Apple credential capture.
 *
 * The client's only job is to hand the one-time authorization code to a
 * trusted backend over the authenticated session. Everything that could turn
 * that into a liability — persisting the code, holding an Apple token, logging
 * either, or letting the handoff break a completed sign-in — is asserted
 * against here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(readSource(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      exports: module.exports,
      module,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

function loadLinker({ session = { access_token: 'jwt' }, invokeResult, invokeThrows } = {}) {
  const invocations = [];
  const supabase = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
    },
    functions: {
      invoke: async (name, options) => {
        invocations.push({ name, options });
        if (invokeThrows) throw new Error('network');
        return invokeResult ?? { data: { status: 'linked' }, error: null };
      },
    },
  };
  const mod = loadTsModule('services/appleCredentialLink.ts', { './supabaseClient': { supabase } });
  return { mod, invocations };
}

test('a captured authorization code is posted to the trusted backend', async () => {
  const { mod, invocations } = loadLinker();

  const outcome = await mod.linkAppleCredential('c-authorization-code');

  assert.equal(outcome, 'linked');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].name, 'apple-credential-link');
  // The body is constructed inside the vm realm, so a direct deepEqual fails
  // on realm identity rather than on content. Round-trip it first.
  assert.deepEqual(JSON.parse(JSON.stringify(invocations[0].options.body)), {
    authorizationCode: 'c-authorization-code',
  });
});

test('the request body carries the code and nothing else', async () => {
  // No user id, no email, no identity token. The server resolves the account
  // from the verified bearer, so there is nothing here to spoof.
  const { mod, invocations } = loadLinker();
  await mod.linkAppleCredential('c-code');

  assert.deepEqual(Object.keys(invocations[0].options.body), ['authorizationCode']);
});

test('Apple sign-ins that return no code are skipped, not treated as errors', async () => {
  // Apple issues an authorization code on first authorization and again after a
  // revoke-and-reauthorize. A routine repeat sign-in may carry none, and the
  // credential captured earlier is still the live one.
  const { mod, invocations } = loadLinker();

  assert.equal(await mod.linkAppleCredential(undefined), 'skipped_no_code');
  assert.equal(await mod.linkAppleCredential(null), 'skipped_no_code');
  assert.equal(await mod.linkAppleCredential('   '), 'skipped_no_code');
  assert.equal(invocations.length, 0, 'nothing may be sent when there is no code');
});

test('the code is never sent without an established session', async () => {
  const { mod, invocations } = loadLinker({ session: null });

  assert.equal(await mod.linkAppleCredential('c-code'), 'skipped_no_session');
  assert.equal(invocations.length, 0, 'an unattributable code must not be transmitted');
});

test('a backend failure never throws into the completed sign-in', async () => {
  const failing = loadLinker({ invokeResult: { data: null, error: { message: 'boom' } } });
  assert.equal(await failing.mod.linkAppleCredential('c-code'), 'failed');

  const throwing = loadLinker({ invokeThrows: true });
  assert.equal(await throwing.mod.linkAppleCredential('c-code'), 'failed');
});

test('an unprovisioned server is reported distinctly from a failure', async () => {
  const { mod } = loadLinker({ invokeResult: { data: { status: 'not_configured' }, error: null } });
  assert.equal(await mod.linkAppleCredential('c-code'), 'not_configured');
});

test('the client never persists the code or any Apple token', () => {
  // Assert against CODE, not prose. The module's header documents the very
  // rules being checked here ("never writes the code to AsyncStorage", "never
  // sees an Apple refresh or access token"), so a raw substring search would
  // match the documentation rather than a violation.
  const source = readSource('services/appleCredentialLink.ts');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  for (const sink of ['AsyncStorage', 'SecureStore', 'secureSessionStorage', 'localStorage']) {
    assert.ok(!code.includes(sink), `the authorization code must not reach ${sink}`);
  }

  // The one legitimate token reference is the SUPABASE session access_token —
  // a different credential entirely, read only to confirm a session exists.
  const withoutSessionCheck = code.replace(/data\?\.session\?\.access_token/g, '');
  assert.ok(
    !/refresh_token|refreshToken|access_token/.test(withoutSessionCheck),
    'no Apple token may ever be handled on the device',
  );
});

test('the client never logs the code', () => {
  const source = readSource('services/appleCredentialLink.ts');
  assert.ok(
    !/console\.(log|warn|error|info|debug)/.test(source),
    'a log line here would put a live Apple grant into device logs',
  );
});

test('the shared Apple path captures the code and traces only a status word', () => {
  // DEF-005 moved the Apple flow into one service shared by the auth screen and
  // onboarding. The contract is unchanged, so it is asserted where it now lives.
  const source = readSource('services/appleSignIn.ts');

  assert.match(
    source,
    /import \{ linkAppleCredential, type AppleCredentialLinkOutcome \} from '\.\/appleCredentialLink'/,
  );
  assert.match(
    source,
    /linkAppleCredential\(credential\.authorizationCode\)/,
    'the authorization code must be taken from the Apple credential',
  );

  // The trace records the outcome word. Tracing the code itself would defeat
  // the point of never logging it. Both surfaces trace, so both are checked.
  for (const screen of ['app/auth/index.tsx', 'app/onboarding/index.tsx']) {
    const screenSource = readSource(screen);
    assert.match(screenSource, /appleCredentialLink: result\.credentialLink/, screen);
    assert.ok(
      !/traceAuthLifecycle\([^)]*authorizationCode/s.test(screenSource),
      `the authorization code must never be traced (${screen})`,
    );
  }
  // The code must not escape the service in the first place.
  assert.ok(
    !/authorizationCode/.test(readSource('app/auth/index.tsx'))
      && !/authorizationCode/.test(readSource('app/onboarding/index.tsx')),
    'no screen may handle the authorization code directly',
  );
});

test('capture happens after the Supabase session is established, and only for Apple', () => {
  const source = readSource('services/appleSignIn.ts');

  const signInIndex = source.indexOf('signInWithIdToken');
  const linkIndex = source.indexOf('linkAppleCredential(credential.authorizationCode)');
  assert.ok(signInIndex > -1 && linkIndex > -1);
  assert.ok(
    signInIndex < linkIndex,
    'the session must exist before the code is sent, or the server cannot attribute it',
  );

  // Exactly one call site, inside the Apple branch. Google and email sign-in
  // are untouched. (The import names the symbol without parentheses, so it is
  // not counted here.)
  assert.equal(
    source.split('linkAppleCredential(').length - 1,
    1,
    'Apple credential capture must have exactly one call site',
  );

  // The Google path lives in the screens; neither may touch Apple capture.
  for (const screen of ['app/auth/index.tsx', 'app/onboarding/index.tsx']) {
    const screenSource = readSource(screen);
    const googleIndex = screenSource.indexOf('signInWithOAuth');
    if (googleIndex > -1) {
      const googleRegion = screenSource.slice(googleIndex, googleIndex + 1200);
      assert.ok(
        !googleRegion.includes('linkAppleCredential'),
        `the Google path must be untouched by Apple credential capture (${screen})`,
      );
    }
  }
});

test('no Apple secret name is reachable from client configuration', () => {
  // The signing key, key id, team id and token encryption key are server
  // secrets. None may appear in the bundle or in any EXPO_PUBLIC_* variable.
  const clientDirs = ['services', 'app', 'components', 'hooks', 'contexts', 'constants', 'stores'];
  const forbidden = [
    'APPLE_PRIVATE_KEY',
    'APPLE_KEY_ID',
    'APPLE_TEAM_ID',
    'APPLE_TOKEN_ENCRYPTION_KEY',
  ];

  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const contents = fs.readFileSync(full, 'utf8');
        for (const name of forbidden) {
          assert.ok(
            !contents.includes(name),
            `${name} must never appear in client source (${path.relative(ROOT, full)})`,
          );
        }
      }
    }
  };

  for (const dir of clientDirs) walk(path.join(ROOT, dir));

  for (const configFile of ['app.json', 'eas.json']) {
    const raw = readSource(configFile);
    for (const name of forbidden) {
      assert.ok(!raw.includes(name), `${name} must never appear in ${configFile}`);
    }
  }
});
