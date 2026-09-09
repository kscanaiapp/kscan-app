// Sign in with Apple credential-state lifecycle (K SCAN AI iOS Repair 02).
//
// THE GAP: K Scan AI already had a governed Sign in with Apple architecture
// (native sign-in -> Supabase session -> authorization code captured ->
// server-side storage -> Apple authorization revoked during terminal account
// deletion). What it had no handling for at all was the LIFECYCLE WHILE THE
// ACCOUNT STILL EXISTS: Apple can report that this device's Sign in with Apple
// credential is no longer authorized, and nothing noticed — the K Scan AI session
// simply continued indefinitely. `getCredentialStateAsync` appeared nowhere in
// the codebase before this repair.
//
// THE REPAIR: services/auth/appleCredentialState.ts asks Apple at two existing
// lifecycle boundaries and, on an invalidating answer, invalidates the session
// through the ONE canonical logout authority (AuthSessionContext's signOut).
// It is session invalidation, never account deletion.
//
// These tests execute the REAL module with the REAL services/actorContext.js
// (so the actor-staleness proof is genuine, not a stub), under a require-shim
// that REJECTS any import outside a tiny allowlist — which is itself the
// structural proof that no deletion, purge, Closet, or Apple-revoke code is
// reachable from this path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MODULE_REL = 'services/auth/appleCredentialState.ts';
const LAYOUT_REL = 'app/_layout.tsx';

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
  vm.runInThisContext(
    `(function (exports, module, require) {\n${transpile(rel)}\n})`,
    { filename: rel },
  )(mod.exports, mod, shim);
  return mod.exports;
}

/** The REAL actor context — same module production uses for epoch isolation. */
function loadActorContext() {
  return evaluate('services/actorContext.js', (spec) => {
    throw new Error(`unexpected actorContext import: ${spec}`);
  });
}

/**
 * Loads the REAL credential-state module. The shim allowlist is deliberately
 * two entries wide: anything else the module tried to import would throw here.
 */
function loadModule({ platformOS = 'ios', actorContext }) {
  const allowed = new Set(['react-native', '../actorContext']);
  const shim = (spec) => {
    if (!allowed.has(spec)) {
      throw new Error(`FORBIDDEN IMPORT in appleCredentialState: ${spec}`);
    }
    if (spec === 'react-native') return { Platform: { OS: platformOS } };
    return actorContext;
  };
  return evaluate(MODULE_REL, shim);
}

/** An Apple SDK double exposing the same shape the real SDK exports. */
function fakeAppleSdk(stateOrThrow, { states } = {}) {
  const CredentialState = states ?? {
    REVOKED: 0,
    AUTHORIZED: 1,
    NOT_FOUND: 2,
    TRANSFERRED: 3,
  };
  const calls = [];
  return {
    calls,
    module: {
      AppleAuthenticationCredentialState: CredentialState,
      getCredentialStateAsync: async (user) => {
        calls.push(user);
        if (typeof stateOrThrow === 'function') return stateOrThrow(user);
        if (stateOrThrow instanceof Error) throw stateOrThrow;
        return stateOrThrow;
      },
    },
  };
}

const APPLE_SUB = '001234.abcdef0123456789abcdef0123456789.0987';

function appleUser(sub = APPLE_SUB) {
  return {
    id: 'kscan-uuid-actor-a',
    email: 'someone@privaterelay.appleid.com',
    identities: [{ id: sub, provider: 'apple', identity_data: { sub } }],
  };
}

function googleUser() {
  return {
    id: 'kscan-uuid-actor-g',
    email: 'someone@gmail.com',
    identities: [{ id: 'google-sub-42', provider: 'google', identity_data: { sub: 'google-sub-42' } }],
  };
}

function emailUser() {
  return { id: 'kscan-uuid-actor-e', email: 'someone@example.com', identities: [] };
}

/** Fresh module + actor context per case; the in-flight guard is module state. */
function harness({ platformOS = 'ios' } = {}) {
  const actorContext = loadActorContext();
  const mod = loadModule({ platformOS, actorContext });
  const signOutCalls = [];
  const signOut = async () => {
    signOutCalls.push(Date.now());
  };
  return { mod, actorContext, signOut, signOutCalls };
}

// ══ Apple credential states ════════════════════════════════════════════════

