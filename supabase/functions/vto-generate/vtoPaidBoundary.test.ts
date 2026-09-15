/**
 * VTO paid-provider boundary — hostile-audit repairs.
 *   INT-KPLUS-007  entitlement must be current AT the provider boundary
 *   SEC-KPLUS-002  a caller-supplied garment URL is not a resource authority
 *   SEC-KPLUS-003  VTO must use CANONICAL K+ semantics, not a fork
 *   SEC-KPLUS-004  one user intent must not buy two provider generations
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isEntitlementRowActive, resolveVtoEntitlement } from './vtoEntitlement.ts';
import { buildVtoIdempotencyKey, reserveVtoGeneration } from './vtoReservation.ts';
import {
  assertSafeRemoteMediaUrl,
  isNonPublicHost,
  resolveSafeRemoteMedia,
} from '../_shared/net/safeRemoteMedia.ts';

const NOW = Date.parse('2026-08-31T12:00:00Z');
const FUTURE = '2026-12-31T00:00:00Z';
const PAST = '2026-01-01T00:00:00Z';
const USER = '11111111-1111-4111-8111-111111111111';

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

// ── SEC-KPLUS-003 — canonical K+ semantics parity ────────────────────────────

test('a null / missing expiry is NOT active (canonical requires expires_at is not null)', () => {
  for (const row of [
    { status: 'active', expires_at: null },
    { status: 'active' },
    { status: 'active', expires_at: '' },
    { status: 'active', expires_at: '   ' },
  ]) {
    assert.equal(
      isEntitlementRowActive(row, NOW),
      false,
      `a null-expiry grant must not be active: ${JSON.stringify(row)}`,
    );
  }
});

test('a REVOKED grant is not active even when status still says active', () => {
  assert.equal(
    isEntitlementRowActive({ status: 'active', expires_at: FUTURE, revoked_at: PAST }, NOW),
    false,
  );
});

test('expired / malformed / wrong-status rows are not active', () => {
  assert.equal(isEntitlementRowActive({ status: 'active', expires_at: PAST }, NOW), false);
  assert.equal(isEntitlementRowActive({ status: 'active', expires_at: 'nope' }, NOW), false);
  assert.equal(isEntitlementRowActive({ status: 'expired', expires_at: FUTURE }, NOW), false);
  assert.equal(isEntitlementRowActive({ status: 'revoked', expires_at: FUTURE }, NOW), false);
  assert.equal(isEntitlementRowActive(null, NOW), false);
  assert.equal(isEntitlementRowActive(undefined, NOW), false);
});

test('a genuinely active, unrevoked, unexpired grant IS active', () => {
  assert.equal(
    isEntitlementRowActive({ status: 'active', expires_at: FUTURE, revoked_at: null }, NOW),
    true,
  );
});

test('resolveVtoEntitlement DELEGATES to the canonical RPC', async () => {
  const calls: string[] = [];
  const outcome = await resolveVtoEntitlement(USER, {
    rpc: async (fn) => {
      calls.push(fn);
      return jsonResponse(true);
    },
    rest: async () => {
      throw new Error('the REST fallback must not run when the RPC answers');
    },
  });
  assert.deepEqual(calls, ['kplus_has_active_entitlement']);
  assert.equal(outcome.state, 'active');
});

test('a canonical false is denied, not unknown', async () => {
  const outcome = await resolveVtoEntitlement(USER, {
    rpc: async () => jsonResponse(false),
    rest: async () => {
      throw new Error('must not fall back on a definite answer');
    },
  });
  assert.equal(outcome.state, 'denied');
});

test('an unreadable authority is unknown (not denied, and never active)', async () => {
  const outcome = await resolveVtoEntitlement(USER, {
    rpc: async () => jsonResponse(null, false),
    rest: async () => jsonResponse(null, false),
  });
  assert.equal(outcome.state, 'unknown');
});

test('the REST fallback applies the SAME canonical rule as the RPC', async () => {
  // RPC unavailable, row has a null expiry -> denied, exactly as canonical.
  const outcome = await resolveVtoEntitlement(USER, {
    rpc: async () => {
      throw new Error('rpc down');
    },
    rest: async () => jsonResponse([{ status: 'active', expires_at: null }]),
    nowMs: NOW,
  });
  assert.equal(outcome.state, 'denied');
  // And the fallback must actually request revoked_at.
  let requestedPath = '';
  await resolveVtoEntitlement(USER, {
    rpc: async () => {
      throw new Error('rpc down');
    },
    rest: async (path) => {
      requestedPath = path;
      return jsonResponse([]);
    },
    nowMs: NOW,
  });
  assert.match(requestedPath, /revoked_at/);
});

// ── SEC-KPLUS-002 — remote garment URL authority ─────────────────────────────

test('loopback, private, link-local and metadata hosts are rejected', () => {
  const hostile = [
    'https://127.0.0.1/g.jpg',
    'https://127.9.9.9/g.jpg',
    'https://localhost/g.jpg',
    'https://sub.localhost/g.jpg',
    'https://10.0.0.5/g.jpg',
    'https://172.16.4.4/g.jpg',
    'https://172.31.255.1/g.jpg',
    'https://192.168.1.1/g.jpg',
    'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'https://100.64.0.1/g.jpg',
    'https://0.0.0.0/g.jpg',
    'https://[::1]/g.jpg',
    'https://[fe80::1]/g.jpg',
    'https://[fd00::1]/g.jpg',
    'https://[::ffff:127.0.0.1]/g.jpg',
    'https://[::ffff:10.0.0.1]/g.jpg',
    'https://[::ffff:169.254.169.254]/g.jpg',
    'https://2130706433/g.jpg',
    'https://0x7f000001/g.jpg',
    'https://internal/g.jpg',
  ];
  for (const url of hostile) {
    const outcome = assertSafeRemoteMediaUrl(url);
    assert.equal(outcome.ok, false, `${url} must be rejected`);
  }
});

test('non-https, embedded credentials and odd ports are rejected', () => {
  assert.equal(assertSafeRemoteMediaUrl('http://cdn.example.com/g.jpg').ok, false);
  assert.equal(assertSafeRemoteMediaUrl('file:///etc/passwd').ok, false);
  assert.equal(assertSafeRemoteMediaUrl('data:image/png;base64,AAA').ok, false);
  assert.equal(assertSafeRemoteMediaUrl('https://u:p@cdn.example.com/g.jpg').ok, false);
  assert.equal(assertSafeRemoteMediaUrl('https://cdn.example.com:8080/g.jpg').ok, false);
  assert.equal(assertSafeRemoteMediaUrl('https://cdn.example.com:22/g.jpg').ok, false);
  assert.equal(assertSafeRemoteMediaUrl('not a url').ok, false);
  assert.equal(assertSafeRemoteMediaUrl(null).ok, false);
});

test('ordinary public retailer URLs still pass — retailer-neutral', () => {
  for (const url of [
    'https://cdn.farfetch.com/img/1.jpg',
    'https://images.kickscrew.com/a/b.png',
    'https://some-unknown-shop.co.uk:443/img.webp',
    'https://m.media-amazon.com/images/I/x.jpg',
  ]) {
    const outcome = assertSafeRemoteMediaUrl(url);
    assert.equal(outcome.ok, true, `${url} must be accepted`);
  }
});

test('isNonPublicHost does not over-block real public hosts', () => {
  for (const host of ['cdn.example.com', '8.8.8.8', '93.184.216.34', 'a.b.c.example.org']) {
    assert.equal(isNonPublicHost(host), false, host);
  }
});

test('a redirect that escapes to a prohibited host is rejected, not followed', async () => {
  const outcome = await resolveSafeRemoteMedia('https://cdn.example.com/g.jpg', {
    fetch: (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data/' },
      })) as unknown as typeof fetch,
  });
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { reason: string }).reason, 'host_not_public');
});

test('a redirect chain that never settles is bounded', async () => {
  let hop = 0;
  const outcome = await resolveSafeRemoteMedia('https://cdn.example.com/g.jpg', {
    maxRedirects: 2,
    fetch: (async () => {
      hop += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://cdn.example.com/hop${hop}.jpg` },
      });
    }) as unknown as typeof fetch,
  });
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { reason: string }).reason, 'too_many_redirects');
});

test('oversized media and disallowed content types are rejected', async () => {
  const big = await resolveSafeRemoteMedia('https://cdn.example.com/g.jpg', {
    fetch: (async () =>
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(50 * 1024 * 1024) },
      })) as unknown as typeof fetch,
  });
  assert.equal(big.ok, false);
  assert.equal((big as { reason: string }).reason, 'too_large');

  const wrongType = await resolveSafeRemoteMedia('https://cdn.example.com/g.svg', {
    fetch: (async () =>
      new Response(null, { status: 200, headers: { 'content-type': 'image/svg+xml' } })) as unknown as typeof fetch,
  });
  assert.equal(wrongType.ok, false);
  assert.equal((wrongType as { reason: string }).reason, 'content_type_not_allowed');
});

// ── SEC-KPLUS-004 — quota + idempotency ──────────────────────────────────────

const IDEM_INPUT = {
  userId: USER,
  productRef: 'farfetch:12345',
  garmentImageUrl: 'https://cdn.example.com/g.jpg',
  personDataUri: 'data:image/jpeg;base64,AAAABBBBCCCC',
};

test('the idempotency key never contains person-image bytes', async () => {
  const key = await buildVtoIdempotencyKey(IDEM_INPUT);
  assert.match(key, /^[0-9a-f]{64}$/, 'must be an opaque digest');
  assert.equal(key.includes('AAAABBBBCCCC'), false);
  assert.equal(key.includes(IDEM_INPUT.personDataUri), false);
});

test('the same intent produces the same key; a different photo does not', async () => {
  const a = await buildVtoIdempotencyKey(IDEM_INPUT);
  const b = await buildVtoIdempotencyKey({ ...IDEM_INPUT });
  assert.equal(a, b, 'a double tap is one intent');

  const otherPhoto = await buildVtoIdempotencyKey({
    ...IDEM_INPUT,
    personDataUri: 'data:image/jpeg;base64,ZZZZZZZZZZZZ',
  });
  assert.notEqual(a, otherPhoto);

  const otherGarment = await buildVtoIdempotencyKey({ ...IDEM_INPUT, productRef: 'farfetch:999' });
  assert.notEqual(a, otherGarment);

  const otherActor = await buildVtoIdempotencyKey({
    ...IDEM_INPUT,
    userId: '22222222-2222-4222-8222-222222222222',
  });
  assert.notEqual(a, otherActor, 'two actors must never share a reservation');
});

test('an explicit user Retry is a NEW intent, not a suppressed replay', async () => {
  const first = await buildVtoIdempotencyKey({ ...IDEM_INPUT, requestGeneration: 'gen-1' });
  const retry = await buildVtoIdempotencyKey({ ...IDEM_INPUT, requestGeneration: 'gen-2' });
  assert.notEqual(first, retry);
});

test('a reservation maps every RPC outcome, and FAILS CLOSED when unreadable', async () => {
  const reserved = await reserveVtoGeneration(USER, 'k'.repeat(64), {
    rpc: async () => jsonResponse([{ outcome: 'reserved', used: 1, daily_limit: 10 }]),
  });
  assert.equal(reserved.outcome, 'reserved');

  const dup = await reserveVtoGeneration(USER, 'k'.repeat(64), {
    rpc: async () =>
      jsonResponse([{ outcome: 'duplicate', used: 1, daily_limit: 10, prior_status: 'in_flight' }]),
  });
  assert.equal(dup.outcome, 'duplicate');

  const over = await reserveVtoGeneration(USER, 'k'.repeat(64), {
    rpc: async () => jsonResponse([{ outcome: 'quota_exceeded', used: 10, daily_limit: 10 }]),
  });
  assert.equal(over.outcome, 'quota_exceeded');

  for (const broken of [
    async () => jsonResponse(null, false),
    async () => jsonResponse([]),
    async () => jsonResponse([{ nonsense: true }]),
    async () => {
      throw new Error('network');
    },
  ]) {
    const outcome = await reserveVtoGeneration(USER, 'k'.repeat(64), {
      rpc: broken as never,
    });
    assert.equal(
      outcome.outcome,
      'unavailable',
      'an unaccountable reservation must never read as reserved',
    );
  }
});

// ── Handler ordering (INT-KPLUS-007 + SEC-KPLUS-004 placement) ───────────────

const HANDLER = await Deno.readTextFile(
  new URL('./vtoHandler.ts', import.meta.url),
);

test('entitlement is re-checked AFTER config/eligibility and BEFORE the provider', () => {
  const firstCheck = HANDLER.indexOf('const entitlement = await deps.resolveVtoEntitlement');
  const recheck = HANDLER.indexOf('const entitlementAtBoundary = await deps.resolveVtoEntitlement');
  const generate = HANDLER.indexOf('await selection.provider.generate');
  assert.ok(firstCheck > 0 && recheck > firstCheck, 'a second, later check must exist');
  assert.ok(recheck < generate, 'the recheck must precede the provider call');
});

test('the reservation is taken BEFORE the provider call', () => {
  const reserve = HANDLER.indexOf('await deps.reserveVtoGeneration');
  const generate = HANDLER.indexOf('await selection.provider.generate');
  assert.ok(reserve > 0 && reserve < generate);
});

test('every reservation outcome except reserved returns without spending', () => {
  for (const marker of ['reservation_unavailable', 'reservation_quota', 'reservation_duplicate']) {
    const idx = HANDLER.indexOf(marker);
    assert.ok(idx > 0, `${marker} must be handled`);
    assert.ok(
      idx < HANDLER.indexOf('await selection.provider.generate'),
      `${marker} must short-circuit before the provider call`,
    );
  }
});

test('the reservation is settled on success AND on every failure path', () => {
  const settlements = HANDLER.match(/await deps\.completeVtoGeneration\(/g) ?? [];
  assert.ok(
    settlements.length >= 4,
    `expected settlement on throw, provider-failure, invalid-output and success; found ${settlements.length}`,
  );
  assert.match(HANDLER, /completeVtoGeneration\(authUser\.id, idempotencyKey, 'succeeded'/);
  assert.match(HANDLER, /completeVtoGeneration\(authUser\.id, idempotencyKey, 'failed'/);
});

test('the garment URL is validated before it can reach the provider', () => {
  const check = HANDLER.indexOf('assertSafeRemoteMediaUrl(garment.imageUrl)');
  const generate = HANDLER.indexOf('await selection.provider.generate');
  assert.ok(check > 0 && check < generate);
  // The normalized URL is what flows on, never the caller's raw string.
  assert.match(HANDLER, /garmentImageUrl: garmentUrlCheck\.url/);
});

test('the rejected URL itself is never logged or returned', () => {
  assert.match(HANDLER, /providerDetail: garmentUrlCheck\.reason/);
  assert.doesNotMatch(HANDLER, /providerDetail: garment\.imageUrl/);
});

test('SEC-KPLUS-007 stays closed: an unknown provider fails, it does not mock', async () => {
  const providers = await Deno.readTextFile(
    new URL('./providers/index.ts', import.meta.url),
  );
  assert.match(providers, /return \{ ok: false, reason: 'provider_unavailable' \};/);
  const mockBranch = providers.indexOf('MOCK_VTO_PROVIDER_ID');
  assert.ok(mockBranch > 0, 'the mock must be reachable only by explicit id');
});
