/**
 * IOS29-NEW-003 — Apple client secret, REST contract, and credential envelope.
 *
 * These run against a throwaway P-256 key generated in-test. No real Apple
 * credential is needed, and none is ever committed.
 *
 * Run: deno test --allow-none supabase/functions/_shared/appleAuth/appleAuth.test.ts
 */

// Deliberately built on node:assert rather than jsr:@std/assert. Pulling a
// registry dependency in would create a root deno.lock on the iOS release line,
// and a lockfile at the repo root can influence how Edge Functions resolve at
// deploy time. A test has no business changing deploy inputs.
import nodeAssert from 'node:assert/strict';

// Declared (not an arrow) so it can carry an `asserts` predicate: the tests
// rely on it to narrow the discriminated result unions after a successful call.
function assert(value: unknown, message?: string): asserts value {
  nodeAssert.ok(value, message);
}
const assertEquals = <T>(actual: T, expected: T, message?: string) =>
  nodeAssert.deepStrictEqual(actual, expected, message);
const assertNotEquals = <T>(actual: T, expected: T, message?: string) =>
  nodeAssert.notDeepStrictEqual(actual, expected, message);
const assertRejects = (
  fn: () => Promise<unknown>,
  _errorClass: unknown,
  messageIncludes: string,
) => nodeAssert.rejects(fn, (error: unknown) => {
  nodeAssert.ok(
    error instanceof Error && error.message.includes(messageIncludes),
    `expected rejection containing "${messageIncludes}"`,
  );
  return true;
});

import {
  APPLE_AUDIENCE,
  APPLE_MAX_CLIENT_SECRET_LIFETIME_SECONDS,
  buildClientSecretClaims,
  createAppleClientSecret,
  decodePkcs8Pem,
} from './appleClientSecret.ts';
import {
  APPLE_REVOKE_ENDPOINT,
  APPLE_TOKEN_ENDPOINT,
  exchangeAuthorizationCode,
  isTerminalRevocationFailure,
  parseAppleErrorCode,
  revokeRefreshToken,
  type AppleFetch,
} from './appleRestApi.ts';
import {
  decryptToken,
  encryptToken,
  importEncryptionKey,
} from './credentialStore.ts';
import { isPlausibleAuthorizationCode, resolveAppleConfig } from './config.ts';

/** A disposable ES256 key in the PKCS#8 PEM shape Apple's .p8 uses. */
async function generateTestKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let binary = '';
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const body = btoa(binary).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

function decodeSegment(segment: string): Record<string, unknown> {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
}

const TEST_CONFIG_BASE = {
  teamId: 'TEAM123456',
  keyId: 'KEYID12345',
  clientId: 'com.kscanai.app',
};

// ── client secret ───────────────────────────────────────────────────────────

Deno.test('client secret claims match Apple’s documented specification', () => {
  const claims = buildClientSecretClaims(TEST_CONFIG_BASE, 1_700_000_000, 300);

  assertEquals(claims.iss, 'TEAM123456', 'iss must be the Team ID');
  assertEquals(claims.sub, 'com.kscanai.app', 'sub must equal the client_id');
  assertEquals(claims.aud, APPLE_AUDIENCE);
  assertEquals(claims.iat, 1_700_000_000);
  assertEquals(claims.exp, 1_700_000_300);
});

Deno.test('client secret uses the native App ID, not a web Services ID', () => {
  // For native Sign in with Apple the client_id is the bundle identifier. A
  // Services ID here is the classic cause of invalid_client.
  const claims = buildClientSecretClaims(TEST_CONFIG_BASE, 1_700_000_000);
  assertEquals(claims.sub, 'com.kscanai.app');
});

Deno.test('a lifetime beyond Apple’s six-month ceiling is refused', () => {
  let threw = false;
  try {
    buildClientSecretClaims(
      TEST_CONFIG_BASE,
      1_700_000_000,
      APPLE_MAX_CLIENT_SECRET_LIFETIME_SECONDS + 1,
    );
  } catch (error) {
    threw = true;
    assertEquals((error as Error).message, 'apple_client_secret_lifetime_exceeds_apple_maximum');
  }
  assert(threw, 'exp more than 15777000s ahead is an error on Apple’s side');
});

Deno.test('the signed secret carries an ES256 header with the Key ID', async () => {
  const privateKeyPem = await generateTestKeyPem();
  const jwt = await createAppleClientSecret(
    { ...TEST_CONFIG_BASE, privateKeyPem },
    1_700_000_000,
  );

  const [headerSegment, payloadSegment, signature] = jwt.split('.');
  const header = decodeSegment(headerSegment);
  assertEquals(header.alg, 'ES256');
  assertEquals(header.kid, 'KEYID12345');

  const payload = decodeSegment(payloadSegment);
  assertEquals(payload.iss, 'TEAM123456');
  assertEquals(payload.aud, APPLE_AUDIENCE);

  // JWS ES256 is a raw 64-byte r‖s pair. A DER signature would be longer and
  // Apple would answer invalid_client.
  const normalized = signature.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  assertEquals(raw.length, 64, 'ES256 JWS signatures are exactly 64 raw bytes (r||s)');
});

