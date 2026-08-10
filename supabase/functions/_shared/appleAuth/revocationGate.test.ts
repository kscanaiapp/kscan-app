/**
 * Apple revocation gate — the decision the production deletion worker makes
 * immediately before it deletes a Supabase Auth user.
 *
 * Built on node:assert rather than a jsr dependency so no root deno.lock is
 * created; a lockfile at the repo root can influence Edge Function deploy
 * resolution, and a test has no business changing deploy inputs.
 */

import nodeAssert from 'node:assert/strict';

import {
  APPLE_REVOCATION_BLOCKING_STATUSES,
  APPLE_REVOCATION_COMPLETE_STATUSES,
  isBlockingRevocationStatus,
  requestAppleRevocation,
  type RevocationFetch,
} from './revocationGate.ts';

const SUPABASE_URL = 'https://project.supabase.co';
const SERVICE_ROLE_KEY = 'service-role-key-value';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function respondingWith(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl: RevocationFetch = (url, req) => {
    calls.push({ url, headers: req.headers, body: req.body });
    return Promise.resolve({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: () =>
        payload === Symbol.for('malformed')
          ? Promise.reject(new Error('not json'))
          : Promise.resolve(payload),
    });
  };
  return { calls, impl };
}

// ── status semantics ────────────────────────────────────────────────────────

Deno.test('the four safe statuses let the purge continue', () => {
  for (const status of APPLE_REVOCATION_COMPLETE_STATUSES) {
    nodeAssert.equal(
      isBlockingRevocationStatus(status),
      false,
      `${status} must not block the auth delete`,
    );
  }
  // Documented intent, so a future edit to the list is a deliberate act.
  nodeAssert.deepStrictEqual(
    [...APPLE_REVOCATION_COMPLETE_STATUSES],
    ['revoked', 'already_gone', 'no_credential', 'unreadable'],
  );
});

Deno.test('failed and not_configured block the auth delete', () => {
  for (const status of APPLE_REVOCATION_BLOCKING_STATUSES) {
    nodeAssert.equal(isBlockingRevocationStatus(status), true, `${status} must block`);
  }
});

Deno.test('an unknown status fails closed', () => {
  // The gate is allowlist-based: anything not explicitly safe blocks. A future
  // status word added to the Edge Function cannot silently permit a delete.
  for (const status of ['', 'ok', 'success', 'REVOKED', 'partially_revoked', 'undefined']) {
    nodeAssert.equal(isBlockingRevocationStatus(status), true, `${status} must fail closed`);
  }
});

// ── request shape ───────────────────────────────────────────────────────────

Deno.test('the gate calls apple-revoke-credential with the trusted user id', async () => {
  const { calls, impl } = respondingWith({ status: 'revoked' });

  const outcome = await requestAppleRevocation({
    userId: USER_ID,
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetchImpl: impl,
  });

  nodeAssert.equal(outcome.status, 'revoked');
  nodeAssert.equal(calls.length, 1);
  nodeAssert.equal(calls[0].url, `${SUPABASE_URL}/functions/v1/apple-revoke-credential`);
  nodeAssert.equal(calls[0].headers.Authorization, `Bearer ${SERVICE_ROLE_KEY}`);

  // Exactly one field. There is no second identifier a caller could confuse the
  // endpoint with, and the endpoint additionally refuses any non-service-role
  // bearer.
  const body = JSON.parse(calls[0].body);
  nodeAssert.deepStrictEqual(Object.keys(body), ['userId']);
  nodeAssert.equal(body.userId, USER_ID);
});

Deno.test('a trailing slash on the project URL does not produce a double slash', async () => {
  const { calls, impl } = respondingWith({ status: 'no_credential' });
  await requestAppleRevocation({
    userId: USER_ID,
    supabaseUrl: 'https://project.supabase.co/',
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetchImpl: impl,
  });
  nodeAssert.equal(calls[0].url, 'https://project.supabase.co/functions/v1/apple-revoke-credential');
});

// ── every answer maps to a decision, and nothing throws ─────────────────────

Deno.test('each status from the function is passed through unchanged', async () => {
  for (const status of [...APPLE_REVOCATION_COMPLETE_STATUSES, ...APPLE_REVOCATION_BLOCKING_STATUSES]) {
    const { impl } = respondingWith({ status });
    const outcome = await requestAppleRevocation({
      userId: USER_ID,
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      fetchImpl: impl,
    });
    nodeAssert.equal(outcome.status, status);
  }
});

Deno.test('a network exception blocks instead of throwing', async () => {
  const impl: RevocationFetch = () => Promise.reject(new Error('dns'));

  const outcome = await requestAppleRevocation({
    userId: USER_ID,
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetchImpl: impl,
  });

  nodeAssert.equal(outcome.status, 'failed');
  nodeAssert.equal(outcome.detail, 'transport');
  nodeAssert.equal(isBlockingRevocationStatus(outcome.status), true);
});

Deno.test('a non-2xx response blocks', async () => {
  const { impl } = respondingWith({ error: 'Forbidden' }, { ok: false, status: 403 });

  const outcome = await requestAppleRevocation({
    userId: USER_ID,
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetchImpl: impl,
  });

  nodeAssert.equal(outcome.status, 'failed');
  nodeAssert.equal(outcome.detail, 'http_error');
});

Deno.test('a malformed response body blocks', async () => {
  const { impl } = respondingWith(Symbol.for('malformed'));

  const outcome = await requestAppleRevocation({
    userId: USER_ID,
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetchImpl: impl,
  });

  nodeAssert.equal(outcome.status, 'failed');
  nodeAssert.equal(outcome.detail, 'malformed_response');
});

Deno.test('a 200 carrying an unrecognised status blocks', async () => {
  for (const payload of [{ status: 'weird' }, {}, null, { status: 42 }, 'plain-string']) {
    const { impl } = respondingWith(payload);
    const outcome = await requestAppleRevocation({
      userId: USER_ID,
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      fetchImpl: impl,
    });
    nodeAssert.equal(outcome.status, 'failed', `payload ${JSON.stringify(payload)} must block`);
    nodeAssert.equal(outcome.detail, 'unknown_status');
  }
});

// The "gate reimplements no Apple logic" assertion lives in
// __tests__/productionDeletionWorkerAppleRevocation.test.js instead. Reading a
// source file from here would need `deno test --allow-read`, and granting the
// whole Edge Function suite filesystem access to satisfy one source-level check
// is a worse trade than asserting it where source reading is already the idiom.
