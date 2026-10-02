/**
 * The individual fail-closed guards, exercised in isolation.
 *
 * vtoHandler.test.ts proves they are wired in the right order; these prove
 * each one is actually conservative on its own, including on the paths the
 * handler tests reach only through a stub (an unreadable table, a malformed
 * config row, an expired grant).
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  DEFAULT_VTO_SUPPORTED_CATEGORIES,
  DISABLED_VTO_CONFIG,
  normalizeVtoFeatureConfig,
  readVtoFeatureConfig,
} from './vtoFeatureControl.ts';
import { resolveVtoEntitlement } from './vtoEntitlement.ts';
import { evaluateServerVtoEligibility, toCanonicalVtoCategory } from './vtoEligibility.ts';
import { validateVtoResultMedia } from './vtoResultValidation.ts';
import { MOCK_VTO_RESULT_DATA_URI } from './providers/mockResultAsset.ts';
import { MOCK_VTO_PROVIDER_ID, resolveVtoProvider } from './providers/index.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Feature control ──────────────────────────────────────────────────────────

Deno.test('feature control: an unreadable table resolves to disabled', async () => {
  const config = await readVtoFeatureConfig({
    rest: () => Promise.resolve(new Response('nope', { status: 500 })),
  });
  assertEquals(config.enabled, false);
});

Deno.test('feature control: a thrown request resolves to disabled', async () => {
  const config = await readVtoFeatureConfig({
    rest: () => Promise.reject(new Error('network down')),
  });
  assertEquals(config.enabled, false);
});

Deno.test('feature control: a missing row resolves to disabled', async () => {
  const config = await readVtoFeatureConfig({ rest: () => Promise.resolve(jsonResponse([])) });
  assertEquals(config.enabled, false);
});

Deno.test('feature control: only a literal true enables the feature', () => {
  for (const enabled of ['true', 1, 'yes', {}, [], null, undefined]) {
    assertEquals(normalizeVtoFeatureConfig({ schemaVersion: 1, enabled }).enabled, false, String(enabled));
  }
  assertEquals(normalizeVtoFeatureConfig({ schemaVersion: 1, enabled: true }).enabled, true);
});

Deno.test('feature control: an unexpected schemaVersion resolves to disabled', () => {
  const config = normalizeVtoFeatureConfig({ schemaVersion: 2, enabled: true });
  assertEquals(config, DISABLED_VTO_CONFIG);
});

Deno.test('feature control: an explicitly empty category allowlist is honoured', () => {
  // "No category is enabled right now" is a legitimate operator decision and
  // must not silently fall back to the built-in defaults.
  const config = normalizeVtoFeatureConfig({
    schemaVersion: 1,
    enabled: true,
    supportedCategories: [],
  });
  assertEquals(config.supportedCategories, []);
});

Deno.test('feature control: a malformed category list falls back to the default', () => {
  const config = normalizeVtoFeatureConfig({
    schemaVersion: 1,
    enabled: true,
    supportedCategories: ['top', 42, null],
  });
  assertEquals(config.supportedCategories, DEFAULT_VTO_SUPPORTED_CATEGORIES);
});

Deno.test('feature control: an enabled config that names NO provider does not fall back to the mock', () => {
  // The registry refuses to substitute the mock for an unknown provider id,
  // but that guard is one layer below the normalizer and cannot see a default
  // chosen here. An operator who flips `enabled` without naming a provider --
  // a partial write to this same JSON blob is exactly how a kill switch gets
  // toggled -- must not get placeholder art presented as a real try-on.
  const config = normalizeVtoFeatureConfig({ schemaVersion: 1, enabled: true, supportedCategories: ['top'] });
  assertEquals(config.enabled, true);
  assert(config.provider !== MOCK_VTO_PROVIDER_ID, 'must not silently select the mock');
  const selection = resolveVtoProvider({ providerId: config.provider });
  assertEquals(selection.ok, false);
  if (selection.ok === false) assertEquals(selection.reason, 'provider_unavailable');
});

Deno.test('feature control: a blank or non-string provider is unconfigured, not the mock', () => {
  for (const provider of ['', '   ', 12345, null, {}, ['mock']]) {
    const config = normalizeVtoFeatureConfig({ schemaVersion: 1, enabled: true, provider });
    assert(
      config.provider !== MOCK_VTO_PROVIDER_ID,
      `provider ${JSON.stringify(provider)} must not resolve to the mock`,
    );
    assertEquals(resolveVtoProvider({ providerId: config.provider }).ok, false);
  }
});

Deno.test('feature control: the mock is still reachable when an operator names it explicitly', () => {
  // The repair must not break local/dev use: an explicit 'mock' is a
  // deliberate operator choice and stays supported.
  const config = normalizeVtoFeatureConfig({ schemaVersion: 1, enabled: true, provider: 'mock' });
  assertEquals(config.provider, MOCK_VTO_PROVIDER_ID);
  // VTO-MOCK-001: naming it is now necessary but no longer sufficient -- the
  // deployment must also permit the mock. Local/dev use is preserved by
  // granting that permission, which is a deliberate act rather than a default.
  const previous = Deno.env.get('VTO_ALLOW_MOCK_PROVIDER');
  Deno.env.set('VTO_ALLOW_MOCK_PROVIDER', 'true');
  try {
    assertEquals(resolveVtoProvider({ providerId: config.provider }).ok, true);
  } finally {
    if (previous === undefined) Deno.env.delete('VTO_ALLOW_MOCK_PROVIDER');
    else Deno.env.set('VTO_ALLOW_MOCK_PROVIDER', previous);
  }
  Deno.env.delete('VTO_ALLOW_MOCK_PROVIDER');
  assertEquals(resolveVtoProvider({ providerId: config.provider }).ok, false);
});

Deno.test('feature control: the fail-closed constant names no provider at all', () => {
  assertEquals(resolveVtoProvider({ providerId: DISABLED_VTO_CONFIG.provider }).ok, false);
});

Deno.test('feature control: the mock latency knob is bounded', () => {
  assertEquals(normalizeVtoFeatureConfig({ enabled: true, mockLatencyMs: -5 }).mockLatencyMs, 0);
  assertEquals(
    normalizeVtoFeatureConfig({ enabled: true, mockLatencyMs: 10_000_000 }).mockLatencyMs,
    60_000,
  );
});

// ── Entitlement ──────────────────────────────────────────────────────────────

Deno.test('entitlement: an unavailable canonical authority is unknown, not free', async () => {
  const outcome = await resolveVtoEntitlement('user-1', {
    rpc: () => Promise.resolve(new Response('nope', { status: 500 })),
  });
  assertEquals(outcome.state, 'unknown');
});

Deno.test('entitlement: a confirmed canonical no-access answer is denied', async () => {
  const outcome = await resolveVtoEntitlement('user-1', {
    rpc: () => Promise.resolve(jsonResponse(false)),
  });
  assertEquals(outcome.state, 'denied');
});

Deno.test('entitlement: every canonical active grant family is allowed identically', async () => {
  for (const source of ['complimentary', 'store_subscription', 'trial', 'store_lifetime']) {
    const outcome = await resolveVtoEntitlement(`actor-${source}`, {
      rpc: () => Promise.resolve(jsonResponse(true)),
    });
    assertEquals(outcome.state, 'active', source);
  }
});

Deno.test('entitlement: expiry, revocation and refund remain canonical denied answers', async () => {
  for (const lifecycle of ['expired', 'revoked', 'refunded']) {
    const outcome = await resolveVtoEntitlement(`actor-${lifecycle}`, {
      rpc: () => Promise.resolve(jsonResponse(false)),
    });
    assertEquals(outcome.state, 'denied', lifecycle);
  }
});

Deno.test('entitlement: malformed canonical responses are unknown, never free', async () => {
  for (const value of [null, undefined, 0, 1, 'true', [], {}, { hasAccess: true }]) {
    const response = value === undefined
      ? new Response(undefined, { status: 200 })
      : jsonResponse(value);
    const outcome = await resolveVtoEntitlement('user-1', {
      rpc: () => Promise.resolve(response),
    });
    assertEquals(outcome.state, 'unknown', JSON.stringify(value));
  }
});

Deno.test('entitlement: canonical lookup is bound to the authenticated actor and K+ key', async () => {
  const calls: Array<{ fn: string; body: Record<string, unknown> }> = [];
  const rpc = (fn: string, body: Record<string, unknown>) => {
    calls.push({ fn, body });
    return Promise.resolve(jsonResponse(body.p_user_id === 'actor-a'));
  };
  const actorA = await resolveVtoEntitlement('actor-a', { rpc });
  const actorB = await resolveVtoEntitlement('actor-b', { rpc });
  assertEquals(actorA.state, 'active');
  assertEquals(actorB.state, 'denied', 'actor A\'s positive result must not be reused for actor B');
  assertEquals(calls, [
    {
      fn: 'kplus_has_active_entitlement',
      body: { p_user_id: 'actor-a', p_entitlement_key: 'k_plus' },
    },
    {
      fn: 'kplus_has_active_entitlement',
      body: { p_user_id: 'actor-b', p_entitlement_key: 'k_plus' },
    },
  ]);
});

Deno.test('entitlement: a fresh retry recovers after temporary authority failure', async () => {
  let attempts = 0;
  const rpc = () => {
    attempts += 1;
    return attempts === 1
      ? Promise.reject(new Error('temporary outage'))
      : Promise.resolve(jsonResponse(true));
  };
  assertEquals((await resolveVtoEntitlement('user-1', { rpc })).state, 'unknown');
  assertEquals((await resolveVtoEntitlement('user-1', { rpc })).state, 'active');
  assertEquals(attempts, 2);
});

// ── Eligibility ──────────────────────────────────────────────────────────────

Deno.test('eligibility: garment-bearing categories resolve to a slot', () => {
  const supported = ['top', 'outerwear', 'blazer', 'dress'];
  for (const category of ['wool coat', 'silk blouse', 'tailored blazer', 'midi dress']) {
    const outcome = evaluateServerVtoEligibility({
      category,
      garmentImageUrl: 'https://cdn.example.com/x.jpg',
      productRef: 'p1',
      supportedCategories: supported,
    });
    assertEquals(outcome.eligible, true, category);
  }
});

Deno.test('eligibility: non-garment categories are never eligible', () => {
  for (const category of ['sneakers', 'handbag', 'sunglasses', 'gold necklace', '']) {
    const outcome = evaluateServerVtoEligibility({
      category,
      garmentImageUrl: 'https://cdn.example.com/x.jpg',
      productRef: 'p1',
      supportedCategories: ['top', 'outerwear', 'blazer', 'dress', 'pants', 'skirt'],
    });
    assertEquals(outcome.eligible, false, category);
  }
});

Deno.test('eligibility: a recognised garment outside the allowlist is refused', () => {
  // Trousers are a garment VTO understands, but reliability decides what
  // ships -- the allowlist, not the slot map, is the gate.
  const outcome = evaluateServerVtoEligibility({
    category: 'trousers',
    garmentImageUrl: 'https://cdn.example.com/x.jpg',
    productRef: 'p1',
    supportedCategories: DEFAULT_VTO_SUPPORTED_CATEGORIES,
  });
  assertEquals(outcome.eligible, false);
  if (outcome.eligible === false) assertEquals(outcome.reason, 'unsupported_category');
});

Deno.test('eligibility: a product reference problem is reported before a category one', () => {
  const outcome = evaluateServerVtoEligibility({
    category: 'sneakers',
    garmentImageUrl: 'https://cdn.example.com/x.jpg',
    productRef: '',
    supportedCategories: DEFAULT_VTO_SUPPORTED_CATEGORIES,
  });
  assertEquals(outcome.eligible, false);
  if (outcome.eligible === false) assertEquals(outcome.reason, 'invalid_product_reference');
});

Deno.test('eligibility: canonicalization matches the shared scan taxonomy', () => {
  assertEquals(toCanonicalVtoCategory('Puffer Jacket'), 'outerwear');
  assertEquals(toCanonicalVtoCategory('bootcut jeans'), 'pants');
  assertEquals(toCanonicalVtoCategory('NON_FASHION'), 'NON_FASHION');
});

// ── Result validation ────────────────────────────────────────────────────────

Deno.test('validation: the mock asset passes', () => {
  const outcome = validateVtoResultMedia({
    dataUri: MOCK_VTO_RESULT_DATA_URI,
    mediaType: 'image/png',
    width: 256,
    height: 320,
  });
  assertEquals(outcome.ok, true);
});

Deno.test('validation: a 200 carrying junk is not a result', () => {
  const cases: Array<[string, { dataUri: string; mediaType: string }]> = [
    ['not a data uri', { dataUri: 'https://cdn.example.com/x.png', mediaType: 'image/png' }],
    ['empty', { dataUri: '', mediaType: 'image/png' }],
    ['unsupported type', { dataUri: 'data:image/gif;base64,R0lGODdh', mediaType: 'image/gif' }],
    ['html masquerading', { dataUri: 'data:text/html;base64,PGh0bWw+', mediaType: 'image/png' }],
    ['too small', { dataUri: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png' }],
  ];
  for (const [label, media] of cases) {
    const outcome = validateVtoResultMedia({ ...media, width: null, height: null });
    assertEquals(outcome.ok, false, label);
  }
});

Deno.test('validation: a declared type that disagrees with the payload is rejected', () => {
  // A PNG announced as a JPEG renders as a broken image, and "the provider
  // returned 200" would otherwise call it a success.
  const outcome = validateVtoResultMedia({
    dataUri: MOCK_VTO_RESULT_DATA_URI,
    mediaType: 'image/jpeg',
    width: null,
    height: null,
  });
  assertEquals(outcome.ok, false);
  if (outcome.ok === false) assertEquals(outcome.detail, 'media_type_mismatch');
});

Deno.test('validation: magic bytes must agree with the declared type', () => {
  const notAPng = `data:image/png;base64,${btoa('x'.repeat(4096))}`;
  const outcome = validateVtoResultMedia({
    dataUri: notAPng,
    mediaType: 'image/png',
    width: null,
    height: null,
  });
  assertEquals(outcome.ok, false);
  if (outcome.ok === false) assertEquals(outcome.detail, 'magic_bytes_mismatch');
});

Deno.test('validation: makes no quality claim it cannot support', async () => {
  // The seam deliberately reports structural validity only. If this file ever
  // starts asserting identity/garment fidelity, that must be a deliberate
  // change with a real classifier behind it.
  const source = await Deno.readTextFile(
    new URL('./vtoResultValidation.ts', import.meta.url),
  );
  for (const claim of ['identityFidelity', 'garmentFidelity', 'qualityScore', 'bodyIntegrity']) {
    assert(!source.includes(`${claim}:`), `must not compute ${claim}`);
  }
});
