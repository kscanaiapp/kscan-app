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
import { isEntitlementRowActive, resolveVtoEntitlement } from './vtoEntitlement.ts';
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
  assertEquals(resolveVtoProvider({ providerId: config.provider }).ok, true);
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

Deno.test('entitlement: an unreadable table is unknown, not denied and not active', async () => {
  const outcome = await resolveVtoEntitlement('user-1', {
    rest: () => Promise.resolve(new Response('nope', { status: 500 })),
  });
  assertEquals(outcome.state, 'unknown');
});

Deno.test('entitlement: no row means denied', async () => {
  const outcome = await resolveVtoEntitlement('user-1', {
    rest: () => Promise.resolve(jsonResponse([])),
  });
  assertEquals(outcome.state, 'denied');
});

Deno.test('entitlement: an active, unexpired grant is active', async () => {
  const outcome = await resolveVtoEntitlement('user-1', {
    rest: () =>
      Promise.resolve(jsonResponse([{ status: 'active', expires_at: '2027-01-01T00:00:00Z' }])),
    nowMs: Date.parse('2026-08-30T00:00:00Z'),
  });
  assertEquals(outcome.state, 'active');
});

Deno.test('entitlement: a row left active past its expiry is NOT access', async () => {
  const outcome = await resolveVtoEntitlement('user-1', {
    rest: () =>
      Promise.resolve(jsonResponse([{ status: 'active', expires_at: '2026-01-01T00:00:00Z' }])),
    nowMs: Date.parse('2026-08-30T00:00:00Z'),
  });
  assertEquals(outcome.state, 'denied');
});

Deno.test('entitlement: revoked and expired statuses are denied', () => {
  const now = Date.parse('2026-08-30T00:00:00Z');
  for (const status of ['revoked', 'expired', 'pending', '']) {
    assertEquals(
      isEntitlementRowActive({ status, expires_at: '2027-01-01T00:00:00Z' }, now),
      false,
      status,
    );
  }
});

Deno.test('entitlement: a NULL-expiry grant is NOT active (SEC-KPLUS-003)', () => {
  // This test previously asserted the opposite -- that a null expiry meant a
  // legitimate non-expiring staff/admin grant. That was a VTO-only fork.
  // Canonical K+ has no such concept: public.kplus_has_active_entitlement
  // requires `expires_at is not null and expires_at > now()`, and even
  // grant_kplus_early_access derives "active" the same way. VTO was the sole
  // surface that would have honoured a null-expiry row.
  const now = Date.parse('2026-08-30T00:00:00Z');
  assertEquals(isEntitlementRowActive({ status: 'active', expires_at: null }, now), false);
  assertEquals(isEntitlementRowActive({ status: 'active' }, now), false);
});

Deno.test('entitlement: a revoked grant is not active (SEC-KPLUS-003)', () => {
  // Canonical additionally requires `revoked_at is null`; VTO never read it.
  const now = Date.parse('2026-08-30T00:00:00Z');
  assertEquals(
    isEntitlementRowActive(
      { status: 'active', expires_at: '2026-12-31T00:00:00Z', revoked_at: '2026-08-01T00:00:00Z' },
      now,
    ),
    false,
  );
});

Deno.test('entitlement: an unparseable expiry is denied rather than assumed valid', () => {
  const now = Date.parse('2026-08-30T00:00:00Z');
  assertEquals(isEntitlementRowActive({ status: 'active', expires_at: 'soon' }, now), false);
});

Deno.test('entitlement: the query is scoped to the k_plus key and the given user', async () => {
  let path = '';
  await resolveVtoEntitlement('user-42', {
    rest: (p: string) => {
      path = p;
      return Promise.resolve(jsonResponse([]));
    },
  });
  assert(path.includes('user_id=eq.user-42'));
  assert(path.includes('entitlement_key=eq.k_plus'));
  // No VTO-specific entitlement key exists, and none is invented here.
  assert(!path.includes('vto'));
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