test('Apple + AUTHORIZED: session is kept, no sign-out', async () => {
  const { mod, signOut, signOutCalls } = harness();
  const sdk = fakeAppleSdk(1);
  const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  assert.equal(outcome, 'authorized');
  assert.equal(signOutCalls.length, 0, 'an authorized credential must never sign the user out');
  assert.deepEqual(sdk.calls, [APPLE_SUB], 'Apple is asked about the Apple subject id, nothing else');
});

test('Apple + REVOKED: canonical sign-out exactly once', async () => {
  const { mod, signOut, signOutCalls } = harness();
  const sdk = fakeAppleSdk(0);
  const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  assert.equal(outcome, 'revoked');
  assert.equal(signOutCalls.length, 1);
});

test('Apple + NOT_FOUND: canonical sign-out exactly once', async () => {
  const { mod, signOut, signOutCalls } = harness();
  const sdk = fakeAppleSdk(2);
  const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  assert.equal(outcome, 'not_found');
  assert.equal(signOutCalls.length, 1);
});

// TRANSFERRED is Apple's app-transfer state (the app moved between developer
// accounts, so the existing user identifier must be re-established). The
// conservative handling the SDK contract supports is to require
// re-authentication: invalidate the session, delete nothing, and build no
// migration system in this lane. It is explicitly NOT classified as authorized.
test('Apple + TRANSFERRED: treated as requiring re-authentication, never as authorized', async () => {
  const { mod, signOut, signOutCalls } = harness();
  const sdk = fakeAppleSdk(3);
  const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  assert.equal(outcome, 'transferred');
  assert.notEqual(outcome, 'authorized');
  assert.equal(signOutCalls.length, 1, 'requires re-authentication');
});

test('Apple + credential API throws: session preserved, no sign-out', async () => {
  const { mod, signOut, signOutCalls } = harness();
  const sdk = fakeAppleSdk(new Error('network unreachable'));
  const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  assert.equal(outcome, 'check_failed');
  assert.equal(signOutCalls.length, 0, 'a thrown check must never sign the user out');
});

test('Apple + the SDK itself fails to load: session preserved, no sign-out', async () => {
  const { mod, signOut, signOutCalls } = harness();
  const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => {
      throw new Error('native module unavailable');
    },
  });
  assert.equal(outcome, 'check_failed');
  assert.equal(signOutCalls.length, 0);
});

test('Apple + malformed/unrecognised response: fails safe, no destructive action', async () => {
  for (const malformed of [undefined, null, 99, 'REVOKED', {}, NaN]) {
    const { mod, signOut, signOutCalls } = harness();
    const sdk = fakeAppleSdk(malformed);
    const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
      signOut,
      loadAppleAuthentication: async () => sdk.module,
    });
    assert.equal(outcome, 'check_failed', `malformed response ${String(malformed)} must fail safe`);
    assert.equal(signOutCalls.length, 0, `malformed response ${String(malformed)} must not sign out`);
  }
});

test('an SDK without TRANSFERRED defined still classifies the three core states', async () => {
  const states = { REVOKED: 0, AUTHORIZED: 1, NOT_FOUND: 2 };
  for (const [value, expected] of [[1, 'authorized'], [0, 'revoked'], [2, 'not_found']]) {
    const { mod, signOut } = harness();
    const sdk = fakeAppleSdk(value, { states });
    const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
      signOut,
      loadAppleAuthentication: async () => sdk.module,
    });
    assert.equal(outcome, expected);
  }
});

// ══ Actor correctness ══════════════════════════════════════════════════════

test('ACTOR SAFETY: actor A returning REVOKED after a switch to B does not sign out B', async () => {
  const { mod, actorContext, signOut, signOutCalls } = harness();
  // Actor A is current when the check begins.
  actorContext.advanceActorEpoch('kscan-uuid-actor-a');

  let releaseApple;
  const applePending = new Promise((resolve) => {
    releaseApple = resolve;
  });
  const sdk = fakeAppleSdk(async () => {
    await applePending;
    return 0; // REVOKED — for actor A
  });

  const pending = mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });

  // The actor changes to B while Apple is still answering.
  actorContext.advanceActorEpoch('kscan-uuid-actor-b');
  releaseApple();

  const outcome = await pending;
  assert.equal(outcome, 'stale_actor', "A's answer must be discarded once B is current");
  assert.equal(signOutCalls.length, 0, 'actor B must NOT be signed out by actor A\'s revocation');
});

