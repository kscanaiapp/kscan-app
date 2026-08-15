/**
 * KSB29-057 — LOGOUT MUST SURVIVE A NETWORK FAILURE.
 *
 * THE DEFECT, PRECISELY. `AuthSessionContext.signOut` was:
 *
 *     setSession(null);
 *     await supabase.auth.signOut();
 *
 * and auth-js's `_signOut` only reaches its local `_removeSession()` step if
 * the remote revocation succeeded or failed with 401/403/404:
 *
 *     const { error } = await this.admin.signOut(accessToken, scope)
 *     if (error) {
 *       if (!(isAuthApiError(error) && (404|401|403) || isAuthSessionMissingError(error)))
 *         return this._returnResult({ error })      <-- returns HERE
 *     }
 *     if (scope !== 'others') { await this._removeSession() }   <-- never runs
 *
 * A plain network failure is none of those statuses, so the persisted session
 * survived. The UI showed the user as signed out, and the next cold start
 * restored them as authenticated — the previous actor, with their wardrobe and
 * their Dressing Rooms, returned on a device the user had explicitly logged
 * out of.
 *
 * The first test drives the REAL auth-js client against a failing network to
 * prove the underlying behaviour is genuinely what the fix must compensate for,
 * rather than taking the source reading on trust.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function parse(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  return ts.createSourceFile(filename, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);
}

function* walk(node) {
  yield node;
  for (const child of node.getChildren()) yield* walk(child);
}

function findFunctionBody(sourceFile, name) {
  for (const node of walk(sourceFile)) {
    if (!ts.isVariableDeclaration(node) || node.name.getText() !== name) continue;
    return node.initializer.getText();
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The behaviour the fix exists to compensate for                      */
/* ------------------------------------------------------------------ */

