// Sign in with Apple credential-state checks are scoped to THIS device's
// Apple sign-in.
//
// THE DEFECT: AppleCredentialStateBridge asked Apple about any account whose
// Supabase identities include an 'apple' identity, however the current session
// was created. Supabase links a verified same-email Apple identity to an
// existing account, so an account can carry one and still sign in with email
// or Google. getCredentialStateAsync answers for the Apple ID signed in on the
// device, so:
//   - after the person stopped using Sign in with Apple for K Scan AI (Apple
//     answers REVOKED), every later email or Google sign-in on iOS was signed
//     straight back out — an iOS-only lockout;
//   - on an iPhone or iPad signed in to a different Apple ID, or none, the
//     answer about the linked identity is not about this session at all.
//
// THE REPAIR: app/auth/index.tsx records the subject that completes Sign in
// with Apple on this device (services/auth/appleSignInDeviceRecord.ts), the
// check only consults Apple for that subject, and an invalidating answer
// forgets the record before signing out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MODULE_REL = 'services/auth/appleCredentialState.ts';
const RECORD_REL = 'services/auth/appleSignInDeviceRecord.ts';
const APPLE_SUB = '001234.abcdef0123456789abcdef0123456789.0987';

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

function evaluate(rel, shim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, shim);
  return mod.exports;
}

function harness() {
  const actorContext = evaluate('services/actorContext.js', (spec) => {
    throw new Error(`unexpected actorContext import: ${spec}`);
  });
  const mod = evaluate(MODULE_REL, (spec) => {
    if (spec === 'react-native') return { Platform: { OS: 'ios' } };
    if (spec === '../actorContext') return actorContext;
    throw new Error(`FORBIDDEN IMPORT in appleCredentialState: ${spec}`);
  });
  const events = [];
  const signOut = async () => {
    events.push('signOut');
  };
  return { mod, actorContext, events, signOut };
}

function fakeAppleSdk(state) {
  const calls = [];
  return {
    calls,
    module: {
      AppleAuthenticationCredentialState: { REVOKED: 0, AUTHORIZED: 1, NOT_FOUND: 2, TRANSFERRED: 3 },
      getCredentialStateAsync: async (user) => {
        calls.push(user);
        return state;
      },
    },
  };
}

/** An account created with email that later linked Sign in with Apple. */
function linkedAccount() {
  return {
    id: 'kscan-uuid-linked',
    email: 'someone@example.com',
    identities: [
      { id: 'email-id', provider: 'email', identity_data: {} },
      { id: APPLE_SUB, provider: 'apple', identity_data: { sub: APPLE_SUB } },
    ],
  };
}

/** A stateful stand-in for the Keychain record. */
function deviceRecord(initial, events) {
  let subject = initial;
  return {
    readThisDeviceAppleSubject: async () => subject,
    forgetThisDeviceAppleSubject: async () => {
      events.push('forget');
      subject = null;
    },
  };
}

test('an email session on an account with a linked Apple identity is not checked when this device has no Apple sign-in', async () => {
  const { mod, events, signOut } = harness();
  const sdk = fakeAppleSdk(0);
  let loaderCalls = 0;

  const outcome = await mod.runAppleCredentialStateCheck(linkedAccount(), {
    signOut,
    ...deviceRecord(null, events),
    loadAppleAuthentication: async () => {
      loaderCalls += 1;
      return sdk.module;
    },
  });

  assert.equal(outcome, 'not_this_device');
  assert.equal(loaderCalls, 0, 'the Apple SDK is not even loaded');
  assert.equal(sdk.calls.length, 0);
  assert.deepEqual(events, []);
});

test('a device whose Apple sign-in was a different Apple ID never checks this account', async () => {
  const { mod, events, signOut } = harness();
  const sdk = fakeAppleSdk(2);

  const outcome = await mod.runAppleCredentialStateCheck(linkedAccount(), {
    signOut,
    ...deviceRecord('000999.another-apple-id.0001', events),
    loadAppleAuthentication: async () => sdk.module,
  });

  assert.equal(outcome, 'not_this_device');
  assert.equal(sdk.calls.length, 0);
  assert.deepEqual(events, []);
});

test('LOCKOUT: after Apple revokes, the record is forgotten before sign-out and the next email sign-in stays signed in', async () => {
  const { mod, events, signOut } = harness();
  const sdk = fakeAppleSdk(0); // REVOKED: the person stopped using Sign in with Apple
  const record = deviceRecord(APPLE_SUB, events);
  const deps = { signOut, ...record, loadAppleAuthentication: async () => sdk.module };

  assert.equal(await mod.runAppleCredentialStateCheck(linkedAccount(), deps), 'revoked');
  assert.deepEqual(events, ['forget', 'signOut'], 'the record is cleared before the sign-out');

  // The same person signs back in with email on this device.
  assert.equal(await mod.runAppleCredentialStateCheck(linkedAccount(), deps), 'not_this_device');
  assert.deepEqual(events, ['forget', 'signOut'], 'the email session is not signed out again');
  assert.equal(sdk.calls.length, 1);
});

test('NEGATIVE CONTROL: without the device scope every email sign-in would be signed back out', async () => {
  // A record that is always present and never cleared reproduces the pre-repair
  // behaviour (any linked Apple identity was checked on every sign-in).
  const { mod, events, signOut } = harness();
  const sdk = fakeAppleSdk(0);
  const deps = {
    signOut,
    readThisDeviceAppleSubject: async () => APPLE_SUB,
    forgetThisDeviceAppleSubject: async () => {},
    loadAppleAuthentication: async () => sdk.module,
  };

  assert.equal(await mod.runAppleCredentialStateCheck(linkedAccount(), deps), 'revoked');
  assert.equal(await mod.runAppleCredentialStateCheck(linkedAccount(), deps), 'revoked');
  assert.deepEqual(events, ['signOut', 'signOut'], 'the lockout loop the device scope prevents');
});