test('ACTOR SAFETY: a sign-out during the check also discards the answer', async () => {
  const { mod, actorContext, signOut, signOutCalls } = harness();
  actorContext.advanceActorEpoch('kscan-uuid-actor-a');

  let releaseApple;
  const applePending = new Promise((resolve) => {
    releaseApple = resolve;
  });
  const sdk = fakeAppleSdk(async () => {
    await applePending;
    return 0;
  });
  const pending = mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });

  // Signed-out device-local partition is its own actor context.
  actorContext.advanceActorEpoch(null);
  releaseApple();

  assert.equal(await pending, 'stale_actor');
  assert.equal(signOutCalls.length, 0);
});

test('NEGATIVE CONTROL: with the actor unchanged, the same flow DOES sign out', async () => {
  // Proves the two staleness tests above bite because of the epoch change,
  // not because the deferred-resolution harness never signs anyone out.
  const { mod, actorContext, signOut, signOutCalls } = harness();
  actorContext.advanceActorEpoch('kscan-uuid-actor-a');

  let releaseApple;
  const applePending = new Promise((resolve) => {
    releaseApple = resolve;
  });
  const sdk = fakeAppleSdk(async () => {
    await applePending;
    return 0;
  });
  const pending = mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  releaseApple(); // no actor change this time

  assert.equal(await pending, 'revoked');
  assert.equal(signOutCalls.length, 1);
});

// ══ Provider isolation ═════════════════════════════════════════════════════