Deno.test('a .p8 whose newlines were flattened by a secret manager still loads', async () => {
  const pem = await generateTestKeyPem();
  const escaped = pem.replace(/\n/g, '\\n');
  assertEquals(decodePkcs8Pem(escaped).length, decodePkcs8Pem(pem).length);

  // And it actually signs, rather than merely parsing.
  const jwt = await createAppleClientSecret({ ...TEST_CONFIG_BASE, privateKeyPem: escaped });
  assertEquals(jwt.split('.').length, 3);
});

Deno.test('a malformed private key fails without echoing key material', async () => {
  await assertRejects(
    () => createAppleClientSecret({ ...TEST_CONFIG_BASE, privateKeyPem: 'not-a-key' }),
    Error,
    'apple_private_key',
  );
});

// ── token exchange ──────────────────────────────────────────────────────────

function recordingFetch(status: number, body: string) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl: AppleFetch = (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return Promise.resolve({ status, text: () => Promise.resolve(body) });
  };
  return { calls, impl };
}

Deno.test('authorization-code exchange posts exactly Apple’s documented form', async () => {
  const privateKeyPem = await generateTestKeyPem();
  const { calls, impl } = recordingFetch(
    200,
    JSON.stringify({ refresh_token: 'r-token', access_token: 'a-token' }),
  );

  const result = await exchangeAuthorizationCode({
    config: { ...TEST_CONFIG_BASE, privateKeyPem },
    authorizationCode: 'c-code',
    fetchImpl: impl,
  });

  assert(result.ok);
  assertEquals(result.refreshToken, 'r-token');

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, APPLE_TOKEN_ENDPOINT);
  assertEquals(calls[0].headers['content-type'], 'application/x-www-form-urlencoded');

  const form = new URLSearchParams(calls[0].body);
  assertEquals(form.get('grant_type'), 'authorization_code');
  assertEquals(form.get('client_id'), 'com.kscanai.app');
  assertEquals(form.get('code'), 'c-code');
  assert(form.get('client_secret'));

  // Apple: send redirect_uri "only if the application provided a redirect_uri
  // in the initial authorization request". Native sign-in provides none, and
  // sending one anyway is rejected as invalid_client.
  assertEquals(form.has('redirect_uri'), false, 'native exchange must omit redirect_uri');
});

Deno.test('a 200 with no refresh_token is a failure, not a success', async () => {
  const privateKeyPem = await generateTestKeyPem();
  const { impl } = recordingFetch(200, JSON.stringify({ access_token: 'a-token' }));

  const result = await exchangeAuthorizationCode({
    config: { ...TEST_CONFIG_BASE, privateKeyPem },
    authorizationCode: 'c-code',
    fetchImpl: impl,
  });

  assertEquals(result.ok, false);
  assert(!result.ok && result.reason === 'no_refresh_token');
});

Deno.test('a replayed authorization code surfaces Apple’s invalid_grant', async () => {
  const privateKeyPem = await generateTestKeyPem();
  const { impl } = recordingFetch(400, JSON.stringify({ error: 'invalid_grant' }));

  const result = await exchangeAuthorizationCode({
    config: { ...TEST_CONFIG_BASE, privateKeyPem },
    authorizationCode: 'spent-code',
    fetchImpl: impl,
  });

  assert(!result.ok && result.reason === 'apple_error');
  assertEquals(!result.ok && result.reason === 'apple_error' ? result.error : null, 'invalid_grant');
});

Deno.test('a transport failure is distinguished from an Apple rejection', async () => {
  const privateKeyPem = await generateTestKeyPem();
  const impl: AppleFetch = () => Promise.reject(new Error('dns'));

  const result = await exchangeAuthorizationCode({
    config: { ...TEST_CONFIG_BASE, privateKeyPem },
    authorizationCode: 'c-code',
    fetchImpl: impl,
  });

  assert(!result.ok && result.reason === 'transport');
});

// ── revocation ──────────────────────────────────────────────────────────────

Deno.test('revocation posts the refresh token with the documented hint', async () => {
  const privateKeyPem = await generateTestKeyPem();
  const { calls, impl } = recordingFetch(200, '');

  const result = await revokeRefreshToken({
    config: { ...TEST_CONFIG_BASE, privateKeyPem },
    refreshToken: 'r-token',
    fetchImpl: impl,
  });

  assertEquals(result.ok, true);
  assertEquals(calls[0].url, APPLE_REVOKE_ENDPOINT);

  const form = new URLSearchParams(calls[0].body);
  assertEquals(form.get('token'), 'r-token');
  assertEquals(form.get('token_type_hint'), 'refresh_token');
  assertEquals(form.get('client_id'), 'com.kscanai.app');
  assert(form.get('client_secret'));
});

Deno.test('an already-invalidated token still reports success', async () => {
  // Apple documents 200-with-no-body both for a fresh revocation and when the
  // token "was previously invalidated". That is what makes a retried or
  // duplicated deletion run safe.
  const privateKeyPem = await generateTestKeyPem();
  const { impl } = recordingFetch(200, '');

  const result = await revokeRefreshToken({
    config: { ...TEST_CONFIG_BASE, privateKeyPem },
    refreshToken: 'already-revoked',
    fetchImpl: impl,
  });

  assertEquals(result.ok, true);
});