test('a storage fault while forgetting never keeps an invalidated session signed in', async () => {
  const { mod, events, signOut } = harness();
  const sdk = fakeAppleSdk(2); // NOT_FOUND on the device that signed in with Apple

  const outcome = await mod.runAppleCredentialStateCheck(linkedAccount(), {
    signOut,
    readThisDeviceAppleSubject: async () => APPLE_SUB,
    forgetThisDeviceAppleSubject: async () => {
      throw new Error('keychain unavailable');
    },
    loadAppleAuthentication: async () => sdk.module,
  });

  assert.equal(outcome, 'not_found');
  assert.deepEqual(events, ['signOut']);
});

test('a device-record read that throws preserves the session and never calls Apple', async () => {
  const { mod, events, signOut } = harness();
  const sdk = fakeAppleSdk(0);

  const outcome = await mod.runAppleCredentialStateCheck(linkedAccount(), {
    signOut,
    readThisDeviceAppleSubject: async () => {
      throw new Error('keychain unavailable');
    },
    loadAppleAuthentication: async () => sdk.module,
  });

  assert.equal(outcome, 'check_failed');
  assert.equal(sdk.calls.length, 0);
  assert.deepEqual(events, []);
});

test('an actor switch during the device-record read discards the check', async () => {
  const { mod, actorContext, events, signOut } = harness();
  actorContext.advanceActorEpoch('kscan-uuid-linked');
  const sdk = fakeAppleSdk(0);
  let releaseRead;
  const readPending = new Promise((resolve) => {
    releaseRead = resolve;
  });

  const pending = mod.runAppleCredentialStateCheck(linkedAccount(), {
    signOut,
    readThisDeviceAppleSubject: async () => {
      await readPending;
      return APPLE_SUB;
    },
    loadAppleAuthentication: async () => sdk.module,
  });
  actorContext.advanceActorEpoch('kscan-uuid-someone-else');
  releaseRead();

  assert.equal(await pending, 'stale_actor');
  assert.equal(sdk.calls.length, 0);
  assert.deepEqual(events, []);
});

test('the device record stores and clears only the Apple subject under its own Keychain key', async () => {
  const keychain = new Map();
  const record = evaluate(RECORD_REL, (spec) => {
    if (spec !== 'expo-secure-store') throw new Error(`FORBIDDEN IMPORT in appleSignInDeviceRecord: ${spec}`);
    return {
      setItemAsync: async (k, v) => keychain.set(k, v),
      getItemAsync: async (k) => (keychain.has(k) ? keychain.get(k) : null),
      deleteItemAsync: async (k) => keychain.delete(k),
    };
  });

  assert.equal(await record.readThisDeviceAppleSubject(), null);
  await record.rememberThisDeviceAppleSubject(`  ${APPLE_SUB} `);
  assert.deepEqual([...keychain.entries()], [['kscan.auth.appleSignInSubject.v1', APPLE_SUB]]);
  assert.equal(await record.readThisDeviceAppleSubject(), APPLE_SUB);
  await record.rememberThisDeviceAppleSubject('');
  assert.equal(await record.readThisDeviceAppleSubject(), APPLE_SUB, 'an empty subject never overwrites');
  await record.forgetThisDeviceAppleSubject();
  assert.equal(await record.readThisDeviceAppleSubject(), null);

  const failing = evaluate(RECORD_REL, () => ({
    setItemAsync: async () => {
      throw new Error('keychain unavailable');
    },
    getItemAsync: async () => {
      throw new Error('keychain unavailable');
    },
    deleteItemAsync: async () => {
      throw new Error('keychain unavailable');
    },
  }));
  await failing.rememberThisDeviceAppleSubject(APPLE_SUB);
  assert.equal(await failing.readThisDeviceAppleSubject(), null, 'a storage fault reads as no record');
  await failing.forgetThisDeviceAppleSubject();

  const source = fs.readFileSync(path.join(ROOT, RECORD_REL), 'utf8');
  assert.doesNotMatch(source, /AsyncStorage|authorizationCode|identityToken/);
});

test('the sign-in screen records the subject before the session exists, in the Apple branch only', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app/auth/index.tsx'), 'utf8');
  const call = 'rememberThisDeviceAppleSubject(credential.user)';
  assert.equal(source.split(call).length - 1, 1, 'exactly one call site');

  const appleStart = source.indexOf('const handleAppleSignIn');
  const appleEnd = source.indexOf('\n  const ', appleStart + 1);
  const recordIndex = source.indexOf(call);
  const sessionIndex = source.indexOf('signInWithIdToken', appleStart);
  assert.ok(appleStart > -1 && recordIndex > appleStart, 'inside handleAppleSignIn');
  assert.ok(appleEnd === -1 || recordIndex < appleEnd, 'inside handleAppleSignIn');
  assert.ok(recordIndex < sessionIndex, 'recorded before signInWithIdToken creates the session');
});

test('the layout bridge passes the device record to both lifecycle checks', () => {
  const layout = fs.readFileSync(path.join(ROOT, 'app/_layout.tsx'), 'utf8');
  const start = layout.indexOf('function AppleCredentialStateBridge()');
  const end = layout.indexOf('\nfunction ', start + 1);
  const bridge = layout.slice(start, end === -1 ? undefined : end);

  assert.equal(bridge.split('runAppleCredentialStateCheck(').length - 1, 2);
  assert.equal(bridge.split('readThisDeviceAppleSubject,').length - 1, 2);
  assert.equal(bridge.split('forgetThisDeviceAppleSubject,').length - 1, 2);
});