test('PROVIDER ISOLATION: a Google session never calls getCredentialStateAsync', async () => {
  const { mod, signOut, signOutCalls } = harness();
  const sdk = fakeAppleSdk(0);
  const outcome = await mod.runAppleCredentialStateCheck(googleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  assert.equal(outcome, 'not_apple_actor');
  assert.deepEqual(sdk.calls, [], 'Apple must never be consulted about a Google actor');
  assert.equal(signOutCalls.length, 0);
});

test('PROVIDER ISOLATION: an email session never calls getCredentialStateAsync', async () => {
  const { mod, signOut, signOutCalls } = harness();
  const sdk = fakeAppleSdk(0);
  const outcome = await mod.runAppleCredentialStateCheck(emailUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  assert.equal(outcome, 'not_apple_actor');
  assert.deepEqual(sdk.calls, []);
  assert.equal(signOutCalls.length, 0);
});

test('PROVIDER ISOLATION: a null/absent user never calls Apple', async () => {
  for (const value of [null, undefined, {}, { identities: null }]) {
    const { mod, signOut } = harness();
    const sdk = fakeAppleSdk(0);
    const outcome = await mod.runAppleCredentialStateCheck(value, {
      signOut,
      loadAppleAuthentication: async () => sdk.module,
    });
    assert.equal(outcome, 'not_apple_actor');
    assert.deepEqual(sdk.calls, []);
  }
});

test('PROVIDER ISOLATION: the Apple SDK loader is not even invoked for a non-Apple actor', async () => {
  const { mod, signOut } = harness();
  let loaderCalls = 0;
  await mod.runAppleCredentialStateCheck(googleUser(), {
    signOut,
    loadAppleAuthentication: async () => {
      loaderCalls += 1;
      return fakeAppleSdk(0).module;
    },
  });
  assert.equal(loaderCalls, 0, 'the native Apple module must not even be loaded');
});

test('the Apple identifier comes from the Apple identity, never from email or the K Scan AI user id', () => {
  const { mod } = harness();
  assert.equal(mod.resolveAppleUserId(appleUser()), APPLE_SUB);
  // Not the K Scan AI UUID, not the email.
  assert.notEqual(mod.resolveAppleUserId(appleUser()), 'kscan-uuid-actor-a');
  assert.notEqual(mod.resolveAppleUserId(appleUser()), 'someone@privaterelay.appleid.com');
  assert.equal(mod.resolveAppleUserId(googleUser()), null);
  assert.equal(mod.resolveAppleUserId(emailUser()), null);
  // Falls back to identity_data.sub when id is absent, and never invents one.
  assert.equal(
    mod.resolveAppleUserId({ identities: [{ provider: 'apple', identity_data: { sub: 'sub-only' } }] }),
    'sub-only',
  );
  assert.equal(mod.resolveAppleUserId({ identities: [{ provider: 'apple' }] }), null);
  assert.equal(mod.resolveAppleUserId({ identities: [{ provider: 'apple', id: '   ' }] }), null);
});

// ══ Platform boundary (Android unchanged) ══════════════════════════════════

test('ANDROID: never calls Apple and never signs anyone out, even for an Apple identity', async () => {
  const { mod, signOut, signOutCalls } = harness({ platformOS: 'android' });
  const sdk = fakeAppleSdk(0); // would be REVOKED on iOS
  const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  assert.equal(outcome, 'unsupported_platform');
  assert.deepEqual(sdk.calls, [], 'Android must issue zero Apple credential-state calls');
  assert.equal(signOutCalls.length, 0, 'Android behavior is unchanged by this repair');
});

test('NEGATIVE CONTROL: the identical input on iOS DOES revoke — proving the Android guard is what stopped it', async () => {
  const { mod, signOut, signOutCalls } = harness({ platformOS: 'ios' });
  const sdk = fakeAppleSdk(0);
  const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  assert.equal(outcome, 'revoked');
  assert.equal(signOutCalls.length, 1);
});

// ══ Lifecycle: bounded, idempotent, no polling ═════════════════════════════

test('IDEMPOTENCY: overlapping checks for the same actor collapse into one Apple call and one sign-out', async () => {
  const { mod, signOut, signOutCalls } = harness();
  let releaseApple;
  const applePending = new Promise((resolve) => {
    releaseApple = resolve;
  });
  const sdk = fakeAppleSdk(async () => {
    await applePending;
    return 0;
  });
  const deps = { signOut, loadAppleAuthentication: async () => sdk.module };

  const first = mod.runAppleCredentialStateCheck(appleUser(), deps);
  const second = mod.runAppleCredentialStateCheck(appleUser(), deps);
  const third = mod.runAppleCredentialStateCheck(appleUser(), deps);
  releaseApple();

  const outcomes = await Promise.all([first, second, third]);
  assert.equal(outcomes[0], 'revoked');
  assert.equal(outcomes[1], 'in_flight');
  assert.equal(outcomes[2], 'in_flight');
  assert.equal(sdk.calls.length, 1, 'duplicate lifecycle events must not duplicate the Apple request');
  assert.equal(signOutCalls.length, 1, 'duplicate lifecycle events must not duplicate the logout');
});

test('IDEMPOTENCY: the guard releases, so a later boundary can check again', async () => {
  const { mod, signOut } = harness();
  const sdk = fakeAppleSdk(1);
  const deps = { signOut, loadAppleAuthentication: async () => sdk.module };
  assert.equal(await mod.runAppleCredentialStateCheck(appleUser(), deps), 'authorized');
  assert.equal(await mod.runAppleCredentialStateCheck(appleUser(), deps), 'authorized');
  assert.equal(sdk.calls.length, 2, 'sequential boundaries each get a real check');
});

/**
 * The AppleCredentialStateBridge component alone.
 *
 * Ends at the NEXT top-level declaration rather than at `Layout`, so a sibling
 * bridge added later cannot silently be counted as part of this one's
 * boundaries. Repair 07's TerminalDeletionBridge now sits between them.
 */
function appleBridgeSource(layout) {
  const start = layout.indexOf('function AppleCredentialStateBridge()');
  const rest = layout.slice(start + 1);
  const nextDeclaration = rest.search(/\nfunction |\nexport default function /);
  return layout.slice(start, nextDeclaration === -1 ? undefined : start + 1 + nextDeclaration);
}

test('LIFECYCLE: the bridge checks on authenticated restoration and on background -> active only', () => {
  const layout = fs.readFileSync(path.join(ROOT, LAYOUT_REL), 'utf8');
  assert.match(layout, /<AppleCredentialStateBridge \/>/, 'the bridge must be mounted');
  assert.match(
    layout,
    /function AppleCredentialStateBridge\(\)/,
    'the bridge must exist in the layout',
  );
  const bridge = appleBridgeSource(layout);
  // Boundary 1: an authenticated actor becoming available.
  assert.match(bridge, /if \(!userId\) return;/, 'checks are gated on an authenticated actor');
  // Keyed on the actor id (extra deps such as the user object and the logout
  // authority are fine and are what keeps the listener from closing over a
  // departed actor — what matters is that userId leads the dependency array).
  assert.match(bridge, /\[userId[,\]]/, 'restoration boundary is keyed on the actor id');
  // Boundary 2: a real background/inactive -> active transition.
  assert.match(bridge, /AppState\.addEventListener\('change'/);
  assert.match(bridge, /inactive\|background/);
  assert.match(bridge, /next === 'active'/);
  // Boundary discipline: no polling, no timers, no background execution.
  assert.doesNotMatch(bridge, /setInterval|setTimeout/, 'no timer-driven polling');
  assert.match(bridge, /subscription\.remove\(\)/, 'the listener is torn down');
});

test('LIFECYCLE: nothing runs the check on every render', () => {
  const layout = fs.readFileSync(path.join(ROOT, LAYOUT_REL), 'utf8');
  const bridge = appleBridgeSource(layout);
  // Every invocation must sit inside a useEffect, never in the render body.
  const invocations = bridge.match(/runAppleCredentialStateCheck\(/g) ?? [];
  assert.ok(invocations.length > 0, 'the bridge must actually run the check');
  const effects = bridge.match(/useEffect\(/g) ?? [];
  assert.equal(effects.length, 2, 'exactly two lifecycle boundaries');
});

// ══ Destructive-action negative controls ═══════════════════════════════════

test('DESTRUCTIVE-ACTION CONTROL: a revocation performs no action other than the canonical sign-out', async () => {
  const { mod, signOut, signOutCalls } = harness();
  const sdk = fakeAppleSdk(0);
  // The injected dependency set IS the complete set of effects available to
  // the module: an Apple read and the canonical logout. There is no deletion
  // client, no storage handle, no Supabase client, and no Closet/scan store.
  const outcome = await mod.runAppleCredentialStateCheck(appleUser(), {
    signOut,
    loadAppleAuthentication: async () => sdk.module,
  });
  assert.equal(outcome, 'revoked');
  assert.equal(signOutCalls.length, 1);
  assert.equal(sdk.calls.length, 1);
});

test('DESTRUCTIVE-ACTION CONTROL: the module cannot reach deletion, purge, Closet, or Apple-revoke code', () => {
  // The require-shim used by every test above throws on ANY import outside
  // {react-native, ../actorContext}. Loading the module at all therefore
  // proves its entire import surface. This restates that as an explicit,
  // readable assertion, and adds a source scan for the destructive APIs.
  const actorContext = loadActorContext();
  assert.doesNotThrow(() => loadModule({ platformOS: 'ios', actorContext }));

  const source = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
  // Strip comments AND `import type` lines. A type-only import is erased at
  // compile time and creates no runtime dependency — the transpiled module
  // loaded above proves that, since the require-shim would have thrown on any
  // real import of it. What must not exist is a RUNTIME reach into any of
  // these subsystems.
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return false;
      if (trimmed.startsWith('import type ')) return false;
      return true;
    })
    .join('\n');

  for (const forbidden of [
    'apple-revoke-credential',
    'process-account-deletions',
    'handle-user-deletion',
    'deleteUser',
    'deletion_requests',
    'saved_scans',
    'closet_items',
    'functions.invoke',
    'supabaseClient',
    'supabase.',
    'AsyncStorage',
    'clearPersistedAuthSessions',
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `credential-state handling must not reference ${forbidden}`,
    );
  }

  // And the only non-type import surface is the two-entry allowlist itself.
  const runtimeImports = [...source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+'([^']+)'/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    runtimeImports.sort(),
    ['../actorContext', 'react-native'],
    'the runtime import surface must stay exactly react-native + the actor context',
  );
});

test('DESTRUCTIVE-ACTION CONTROL: only revoked/not_found/transferred can ever invalidate a session', () => {
  const { mod } = harness();
  const invalidating = ['revoked', 'not_found', 'transferred'];
  const preserving = [
    'authorized',
    'check_failed',
    'stale_actor',
    'in_flight',
    'not_apple_actor',
    'unsupported_platform',
  ];
  for (const outcome of invalidating) {
    assert.equal(mod.isInvalidatingOutcome(outcome), true, `${outcome} must invalidate`);
  }
  for (const outcome of preserving) {
    assert.equal(mod.isInvalidatingOutcome(outcome), false, `${outcome} must preserve the session`);
  }
});

test('LOGOUT AUTHORITY: the module reproduces no part of the canonical sign-out', () => {
  const source = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
    .join('\n');
  // Each of these belongs to AuthSessionContext's signOut, which is injected.
  for (const owned of [
    'auth.signOut',
    'resetPostHogUser',
    'syncPostHogIdentity',
    'revokeWatchAlertsForThisDevice',
    'resetActorScopedRuntimeState',
    'advanceActorEpoch',
    'stopAvatarSpeechPlayback',
  ]) {
    assert.ok(!code.includes(owned), `${owned} is the logout authority's job, not this module's`);
  }
  // It calls exactly one thing to end a session: the injected authority.
  assert.match(code, /deps\.signOut\(\)/);
});
