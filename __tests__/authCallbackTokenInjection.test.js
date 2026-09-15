#!/usr/bin/env node
'use strict';

/**
 * SEC-AUTH-CB-001 -- hostile verification of the kscan:// auth callback.
 *
 * THE DEFECT, AS REPRODUCED ON THE CLEAN BUILD 34 RELEASE AUTHORITY
 * (release/kscan-pre-freeze-v1 @ 2e61adf7):
 *
 *   The Supabase client runs the implicit flow -- @supabase/auth-js 2.105.4
 *   defaults `flowType` to 'implicit' and services/supabaseClient.ts does not
 *   override it -- so a legitimate callback arrives as
 *   kscan://auth/callback#access_token=...&refresh_token=... and
 *   services/oauthCallbackSession.ts handed that pair straight to
 *   supabase.auth.setSession().
 *
 *   setSession validates a token pair SERVER-SIDE (GET /auth/v1/user for a
 *   live access token, or the refresh grant for an expired one), so a FORGED
 *   pair was already rejected. What it cannot know is who sent the link. A
 *   pair that is genuinely valid for the ATTACKER's own account passed every
 *   check, so an unsolicited kscan:// link signed the victim's device into the
 *   attacker's account -- silently replacing the identity already signed in.
 *   That is login CSRF / forced login: the victim's later scans, closet and
 *   photos file into an account the attacker controls.
 *
 * THE REPAIR, WHICH THESE TESTS PIN:
 *
 *   gate 1  a token callback naming any account other than the one already
 *           signed in is refused before any session is written.
 *   gate 2  a token callback on a signed-out device is honoured only while a
 *           device-initiated marker from services/authCallbackOrigin is live.
 *
 * Every token here is synthetic. No real user, project or credential appears,
 * and the fake auth server below only ever recognises the two fixture pairs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const { parseAuthCallbackUrl } = require('../services/authDeepLink');

// ── synthetic identities ─────────────────────────────────────────────────────

const VICTIM = { id: '11111111-1111-4111-8111-111111111111', email: 'victim@example.invalid' };
const ATTACKER = { id: '22222222-2222-4222-8222-222222222222', email: 'attacker@example.invalid' };

/** A structurally real, cryptographically meaningless JWT. */
function synthJwt(sub, expOffsetSeconds = 3600) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [
    b64({ alg: 'HS256', typ: 'JWT' }),
    b64({ sub, exp: Math.floor(Date.now() / 1000) + expOffsetSeconds }),
    'c3ludGhldGljLXNpZ25hdHVyZQ',
  ].join('.');
}

const TOKENS = {
  victimAccess: synthJwt(VICTIM.id),
  victimRefresh: 'victim-refresh-token',
  attackerAccess: synthJwt(ATTACKER.id),
  attackerRefresh: 'attacker-refresh-token',
  attackerExpiredAccess: synthJwt(ATTACKER.id, -3600),
  // A token that LIES about sub to try to slip past the identity comparison.
  attackerSpoofingVictim: synthJwt(VICTIM.id),
};

// ── module loader ────────────────────────────────────────────────────────────

