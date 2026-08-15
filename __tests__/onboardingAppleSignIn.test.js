/**
 * DEF-005 — the onboarding Apple control must actually start Apple auth.
 *
 * Onboarding is the PRIMARY unauthenticated surface: `app/_layout.tsx` rewrites
 * every `/auth` guard redirect to `/onboarding`, so this is the path a user —
 * and an App Review reviewer — is most likely to take. It was wired to
 * `onContinueApple={goToAuth}`, pure navigation, so the first tap produced no
 * Apple sheet and only moved the user to a second screen to press Apple again.
 *
 * These tests pin two things: that the control runs the real authentication
 * path, and that there is exactly ONE Apple implementation behind both
 * surfaces. The second is the durable half — duplication is what let the two
 * screens drift apart and is the shared root cause of DEF-006, where the copy
 * that shipped never captured Apple's one-time fullName.
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

// ── The control is wired to authentication, not navigation ────────────────

test('DEF-005: onboarding Apple control invokes Apple auth, not navigation', () => {
  const onboarding = readSource('app/onboarding/index.tsx');
  // Scoped to the render block: the handler's own comment quotes the old
  // wiring, and a whole-file match would read that comment as the defect.
  const render = onboarding.slice(onboarding.indexOf('const renderAuthChoice'));

  assert.ok(
    !/onContinueApple=\{goToAuth\}/.test(render),
    'the regression: Apple wired to the navigation helper instead of authentication',
  );
  assert.ok(
    /onContinueApple=\{handleAppleSignIn\}/.test(render),
    'Apple must be wired to a real sign-in handler',
  );
  assert.ok(
    /performAppleSignIn\(\)/.test(onboarding),
    'the handler must run the native Apple authorization',
  );
});

test('DEF-005: a successful onboarding Apple sign-in enters the canonical flow', () => {
  const onboarding = readSource('app/onboarding/index.tsx');
  const handler = onboarding.slice(
    onboarding.indexOf('const handleAppleSignIn'),
    onboarding.indexOf('// ── Step 4: Accept & Continue handler'),
  );
  assert.ok(handler.length > 0, 'Apple handler not found');

  // Same continuation the email and Google paths use — Apple must not invent
  // its own post-auth routing.
  assert.ok(
    /continueAuthenticatedFlow\(result\.userId\)/.test(handler),
    'success must enter the canonical authenticated continuation',
  );
  assert.ok(
    !/goToAuth\(\)|router\.(push|replace)\(/.test(handler),
    'the Apple handler must not navigate to a second surface',
  );
});

test('DEF-005: cancellation stays cancellation on the onboarding surface too', () => {
  const onboarding = readSource('app/onboarding/index.tsx');
  const handler = onboarding.slice(
    onboarding.indexOf('const handleAppleSignIn'),
    onboarding.indexOf('// ── Step 4: Accept & Continue handler'),
  );
  assert.ok(
    /status === 'cancelled'[\s\S]{0,120}Sign-in cancelled\./.test(handler),
    'a dismissed Apple sheet must not be reported as an authentication failure',
  );
});

test('DEF-005: the Apple control reflects in-flight state', () => {
  const step = readSource('components/account-home/AccountSetupStepV1.tsx');
  const block = step.slice(step.indexOf('onboarding-continue-apple-button-v1'));
  assert.ok(/loading=\{appleBusy\}/.test(block), 'the Apple button must show progress');
  assert.ok(/disabled=\{appleBusy\}/.test(block), 'the Apple button must not be double-tappable');
});

test('Android behaviour is unchanged: the Apple control stays iOS-only', () => {
  const onboarding = readSource('app/onboarding/index.tsx');
  const step = readSource('components/account-home/AccountSetupStepV1.tsx');

  assert.ok(
    /appleAvailable=\{Platform\.OS === 'ios'\}/.test(onboarding),
    'availability must still be gated on iOS',
  );
  assert.ok(
    /appleAvailable && Platform\.OS === 'ios' && onContinueApple/.test(step),
    'the button must still render only on iOS',
  );
  // Second line of defence: the service refuses off-iOS regardless of UI.
  assert.ok(
    /Platform\.OS !== 'ios'[\s\S]{0,80}return \{ status: 'unavailable' \}/.test(
      readSource('services/appleSignIn.ts'),
    ),
    'the service itself must refuse to run off iOS',
  );
});

// ── Exactly one Apple implementation (root cause of DEF-005/DEF-006) ──────

test('both surfaces share one Apple implementation', () => {
  const onboarding = readSource('app/onboarding/index.tsx');
  const authScreen = readSource('app/auth/index.tsx');

  for (const [name, source] of [['onboarding', onboarding], ['auth screen', authScreen]]) {
    assert.ok(
      /performAppleSignIn/.test(source),
      `${name} must call the shared Apple service`,
    );
    // Neither screen may drive the Apple SDK itself — that is what allowed the
    // two implementations to diverge.
    assert.ok(
      !/AppleAuthentication\.signInAsync/.test(source),
      `${name} must not run its own Apple authorization`,
    );
    assert.ok(
      !/signInWithIdToken/.test(source),
      `${name} must not establish its own Apple session`,
    );
  }
});

test('DEF-006 closes on both surfaces because capture lives in the shared path', () => {
  const service = readSource('services/appleSignIn.ts');
  assert.ok(
    /captureAppleDisplayName\([\s\S]{0,80}credential\.fullName/.test(service),
    'the shared path must capture Apple first-authorization name',
  );
  assert.ok(
    /linkAppleCredential\(credential\.authorizationCode\)/.test(service),
    'the shared path must hand off the one-time authorization code',
  );
  // Order matters: the authorization code is single-use and short-lived, so it
  // must be spent before the name write.
  assert.ok(
    service.indexOf('linkAppleCredential') < service.indexOf('captureAppleDisplayName'),
    'the authorization code must be spent before the name write',
  );
});

// ── The service behaves correctly ─────────────────────────────────────────

function loadService({ signInAsync, idTokenResult } = {}) {
  const calls = { link: 0, capture: 0 };
  const filename = path.join(ROOT, 'services/appleSignIn.ts');
  const output = ts.transpileModule(readSource('services/appleSignIn.ts'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const requireMap = {
    'expo-apple-authentication': {
      isAvailableAsync: async () => true,
      signInAsync: signInAsync ?? (async () => ({
        identityToken: 'tok',
        authorizationCode: 'code',
        fullName: { givenName: 'Ada', familyName: 'Lovelace' },
      })),
      AppleAuthenticationScope: { FULL_NAME: 1, EMAIL: 0 },
    },
    'expo-crypto': {
      getRandomBytes: (n) => new Uint8Array(n).fill(7),
      digestStringAsync: async () => 'hashed',
      CryptoDigestAlgorithm: { SHA256: 'SHA256' },
    },
    'react-native': { Platform: { OS: 'ios' } },
    './supabaseClient': {
      supabase: {
        auth: {
          signInWithIdToken: async () =>
            idTokenResult ?? { data: { user: { id: 'u1' } }, error: null },
        },
      },
    },
    './appleCredentialLink': {
      linkAppleCredential: async () => {
        calls.link += 1;
        return 'linked';
      },
    },
    './appleDisplayName': {
      captureAppleDisplayName: async () => {
        calls.capture += 1;
        return 'saved';
      },
    },
  };

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
  return { mod: module.exports, calls };
}

test('service: a successful authorization returns the session and both follow-ups', async () => {
  const { mod, calls } = loadService();
  const result = await mod.performAppleSignIn();

  assert.equal(result.status, 'signed-in');
  assert.equal(result.userId, 'u1');
  assert.equal(result.credentialLink, 'linked');
  assert.equal(result.displayName, 'saved');
  assert.equal(calls.link, 1);
  assert.equal(calls.capture, 1);
});

test('service: a dismissed sheet is cancellation, and runs no follow-ups', async () => {
  const cancel = Object.assign(new Error('canceled'), { code: 'ERR_REQUEST_CANCELED' });
  const { mod, calls } = loadService({
    signInAsync: async () => {
      throw cancel;
    },
  });

  const result = await mod.performAppleSignIn();
  assert.equal(result.status, 'cancelled');
  assert.equal(calls.link, 0, 'nothing may be spent when the user cancelled');
  assert.equal(calls.capture, 0);
});

test('service: a missing identity token fails without establishing a session', async () => {
  const { mod, calls } = loadService({
    signInAsync: async () => ({ identityToken: null, authorizationCode: 'code' }),
  });

  const result = await mod.performAppleSignIn();
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'no-identity-token');
  assert.equal(calls.link, 0);
});

test('service: a rejected token does not run the follow-ups', async () => {
  const { mod, calls } = loadService({
    idTokenResult: { data: null, error: new Error('bad token') },
  });

  const result = await mod.performAppleSignIn();
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'sign-in-rejected');
  assert.equal(calls.link, 0, 'no credential handoff without a session');
  assert.equal(calls.capture, 0, 'no name write without a session');
});

test('service: a network failure is reported as network, not a generic error', async () => {
  const { mod } = loadService({
    signInAsync: async () => {
      throw new Error('A network error occurred.');
    },
  });

  const result = await mod.performAppleSignIn();
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'network');
});

test('service: the name and authorization code never leave as part of the result', async () => {
  const { mod } = loadService();
  const result = await mod.performAppleSignIn();
  const serialized = JSON.stringify(result);

  assert.ok(!serialized.includes('Ada'), 'the Apple name must not ride out in the result');
  assert.ok(!serialized.includes('code'), 'the authorization code must not ride out in the result');
});