Deno.test('invalid_grant is terminal; everything else stays retryable', async () => {
  const privateKeyPem = await generateTestKeyPem();

  const invalidGrant = await revokeRefreshToken({
    config: { ...TEST_CONFIG_BASE, privateKeyPem },
    refreshToken: 'r',
    fetchImpl: recordingFetch(400, JSON.stringify({ error: 'invalid_grant' })).impl,
  });
  assertEquals(isTerminalRevocationFailure(invalidGrant), true);

  // A bad key or expired secret is an operator problem: retryable, so the
  // deletion pipeline holds rather than dropping the obligation.
  const invalidClient = await revokeRefreshToken({
    config: { ...TEST_CONFIG_BASE, privateKeyPem },
    refreshToken: 'r',
    fetchImpl: recordingFetch(401, JSON.stringify({ error: 'invalid_client' })).impl,
  });
  assertEquals(isTerminalRevocationFailure(invalidClient), false);

  const serverError = await revokeRefreshToken({
    config: { ...TEST_CONFIG_BASE, privateKeyPem },
    refreshToken: 'r',
    fetchImpl: recordingFetch(503, 'upstream unavailable').impl,
  });
  assertEquals(isTerminalRevocationFailure(serverError), false);
});

Deno.test('an unparseable Apple body never leaks into the error code', () => {
  assertEquals(parseAppleErrorCode('<html>gateway timeout</html>'), 'unknown');
  assertEquals(parseAppleErrorCode(JSON.stringify({ error: 'not_a_real_code' })), 'unknown');
  assertEquals(parseAppleErrorCode(JSON.stringify({ error: 'invalid_client' })), 'invalid_client');
});

// ── credential envelope ─────────────────────────────────────────────────────

const TEST_KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

Deno.test('the stored envelope is ciphertext, not the token', async () => {
  const key = await importEncryptionKey(TEST_KEY_B64);
  const envelope = await encryptToken(key, 'apple-refresh-token-value');

  assert(!envelope.includes('apple-refresh-token-value'), 'the plaintext must not survive');
  assert(envelope.startsWith('v1.'), 'the envelope must be versioned');
  assertEquals(envelope.split('.').length, 3);
  assertEquals(await decryptToken(key, envelope), 'apple-refresh-token-value');
});

Deno.test('encrypting twice produces different ciphertext', async () => {
  // A fresh GCM nonce each time. Without it, identical tokens would be
  // correlatable across rows.
  const key = await importEncryptionKey(TEST_KEY_B64);
  assertNotEquals(await encryptToken(key, 'same'), await encryptToken(key, 'same'));
});

Deno.test('a wrong key or tampered envelope decrypts to null, never to garbage', async () => {
  const key = await importEncryptionKey(TEST_KEY_B64);
  const otherKey = await importEncryptionKey(
    btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
  );
  const envelope = await encryptToken(key, 'apple-refresh-token-value');

  assertEquals(await decryptToken(otherKey, envelope), null);
  assertEquals(await decryptToken(key, envelope.replace('v1.', 'v2.')), null);
  assertEquals(await decryptToken(key, 'nonsense'), null);
});

Deno.test('a key of the wrong length is a configuration error', async () => {
  await assertRejects(
    () => importEncryptionKey(btoa('short')),
    Error,
    'apple_token_encryption_key_wrong_length',
  );
});

// ── configuration ───────────────────────────────────────────────────────────

Deno.test('missing Apple configuration is reported by name, never by value', () => {
  const resolution = resolveAppleConfig(() => undefined);
  assertEquals(resolution.configured, false);
  assert(!resolution.configured && resolution.missing.includes('APPLE_PRIVATE_KEY'));
  assert(!resolution.configured && resolution.missing.includes('APPLE_TOKEN_ENCRYPTION_KEY'));
});

Deno.test('a fully provisioned environment resolves', () => {
  const env: Record<string, string> = {
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEY_ID: 'KEYID12345',
    APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
    APPLE_CLIENT_ID: 'com.kscanai.app',
    APPLE_TOKEN_ENCRYPTION_KEY: TEST_KEY_B64,
  };
  const resolution = resolveAppleConfig((name) => env[name]);
  assert(resolution.configured);
  assertEquals(resolution.configured && resolution.config.clientId, 'com.kscanai.app');
});

Deno.test('authorization-code shape guard rejects obvious junk', () => {
  assertEquals(isPlausibleAuthorizationCode('c1a2b3c4d5'), true);
  assertEquals(isPlausibleAuthorizationCode(''), false);
  assertEquals(isPlausibleAuthorizationCode('short'), false);
  assertEquals(isPlausibleAuthorizationCode('has spaces and <html>'), false);
  assertEquals(isPlausibleAuthorizationCode('x'.repeat(513)), false);
  assertEquals(isPlausibleAuthorizationCode(null), false);
});