function loadService(defaultClient, origin) {
  const filename = path.join(ROOT, 'services/oauthCallbackSession.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      Date,
      Error,
      Math,
      Promise,
      Buffer,
      JSON,
      exports: module.exports,
      module,
      require: (id) => {
        if (id === './supabaseClient') return { supabase: defaultClient };
        if (id === './authCallbackOrigin') return origin;
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

/** The real origin module, so the identity comparison is the shipped one. */
function loadOriginModule(store) {
  const filename = path.join(ROOT, 'services/authCallbackOrigin.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      Date,
      Error,
      Math,
      Number,
      Object,
      Promise,
      Buffer,
      JSON,
      String,
      exports: module.exports,
      module,
      require: (id) => {
        if (id === '@react-native-async-storage/async-storage') return { default: store };
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  const exported = module.exports;
  exported.__setAuthCallbackRequestStoreForTests(store);
  return exported;
}

function memoryStore() {
  const map = new Map();
  return {
    map,
    async getItem(k) { return map.has(k) ? map.get(k) : null; },
    async setItem(k, v) { map.set(k, v); },
    async removeItem(k) { map.delete(k); },
  };
}

function throwingStore() {
  return {
    async getItem() { throw new Error('keystore unavailable'); },
    async setItem() { throw new Error('keystore unavailable'); },
    async removeItem() { throw new Error('keystore unavailable'); },
  };
}

// ── a faithful stand-in for @supabase/auth-js 2.105.4 ────────────────────────
// setSession's real contract: decode the access token; if unexpired, validate
// it with GET /auth/v1/user; if expired, spend the refresh token. Either way
// the SERVER decides. Only the two fixture pairs exist here -- anything else
// is forged and is rejected exactly as GoTrue would reject it.

const SERVER_PAIRS = new Map([
  [TOKENS.victimAccess, { user: VICTIM, refresh: TOKENS.victimRefresh }],
  [TOKENS.attackerAccess, { user: ATTACKER, refresh: TOKENS.attackerRefresh }],
  [TOKENS.attackerExpiredAccess, { user: ATTACKER, refresh: TOKENS.attackerRefresh }],
]);

function makeClient(initialSession = null) {
  let stored = initialSession;
  const events = [];
  const calls = { setSession: 0, exchangeCodeForSession: 0, getSession: 0 };
  return {
    events,
    calls,
    get stored() { return stored; },
    auth: {
      /** Test seam: lets the OTP client below replace the stored session. */
      __store(next) { stored = next; },
      async getSession() {
        calls.getSession += 1;
        return { data: { session: stored }, error: null };
      },
      async exchangeCodeForSession() {
        calls.exchangeCodeForSession += 1;
        // flowType is implicit on this line, so a code has no local verifier.
        return { data: { session: null }, error: new Error('no code verifier present') };
      },
      async setSession({ access_token: accessToken, refresh_token: refreshToken }) {
        calls.setSession += 1;
        if (!accessToken || !refreshToken) {
          return { data: { session: null, user: null }, error: new Error('AuthSessionMissingError') };
        }
        const record = SERVER_PAIRS.get(accessToken);
        if (!record || record.refresh !== refreshToken) {
          return { data: { session: null, user: null }, error: new Error('invalid claim: token is invalid') };
        }
        const session = { access_token: accessToken, refresh_token: refreshToken, user: record.user };
        stored = session;
        events.push(['SIGNED_IN', record.user.id]);
        return { data: { session, user: record.user }, error: null };
      },
    },
  };
}

const sessionFor = (user, accessToken, refreshToken) => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  user,
});

function tokenCallbackUrl(accessToken, refreshToken, extra = '') {
  return `kscan://auth/callback#access_token=${accessToken}&refresh_token=${refreshToken}&token_type=bearer&expires_in=3600${extra}`;
}

/** One hostile or legitimate delivery, end to end. */
async function deliver(url, { session = null, store = null, markerKind = null } = {}) {
  const backing = store ?? memoryStore();
  const origin = loadOriginModule(backing);
  if (markerKind) await origin.beginAuthCallbackRequest(markerKind);
  const client = makeClient(session);
  const { completeOAuthCallbackSession } = loadService(client, origin);
  const result = await completeOAuthCallbackSession(parseAuthCallbackUrl(url), client);
  return { result, client, origin, store: backing };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. LEGITIMATE FLOWS STILL WORK
// ═══════════════════════════════════════════════════════════════════════════

test('LEGIT: an email/OAuth callback the device asked for establishes the session', async () => {
  const { result, client } = await deliver(
    tokenCallbackUrl(TOKENS.victimAccess, TOKENS.victimRefresh),
    { markerKind: 'oauth' },
  );
  assert.equal(result.error, null);
  assert.equal(result.source, 'tokens');
  assert.equal(result.session.user.id, VICTIM.id);
  assert.deepEqual(client.events, [['SIGNED_IN', VICTIM.id]]);
});

test('LEGIT: a password-reset callback works at cold start, long after the request', async () => {
  const store = memoryStore();
  const origin = loadOriginModule(store);
  // Requested now; the link is opened from a mail client 12 hours later, after
  // the app was killed -- the marker is durable, so it is still honoured.
  await origin.beginAuthCallbackRequest('password_reset', Date.now() - 12 * 60 * 60 * 1000);

  const { result } = await deliver(
    tokenCallbackUrl(TOKENS.victimAccess, TOKENS.victimRefresh, '&type=recovery'),
    { store, markerKind: null },
  );
  assert.equal(result.error, null);
  assert.equal(result.session.user.id, VICTIM.id);
});

test('LEGIT: a code/PKCE callback is untouched by the origin gate', async () => {
  const store = memoryStore();
  const origin = loadOriginModule(store);
  const client = makeClient(null);
  const { completeOAuthCallbackSession } = loadService(client, origin);
  const result = await completeOAuthCallbackSession(
    parseAuthCallbackUrl('kscan://auth/callback?code=abc123'),
    client,
  );
  assert.equal(result.source, 'code');
  assert.equal(client.calls.exchangeCodeForSession, 1);
  assert.equal(client.calls.setSession, 0, 'a code callback must never reach setSession');
});

test('LEGIT: signing in again as the SAME account is accepted, not treated as an attack', async () => {
  const existing = sessionFor(VICTIM, TOKENS.victimAccess, TOKENS.victimRefresh);
  const { result } = await deliver(
    tokenCallbackUrl(TOKENS.victimAccess, TOKENS.victimRefresh),
    { session: existing, markerKind: 'oauth' },
  );
  assert.equal(result.error, null);
  assert.equal(result.session.user.id, VICTIM.id);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE REPORTED ATTACK -- CROSS-ACCOUNT SESSION SUBSTITUTION
// ═══════════════════════════════════════════════════════════════════════════

test('ATTACK: a crafted callback can no longer replace a signed-in user with another account', async () => {
  const existing = sessionFor(VICTIM, TOKENS.victimAccess, TOKENS.victimRefresh);
  const { result, client } = await deliver(
    tokenCallbackUrl(TOKENS.attackerAccess, TOKENS.attackerRefresh),
    { session: existing, markerKind: 'oauth' },
  );

  assert.equal(result.session, null);
  assert.equal(result.error.reason, 'identity_substitution');
  assert.equal(client.calls.setSession, 0, 'refused BEFORE any session is written');
  assert.deepEqual(client.events, [], 'no SIGNED_IN event for the substituted account');
  assert.equal(client.stored.user.id, VICTIM.id, 'the signed-in identity is unchanged');
});

test('ATTACK: the substitution is refused even while a legitimate flow is in flight', async () => {
  // The worst case for gate 2 alone: the user really did start an OAuth flow,
  // so a marker is live. Gate 1 still refuses the foreign identity.
  const existing = sessionFor(VICTIM, TOKENS.victimAccess, TOKENS.victimRefresh);
  const { result, client } = await deliver(
    tokenCallbackUrl(TOKENS.attackerAccess, TOKENS.attackerRefresh),
    { session: existing, markerKind: 'oauth' },
  );
  assert.equal(result.error.reason, 'identity_substitution');
  assert.equal(client.calls.setSession, 0);
});

test('ATTACK: an unsolicited callback on a signed-OUT device is refused', async () => {
  const { result, client } = await deliver(
    tokenCallbackUrl(TOKENS.attackerAccess, TOKENS.attackerRefresh),
    { markerKind: null },
  );
  assert.equal(result.session, null);
  assert.equal(result.error.reason, 'unsolicited_callback');
  assert.equal(client.calls.setSession, 0);
  assert.equal(client.stored, null);
});

test('ATTACK: a token that LIES about sub to match the victim still cannot install a session', async () => {
  // attackerSpoofingVictim claims sub = VICTIM, so it passes the local
  // comparison -- and is then rejected by the server, which is the only thing
  // that decides identity. The unverified claim is a routing hint, never trust.
  const existing = sessionFor(VICTIM, TOKENS.victimAccess, TOKENS.victimRefresh);
  const { result, client } = await deliver(
    tokenCallbackUrl(TOKENS.attackerSpoofingVictim, TOKENS.attackerRefresh),
    { session: existing, markerKind: 'oauth' },
  );
  assert.equal(client.stored.user.id, VICTIM.id, 'the victim session is never replaced');
  assert.notEqual(result.session && result.session.user.id, ATTACKER.id);
});

test('ATTACK: an expired attacker access token cannot be refreshed into a live foreign session', async () => {
  const existing = sessionFor(VICTIM, TOKENS.victimAccess, TOKENS.victimRefresh);
  const { result, client } = await deliver(
    tokenCallbackUrl(TOKENS.attackerExpiredAccess, TOKENS.attackerRefresh),
    { session: existing, markerKind: 'oauth' },
  );
  assert.equal(result.error.reason, 'identity_substitution');
  assert.equal(client.calls.setSession, 0);
  assert.equal(client.stored.user.id, VICTIM.id);
});

test('ATTACK: replaying the same hostile callback is refused every time', async () => {
  const store = memoryStore();
  const origin = loadOriginModule(store);
  const client = makeClient(null);
  const { completeOAuthCallbackSession } = loadService(client, origin);
  const parsed = parseAuthCallbackUrl(tokenCallbackUrl(TOKENS.attackerAccess, TOKENS.attackerRefresh));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await completeOAuthCallbackSession(parsed, client);
    assert.equal(result.session, null, `replay ${attempt + 1} must stay refused`);
    assert.equal(result.error.reason, 'unsolicited_callback');
  }
  assert.equal(client.calls.setSession, 0);
  assert.equal(client.stored, null);
});

test('ATTACK: a hostile link arriving AFTER a legitimate sign-in finds no marker left to spend', async () => {
  const store = memoryStore();
  const origin = loadOriginModule(store);
  await origin.beginAuthCallbackRequest('oauth');
  const client = makeClient(null);
  const { completeOAuthCallbackSession } = loadService(client, origin);

  const ok = await completeOAuthCallbackSession(
    parseAuthCallbackUrl(tokenCallbackUrl(TOKENS.victimAccess, TOKENS.victimRefresh)),
    client,
  );
  assert.equal(ok.session.user.id, VICTIM.id);
  assert.equal(await origin.peekAuthCallbackRequest(), null, 'the marker is spent on success');

  const hostile = await completeOAuthCallbackSession(
    parseAuthCallbackUrl(tokenCallbackUrl(TOKENS.attackerAccess, TOKENS.attackerRefresh)),
    client,
  );
  assert.equal(hostile.error.reason, 'identity_substitution');
  assert.equal(client.stored.user.id, VICTIM.id);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE REST OF THE HOSTILE MATRIX
// ═══════════════════════════════════════════════════════════════════════════

test('MATRIX: forged / random tokens are rejected (server-side validation still holds)', async () => {
  const { result, client } = await deliver(
    tokenCallbackUrl('not-a-real-access-token', 'not-a-real-refresh-token'),
    { markerKind: 'oauth' },
  );
  assert.ok(result.error);
  assert.equal(result.session, null);
  assert.equal(client.stored, null);
});

test('MATRIX: a mismatched pair (real access token, wrong refresh token) is rejected', async () => {
  const { result, client } = await deliver(
    tokenCallbackUrl(TOKENS.victimAccess, TOKENS.attackerRefresh),
    { markerKind: 'oauth' },
  );
  assert.ok(result.error);
  assert.equal(client.stored, null);
});

test('MATRIX: an access token with no refresh token is not a session callback at all', async () => {
  const { result, client } = await deliver(
    `kscan://auth/callback#access_token=${TOKENS.attackerAccess}&token_type=bearer`,
    { markerKind: 'oauth' },
  );
  assert.equal(result.source, 'missing');
  assert.equal(result.session, null);
  assert.equal(client.calls.setSession, 0);
});

test('MATRIX: a malformed callback touches auth not at all', async () => {
  const { result, client } = await deliver('kscan://auth/callback#not=a&real=callback', {
    markerKind: 'oauth',
  });
  assert.equal(result.source, 'missing');
  assert.equal(client.calls.setSession + client.calls.exchangeCodeForSession, 0);
});

test('MATRIX: query-string token delivery is gated identically to fragment delivery', async () => {
  // Expo Router hands route params through buildAuthCallbackUrlFromParams, so
  // the ?access_token= shape reaches the same code path and must be gated too.
  const { result, client } = await deliver(
    `kscan://auth/callback?access_token=${TOKENS.attackerAccess}&refresh_token=${TOKENS.attackerRefresh}`,
    { markerKind: null },
  );
  assert.equal(result.error.reason, 'unsolicited_callback');
  assert.equal(client.calls.setSession, 0);
});

test('MATRIX: an attacker-chosen type=recovery does not manufacture authorisation', async () => {
  const { result, client } = await deliver(
    tokenCallbackUrl(TOKENS.attackerAccess, TOKENS.attackerRefresh, '&type=recovery'),
    { markerKind: null },
  );
  assert.equal(result.error.reason, 'unsolicited_callback');
  assert.equal(client.calls.setSession, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE MARKER ITSELF
// ═══════════════════════════════════════════════════════════════════════════

test('MARKER: an expired marker does not authorise a callback, and is cleared', async () => {
  const store = memoryStore();
  const origin = loadOriginModule(store);
  const ttl = origin.AUTH_CALLBACK_REQUEST_TTL_MS.oauth;
  await origin.beginAuthCallbackRequest('oauth', Date.now() - ttl - 1);

  assert.equal(await origin.peekAuthCallbackRequest(), null);
  const { result } = await deliver(tokenCallbackUrl(TOKENS.attackerAccess, TOKENS.attackerRefresh), {
    store,
  });
  assert.equal(result.error.reason, 'unsolicited_callback');
});

test('MARKER: each kind expires on its own TTL, and email kinds outlive an OAuth round trip', async () => {
  const origin = loadOriginModule(memoryStore());
  const ttls = origin.AUTH_CALLBACK_REQUEST_TTL_MS;
  assert.ok(ttls.oauth > 0 && ttls.oauth <= 60 * 60 * 1000, 'oauth stays a short window');
  for (const kind of ['password_reset', 'email_confirmation']) {
    assert.ok(ttls[kind] > ttls.oauth, `${kind} must outlive an OAuth round trip`);
    assert.ok(ttls[kind] <= 24 * 60 * 60 * 1000, `${kind} must not outlive its own link`);
  }
});

test('MARKER: a corrupt, unknown-kind or future-dated marker reads as no marker', async () => {
  const origin = loadOriginModule(memoryStore());
  for (const raw of [
    'not json',
    '"a string"',
    '{"kind":"admin_override","startedAt":0}',
    '{"kind":"oauth"}',
    '{"kind":"oauth","startedAt":"soon"}',
    JSON.stringify({ kind: 'oauth', startedAt: Date.now() + 60_000 }),
  ]) {
    origin.__setAuthCallbackRequestStoreForTests({
      async getItem() { return raw; },
      async setItem() {},
      async removeItem() {},
    });
    assert.equal(await origin.peekAuthCallbackRequest(), null, `must reject: ${raw}`);
  }
});

test('MARKER: unreadable storage fails CLOSED -- the callback is refused, not trusted', async () => {
  const { result, client } = await deliver(
    tokenCallbackUrl(TOKENS.attackerAccess, TOKENS.attackerRefresh),
    { store: throwingStore() },
  );
  assert.equal(result.error.reason, 'unsolicited_callback');
  assert.equal(client.calls.setSession, 0);
});

test('MARKER: an unwritable store never aborts the sign-in attempt itself', async () => {
  const origin = loadOriginModule(throwingStore());
  await assert.doesNotReject(() => origin.beginAuthCallbackRequest('oauth'));
});

test('MARKER: the persisted marker holds no token, code, email or secret', async () => {
  const store = memoryStore();
  const origin = loadOriginModule(store);
  await origin.beginAuthCallbackRequest('password_reset');
  const [[key, value]] = [...store.map.entries()];
  assert.match(key, /^kscan-auth-callback-request$/);
  assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ['kind', 'startedAt']);
  assert.equal(JSON.parse(value).kind, 'password_reset');
});

test('MARKER: readUnverifiedSubjectClaim never throws and never invents an identity', async () => {
  const origin = loadOriginModule(memoryStore());
  for (const bad of [null, undefined, '', 'a.b', 'a.b.c.d', 'x.!!!.z', 'x.e30.z']) {
    assert.equal(origin.readUnverifiedSubjectClaim(bad), null, `must be null for ${String(bad)}`);
  }
  assert.equal(origin.readUnverifiedSubjectClaim(TOKENS.victimAccess), VICTIM.id);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE WIRING -- every flow that can land tokens marks itself first
// ═══════════════════════════════════════════════════════════════════════════

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('WIRING: every flow that redirects to the callback records a marker first', () => {
  const flows = [
    ['app/auth/index.tsx', 'signInWithOAuth', "beginAuthCallbackRequest('oauth')"],
    ['app/onboarding/index.tsx', 'signInWithOAuth', "beginAuthCallbackRequest('oauth')"],
    ['app/auth/reset.tsx', 'resetPasswordForEmail', "beginAuthCallbackRequest('password_reset')"],
    ['contexts/AuthSessionContext.tsx', 'signUp', "beginAuthCallbackRequest('email_confirmation')"],
  ];
  for (const [file, requestCall, marker] of flows) {
    const src = read(file);
    const markerIdx = src.indexOf(marker);
    const requestIdx = src.indexOf(`supabase.auth.${requestCall}(`);
    assert.ok(markerIdx > -1, `${file} must record a callback marker`);
    assert.ok(requestIdx > -1, `${file} must still make its ${requestCall} request`);
    assert.ok(markerIdx < requestIdx, `${file}: the marker must be written BEFORE ${requestCall}`);
  }
});

test('WIRING: no AUTH_CALLBACK_URL redirect exists without a marker beside it', () => {
  const callers = ['app/auth/index.tsx', 'app/onboarding/index.tsx', 'app/auth/reset.tsx', 'contexts/AuthSessionContext.tsx'];
  for (const file of callers) {
    const src = read(file);
    if (!/(redirectTo|emailRedirectTo):\s*AUTH_CALLBACK_URL/.test(src)) continue;
    assert.match(src, /beginAuthCallbackRequest\(/, `${file} redirects to the callback but records no marker`);
  }
});

test('WIRING: the callback session service refuses tokens through a named security error', () => {
  const src = read('services/oauthCallbackSession.ts');
  assert.match(src, /class AuthCallbackOriginError/);
  assert.match(src, /'unsolicited_callback'/);
  assert.match(src, /'identity_substitution'/);
  // The identity decision must precede the setSession call in source order.
  assert.ok(
    src.indexOf('identity_substitution') < src.indexOf('client.auth.setSession'),
    'the identity gate must be decided before setSession is reached',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE OTP (token_hash) HALF OF THE SAME CALLBACK
// ═══════════════════════════════════════════════════════════════════════════
//
// A token_hash link is server-verified and single-use, so it cannot be forged
// -- but an attacker can start a password reset on their OWN account and
// forward the resulting kscan:// link, which is the same forced login. The
// marker is the gate here; a token_hash names no subject, so the identity check
// can only run after the fact, and undoes the substitution locally.

/** verifyOtp resolves whichever fixture account the hash belongs to. */
const OTP_HASHES = new Map([
  ['victim-recovery-hash', VICTIM],
  ['attacker-recovery-hash', ATTACKER],
]);

function makeOtpClient(initialSession = null) {
  const client = makeClient(initialSession);
  client.calls.verifyOtp = 0;
  client.calls.signOut = 0;
  client.auth.verifyOtp = async ({ token_hash: tokenHash }) => {
    client.calls.verifyOtp += 1;
    const user = OTP_HASHES.get(tokenHash);
    if (!user) return { data: { session: null, user: null }, error: new Error('Token has expired or is invalid') };
    const session = sessionFor(user, synthJwt(user.id), `${user.id}-refresh`);
    client.auth.__store(session);
    client.events.push(['SIGNED_IN', user.id]);
    return { data: { session, user }, error: null };
  };
  client.auth.signOut = async () => {
    client.calls.signOut += 1;
    client.auth.__store(null);
    return { error: null };
  };
  return client;
}

function otpUrl(hash, type = 'recovery') {
  return `kscan://auth/callback#token_hash=${hash}&type=${type}`;
}

async function deliverOtp(url, { session = null, markerKind = null } = {}) {
  const store = memoryStore();
  const origin = loadOriginModule(store);
  if (markerKind) await origin.beginAuthCallbackRequest(markerKind);
  const client = makeOtpClient(session);
  const { completeTokenHashCallbackSession } = loadService(client, origin);
  const result = await completeTokenHashCallbackSession(parseAuthCallbackUrl(url), client);
  return { result, client, origin };
}

test('OTP LEGIT: a recovery link the device asked for verifies and establishes the session', async () => {
  const { result, client } = await deliverOtp(otpUrl('victim-recovery-hash'), {
    markerKind: 'password_reset',
  });
  assert.equal(result.error, null);
  assert.equal(result.source, 'otp');
  assert.equal(result.session.user.id, VICTIM.id);
  assert.equal(client.calls.verifyOtp, 1);
});

test('OTP ATTACK: a forwarded recovery link for the attacker account is refused unsolicited', async () => {
  const { result, client } = await deliverOtp(otpUrl('attacker-recovery-hash'), { markerKind: null });
  assert.equal(result.session, null);
  assert.equal(result.error.reason, 'unsolicited_callback');
  assert.equal(client.calls.verifyOtp, 0, 'the one-time token is never even spent');
  assert.equal(client.stored, null);
});

test('OTP ATTACK: a substitution that gets past the marker is undone, not left standing', async () => {
  const existing = sessionFor(VICTIM, TOKENS.victimAccess, TOKENS.victimRefresh);
  // Worst case: the victim really did start a reset, and the attacker's link
  // wins the race inside that window.
  const { result, client } = await deliverOtp(otpUrl('attacker-recovery-hash'), {
    session: existing,
    markerKind: 'password_reset',
  });
  assert.equal(result.session, null);
  assert.equal(result.error.reason, 'identity_substitution');
  assert.equal(client.calls.signOut, 1, 'the substituted session is cleared from the device');
  assert.equal(client.stored, null, 'the device is signed out rather than left as the attacker');
});

test('OTP: a local-scope sign-out is used, so no account we do not own is touched globally', () => {
  const src = read('services/oauthCallbackSession.ts');
  assert.match(src, /signOut\(\{ scope: 'local' \}\)/);
});

test('OTP: an invalid or expired one-time token is refused without a session', async () => {
  const { result, client } = await deliverOtp(otpUrl('expired-hash'), { markerKind: 'password_reset' });
  assert.ok(result.error);
  assert.equal(result.session, null);
  assert.equal(client.stored, null);
});

test('OTP: a callback with a token_hash but no type is not an OTP callback', async () => {
  const { result, client } = await deliverOtp('kscan://auth/callback#token_hash=victim-recovery-hash', {
    markerKind: 'password_reset',
  });
  assert.equal(result.source, 'missing');
  assert.equal(client.calls.verifyOtp, 0);
});

test('WIRING: the callback screen routes token_hash through the gated path, not verifyOtp directly', () => {
  const src = read('app/auth/callback.tsx');
  assert.match(src, /completeTokenHashCallbackSession\(parsed\)/);
  assert.ok(
    !/supabase\.auth\.verifyOtp/.test(src),
    'the screen must not call verifyOtp directly any more -- that bypasses the gate',
  );
});

test('WIRING: a refused link is never reported to the user as a completed sign-in', () => {
  const src = read('app/auth/callback.tsx');
  assert.match(src, /AuthCallbackOriginError/);
  assert.match(src, /AUTH_CALLBACK_REFUSED_MESSAGE/);
  const refused = src.slice(src.indexOf('AUTH_CALLBACK_REFUSED_MESSAGE ='));
  const literal = refused.slice(0, refused.indexOf(';'));
  assert.ok(!/completed/i.test(literal), 'the refusal copy must not claim the sign-in completed');
  // One message for both reasons: a refusal never names the account involved.
  assert.ok(!/account|email|user/i.test(literal), 'the refusal copy must not describe the other account');
});