test('auth-js really does keep the persisted session when revocation fails offline', async () => {
  const { createClient } = require('@supabase/supabase-js');

  const store = new Map();
  const storage = {
    getItem: async (key) => (store.has(key) ? store.get(key) : null),
    setItem: async (key, value) => void store.set(key, value),
    removeItem: async (key) => void store.delete(key),
  };

  const client = createClient('https://durable-logout-test.supabase.co', 'test-anon-key', {
    auth: {
      storage,
      storageKey: 'sb-durable-logout-test-auth-token',
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      // Every network call fails the way an offline device fails.
      fetch: async () => {
        throw new TypeError('Network request failed');
      },
    },
  });

  // A structurally valid unsigned JWT: auth-js decodes the payload locally.
  const b64url = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const accessToken = [
    b64url({ alg: 'HS256', typ: 'JWT' }),
    b64url({ sub: '00000000-0000-4000-8000-000000000001', exp: 9_999_999_999, role: 'authenticated' }),
    'signature',
  ].join('.');

  // Seed the persisted session directly rather than via setSession(), which
  // validates over the network and so cannot run on an offline client. This is
  // the same shape auth-js writes, and is what a returning user's device holds.
  const KEY = 'sb-durable-logout-test-auth-token';
  store.set(
    KEY,
    JSON.stringify({
      access_token: accessToken,
      refresh_token: 'refresh-token-1',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: 9_999_999_999,
      user: { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated' },
    }),
  );
  assert.ok(store.size > 0, 'a session must be persisted before the test means anything');

  await client.auth.signOut();

  // THIS is the defect. Not a hypothesis about it — the observed result.
  assert.ok(
    store.size > 0,
    'auth-js leaves the persisted session behind when revocation fails offline',
  );

  // And the fix's mechanism — clearing the key directly — does remove it.
  await storage.removeItem(KEY);
  assert.equal(await storage.getItem(KEY), null);
});

/* ------------------------------------------------------------------ */
/* The repair                                                          */
/* ------------------------------------------------------------------ */

test('the client exposes an unconditional local session clear', () => {
  const sourceFile = parse('services/supabaseClient.ts');

  let declaration = null;
  for (const node of walk(sourceFile)) {
    if (!ts.isFunctionDeclaration(node)) continue;
    if (!node.name || node.name.getText() !== 'clearPersistedAuthSession') continue;
    declaration = node;
  }
  assert.ok(declaration, 'services/supabaseClient.ts must export clearPersistedAuthSession');

  const body = declaration.body.getText();
  // It must go through the bootstrap storage adapter, which resets `hiddenKeys`
  // and clears BOTH the keystore and the legacy AsyncStorage location. Removing
  // only from one of those would leave recoverable material behind.
  assert.match(body, /authStorage\.removeItem/, 'must clear through the adapter the client reads');
  assert.match(body, /code-verifier/, 'must also drop the PKCE verifier auth-js leaves beside it');
});

test('signOut clears local auth material even when remote revocation fails', () => {
  const body = findFunctionBody(parse('contexts/AuthSessionContext.tsx'), 'signOut');
  assert.ok(body, 'AuthSessionContext must define signOut');

  // The remote call must not be able to abort the local clear.
  const remoteIndex = body.indexOf('supabase.auth.signOut()');
  const clearIndex = body.indexOf('clearPersistedAuthSession()');
  assert.ok(remoteIndex >= 0, 'remote revocation must still be attempted');
  assert.ok(clearIndex >= 0, 'the local clear must happen');
  assert.ok(
    clearIndex > remoteIndex,
    'the local clear must follow the remote attempt, not replace it',
  );

  // An unguarded `await supabase.auth.signOut()` would propagate and skip
  // everything after it, which is the whole defect.
  const sourceFile = parse('contexts/AuthSessionContext.tsx');
  let remoteIsGuarded = false;
  let clearIsGuarded = false;
  for (const node of walk(sourceFile)) {
    if (!ts.isTryStatement(node)) continue;
    const block = node.tryBlock.getText();
    if (/supabase\.auth\.signOut\(\)/.test(block)) remoteIsGuarded = true;
    if (/clearPersistedAuthSession\(\)/.test(block)) clearIsGuarded = true;
  }
  assert.ok(remoteIsGuarded, 'a failing remote sign-out must not abort the local clear');
  assert.ok(clearIsGuarded, 'a failing local clear must not throw out of signOut');
});

test('a late auth event cannot restore the actor after an explicit logout', () => {
  const sourceFile = parse('contexts/AuthSessionContext.tsx');
  const body = findFunctionBody(sourceFile, 'signOut');

  // The latch must be taken BEFORE the first await. Everything after an await
  // yields to the event loop, and an auth event landing in that gap would
  // otherwise reinstate the session the user just discarded.
  const latchIndex = body.indexOf('signedOutRef.current = true');
  const firstAwaitIndex = body.indexOf('await ');
  assert.ok(latchIndex >= 0, 'signOut must latch the signed-out state');
  assert.ok(
    latchIndex < firstAwaitIndex,
    'the latch must be taken synchronously, before any await',
  );

  // And the auth-state handler must honour it.
  let handlerHonoursLatch = false;
  let latchClearedOnSignIn = false;
  for (const node of walk(sourceFile)) {
    if (ts.isConditionalExpression(node) && /signedOutRef\.current/.test(node.condition.getText())) {
      // The signed-out branch must yield no session.
      assert.match(
        node.whenTrue.getText(),
        /^null$/,
        'while signed out, an auth event must resolve to no session',
      );
      handlerHonoursLatch = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.left.getText() === 'signedOutRef.current' &&
      node.right.kind === ts.SyntaxKind.FalseKeyword
    ) {
      latchClearedOnSignIn = true;
    }
  }
  assert.ok(handlerHonoursLatch, 'the auth-state handler must refuse sessions while signed out');
  assert.ok(latchClearedOnSignIn, 'a genuine SIGNED_IN must clear the latch');
});
