/**
 * IOS29 — Apple supplies the user's name exactly once.
 *
 * Apple returns `fullName` only on the FIRST authorization for an Apple ID +
 * app pair, and never includes it in the identity token. A client that drops it
 * at that moment leaves the account permanently nameless — which is the state
 * observed in production before this repair. These tests pin the contract:
 * capture it when it is there, never overwrite a name the user already has,
 * and never let the write break a sign-in that has already succeeded.
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

/**
 * The real resolver/builder are used, not stubs: the point of the repair is
 * that the Apple path writes through the same contract email sign-up uses.
 */
function loadNameContract() {
  return loadTsModule('services/userFirstName.ts');
}

function loadCapture({ updateResult, updateThrows } = {}) {
  const updates = [];
  const supabase = {
    auth: {
      updateUser: async (payload) => {
        updates.push(payload);
        if (updateThrows) throw new Error('network');
        return updateResult ?? { data: {}, error: null };
      },
    },
  };
  const mod = loadTsModule('services/appleDisplayName.ts', {
    './supabaseClient': { supabase },
    './userFirstName': loadNameContract(),
  });
  return { mod, updates };
}

const NAMELESS_USER = { id: 'u1', user_metadata: {} };
const APPLE_NAME = { givenName: 'Ada', familyName: 'Lovelace' };

test('composeAppleFullName joins the parts Apple actually returned', () => {
  const { mod } = loadCapture();
  assert.equal(mod.composeAppleFullName(APPLE_NAME), 'Ada Lovelace');
  // Apple lets the user withhold either part; one part is still a usable name.
  assert.equal(mod.composeAppleFullName({ givenName: 'Ada', familyName: null }), 'Ada');
  assert.equal(mod.composeAppleFullName({ givenName: null, familyName: 'Lovelace' }), 'Lovelace');
  assert.equal(mod.composeAppleFullName({ givenName: '   ', familyName: '' }), '');
  assert.equal(mod.composeAppleFullName(null), '');
  assert.equal(mod.composeAppleFullName(undefined), '');
});

test('a first-authorization name is persisted through the sign-up metadata contract', async () => {
  const { mod, updates } = loadCapture();
  const outcome = await mod.captureAppleDisplayName(NAMELESS_USER, APPLE_NAME);

  assert.equal(outcome, 'saved');
  assert.equal(updates.length, 1);
  // Exactly the shape buildSignupNameMetadata produces, written to
  // user_metadata, which is where resolveUserFirstName already reads from.
  // Compared structurally: the payload is built inside the VM realm, so its
  // prototype is not reference-equal to this realm's Object.
  assert.deepEqual(
    JSON.parse(JSON.stringify(updates[0])),
    { data: { full_name: 'Ada Lovelace', first_name: 'Ada' } },
  );
});

test('the saved name is readable by the resolver the greeting surfaces use', async () => {
  const { mod, updates } = loadCapture();
  await mod.captureAppleDisplayName(NAMELESS_USER, APPLE_NAME);

  const { resolveUserFirstName, resolvePreferredName } = loadNameContract();
  const persisted = { id: 'u1', user_metadata: updates[0].data };
  assert.equal(resolveUserFirstName(persisted).firstName, 'Ada');
  assert.equal(resolvePreferredName(persisted), 'Ada');
});

test('a repeat sign-in, where Apple sends no name, writes nothing', async () => {
  for (const fullName of [null, undefined, { givenName: null, familyName: null }, {}]) {
    const { mod, updates } = loadCapture();
    const outcome = await mod.captureAppleDisplayName(NAMELESS_USER, fullName);
    assert.equal(outcome, 'skipped_no_name');
    assert.equal(updates.length, 0, 'no write may be attempted without a name');
  }
});

test('an existing profile name is never overwritten by Apple', async () => {
  // Every field the resolver honours must block the overwrite.
  const existing = [
    { first_name: 'Grace' },
    { given_name: 'Grace' },
    { full_name: 'Grace Hopper' },
    { name: 'Grace Hopper' },
    { display_name: 'Grace Hopper' },
  ];

  for (const user_metadata of existing) {
    const { mod, updates } = loadCapture();
    const outcome = await mod.captureAppleDisplayName({ id: 'u1', user_metadata }, APPLE_NAME);
    assert.equal(outcome, 'skipped_existing_name', JSON.stringify(user_metadata));
    assert.equal(updates.length, 0, 'a chosen name outranks whatever Apple supplies');
  }
});

test('a whitespace-only stored name does not count as an existing name', async () => {
  const { mod, updates } = loadCapture();
  const outcome = await mod.captureAppleDisplayName(
    { id: 'u1', user_metadata: { full_name: '   ' } },
    APPLE_NAME,
  );
  assert.equal(outcome, 'saved');
  assert.equal(updates.length, 1);
});

test('a missing user is refused rather than written blind', async () => {
  const { mod, updates } = loadCapture();
  const outcome = await mod.captureAppleDisplayName(null, APPLE_NAME);
  assert.equal(outcome, 'skipped_no_user');
  assert.equal(updates.length, 0);
});

test('a failed or throwing write never breaks the completed sign-in', async () => {
  const returned = loadCapture({ updateResult: { data: null, error: new Error('nope') } });
  assert.equal(await returned.mod.captureAppleDisplayName(NAMELESS_USER, APPLE_NAME), 'failed');

  // Must resolve, not reject: the caller awaits this after the session exists.
  const thrown = loadCapture({ updateThrows: true });
  assert.equal(await thrown.mod.captureAppleDisplayName(NAMELESS_USER, APPLE_NAME), 'failed');
});

test('the name is never persisted on device and never logged', () => {
  const source = readSource('services/appleDisplayName.ts');
  assert.ok(!/AsyncStorage|SecureStore/.test(source), 'no on-device persistence of the name');
  assert.ok(!/console\.(log|info|warn|error|debug)/.test(source), 'the name must never be logged');
});

test('the auth screen captures the Apple name and traces only a status word', () => {
  const screen = readSource('app/auth/index.tsx');

  assert.ok(
    /captureAppleDisplayName\(/.test(screen),
    'the Apple handler must capture the first-authorization name',
  );
  assert.ok(
    /credential\.fullName/.test(screen),
    'the name must come from the Apple credential itself',
  );
  // The signed-in user has to be threaded through, otherwise the
  // already-has-a-name guard can never see an existing name.
  assert.ok(
    /data: signInData[\s\S]{0,400}?signInWithIdToken/.test(screen),
    'the signed-in user must be captured from signInWithIdToken',
  );
  assert.ok(
    /appleDisplayName: displayNameOutcome/.test(screen),
    'only the outcome status word may be traced',
  );
});

test('Apple sign-in cancellation stays cancellation, not an auth failure', () => {
  const screen = readSource('app/auth/index.tsx');
  assert.ok(
    /ERR_REQUEST_CANCELED[\s\S]{0,200}?[Cc]ancelled/.test(screen),
    'a user-cancelled Apple sheet must not be reported as a sign-in failure',
  );
});
